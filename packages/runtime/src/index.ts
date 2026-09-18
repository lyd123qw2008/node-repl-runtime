/**
 * The runtime facade: two operations, and that is the point.
 *
 * `js` runs a cell in one persistent kernel; `js_reset` clears it. Everything else a
 * model needs — discovering capabilities, calling them, processing results — happens
 * *inside* the cell, which is what keeps the model-visible tool surface at two
 * declarations no matter how many MCP servers are attached.
 */

import { fileURLToPath } from 'node:url'
import { startBridge } from './bridge.js'
import { connectMcpProvider } from './catalog.js'
import { createKernelRoot, startKernel } from './kernel.js'
import type {
  JsCellResult,
  JsOptions,
  McpProviderSpec,
  ProviderConnection,
  RuntimeOptions,
} from './types.js'

export * from './types.js'
export { applyInjection, projectOperation, selectTools, connectMcpProvider } from './catalog.js'

/** The reused kernel server. Its package entry point *is* the MCP server. */
export const KERNEL_PACKAGE = '@qwen-code/node-repl-mcp'

/**
 * Resolve the kernel entry from wherever this package is installed.
 *
 * Uses the ESM resolver, not `createRequire`: the kernel package declares only
 * `types`/`import` conditions, so a `require`-side resolve fails with "No exports
 * main defined".
 */
function resolveKernelEntry(): string {
  return fileURLToPath(import.meta.resolve(KERNEL_PACKAGE))
}

export interface CapabilityRuntime {
  /** Run one JavaScript cell in the persistent kernel. */
  js(code: string, options?: JsOptions): Promise<JsCellResult>
  /** Discard the kernel's bindings. */
  jsReset(): Promise<void>
  /** The projected catalog, for host-side reporting (not a model-facing tool). */
  catalog(): readonly ProviderConnection[]
  dispose(): Promise<void>
}

export async function createCapabilityRuntime(options: RuntimeOptions): Promise<CapabilityRuntime> {
  const connector = options.connector ?? connectMcpProvider
  const providers = new Map<string, ProviderConnection>()
  const failed: string[] = []

  for (const spec of options.providers) {
    try {
      providers.set(spec.id, await connector(spec))
    } catch (error) {
      // A provider that will not connect must not take the runtime down: the model
      // can still work with whatever else attached, and `capHelp()` will show only
      // the live ones. The failure is reported on the status path instead.
      failed.push(`${spec.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (providers.size === 0) {
    throw new Error(`no provider connected (${failed.join('; ') || 'none configured'})`)
  }

  const bridge = await startBridge(providers)
  const root = options.kernelRoot ?? createKernelRoot()

  let kernel
  try {
    kernel = await startKernel({
      root,
      bridge,
      providers,
      entry: options.kernelEntry ?? resolveKernelEntry(),
      defaultTimeoutMs: options.cellTimeoutMs ?? 30_000,
    })
  } catch (error) {
    await bridge.close()
    for (const provider of providers.values()) await provider.close().catch(() => {})
    throw error
  }

  let disposed = false
  return {
    js: (code, runOptions) => kernel.run(code, runOptions),
    jsReset: () => kernel.reset(),
    catalog: () => [...providers.values()],
    async dispose() {
      if (disposed) return
      disposed = true
      await kernel.close().catch(() => {})
      await bridge.close().catch(() => {})
      for (const provider of providers.values()) await provider.close().catch(() => {})
    },
  }
}

/** Human-readable connection report, including providers that failed to attach. */
export function describeProviders(providers: readonly ProviderConnection[]): string {
  return providers
    .map(provider => `${provider.id} (${provider.label}) — ${provider.operations.length} operation(s)`)
    .join('\n')
}

export type { McpProviderSpec, ProviderConnection, JsCellResult, JsOptions }
