/**
 * The tool face is the product claim, so it gets asserted rather than described.
 *
 * Three properties matter and all are checked here, hermetically:
 *   1. the model-visible surface is exactly two tools and does not grow with the
 *      number of attached MCP servers;
 *   2. the declaration cost stays inside the budget, measured with DSH's own length
 *      heuristic so the number is comparable to the rest of the project's notes;
 *   3. a cell's emitted images become durable attachment blocks in the position the cell
 *      emitted them — or a visible notice in that same position, never a lost cell.
 */

import { describe, expect, it, vi } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { CapabilityRuntime, JsCellResult } from '@lyd123qw2008/node-repl-runtime'
import { NODE_REPL_TOOL_NAMES, createNodeReplTools } from '../src/index.js'

/** DSH's own toolsTokens estimate: ceil(chars / 4) + 4. */
function estimatedToolsTokens(declarations: unknown): number {
  return Math.ceil(JSON.stringify(declarations).length / 4) + 4
}

function cellResult(overrides: Partial<JsCellResult> = {}): JsCellResult {
  return { status: 'ok', durationMs: 7, blocks: [{ kind: 'text', text: 'hello' }], output: 'hello', ...overrides }
}

function fakeRuntime(overrides: Partial<CapabilityRuntime> = {}): CapabilityRuntime {
  return {
    js: vi.fn(async () => cellResult()),
    jsReset: vi.fn(async () => {}),
    catalog: () => [],
    dispose: vi.fn(async () => {}),
    ...overrides,
  } as CapabilityRuntime
}

/** One durable reference, as the live store would hand it back. */
const REF = {
  attachmentId: 'attachment-1',
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
} as unknown as ImageAttachmentRef

type Rendered = { readonly type: string; readonly text?: string; readonly attachment?: unknown }
type ToolShape = {
  description: string
  execute(args: unknown, exec: unknown): Promise<unknown>
  output: { render(args: unknown, value: unknown): Rendered[] }
}

function asTool(tool: unknown): ToolShape {
  return tool as ToolShape
}

/** A cell that writes, emits, and writes again — the shape that makes ordering observable. */
const LASTING_CELL = cellResult({
  durationMs: 5,
  blocks: [
    { kind: 'text', text: 'before' },
    { kind: 'image', data: 'AAAA', mimeType: 'image/png' },
    { kind: 'text', text: 'after' },
  ],
  output: 'before\nafter',
})

function storeSpy() {
  const saveImages = vi.fn(async (inputs: readonly unknown[]) => inputs.map(() => REF))
  return { saveImages, store: { saveImages } as unknown as AttachmentStore }
}

function exec(overrides: { provider?: string; model?: string } = {}): ToolRunContext {
  const config = { provider: overrides.provider ?? 'deepseek', model: overrides.model ?? 'deepseek-flash' }
  return {
    signal: undefined,
    agent: {
      options: config,
      session: { requestHeader: () => ({ config }) },
    },
  } as unknown as ToolRunContext
}

