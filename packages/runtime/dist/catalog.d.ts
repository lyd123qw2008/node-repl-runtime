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
import type { McpProviderSpec, ProjectedOperation, ProviderConnection } from './types.js';
interface ListedTool {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema?: {
        readonly properties?: Record<string, unknown>;
        readonly required?: readonly string[];
    };
    readonly outputSchema?: Record<string, unknown>;
    readonly annotations?: {
        readonly readOnlyHint?: unknown;
    };
}
/** Project one advertised tool into a model-visible operation. */
export declare function projectOperation(tool: ListedTool, spec: McpProviderSpec): ProjectedOperation;
/** Exposure narrowing, when the operator asked for it. */
export declare function selectTools(tools: readonly ListedTool[], spec: McpProviderSpec): readonly ListedTool[];
/**
 * Merge host-owned arguments into a call, refusing caller-supplied ones.
 *
 * Refusing (rather than overwriting) is deliberate: which project, account or
 * workspace to act on is a host decision, and a cell that tries to redirect it
 * should get an error it can see, not a silently ignored argument.
 */
export declare function applyInjection(injected: Readonly<Record<string, unknown>>, args: Readonly<Record<string, unknown>>): Record<string, unknown>;
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
export declare const PROVIDER_IMAGE_MAX_BYTES: number;
export declare const PROVIDER_IMAGE_TOTAL_MAX_BYTES: number;
/** One admitted image, in the shape the kernel's `ImageMessage` uses. */
export interface ProviderImage {
    readonly mimeType: string;
    /** Base64, exactly as the server sent it. */
    readonly data: string;
}
export interface ProviderImages {
    readonly images: readonly ProviderImage[];
    /** Images the server sent that admission refused. Never silent: see `mergeProviderImages`. */
    readonly dropped: number;
}
/**
 * Admit the image blocks of one MCP result.
 *
 * Exported for tests, like the other pure projections here: it is a function of the
 * server's reply alone, so it can be asserted without a server.
 */
export declare function collectProviderImages(content: unknown): ProviderImages;
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
export declare function mergeProviderImages(value: unknown, collected: ProviderImages): unknown;
/** Open one MCP session. Nothing is cached or persisted: the surface is live. */
export declare function connectMcpProvider(spec: McpProviderSpec): Promise<ProviderConnection>;
export {};
//# sourceMappingURL=catalog.d.ts.map