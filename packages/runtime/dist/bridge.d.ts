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
 *
 * Three request kinds, and the third is what keeps a long-lived kernel honest:
 *
 *   - `call` — one MCP call, plus a catalog *if the call had to rebuild its session*;
 *   - `catalog` — the live catalog and health, for `cap.refresh()` (discovery is answered
 *     from the kernel's own snapshot otherwise, so exploring the surface costs no round trip);
 *   - `reconnect` — re-open one provider's session, optionally against a new endpoint.
 *
 * The catalog rides on a call reply rather than being pushed at the kernel: the kernel has
 * one socket and asks for nothing it did not ask for, and a session that was rebuilt is
 * exactly the moment its stale operation list would otherwise start lying.
 */
import type { InFlightCall, ProviderConnection, UnattachedProvider } from './types.js';
export interface BridgeOptions {
    /**
     * Providers that are configured but not attached, in both shapes the payload needs.
     *
     * A reader rather than a snapshot: whether a provider is attached changes while this bridge
     * lives, and a list captured at startup would be exactly the stale answer this bridge exists
     * to avoid. One hook rather than two so the failure and its health cannot disagree.
     */
    readonly unattached?: () => readonly UnattachedProvider[];
    /**
     * Connect a configured provider that is not attached, by id.
     *
     * The half of recovery a restart used to be needed for: when the host starts before its MCP
     * server does (an IDE still closed), nothing else can bring that provider in — the connection
     * that a reconnect would re-open never existed. `url` is the same endpoint override a
     * reconnect takes, applied to the first connect instead.
     */
    readonly attach?: (id: string, url?: string) => Promise<ProviderConnection>;
}
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
    /**
     * The provider calls still waiting for an answer, oldest first, with how long each has run.
     *
     * Asked for *before* abandoning them: a cell that ran out of budget while a build was in flight
     * should say so, and after `abandonInFlight` there is nothing left to ask.
     */
    inFlightCalls(): readonly InFlightCall[];
    close(): Promise<void>;
}
export declare function startBridge(providers: ReadonlyMap<string, ProviderConnection>, options?: BridgeOptions): Promise<Bridge>;
//# sourceMappingURL=bridge.d.ts.map