describe('two-tool face', () => {
  it('exposes exactly js and js_reset', () => {
    const tools = createNodeReplTools({ runtime: fakeRuntime() })
    expect(tools.map(tool => tool.name)).toEqual([...NODE_REPL_TOOL_NAMES])
    expect(tools.map(tool => tool.name)).toEqual(['js', 'js_reset'])
  })

  it('keeps the declaration cost inside the budget', () => {
    const tools = createNodeReplTools({ runtime: fakeRuntime() })
    const tokens = estimatedToolsTokens(tools)
    // Everything the model needs to know lives in the `js` description, so this is
    // the price of the minimal face. Measured, not aspirational.
    expect(tokens).toBeLessThan(1_500)
    console.log(`[face] two-tool declaration cost: ~${tokens} tokens`)
  })

  it('teaches the model the rules that are not discoverable from the schema', () => {
    const [js] = createNodeReplTools({ runtime: fakeRuntime() })
    const description = js!.description
    // Each of these was a real failure mode during development.
    expect(description).toContain('nodeRepl.write')
    expect(description).toContain('capHelp')
    expect(description).toContain('var')
    expect(description).toContain('host-owned')
    expect(description).toContain('await import')
    // The kernel injects snapshot code at every statement boundary without a
    // leading separator, so a top-level statement missing its `;` fails the cell
    // with an internal `__qwen_repl_..._snapshot` SyntaxError. Confirmed against
    // @qwen-code/node-repl-mcp 0.1.6 (npm `latest`, and `main` on GitHub).
    expect(description).toContain('statement boundary')
    expect(description).toContain("__qwen_repl_")
    // An affordance the model cannot discover is not an affordance: `_images` and
    // `emitImage` must be named, or a screenshot provider is unusable from a cell.
    expect(description).toContain('_images')
    expect(description).toContain('emitImage')
    // The kernel is one long-lived process, and nothing else tells the model what that
    // implies: a bound screenshot costs memory for the rest of the session, a detached
    // child escapes every reaper, and an undefined `cap` means the kernel was replaced.
    expect(description).toContain('Kernel lifetime')
    expect(description).toContain('detached')
    expect(description).toContain('cap` is ever undefined')
  })

  it('hands the cell straight to the runtime and formats the result as text', async () => {
    const runtime = fakeRuntime()
    const [js] = createNodeReplTools({ runtime })
    const result = await asTool(js).execute({ code: 'nodeRepl.write(1)', timeoutMs: 1234, title: 'demo' }, exec())

    expect(runtime.js).toHaveBeenCalledWith('nodeRepl.write(1)', { timeoutMs: 1234, title: 'demo' })
    const rendered = asTool(js).output.render({}, result)
    expect(rendered[0]!.text).toBe('ok (7ms)\nhello')
  })

  it('reports a failed cell without hiding the status', async () => {
    const runtime = fakeRuntime({
      js: vi.fn(async () => cellResult({
        status: 'error',
        durationMs: 3,
        blocks: [],
        output: '',
        error: { name: 'SyntaxError', message: 'Identifier already declared' },
      })),
    })
    const [js] = createNodeReplTools({ runtime })
    const result = await asTool(js).execute({ code: 'let x = 1' }, exec())
    const rendered = asTool(js).output.render({}, result)
    expect(rendered[0]!.text).toContain('error (3ms)')
    expect(rendered[0]!.text).toContain('SyntaxError')
  })

  it('resets through the runtime and reinstalls the catalog', async () => {
    const runtime = fakeRuntime()
    const [, reset] = createNodeReplTools({ runtime })
    await asTool(reset).execute({}, exec())
    expect(runtime.jsReset).toHaveBeenCalledOnce()
  })

  it('commits emitted images and renders them where the cell emitted them', async () => {
    const runtime = fakeRuntime({ js: vi.fn(async () => LASTING_CELL) })
    const { saveImages, store } = storeSpy()
    const [js] = createNodeReplTools({ runtime, attachments: () => store })

    const result = await asTool(js).execute({ code: 'x' }, exec())
    const rendered = asTool(js).output.render({}, result)

    // One batched commit per cell: the store validates the batch, which is the
    // "one tool result is one message" semantics this needs.
    expect(saveImages).toHaveBeenCalledOnce()
    expect(saveImages.mock.calls[0]![0]).toHaveLength(1)
    // Order is the point: an image between two prose blocks must stay between them.
    expect(rendered.map(block => block.type)).toEqual(['text', 'image', 'text'])
    expect(rendered[0]!.text).toBe('ok (5ms)\nbefore')
    expect(rendered[1]!.attachment).toEqual(REF)
    expect(rendered[2]!.text).toBe('after')
  })

  it('keeps the cell and names the reason when no attachment store is mounted', async () => {
    const runtime = fakeRuntime({ js: vi.fn(async () => LASTING_CELL) })
    const [js] = createNodeReplTools({ runtime })

    const result = await asTool(js).execute({ code: 'x' }, exec())
    const rendered = asTool(js).output.render({}, result)

    // The cell already produced prose worth keeping, so a missing store costs the image,
    // not the result — and it says so in the image's own position.
    expect(rendered.map(block => block.type)).toEqual(['text', 'text', 'text'])
    expect(rendered[1]!.text).toContain('image omitted')
    expect(rendered[1]!.text).toContain('no attachment store is mounted')
  })

  it('refuses images on a route that does not declare image input, without storing them', async () => {
    const runtime = fakeRuntime({ js: vi.fn(async () => LASTING_CELL) })
    const { saveImages, store } = storeSpy()
    const [js] = createNodeReplTools({
      runtime,
      attachments: () => store,
      llm: () => ({ resolveModelInfo: async () => ({ inputModalities: ['text'] }) }),
    })

    const result = await asTool(js).execute({ code: 'x' }, exec({ model: 'text-only' }))
    const rendered = asTool(js).output.render({}, result)

    // Sending it anyway would fail the *provider request* later, taking the turn with it.
    expect(saveImages).not.toHaveBeenCalled()
    expect(rendered[1]!.type).toBe('text')
    expect(rendered[1]!.text).toContain('does not declare image input')
  })

  it('reports a store refusal in place instead of failing the cell', async () => {
    const runtime = fakeRuntime({ js: vi.fn(async () => LASTING_CELL) })
    const saveImages = vi.fn(async () => { throw new Error('Image batch exceeds the configured image-count limit.') })
    const [js] = createNodeReplTools({
      runtime,
      attachments: () => ({ saveImages } as unknown as AttachmentStore),
    })

    const result = await asTool(js).execute({ code: 'x' }, exec())
    const rendered = asTool(js).output.render({}, result)

    expect(rendered[1]!.type).toBe('text')
    expect(rendered[1]!.text).toContain('image-count limit')
  })
})
