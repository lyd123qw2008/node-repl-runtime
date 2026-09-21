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
import { createCapabilityRuntime, type CapabilityRuntime, type McpProviderSpec } from '@lyd123qw2008/node-repl-runtime'

export const name = 'node-repl-runtime-bootstrap'

/** Needs the tool runtime only to noop until the face registers; the face owns tools. */
export const inject = [] as const

export interface NodeReplBootstrapConfig {
  readonly providers?: readonly McpProviderSpec[]
  /** Default per-cell budget. */
  readonly cellTimeoutMs?: number
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

export const apply = async (ctx: Context, config: NodeReplBootstrapConfig = {}): Promise<void> => {
  const providers = resolveProviders(config)
  const runtime: CapabilityRuntime = await createCapabilityRuntime({
    providers,
    ...config.cellTimeoutMs === undefined ? {} : { cellTimeoutMs: config.cellTimeoutMs },
  })

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
  console.log(
    `[node-repl-runtime] mounted ${report}`
    + (disabled.length > 0 ? ` | disabled: ${disabled.join(',')}` : '')
    + (providers.some(provider => Object.keys(provider.inject ?? {}).length > 0)
      ? ` | host-owned args injected: ${providers.flatMap(provider => Object.keys(provider.inject ?? {})).join(',')}`
      : ''),
  )
}
