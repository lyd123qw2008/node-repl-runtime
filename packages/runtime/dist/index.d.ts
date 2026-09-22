/**
 * The runtime facade: two operations, and that is the point.
 *
 * `js` runs a cell in one persistent kernel; `js_reset` clears it. Everything else a
 * model needs — discovering capabilities, calling them, processing results — happens
 * *inside* the cell, which is what keeps the model-visible tool surface at two
 * declarations no matter how many MCP servers are attached.
 */
import type { JsCellResult, JsOptions, McpProviderSpec, ProviderConnection, ProviderFailure, RuntimeOptions } from './types.js';
export * from './types.js';
export { applyInjection, projectOperation, selectTools, connectMcpProvider } from './catalog.js';
export { collectProviderImages, mergeProviderImages, PROVIDER_IMAGE_MAX_BYTES, PROVIDER_IMAGE_TOTAL_MAX_BYTES, type ProviderImage, type ProviderImages, } from './catalog.js';
/** The reused kernel server. Its package entry point *is* the MCP server. */
export declare const KERNEL_PACKAGE = "@qwen-code/node-repl-mcp";
export interface CapabilityRuntime {
    /** Run one JavaScript cell in the persistent kernel. */
    js(code: string, options?: JsOptions): Promise<JsCellResult>;
    /** Discard the kernel's bindings. */
    jsReset(): Promise<void>;
    /** The projected catalog, for host-side reporting (not a model-facing tool). */
    catalog(): readonly ProviderConnection[];
    /**
     * Providers that could not be attached, with their reasons.
     *
     * Separate from `catalog()` because they are not capabilities: nothing can be called on
     * them. They ride into the kernel's config snapshot so `capHelp()` can explain an absence
     * instead of only listing presences.
     */
    failures(): readonly ProviderFailure[];
    dispose(): Promise<void>;
}
export declare function createCapabilityRuntime(options: RuntimeOptions): Promise<CapabilityRuntime>;
/** Human-readable connection report: what attached, and what did not with its reason. */
export declare function describeProviders(providers: readonly ProviderConnection[], failures?: readonly ProviderFailure[]): string;
export type { McpProviderSpec, ProviderConnection, JsCellResult, JsOptions };
//# sourceMappingURL=index.d.ts.map