/**
 * Turn an MCP server into a projected capability catalog.
 *
 * The whole provider-integration story lives here, and it is generic: connect,
 * `tools/list`, project. There is no per-server branch, no allowlist, no review
 * artifact, and no stored schema — whatever the server advertises this session is
 * what the model can call, which is the node_repl behaviour.
 *
 * Two host-side decisions are made, and only these:
 *   1. `inject` keys are removed from the model-visible schema;
 *   2. `include` optionally narrows which tools are exposed at all.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { McpProviderSpec, ProjectedOperation, ProviderConnection } from './types.js'

interface ListedTool {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: { readonly properties?: Record<string, unknown>; readonly required?: readonly string[] }
  readonly outputSchema?: Record<string, unknown>
  readonly annotations?: { readonly readOnlyHint?: unknown }
}

/** Project one advertised tool into a model-visible operation. */
export function projectOperation(tool: ListedTool, spec: McpProviderSpec): ProjectedOperation {
  const injected = Object.keys(spec.inject ?? {})
  const properties: Record<string, unknown> = { ...(tool.inputSchema?.properties ?? {}) }
  for (const name of injected) delete properties[name]
  const required = (tool.inputSchema?.required ?? []).filter(name => !injected.includes(name))
  return {
    name: tool.name,
    // The server's own description. We never author summaries.
    summary: (tool.description ?? tool.name).trim(),
    // Informational. Relayed from the server's declaration, never invented, and
    // never used to block anything.
    safety: tool.annotations?.readOnlyHint === true ? 'read' : 'mutate',
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    // `inject` is an input-side concern, so a declared result shape passes through
    // untouched. Its absence is information too: those are the operations that answer
    // in content blocks rather than structured data.
    ...tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema },
  }
}

/** Exposure narrowing, when the operator asked for it. */
export function selectTools(tools: readonly ListedTool[], spec: McpProviderSpec): readonly ListedTool[] {
  if (spec.include === undefined || spec.include === null) return tools
  const patterns = spec.include.map(pattern => new RegExp(pattern))
  return tools.filter(tool => patterns.some(pattern => pattern.test(tool.name)))
}

/**
 * Merge host-owned arguments into a call, refusing caller-supplied ones.
 *
 * Refusing (rather than overwriting) is deliberate: which project, account or
 * workspace to act on is a host decision, and a cell that tries to redirect it
 * should get an error it can see, not a silently ignored argument.
 */
export function applyInjection(
  injected: Readonly<Record<string, unknown>>,
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  for (const name of Object.keys(injected)) {
    if (Object.hasOwn(args, name)) {
      throw new Error(`${name} is host-owned and may not be supplied by the caller`)
    }
  }
  return { ...args, ...injected }
}

/** Open one MCP session. Nothing is cached or persisted: the surface is live. */
export async function connectMcpProvider(spec: McpProviderSpec): Promise<ProviderConnection> {
  const client = new Client(
    { name: 'node-repl-runtime', version: '0.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  )
  if (spec.transport === 'streamable-http') {
    if (spec.url === undefined) throw new Error(`provider ${spec.id}: transport streamable-http requires url`)
    await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)))
  } else {
    if (spec.command === undefined) throw new Error(`provider ${spec.id}: transport stdio requires command`)
    await client.connect(new StdioClientTransport({
      command: spec.command,
      args: [...(spec.args ?? [])],
      ...spec.cwd === undefined ? {} : { cwd: spec.cwd },
      ...spec.env === undefined ? {} : { env: { ...spec.env } },
    }))
  }

  const listed = await client.listTools(undefined, { timeout: 60_000, cacheMode: 'refresh' })
  const operations = selectTools(listed.tools as ListedTool[], spec).map(tool => projectOperation(tool, spec))
  const injected = spec.inject ?? {}

  return {
    id: spec.id,
    label: spec.label ?? spec.id,
    operations,
    async call(operation, args, signal) {
      const result = await client.callTool(
        { name: operation, arguments: applyInjection(injected, args) },
        // Aborting this request sends the MCP cancellation notification, so a provider
        // that supports it can stop the work instead of finishing it for nobody.
        { timeout: 300_000, ...signal === undefined ? {} : { signal } },
      )
      if (result.isError === true) {
        const text = (result.content ?? [])
          .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
          .map(block => block.text)
          .join('\n')
        throw new Error(text.trim() === '' ? `${spec.id}.${operation} failed` : text)
      }
      // `structuredContent` when the server sends it, otherwise the content blocks.
      // Passed through verbatim: this runtime never rewrites a provider's result.
      return result.structuredContent ?? result.content ?? null
    },
    async close() {
      await client.close().catch(() => {})
    },
  }
}
