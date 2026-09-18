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
/** Open one MCP session. Nothing is cached or persisted: the surface is live. */
export declare function connectMcpProvider(spec: McpProviderSpec): Promise<ProviderConnection>;
export {};
//# sourceMappingURL=catalog.d.ts.map