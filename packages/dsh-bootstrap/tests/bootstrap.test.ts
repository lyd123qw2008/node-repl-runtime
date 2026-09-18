/**
 * Structural tests for the profile-facing half.
 *
 * Booting a profile is the operator's job, but the two ways it can fail for boring
 * reasons — a bundle patch that does not declare the plugins, or provider
 * configuration that resolves to nothing — are cheap to pin here.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveProviders } from '../src/index.js'

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
    expect(text).toContain('@node-repl-runtime/dsh-bootstrap')
    expect(text).toContain('@node-repl-runtime/adapter-dsh')
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

  it('fails loudly rather than starting with no capabilities', () => {
    // A profile that came up silently empty would look like a working setup.
    expect(() => resolveProviders({}, {})).toThrow(/no MCP providers configured/)
    expect(() => resolveProviders({ providers: [] }, { NODE_REPL_PROVIDERS: '   ' })).toThrow(/no MCP providers configured/)
  })
})
