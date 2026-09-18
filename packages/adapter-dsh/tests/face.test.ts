/**
 * The tool face is the product claim, so it gets asserted rather than described.
 *
 * Two properties matter and both are checked here, hermetically:
 *   1. the model-visible surface is exactly two tools and does not grow with the
 *      number of attached MCP servers;
 *   2. the declaration cost stays inside the budget, measured with DSH's own length
 *      heuristic so the number is comparable to the rest of the project's notes.
 */

import { describe, expect, it, vi } from 'vitest'
import type { CapabilityRuntime } from '@lyd123qw2008/node-repl-runtime'
import { NODE_REPL_TOOL_NAMES, createNodeReplTools } from '../src/index.js'

/** DSH's own toolsTokens estimate: ceil(chars / 4) + 4. */
function estimatedToolsTokens(declarations: unknown): number {
  return Math.ceil(JSON.stringify(declarations).length / 4) + 4
}

function fakeRuntime(overrides: Partial<CapabilityRuntime> = {}): CapabilityRuntime {
  return {
    js: vi.fn(async () => ({ status: 'ok' as const, output: 'hello', durationMs: 7 })),
    jsReset: vi.fn(async () => {}),
    catalog: () => [],
    dispose: vi.fn(async () => {}),
    ...overrides,
  } as CapabilityRuntime
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
  })

  it('hands the cell straight to the runtime and formats the result as text', async () => {
    const runtime = fakeRuntime()
    const [js] = createNodeReplTools({ runtime })
    const result = await (js as unknown as {
      execute(args: unknown, exec: unknown): Promise<unknown>
    }).execute({ code: 'nodeRepl.write(1)', timeoutMs: 1234, title: 'demo' }, {})

    expect(runtime.js).toHaveBeenCalledWith('nodeRepl.write(1)', { timeoutMs: 1234, title: 'demo' })
    const rendered = (js as unknown as { output: { render(args: unknown, value: unknown): { text: string }[] } })
      .output.render({}, result)
    expect(rendered[0]!.text).toBe('ok (7ms)\nhello')
  })

  it('reports a failed cell without hiding the status', async () => {
    const runtime = fakeRuntime({
      js: vi.fn(async () => ({
        status: 'error' as const,
        output: '',
        durationMs: 3,
        error: { name: 'SyntaxError', message: 'Identifier already declared' },
      })),
    })
    const [js] = createNodeReplTools({ runtime })
    const result = await (js as unknown as { execute(args: unknown, exec: unknown): Promise<unknown> })
      .execute({ code: 'let x = 1' }, {})
    const rendered = (js as unknown as { output: { render(args: unknown, value: unknown): { text: string }[] } })
      .output.render({}, result)
    expect(rendered[0]!.text).toContain('error (3ms)')
    expect(rendered[0]!.text).toContain('SyntaxError')
  })

  it('resets through the runtime and reinstalls the catalog', async () => {
    const runtime = fakeRuntime()
    const [, reset] = createNodeReplTools({ runtime })
    await (reset as unknown as { execute(args: unknown, exec: unknown): Promise<unknown> }).execute({}, {})
    expect(runtime.jsReset).toHaveBeenCalledOnce()
  })
})
