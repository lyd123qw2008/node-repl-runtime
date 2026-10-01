/**
 * Structural tests for the profile-facing half.
 *
 * Booting a profile is the operator's job, but the bundle wiring and provider
 * configuration precedence are cheap to pin here. An empty provider list is an
 * intentional runtime state, not a bootstrap failure.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveProviders, apply } from '../src/index.js'

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

describe('bundle wiring', () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as {
    dsh?: { bundle?: { patch?: string } }
  }

  it('declares a DSH bundle patch, and the file exists', () => {
    const patch = manifest.dsh?.bundle?.patch
    expect(patch).toBe('./cordis.patch.yml')
    const text = readFileSync(join(PACKAGE_DIR, patch!), 'utf8')
    // Both plugins must be inserted by this bundle: the adapter alone stays dormant,
    // and the bootstrap alone registers no tools.
    expect(text).toContain('@lyd123qw2008/node-repl-dsh-bootstrap')
    expect(text).toContain('@lyd123qw2008/node-repl-dsh-adapter')
  })

  it('keeps machine-local values out of the committed patch', () => {
    const text = readFileSync(join(PACKAGE_DIR, 'cordis.patch.yml'), 'utf8')
    // No endpoint and no project path may be committed: they are per-machine.
    expect(text).not.toMatch(/https?:\/\//)
    expect(text).not.toMatch(/[A-Za-z]:[\\/]/)
  })
})

describe('provider configuration resolution', () => {
  const idea = { id: 'idea', transport: 'streamable-http' as const, url: 'http://127.0.0.1:1/stream' }

  it('prefers explicit plugin config', () => {
    expect(resolveProviders({ providers: [idea] }, {})).toEqual([idea])
  })

  it('falls back to inline JSON in the environment', () => {
    expect(resolveProviders({}, { NODE_REPL_PROVIDERS: JSON.stringify([idea]) })).toEqual([idea])
    expect(resolveProviders({}, { NODE_REPL_PROVIDERS: JSON.stringify({ providers: [idea] }) })).toEqual([idea])
  })

  it('falls back to a JSON file path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nr-providers-'))
    const file = join(dir, 'providers.json')
    writeFileSync(file, JSON.stringify({ providers: [idea] }))
    expect(resolveProviders({}, { NODE_REPL_PROVIDERS_FILE: file })).toEqual([idea])
  })

  it('resolves missing or empty configuration as an empty provider list', () => {
    expect(resolveProviders({}, {})).toEqual([])
    expect(resolveProviders({ providers: [] }, { NODE_REPL_PROVIDERS: JSON.stringify([idea]) })).toEqual([])
    expect(resolveProviders({}, { NODE_REPL_PROVIDERS: '   ' })).toEqual([])
  })

  it('preserves disabled provider fields from explicit configuration', () => {
    const disabled = { ...idea, disabled: true }
    expect(resolveProviders({ providers: [disabled] }, {})).toEqual([disabled])
  })
})

describe('service provisioning', () => {
  /** Minimal context: records the provided service and captures the dispose effect. */
  function recordingContext() {
    const provided = new Map<string, unknown>()
    const effects: (() => void)[] = []
    const ctx = {
      provide(name: string, value: unknown) { provided.set(name, value) },
      effect(factory: () => () => void) {
        effects.push(factory())
        return () => {}
      },
    }
    return { ctx, provided, effects }
  }

  it('provides the service after a successful build and forwards the kernel command', async () => {
    const { ctx, provided, effects } = recordingContext()
    let receivedOptions: unknown
    await apply(ctx as never, {
      providers: [],
      kernelCommand: 'node',
      runtimeFactory: async options => {
        receivedOptions = options
        return {
          js: async () => ({ status: 'ok', output: '', blocks: [], durationMs: 0 }),
          jsReset: async () => {},
          catalog: () => [],
          failures: () => [],
          dispose: async () => {},
        }
      },
    })
    expect(receivedOptions).toMatchObject({ providers: [], kernelCommand: 'node' })
    expect(provided.get('nodeReplRuntime')).toBeDefined()
    // The dispose effect is the only thing that closes kernels and provider sessions,
    // so a provided runtime without one leaks a kernel per boot.
    expect(effects).toHaveLength(1)
  })

  it('still provides the service when runtime construction throws', async () => {
    // The reason this matters is the whole point of the package: the adapter face
    // injects `nodeReplRuntime`, so a bootstrap that ends without providing it leaves
    // the face pending forever. `js` and `js_reset` are then missing from the tool list
    // with no error reported anywhere — the silent absence this runtime exists to avoid.
    //
    // It is reachable in practice: DSH's fail-loud handler charges an escaped rejection
    // from the mounting fiber to this plugin, so an `apply()` that throws must not also
    // be the reason the face never appears. Providing a runtime that cannot run a cell
    // is honest and diagnosable; providing nothing is invisible.
    const { ctx, provided } = recordingContext()
    await apply(ctx as never, {
      providers: [],
      runtimeFactory: async () => { throw new Error('connection closed') },
    })

    const runtime = provided.get('nodeReplRuntime') as {
      js: () => Promise<unknown>
      catalog: () => unknown[]
      failures: () => { id: string; error: string }[]
    }
    expect(runtime).toBeDefined()
    expect(runtime.catalog()).toEqual([])
    expect(runtime.failures()).toEqual([{ id: 'runtime', error: 'connection closed' }])
    // Failure must be loud at the point of use, not a second silent absence.
    await expect(runtime.js()).rejects.toThrow(/node-repl runtime unavailable.*connection closed/)
  })
})
