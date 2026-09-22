/**
 * The model-visible face: exactly two tools.
 *
 * This is the DSH side of the design. `js` and `js_reset` are the whole surface no
 * matter how many MCP servers are attached, which is what makes the tool-declaration
 * cost independent of how much is behind it — the same property node_repl gets from
 * exposing one `js` tool.
 *
 * Images are the one place where the face is not purely a text boundary. A cell's
 * `nodeRepl.emitImage(...)` reaches this file as an ordered block, and DSH's image block
 * carries an attachment reference rather than bytes — so `execute` commits the bytes to
 * the attachment store and `render` puts the reference back in the exact position the
 * cell emitted it. See `docs/05-image-content-blocks.zh-CN.md`.
 *
 * Kept framework-agnostic on purpose: `createNodeReplTools` returns plain definitions
 * so it can be tested without a host, and the Cordis plugin below only wires them up.
 */

import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
// Type-only, so the face gains no runtime dependency: these name the vocabulary it speaks
// and load the `Context.attachments` / `Context.llm` augmentations. Every reference used
// below is produced by the live service at call time, never constructed here.
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { CapabilityRuntime, JsCellBlock, JsCellResult } from '@lyd123qw2008/node-repl-runtime'
import { JS_RESET_TOOL_DESCRIPTION, JS_TOOL_DESCRIPTION } from './descriptions.js'

export * from './descriptions.js'

/** Names are fixed: the model surface must not vary with what is attached. */
export const NODE_REPL_TOOL_NAMES = ['js', 'js_reset'] as const

type ParameterSchemaSpec = Record<string, Record<string, unknown>>

const JS_PARAMETERS = {
  code: {
    type: 'string',
    required: true,
    description: 'JavaScript to run in the persistent kernel. Use nodeRepl.write(...) for the text you want returned.',
  },
  timeoutMs: {
    type: 'integer',
    description: 'Optional budget for this cell in milliseconds. Defaults to the runtime budget (30 s).',
  },
  title: {
    type: 'string',
    description: 'Optional short, single-line, user-visible description of what this cell does. Display only.',
  },
} as const satisfies ParameterSchemaSpec

const RESET_PARAMETERS = {} as const satisfies ParameterSchemaSpec

/**
 * One piece of the model-facing result: prose, or a durable image reference.
 *
 * A type alias, not an interface: the tool contract wants a JSON value, and only type
 * aliases get the implicit index signature that satisfies it.
 */
type JsToolBlock =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image'; readonly attachment: ImageAttachmentRef }

/**
 * Cell outcome as the model sees it.
 *
 * `blocks` stays ordered because order is what the kernel took care to preserve; the
 * status header is folded in by `render`.
 */
type JsToolValue = {
  readonly status: string
  readonly durationMs: number
  /**
   * A mutable array type on purpose: the tool contract's `JsonValue` has no `readonly`
   * form, so a `readonly JsToolBlock[]` here would not satisfy it. The property itself
   * stays readonly, which is what callers actually observe.
   */
  readonly blocks: JsToolBlock[]
  readonly error?: { readonly name: string; readonly message: string }
}

/**
 * The one method this face needs from DSH's LLM service.
 *
 * Structural rather than imported: naming only what is called keeps a capability probe
 * from pinning a second DSH package into the type graph, and the real service is
 * assignable to it.
 */
export interface ImageCapabilityProbe {
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ readonly inputModalities?: readonly string[] }>
}

export interface NodeReplToolHost {
  readonly runtime: CapabilityRuntime
  /**
   * DSH's attachment store, resolved per call.
   *
   * A function, not a value: this face must register whether or not a store is mounted,
   * and the store may mount after it does. `read_image` solves the same ordering problem by
   * making its registration conditional; a two-tool face cannot, because text-only cells
   * must keep working with no store at all.
   */
  readonly attachments?: () => AttachmentStore | undefined
  /** DSH's LLM service, resolved per call, used only to check that the route accepts images. */
  readonly llm?: () => ImageCapabilityProbe | undefined
}

/** An image block as the runtime hands it over: base64 plus the MIME the kernel validated. */
type CellImageBlock = Extract<JsCellBlock, { kind: 'image' }>

