/**
 * Mount the runtime into a DSH profile from configuration alone.
 *
 * This is the piece that was missing: the adapter declares `inject: ['nodeReplRuntime']`,
 * so without a plugin providing that service the two-tool face can never register.
 * This bootstrap creates the runtime and provides it.
 *
 * Provider configuration is deliberately not committed anywhere: which MCP servers to
 * attach, and which host-owned arguments to inject, are machine-local facts. It is read
 * from, in order:
 *
 *   1. `config.providers` in this plugin's own entry,
 *   2. `NODE_REPL_PROVIDERS` (inline JSON),
 *   3. `NODE_REPL_PROVIDERS_FILE` (path to a JSON file).
 *
 * An empty provider list is valid: the bootstrap can provide an empty capability runtime
 * whose `js` / `js_reset` face remains usable. Connection failures are non-fatal, matching
 * the optional DSH MCP-client startup policy; failed providers simply contribute no tools.
 */

import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { createCapabilityRuntime, type CapabilityRuntime, type McpProviderSpec, type ProviderFailure, type RuntimeOptions } from '@lyd123qw2008/node-repl-runtime'

export const name = 'node-repl-runtime-bootstrap'

/** Needs the tool runtime only to noop until the face registers; the face owns tools. */
export const inject = [] as const

export interface NodeReplBootstrapConfig {
  readonly providers?: readonly McpProviderSpec[]
  /** Default per-cell budget. */
  readonly cellTimeoutMs?: number
  /**
   * Node-mode executable for the kernel child.
   *
   * Required in practice for the Desktop host, whose `process.execPath` is `electron.exe`
   * while the MCP stdio transport strips `ELECTRON_RUN_AS_NODE` — so the kernel child would
   * start as a GUI and close its stdio almost immediately. Left unset, the runtime applies
   * `process.execPath`; Electron hosts must set this to a Node-mode executable.
   */
  readonly kernelCommand?: string
  /** Override runtime construction (tests). Mirrors the runtime's own `connector` seam. */
  readonly runtimeFactory?: (options: RuntimeOptions) => Promise<CapabilityRuntime>
}

interface ProviderFile {
  readonly providers?: readonly McpProviderSpec[]
}

/** Read provider specs from config or the environment. Exported for tests. */
export function resolveProviders(
  config: NodeReplBootstrapConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly McpProviderSpec[] {
  if (config.providers !== undefined) return config.providers

  const inline = env.NODE_REPL_PROVIDERS
  if (inline !== undefined && inline.trim() !== '') {
    const parsed = JSON.parse(inline) as ProviderFile | McpProviderSpec[]
    return Array.isArray(parsed) ? parsed : parsed.providers ?? []
  }

  const file = env.NODE_REPL_PROVIDERS_FILE
  if (file !== undefined && file.trim() !== '') {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ProviderFile | McpProviderSpec[]
    return Array.isArray(parsed) ? parsed : parsed.providers ?? []
  }

  return []
}

/**
 * A runtime that attached nothing.
 *
 * Only reachable when `createCapabilityRuntime` itself throws, which the per-provider
 * catch inside it is written to prevent. It exists because the alternative is worse:
 * see {@link apply}.
 */
function createEmptyRuntime(failures: readonly ProviderFailure[]): CapabilityRuntime {
  const report = failures.map(failure => `${failure.id}: ${failure.error}`).join('; ')
  const dead = async () => {
    throw new Error(`node-repl runtime unavailable${report === '' ? '' : ` (${report})`}`)
  }
  return {
    js: dead,
    jsReset: dead,
    catalog: () => [],
    failures: () => [...failures],
    dispose: async () => {},
  }
}

export const apply = async (ctx: Context, config: NodeReplBootstrapConfig = {}): Promise<void> => {
  const providers = resolveProviders(config)

  // Build first, provide second, and never let a failure skip the provide.
  //
  // The adapter face injects `nodeReplRuntime`, so a bootstrap that ends without
  // providing it leaves the face pending forever: `js` and `js_reset` are then absent
  // from the tool list with no error anywhere, which is exactly the silent-absence bug
  // this whole package exists to avoid. Providing a runtime that cannot run a cell is
  // honest and diagnosable; providing nothing is invisible.
  let runtime: CapabilityRuntime
  try {
    const build = config.runtimeFactory ?? createCapabilityRuntime
    runtime = await build({
      providers,
      ...config.cellTimeoutMs === undefined ? {} : { cellTimeoutMs: config.cellTimeoutMs },
      ...config.kernelCommand === undefined ? {} : { kernelCommand: config.kernelCommand },
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`[node-repl-runtime] runtime setup failed; providing a non-functional runtime: ${reason}`)
    runtime = createEmptyRuntime([{ id: 'runtime', error: reason }])
  }

  ctx.provide('nodeReplRuntime', runtime)
  ctx.effect(() => () => {
    void runtime.dispose()
  }, 'node-repl-runtime: dispose kernels, bridge and MCP sessions')

  const report = runtime.catalog()
    .map(provider => `${provider.id}=${provider.operations.length}`)
    .join(' ') || 'no connected providers'
  const disabled = providers
    .filter(provider => provider.disabled === true)
    .map(provider => provider.id)
  const failed = runtime.failures().map(failure => `${failure.id}=${failure.error}`).join(' ')
  console.log(
    `[node-repl-runtime] mounted ${report}`
    + (disabled.length > 0 ? ` | disabled: ${disabled.join(',')}` : '')
    + (failed === '' ? '' : ` | failed: ${failed}`)
    + (providers.some(provider => Object.keys(provider.inject ?? {}).length > 0)
      ? ` | host-owned args injected: ${providers.flatMap(provider => Object.keys(provider.inject ?? {})).join(',')}`
      : ''),
  )
}
