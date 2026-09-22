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
  ProviderFailure,
  RuntimeOptions,
} from './types.js'

export * from './types.js'
export { applyInjection, projectOperation, selectTools, connectMcpProvider } from './catalog.js'
// Pure functions of one provider reply, so they are asserted directly instead of through a
// CONNECTED server — the same reason `projectOperation` and `selectTools` are exported.
export {
  collectProviderImages,
  mergeProviderImages,
  PROVIDER_IMAGE_MAX_BYTES,
  PROVIDER_IMAGE_TOTAL_MAX_BYTES,
  type ProviderImage,
  type ProviderImages,
} from './catalog.js'

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
  /**
   * Providers that could not be attached, with their reasons.
   *
   * Separate from `catalog()` because they are not capabilities: nothing can be called on
   * them. They ride into the kernel's config snapshot so `capHelp()` can explain an absence
   * instead of only listing presences.
   */
  failures(): readonly ProviderFailure[]
  dispose(): Promise<void>
}

export async function createCapabilityRuntime(options: RuntimeOptions): Promise<CapabilityRuntime> {
  const connector = options.connector ?? connectMcpProvider
  const providers = new Map<string, ProviderConnection>()
  const failures: ProviderFailure[] = []

  for (const spec of options.providers) {
    if (spec.disabled === true) continue
    try {
      providers.set(spec.id, await connector(spec))
    } catch (error) {
      // Match the optional MCP-client startup policy: a provider that will not
      // connect contributes no capabilities, but it must not take the runtime
      // down. Other providers — including none — can still be used.
      const message = error instanceof Error ? error.message : String(error)
      failures.push({ id: spec.id, error: message })
      console.warn(`[node-repl-runtime] provider ${spec.id} failed to connect: ${message}`)
    }
  }
  // An empty catalog is a valid runtime state. The face still provides js and
  // js_reset, while cap.list() simply reports no connected capabilities.

  const bridge = await startBridge(providers)
  const root = options.kernelRoot ?? createKernelRoot()

  let kernel
  try {
    kernel = await startKernel({
      root,
      bridge,
      providers,
      failures,
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
    failures: () => [...failures],
    async dispose() {
      if (disposed) return
      disposed = true
      await kernel.close().catch(() => {})
      await bridge.close().catch(() => {})
      for (const provider of providers.values()) await provider.close().catch(() => {})
    },
  }
}

/** Human-readable connection report: what attached, and what did not with its reason. */
export function describeProviders(
  providers: readonly ProviderConnection[],
  failures: readonly ProviderFailure[] = [],
): string {
  return [
    ...providers.map(provider => `${provider.id} (${provider.label}) — ${provider.operations.length} operation(s)`),
    // The previous version of this comment claimed it included failures while the body did
    // not: exactly the silent-absence bug this change is about, in miniature.
    ...failures.map(failure => `${failure.id} — NOT ATTACHED: ${failure.error}`),
  ].join('\n')
}

export type { McpProviderSpec, ProviderConnection, JsCellResult, JsOptions }