/**
 * Why a cell's images did not become content blocks. Rendered as visible text in the
 * image's own position — never thrown, because the cell already produced prose worth
 * keeping.
 */
type ImageRefusal = string

const IMAGE_OMITTED = 'image omitted'

/**
 * Refuse images when the exact calling route cannot accept them.
 *
 * The failure this prevents is not cosmetic. An image on a text-only route fails the
 * *provider request*, taking the whole turn with it — long after the cell succeeded and
 * with nothing pointing back at the image as the cause. So the check runs here, at the one
 * place that knows both the route and the pixels.
 *
 * Two deliberate differences from `read_image`, which refuses by throwing: this tool has
 * already run its cell, so a missing image becomes visible text instead of costing the
 * cell's prose; and an unresolvable route proceeds, because a probe that cannot answer is
 * not evidence that the route is text-only.
 */
async function imageRouteRefusal(
  host: NodeReplToolHost,
  exec: ToolRunContext,
): Promise<ImageRefusal | undefined> {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = host.llm?.()
  if (llm === undefined || provider === undefined || model === undefined) return undefined
  try {
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    if (info.inputModalities?.includes('image') === true) return undefined
    return `model "${model}" does not declare image input`
  } catch {
    return undefined
  }
}

/**
 * Turn a cell's images into durable references, or say why not.
 *
 * DSH's image block carries a reference rather than bytes, and that is not bureaucracy:
 * `compaction-image-offload` replaces the oldest image occurrences with placeholder text
 * plus a read-only path when a route demands it, so the model can read them back later.
 * Inline bytes would trade that away for a context that can only grow.
 *
 * One `saveImages` call for the whole cell rather than a loop: the store validates the
 * batch — count, aggregate bytes, accepted media types — before committing any member,
 * which is exactly the "one tool result is one message" semantics this needs.
 */
