/**
 * Own the reused node_repl kernel.
 *
 * The kernel itself is `@qwen-code/node-repl-mcp` (Apache-2.0), which already
 * implements the parts that are expensive to get right: a child-process Node kernel
 * with top-level await, bindings that persist and survive a throwing cell, module
 * roots, cancellation, reset, and the cell transform that makes re-declaration
 * semantics work. This package does not reimplement any of it — it starts that
 * kernel, hands it a capability catalog, and runs cells.
 *
 * What we add on top is exactly one thing: a scratch kernel root containing the
 * `nr-cap` bridge module, plus a config snapshot, so a cell can `await
 * import('nr-cap')` and reach the host's MCP catalog.
 *
 * Measured deviation worth knowing (see `docs/02-reuse-spike-results.zh-CN.md`):
 * this kernel rejects a second `let`/`const` for the same name with a SyntaxError,
 * while `var` may be re-declared. That is why the tool description tells the model
 * to prefer `var` for names it may redefine.
 */
import type { Bridge } from './bridge.js';
import type { JsCellResult, JsOptions, ProviderConnection } from './types.js';
/**
 * Where the kernel child lives. Kept scratch: it holds a generated config, not user data.
 *
 * The name is a UUID rather than a timestamp: two runtimes created in the same
 * millisecond would otherwise share a directory, and one runtime's cleanup would delete
 * the other's kernel root mid-run.
 */
export declare function createKernelRoot(): string;
interface KernelSession {
    run(code: string, options?: JsOptions): Promise<JsCellResult>;
    reset(): Promise<void>;
    close(): Promise<void>;
}
export declare function startKernel(options: {
    root: string;
    bridge: Bridge;
    providers: ReadonlyMap<string, ProviderConnection>;
    entry: string;
    defaultTimeoutMs: number;
}): Promise<KernelSession>;
export {};
//# sourceMappingURL=kernel.d.ts.map