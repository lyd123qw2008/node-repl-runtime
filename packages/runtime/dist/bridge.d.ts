/**
 * The host side of the capability bridge.
 *
 * The kernel cannot reach MCP servers directly, and should not: keeping the call on
 * the host is what lets host-owned arguments be injected and caller-supplied ones be
 * refused. So the kernel talks back over loopback TCP with a per-run token, and this
 * server turns `{provider.operation, args}` into an MCP call.
 *
 * Loopback + random port + random token, because this channel is only reachable from
 * the kernel child process we started. It is not a security boundary between mutually
 * distrusting parties and is not presented as one.
 */
import type { ProviderConnection } from './types.js';
export interface Bridge {
    readonly host: string;
    readonly port: number;
    readonly token: string;
    /**
     * Abort every provider call still waiting for an answer because the cell that asked
     * for it is gone.
     *
     * A cancelled cell cannot read its result, and a call left in flight does not merely
     * waste work: a provider that serializes requests per session — the browser bridge is
     * one — keeps that session's later calls queued behind it. Dropping the caller is not
     * enough; the request itself has to be abandoned. Aborting sends the MCP cancellation
     * notification, so a provider that supports cancellation can stop the work as well.
     */
    abandonInFlight(reason: string): void;
    close(): Promise<void>;
}
export declare function startBridge(providers: ReadonlyMap<string, ProviderConnection>): Promise<Bridge>;
//# sourceMappingURL=bridge.d.ts.map