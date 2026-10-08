/**
 * The runtime facade: two operations, and that is the point.
 *
 * `js` runs a cell in one persistent kernel; `js_reset` clears it. Everything else a
 * model needs — discovering capabilities, calling them, processing results — happens
 * *inside* the cell, which is what keeps the model-visible tool surface at two
 * declarations no matter how many MCP servers are attached.
 */
import { fileURLToPath } from 'node:url';
import { startBridge } from './bridge.js';
import { connectMcpProvider, describeProviderError, unattachedHealth } from './catalog.js';
import { createKernelRoot, startKernel } from './kernel.js';
export * from './types.js';
export { applyInjection, catalogEntries, classifySessionLoss, connectMcpProvider, describeProviderError, isSessionLoss, projectOperation, providerHealth, selectTools, unattachedHealth, } from './catalog.js';
export { abandonedCallsNotice, catalogRecoveryNotice, hostCancelledNotice } from './kernel.js';
// Pure functions of one provider reply, so they are asserted directly instead of through a
// CONNECTED server — the same reason `projectOperation` and `selectTools` are exported.
export { collectProviderImages, mergeProviderImages, PROVIDER_IMAGE_MAX_BYTES, PROVIDER_IMAGE_TOTAL_MAX_BYTES, } from './catalog.js';
/** Our maintained Qwen-derived kernel package (MCP entry kept as a compatibility boundary). */
export const KERNEL_PACKAGE = '@lyd123qw2008/node-repl-kernel-engine';
/**
 * Resolve the kernel entry from wherever this package is installed.
 *
 * Uses the ESM resolver, not `createRequire`: the kernel package declares only
 * `types`/`import` conditions, so a `require`-side resolve fails with "No exports
 * main defined".
 */
function resolveKernelEntry() {
    return fileURLToPath(import.meta.resolve(KERNEL_PACKAGE));
}
export async function createCapabilityRuntime(options) {
    const connector = options.connector ?? connectMcpProvider;
    const providers = new Map();
    /**
     * Every configured provider that is *not* attached, keyed by id, with its spec and latest
     * reason.
     *
     * A map rather than an array because attaching replaces the reason rather than adding a second
     * one: "it failed at startup" and "it failed again just now" are one fact that has changed. The
     * spec is kept here because it is the only thing that makes a later attach possible at all.
     */
    const unattached = new Map();
    /**
     * Providers the operator switched off.
     *
     * Tracked separately from `unattached` and never attachable: "disabled" means the server must
     * not be started, so a reconnect that started it anyway would be the runtime overruling the
     * person who wrote the profile.
     */
    const disabled = new Set();
    /** Attach attempts in flight, so concurrent callers share one connection instead of racing. */
    const attaching = new Map();
    const connect = async (spec) => {
        const connection = await connector(spec);
        providers.set(spec.id, connection);
        unattached.delete(spec.id);
        return connection;
    };
    const attach = async (id, url) => {
        const pending = attaching.get(id);
        if (pending !== undefined)
            return pending;
        const entry = unattached.get(id);
        if (entry === undefined) {
            throw new Error(disabled.has(id)
                ? `provider ${id} is configured with disabled: true`
                : `unknown provider ${id}`);
        }
        // The endpoint override is applied to the *first* connect rather than followed by a second
        // one: an IDE that came back on a different port needs exactly one session, not two.
        const spec = url === undefined ? entry.spec : { ...entry.spec, url };
        const attempt = connect(spec)
            .catch((error) => {
            const message = describeProviderError(error);
            unattached.set(id, { spec: entry.spec, error: message });
            console.warn(`[node-repl-runtime] provider ${id} could not be attached: ${message}`);
            throw error;
        })
            .finally(() => { attaching.delete(id); });
        attaching.set(id, attempt);
        return attempt;
    };
    /**
     * Attach every enabled provider, concurrently.
     *
     * Concurrency is the point: these are independent network handshakes, and doing them in a row
     * makes startup cost the *sum* of every server's latency. That is not hypothetical — a host
     * started while an IDE is still warming up used to wait out that IDE before it could answer
     * anything, even though two other servers were ready in milliseconds. A server that never
     * answers is bounded by the SDK's own request timeout rather than blocking forever.
     */
    await Promise.all(options.providers.map(async (spec) => {
        if (spec.disabled === true) {
            disabled.add(spec.id);
            return;
        }
        try {
            await connect(spec);
        }
        catch (error) {
            // Match the optional MCP-client startup policy: a provider that will not
            // connect contributes no capabilities, but it must not take the runtime
            // down. Other providers — including none — can still be used.
            const message = describeProviderError(error);
            unattached.set(spec.id, { spec, error: message });
            console.warn(`[node-repl-runtime] provider ${spec.id} failed to connect: ${message}`);
        }
    }));
    // An empty catalog is a valid runtime state. The face still provides js and
    // js_reset, while cap.list() simply reports no connected capabilities.
    /**
     * Failures in configured order, not in whichever order the servers answered.
     *
     * Now that connections overlap, insertion order into `unattached` is completion order, which
     * would make the kernel's snapshot — and `capHelp()` with it — reshuffle between runs of the
     * same configuration.
     */
    const configuredOrder = new Map(options.providers.map((spec, index) => [spec.id, index]));
    const unattachedProviders = () => [...unattached.values()]
        .sort((left, right) => (configuredOrder.get(left.spec.id) ?? 0) - (configuredOrder.get(right.spec.id) ?? 0))
        .map(entry => ({
        failure: { id: entry.spec.id, error: entry.error },
        health: unattachedHealth(entry.spec, entry.error),
    }));
    // Startup stages need their own error boundary. A bare transport error here otherwise looks
    // like a provider failure, even though the provider catalog may have connected successfully.
    let bridge;
    try {
        bridge = await startBridge(providers, { unattached: unattachedProviders, attach });
    }
    catch (error) {
        for (const provider of providers.values())
            await provider.close().catch(() => { });
        throw new Error(`capability bridge failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const root = options.kernelRoot ?? createKernelRoot();
    let kernel;
    try {
        kernel = await startKernel({
            root,
            bridge,
            providers,
            failures: unattachedProviders().map(entry => entry.failure),
            entry: options.kernelEntry ?? resolveKernelEntry(),
            defaultTimeoutMs: options.cellTimeoutMs ?? 30_000,
            ...options.kernelCommand === undefined ? {} : { command: options.kernelCommand },
        });
    }
    catch (error) {
        await bridge.close().catch(() => { });
        for (const provider of providers.values())
            await provider.close().catch(() => { });
        throw new Error(`kernel startup failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    let disposed = false;
    return {
        js: (code, runOptions) => kernel.run(code, runOptions),
        jsReset: () => kernel.reset(),
        catalog: () => [...providers.values()],
        failures: () => unattachedProviders().map(entry => entry.failure),
        async dispose() {
            if (disposed)
                return;
            disposed = true;
            await kernel.close().catch(() => { });
            await bridge.close().catch(() => { });
            for (const provider of providers.values())
                await provider.close().catch(() => { });
        },
    };
}
/** Human-readable connection report: what attached, and what did not with its reason. */
export function describeProviders(providers, failures = []) {
    return [
        ...providers.map(provider => `${provider.id} (${provider.label}) — ${provider.operations.length} operation(s)`),
        // The previous version of this comment claimed it included failures while the body did
        // not: exactly the silent-absence bug this change is about, in miniature.
        ...failures.map(failure => `${failure.id} — NOT ATTACHED: ${failure.error}`),
    ].join('\n');
}
//# sourceMappingURL=index.js.map