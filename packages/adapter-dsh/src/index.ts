/**
 * The model-visible face: exactly two tools.
 *
 * This is the DSH side of the design. `js` and `js_reset` are the whole surface no
 * matter how many MCP servers are attached, which is what makes the tool-declaration
 * cost independent of how much is behind it — the same property node_repl gets from
 * exposing one `js` tool.
 *
 * Kept framework-agnostic on purpose: `createNodeReplTools` returns plain definitions
 * so it can be tested without a host, and the Cordis plugin below only wires them up.
 */

import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type { CapabilityRuntime, JsCellResult } from '@lyd123qw2008/node-repl-runtime'
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
 * Cell outcome as the model sees it, flattened so nothing needs a second call.
 *
 * A type alias, not an interface: the tool contract wants a JSON value, and only type
 * aliases get the implicit index signature that satisfies it.
 */
type JsToolValue = {
  readonly status: string
  readonly durationMs: number
  readonly output: string
  readonly error?: { readonly name: string; readonly message: string }
}

function cellValue(result: JsCellResult): JsToolValue {
  return {
    status: result.status,
    durationMs: result.durationMs,
    output: result.output,
    ...result.error === undefined ? {} : { error: { name: result.error.name, message: result.error.message } },
  }
}

/**
 * Formatted as plain text rather than `JSON.stringify`: the whole point of a REPL is
 * that what the cell wrote comes back readable, with real newlines.
 */
const cellOutput = {
  schema: { type: 'json' } as const,
  render(_args: unknown, value: unknown) {
    const cell = value as JsToolValue
    const header = cell.status === 'ok'
      ? `ok (${cell.durationMs}ms)`
      : `${cell.status} (${cell.durationMs}ms)${cell.error === undefined ? '' : `: ${cell.error.name}: ${cell.error.message}`}`
    const body = (cell.output ?? '').trim()
    return [{ type: 'text' as const, text: body === '' ? header : `${header}\n${body}` }]
  },
}

export interface NodeReplToolHost {
  readonly runtime: CapabilityRuntime
}

/** Build the two tool definitions over a runtime. */
export function createNodeReplTools(host: NodeReplToolHost) {
  const jsTool = defineTool({
    name: NODE_REPL_TOOL_NAMES[0],
    description: JS_TOOL_DESCRIPTION,
    parameters: JS_PARAMETERS,
    output: cellOutput,
    async execute(
      args: { code: string; timeoutMs?: number; title?: string },
      _exec: ToolRunContext,
    ): Promise<JsToolValue> {
      const result = await host.runtime.js(args.code, {
        ...args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs },
        ...args.title === undefined ? {} : { title: args.title },
      })
      return cellValue(result)
    },
  })

  const resetTool = defineTool({
    name: NODE_REPL_TOOL_NAMES[1],
    description: JS_RESET_TOOL_DESCRIPTION,
    parameters: RESET_PARAMETERS,
    output: cellOutput,
    async execute(_args: Record<string, never>, _exec: ToolRunContext): Promise<JsToolValue> {
      await host.runtime.jsReset()
      return { status: 'ok', durationMs: 0, output: 'kernel reset; capabilities re-installed' }
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
 * attach, and with which host-owned arguments, is a composition decision.
 */
export const inject = ['tools', 'nodeReplRuntime'] as const

/** Register exactly `js` and `js_reset`. */
export function apply(ctx: Context): void {
  const definitions = createNodeReplTools({ runtime: ctx.nodeReplRuntime })
  const disposers = definitions.map(definition => ctx.tools.register(definition))
  ctx.effect(() => () => {
    for (const dispose of disposers.reverse()) dispose()
  }, 'node-repl-runtime-adapter-dsh: unregister the two-tool face')
}
