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
import type { Context } from '@deepseek-ai/cordis';
import type { CapabilityRuntime } from '@lyd123qw2008/node-repl-runtime';
export * from './descriptions.js';
/** Names are fixed: the model surface must not vary with what is attached. */
export declare const NODE_REPL_TOOL_NAMES: readonly ["js", "js_reset"];
export interface NodeReplToolHost {
    readonly runtime: CapabilityRuntime;
}
/** Build the two tool definitions over a runtime. */
export declare function createNodeReplTools(host: NodeReplToolHost): readonly [import("@deepseek-ai/dsh-tools").ToolDefinition, import("@deepseek-ai/dsh-tools").ToolDefinition];
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Supplied by a bootstrap plugin; this adapter only consumes it. */
        nodeReplRuntime: CapabilityRuntime;
    }
}
/** Cordis plugin name used by Loader diagnostics. */
export declare const name = "node-repl-runtime-adapter-dsh";
/**
 * Waits for the tool runtime and for a runtime supplied by a bootstrap plugin.
 *
 * The adapter deliberately does not create the runtime itself: which MCP servers to
 * attach, and with which host-owned arguments, is a composition decision.
 */
export declare const inject: readonly ["tools", "nodeReplRuntime"];
/** Register exactly `js` and `js_reset`. */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map