async function commitImages(
  host: NodeReplToolHost,
  images: readonly CellImageBlock[],
  exec: ToolRunContext,
): Promise<{ readonly refs: readonly ImageAttachmentRef[]; readonly refusal?: ImageRefusal }> {
  if (images.length === 0) return { refs: [] }
  const refusal = await imageRouteRefusal(host, exec)
  if (refusal !== undefined) return { refs: [], refusal }
  const store = host.attachments?.()
  if (store === undefined) return { refs: [], refusal: 'no attachment store is mounted' }
  try {
    const refs = await store.saveImages(images.map(image => ({
      data: Buffer.from(image.data, 'base64'),
      // The kernel restricted this to its own png/jpeg/webp allowlist before the block
      // existed, so the cast records a fact rather than asserting one. A store that
      // accepts fewer types still gets to refuse it, below.
      mediaType: image.mimeType as ImageMediaType,
      name: 'node-repl.png',
    })))
    return { refs }
  } catch (error) {
    return { refs: [], refusal: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Rebuild the cell's ordered blocks for the model, substituting each image with its
 * reference — or, when it could not be committed, with a notice in that same position.
 * Order is the reason `blocks` exists, so a refusal must not shuffle the prose around it.
 */
function toToolBlocks(
  blocks: readonly JsCellBlock[],
  refs: readonly ImageAttachmentRef[],
  refusal: ImageRefusal | undefined,
): JsToolBlock[] {
  const toolBlocks: JsToolBlock[] = []
  let imageIndex = 0
  for (const block of blocks) {
    if (block.kind === 'text') {
      toolBlocks.push({ kind: 'text', text: block.text })
      continue
    }
    const ref = refs[imageIndex]
    imageIndex++
    toolBlocks.push(ref === undefined
      ? { kind: 'text', text: `[${IMAGE_OMITTED}: ${refusal ?? 'not stored'}]` }
      : { kind: 'image', attachment: ref })
  }
  return toolBlocks
}

/**
 * Formatted as content blocks rather than `JSON.stringify`: the whole point of a REPL is
 * that what the cell wrote comes back readable, with real newlines — and an image comes
 * back as an image, in the position the cell put it.
 */
const cellOutput = {
  schema: { type: 'json' } as const,
  render(_args: unknown, value: unknown): ContentBlock[] {
    const cell = value as JsToolValue
    const header = cell.status === 'ok'
      ? `ok (${cell.durationMs}ms)`
      : `${cell.status} (${cell.durationMs}ms)${cell.error === undefined ? '' : `: ${cell.error.name}: ${cell.error.message}`}`
    const [first, ...rest] = cell.blocks
    // The status lead folds into the first text block when there is one, so a text-only
    // cell renders exactly as it did before images existed.
    const rendered: ContentBlock[] = first?.kind === 'text'
      ? [{ type: 'text', text: `${header}\n${first.text}` }]
      : [{ type: 'text', text: header }]
    for (const block of first?.kind === 'text' ? rest : cell.blocks) {
      rendered.push(block.kind === 'text'
        ? { type: 'text', text: block.text }
        : { type: 'image', attachment: block.attachment })
    }
    return rendered
  },
}

/**
 * Hand a cell outcome to the tool contract.
 *
 * The one cast in this file, kept in one place, and it is a compiler limitation rather
 * than a shortcut: the contract types its value as `JsonValue`, a recursive alias with an
 * index signature, and TypeScript gives implicit index signatures to aliases only. DSH's
 * `ImageAttachmentRef` is an interface — it *is* lossless JSON, and the value handed over
 * here is the live store's own object, never reshaped — so the compiler cannot see what
 * the runtime already guarantees. Returning `never` makes the result assignable where the
 * contract wants `JsonValue` without this file restating that type.
 */
function forToolContract(value: JsToolValue): never {
  return value as never
}

/** Build the two tool definitions over a runtime. */
export function createNodeReplTools(host: NodeReplToolHost) {
  const jsTool = defineTool({
    name: NODE_REPL_TOOL_NAMES[0],
    description: JS_TOOL_DESCRIPTION,
    parameters: JS_PARAMETERS,
    output: cellOutput,
    // The return type is deliberately inferred: `forToolContract` yields `never`, which is
    // what lets the value satisfy the contract's `JsonValue`; annotating it here would put
    // the unassignable shape back.
    async execute(
      args: { code: string; timeoutMs?: number; title?: string },
      exec: ToolRunContext,
    ) {
      const result = await host.runtime.js(args.code, {
        ...args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs },
        ...args.title === undefined ? {} : { title: args.title },
      })
      const images = result.blocks.filter((block): block is CellImageBlock => block.kind === 'image')
      const { refs, refusal } = await commitImages(host, images, exec)
      return forToolContract({
        status: result.status,
        durationMs: result.durationMs,
        blocks: toToolBlocks(result.blocks, refs, refusal),
        ...result.error === undefined ? {} : { error: { name: result.error.name, message: result.error.message } },
      })
    },
  })

  const resetTool = defineTool({
    name: NODE_REPL_TOOL_NAMES[1],
    description: JS_RESET_TOOL_DESCRIPTION,
    parameters: RESET_PARAMETERS,
    output: cellOutput,
    async execute(_args: Record<string, never>, _exec: ToolRunContext) {
      await host.runtime.jsReset()
      return forToolContract({
        status: 'ok',
        durationMs: 0,
        blocks: [{ kind: 'text', text: 'kernel reset; capabilities re-installed' }],
      })
    },
  })

  return [jsTool, resetTool] as const
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Supplied by a bootstrap plugin; this adapter only consumes it. */
    nodeReplRuntime: CapabilityRuntime
  }
}

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'node-repl-runtime-adapter-dsh'

/**
 * Waits for the tool runtime and for a runtime supplied by a bootstrap plugin.
 *
 * The adapter deliberately does not create the runtime itself: which MCP servers to
 * attach, and with which host-owned arguments, is a composition decision. The attachment
 * store and LLM service are a different case — they are optional, so they are read per
 * call instead of being waited for.
 */
export const inject = ['tools', 'nodeReplRuntime'] as const

/** Register exactly `js` and `js_reset`. */
export function apply(ctx: Context): void {
  const definitions = createNodeReplTools({
    runtime: ctx.nodeReplRuntime,
    attachments: () => ctx.get('attachments'),
    llm: () => ctx.get('llm'),
  })
  const disposers = definitions.map(definition => ctx.tools.register(definition))
  ctx.effect(() => () => {
    for (const dispose of disposers.reverse()) dispose()
  }, 'node-repl-runtime-adapter-dsh: unregister the two-tool face')
}
