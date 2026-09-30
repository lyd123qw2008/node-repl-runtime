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
import type { CatalogEntry, McpProviderSpec, ProjectedOperation, ProviderConnection, ProviderHealth } from './types.js';
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
/**
 * How a failed call relates to the session, and whether a retry can be proved free of side effects.
 *
 * `never-ran` is the safe case: the server rejected the request (a session it does not know) or the
 * transport was gone before anything was sent, so the tool cannot have executed. `maybe-ran` is the
 * honest case: the connection failed with the request in flight, which says nothing about whether
 * the server started the tool — retrying one of those is a decision, not a repair, and `call()`
 * makes it per operation (read-only retries, mutations do not).
 */
export type SessionLossKind = 'never-ran' | 'maybe-ran';
/**
 * Classify an error as a lost session, if that is what it is.
 *
 * Measured against SDK 2.0, because the obvious reading is wrong in two places.
 *
 * First, the streamable-HTTP transport reports *every* non-OK POST as the same `SdkHttpError` code
 * (`CLIENT_HTTP_NOT_IMPLEMENTED`), so the code says nothing and the HTTP status is the only signal.
 * The MCP spec has a server answer `404` for a session it does not know, and that is exactly what
 * IDEA does after a restart — "Streamable HTTP session not found", with the call rejected rather
 * than run.
 *
 * Second, the SDK's *request* path rejects a dead transport with a plain
 * `new Error("Not connected")` — no `code` at all (dist/src-D_zzAWoS.mjs:6063,
 * `_requestWithSchemaViaCodec`); only its notification path uses `SdkErrorCode.NotConnected`
 * (…:6181). Matching that message is therefore the only way to see the shape, and it is the shape
 * that matters most for stdio: when a child exits, the transport's own `close` handler clears the
 * client's transport, so the *next* call takes exactly this path — a provider dead until the host
 * restarts unless it is classified here.
 */
export declare function classifySessionLoss(error: unknown): SessionLossKind | undefined;
/**
 * Whether an error means the session the client is holding is gone.
 *
 * A tool that failed *on the server* is deliberately not in this set: it answers with a result, not
 * with a transport error, and retrying it would repeat a side effect.
 */
export declare function isSessionLoss(error: unknown): boolean;
/**
 * One line about a provider failure, bounded.
 *
 * The SDK builds its HTTP error message out of the whole response body — `Error POSTing to
 * endpoint: ${body}` — with no cap (dist/index.mjs:5360,5382). Relayed verbatim, a proxy or a
 * gateway answering with an HTML page would arrive as kilobytes: into the kernel's heap, and from
 * there into the model's context. The cut is marked, because a reader has to know the message is
 * not the whole story.
 */
export declare function describeProviderError(error: unknown): string;
/**
 * The catalog as the kernel receives it.
 *
 * One builder for both directions — the snapshot written before the kernel starts, and the
 * refresh that follows a rebuilt session — because a drift between them would be invisible
 * until a restart, which is precisely the class of bug this file just grew a fix for.
 */
export declare function catalogEntries(providers: Iterable<ProviderConnection>): readonly CatalogEntry[];
/**
 * Health for a connection, including one that owns no session.
 *
 * A connection without a `session` is not unhealthy — it simply has nothing to re-open, and
 * `reconnectable: false` is how a caller can tell that apart from a provider whose session is
 * currently down. Reporting it at all (rather than omitting it) keeps `cap.status()` a complete
 * picture of the catalog, which is what makes an absence explicable.
 */
export declare function providerHealth(provider: ProviderConnection): ProviderHealth;
/**
 * Health for a provider that is configured but not attached.
 *
 * Synthesized from the spec rather than from a connection, because there is no connection —
 * that is the whole point. It is what lets `cap.status()` answer "where is idea?" with a reason
 * instead of an absence, and `reconnectable: true` is a promise the attach path has to keep.
 */
export declare function unattachedHealth(spec: McpProviderSpec, error: string): ProviderHealth;
/** Open one MCP session, with the recovery a long-lived host needs. Nothing is persisted. */
export declare function connectMcpProvider(spec: McpProviderSpec): Promise<ProviderConnection>;
export {};
//# sourceMappingURL=catalog.d.ts.map