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
import type { JsCellResult, JsOptions, InFlightCall, ProviderConnection, ProviderFailure } from './types.js';
/**
 * What a cell that lost its kernel is told about the catalog.
 *
 * The failure branch is the point. `crashed` already says the cell died, but a catalog that
 * could not be put back leaves every later cell answering `cap is not defined` with no
 * explanation — and the previous version of this code swallowed exactly that error, which is
 * the one case where saying nothing costs the most. Exported because the notice is a pure
 * function of the failure, like the other projections this runtime asserts directly.
 */
export declare function catalogRecoveryNotice(failure: string | undefined): string;
/**
 * What a cell that ended with provider calls still in flight is told about them.
 *
 * Two facts, because both are needed to act: which call was cut off and how long it had been
 * running. A budget ending is then distinguishable from a hung tool, and the fix — a larger
 * `timeoutMs` — is stated where the model reads it rather than left in a document. The caution is
 * not boilerplate: a cancelled call may already have caused part of its side effect, so a blind
 * re-run of a deploy or a command that writes files is the one retry that can make things worse.
 */
export declare function abandonedCallsNotice(calls: readonly InFlightCall[], status: JsCellResult['status'], budgetMs: number): string | undefined;
/**
 * What a host cancellation says in the result.
 *
 * Not the same message as a spent budget: there is nothing to retry differently and no larger
 * `timeoutMs` to suggest, because the person asked for the cell to stop. What a reader needs is
 * who stopped it, what happened to the state, and which provider calls were cut off.
 *
 * The rollback is the kernel's own behaviour and worth naming: `kernel.mjs` restores the bindings
 * captured at cell entry, so everything the cancelled cell assigned is gone while earlier bindings
 * keep their values. A model that does not know this will read a later `undefined` as a bug.
 */
export declare function hostCancelledNotice(calls: readonly InFlightCall[]): string;
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
    /** Providers that did not attach, so the kernel's help can explain what is missing. */
    failures: readonly ProviderFailure[];
    entry: string;
    defaultTimeoutMs: number;
    /** Node-mode executable for the kernel child. Defaults to {@link resolveKernelCommand}. */
    command?: string;
}): Promise<KernelSession>;
export {};
//# sourceMappingURL=kernel.d.ts.map