/**
 * Own the reused node_repl kernel.
 *
 * The kernel engine is maintained in `@lyd123qw2008/node-repl-kernel-engine`,
 * derived from Qwen's Apache-2.0 `0.1.6` source snapshot. It supplies a child-process
 * Node kernel with top-level await, persistent bindings, module roots, cancellation,
 * reset, and the cell transform. This runtime starts its compatibility MCP entry,
 * hands it a capability catalog, and runs cells; custom cell semantics are maintained
 * in the owned kernel package.
 *
 * What we add on top is exactly one thing: a scratch kernel root containing the
 * `nr-cap` bridge module, plus a config snapshot, so a cell can `await
 * import('nr-cap')` and reach the host's MCP catalog.
 *
 * The owned cell transform permits cross-cell top-level redeclaration while
 * keeping references and earlier closures on the same live binding. Duplicate
 * lexical declarations in one cell remain JavaScript syntax errors; assigning to
 * a current `const` still throws. Cancellation restores the binding reference
 * state captured at cell entry.
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