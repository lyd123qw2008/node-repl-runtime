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
import type { Context } from '@deepseek-ai/cordis';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { CapabilityRuntime } from '@lyd123qw2008/node-repl-runtime';
export * from './descriptions.js';
/** Names are fixed: the model surface must not vary with what is attached. */
export declare const NODE_REPL_TOOL_NAMES: readonly ["js", "js_reset"];
/**
 * The one method this face needs from DSH's LLM service.
 *
 * Structural rather than imported: naming only what is called keeps a capability probe
 * from pinning a second DSH package into the type graph, and the real service is
 * assignable to it.
 */
export interface ImageCapabilityProbe {
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{
        readonly inputModalities?: readonly string[];
    }>;
}
export interface NodeReplToolHost {
    readonly runtime: CapabilityRuntime;
    /**
     * DSH's attachment store, resolved per call.
     *
     * A function, not a value: this face must register whether or not a store is mounted,
     * and the store may mount after it does. `read_image` solves the same ordering problem by
     * making its registration conditional; a two-tool face cannot, because text-only cells
     * must keep working with no store at all.
     */
    readonly attachments?: () => AttachmentStore | undefined;
    /** DSH's LLM service, resolved per call, used only to check that the route accepts images. */
    readonly llm?: () => ImageCapabilityProbe | undefined;
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
 * attach, and with which host-owned arguments, is a composition decision. The attachment
 * store and LLM service are a different case — they are optional, so they are read per
 * call instead of being waited for.
 */
export declare const inject: readonly ["tools", "nodeReplRuntime"];
/** Register exactly `js` and `js_reset`. */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map