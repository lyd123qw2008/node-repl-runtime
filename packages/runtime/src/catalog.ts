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

/**
 * Image admission for provider results.
 *
 * The kernel validates and budgets what a *cell* emits: its `output-adapter` allowlists
 * png/jpeg/webp, sniffs the bytes, and enforces per-image and aggregate ceilings. A
 * provider's reply never passes through that gate — it arrives here first — so without
 * this step the pixels are simply lost (measured against `cap.cua.get_window_state`,
 * which returns `screenshot_mime_type` and no bytes).
 *
 * The numbers are deliberately the kernel's own model-tier budget rather than a second
 * policy: reusing them means a provider cannot hand the model pixels the kernel would
 * have refused on the way out.
 */
export const PROVIDER_IMAGE_MAX_BYTES = 4 * 1024 * 1024
export const PROVIDER_IMAGE_TOTAL_MAX_BYTES = 8 * 1024 * 1024

/** The kernel's own allowlist, so the two cannot drift apart silently. */
const PROVIDER_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

/** One admitted image, in the shape the kernel's `ImageMessage` uses. */
export interface ProviderImage {
  readonly mimeType: string
  /** Base64, exactly as the server sent it. */
  readonly data: string
}

export interface ProviderImages {
  readonly images: readonly ProviderImage[]
  /** Images the server sent that admission refused. Never silent: see `mergeProviderImages`. */
  readonly dropped: number
}

/**
 * Admit the image blocks of one MCP result.
 *
 * Exported for tests, like the other pure projections here: it is a function of the
 * server's reply alone, so it can be asserted without a server.
 */
export function collectProviderImages(content: unknown): ProviderImages {
  if (!Array.isArray(content)) return { images: [], dropped: 0 }
  const images: ProviderImage[] = []
  let total = 0
  let dropped = 0
  for (const raw of content) {
    const block = raw as { type?: unknown; mimeType?: unknown; data?: unknown } | null
    if (block === null || typeof block !== 'object' || block.type !== 'image') continue
    const mimeType = typeof block.mimeType === 'string' ? block.mimeType.toLowerCase() : ''
    const data = typeof block.data === 'string' ? block.data : ''
    // Base64 is 4 encoded characters per 3 bytes. Measuring the ceiling this way avoids
    // decoding megabytes only to count them, and a ceiling does not need the exact byte
    // count the way a validator would.
    const bytes = Math.floor(data.length / 4) * 3
    if (!PROVIDER_IMAGE_MIME_TYPES.has(mimeType)
      || data === ''
      || bytes > PROVIDER_IMAGE_MAX_BYTES
      || total + bytes > PROVIDER_IMAGE_TOTAL_MAX_BYTES) {
      dropped++
      continue
    }
    total += bytes
    images.push({ mimeType, data })
  }
  return { images, dropped }
}

/**
 * Park admitted images on the value the cell will receive.
 *
 * `_images` rather than an automatic push is the whole point: bytes sitting on a kernel
 * value cost no context until the cell writes them out, so "the model asks for pixels"
 * stays true without the runtime guessing when a picture is worth showing.
 *
 * A reply that is not a plain object (a bare content array, a scalar) keeps its value
 * under `_value`: silently reshaping a provider's answer into an object would be worse
 * than one documented hop. Nothing is attached at all when the server sent no images,
 * so every provider that never returns pixels sees a byte-identical result.
 */
export function mergeProviderImages(value: unknown, collected: ProviderImages): unknown {
  if (collected.images.length === 0 && collected.dropped === 0) return value
  const extras: Record<string, unknown> = { _images: collected.images }
  // A drop is reported on the value too. The kernel reports its own drops as visible
  // text; here the value is the only channel the cell reads.
  if (collected.dropped > 0) extras._imagesDropped = collected.dropped
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return { ...value, ...extras }
  }
  return { _value: value, ...extras }
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
      // Passed through verbatim: this runtime never rewrites a provider's result. The one
      // addition is additive and conditional — images the server actually sent are parked
      // on the value as `_images`, because a `??` on the structured payload would drop
      // them entirely (they ride in a separate image content block).
      const value = result.structuredContent ?? result.content ?? null
      return mergeProviderImages(value, collectProviderImages(result.content))
    },
    async close() {
      await client.close().catch(() => {})
    },
  }
}
