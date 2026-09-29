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
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { catalogEntries, providerHealth } from './catalog.js';
export async function startBridge(providers, options = {}) {
    const token = randomBytes(24).toString('hex');
    /** Provider calls currently running, keyed by the controller that can abort them. */
    const inFlight = new Map();
    const snapshot = () => {
        const unattached = options.unattached?.() ?? [];
        return {
            providers: catalogEntries(providers.values()),
            health: [
                ...[...providers.values()].map(providerHealth),
                // The ones that never attached, so `cap.status()` can answer "where is idea?" with the
                // reason instead of an absent row. Reported after the live providers: an absence is
                // information, but it is not the headline.
                ...unattached.map(entry => entry.health),
            ],
            failures: unattached.map(entry => entry.failure),
        };
    };
    /**
     * The session generation before and after a call, so a rebuild is observable from here.
     *
     * Read through `health()` rather than tracked with a callback: the reconnect happens inside
     * the provider's own `call`, and asking the connection afterwards is one comparison instead
     * of a notification path that every future connection would have to remember to fire.
     */
    const generation = (provider) => provider.session?.health().generation;
    const handle = async (request, controller) => {
        const id = request.id;
        const fail = (code, message, catalog) => ({
            id,
            ok: false,
            error: { code, message },
            ...catalog === undefined ? {} : { catalog },
        });
        if (request.token !== token)
            return fail('BRIDGE_UNAUTHORIZED', 'bad bridge token');
        if (request.kind === 'catalog')
            return { id, ok: true, value: snapshot() };
        if (request.kind === 'reconnect') {
            const target = String(request.name);
            const url = typeof request.url === 'string' && request.url.trim() !== '' ? request.url : undefined;
            const provider = providers.get(target);
            if (provider === undefined) {
                // Never attached in this process. One verb covers both halves of recovery: re-open what
                // exists, connect what does not — the caller's intent ("make this provider usable") is
                // the same, and the alternative is a second entry point a model has to choose between.
                if (options.attach === undefined)
                    return fail('UNKNOWN_PROVIDER', `unknown provider ${target}`);
                try {
                    // The endpoint override goes into the first connect: attaching and then re-opening to
                    // move it would open a second session the caller never needed.
                    await options.attach(target, url);
                }
                catch (error) {
                    return fail('MCP_ATTACH_FAILED', `provider ${target} is not attached and could not be connected: ${error instanceof Error ? error.message : String(error)}`, snapshot());
                }
                return { id, ok: true, value: snapshot() };
            }
            if (provider.session === undefined) {
                // Honest refusal: this connection owns no session, so there is nothing to re-open and
                // nothing to report. Succeeding here would be a lie a caller could act on.
                return fail('PROVIDER_NOT_RECONNECTABLE', `provider ${target} has no MCP session this runtime can re-open`);
            }
            try {
                await provider.session.reconnect(url === undefined ? {} : { url });
            }
            catch (error) {
                return fail('MCP_RECONNECT_FAILED', `provider ${target} could not be re-opened: ${error instanceof Error ? error.message : String(error)}`, snapshot());
            }
            return { id, ok: true, value: snapshot() };
        }
        if (request.kind !== 'call')
            return fail('BRIDGE_UNSUPPORTED', `unsupported kind ${String(request.kind)}`);
        const full = String(request.name);
        const separator = full.indexOf('.');
        if (separator <= 0)
            return fail('BRIDGE_BAD_NAME', `expected "provider.operation", got ${full}`);
        const provider = providers.get(full.slice(0, separator));
        if (provider === undefined)
            return fail('UNKNOWN_PROVIDER', `unknown provider ${full.slice(0, separator)}`);
        const operation = full.slice(separator + 1);
        if (!provider.operations.some(candidate => candidate.name === operation)) {
            return fail('UNKNOWN_OPERATION', `unknown operation ${full}`);
        }
        const before = generation(provider);
        const rebuilt = () => {
            const after = generation(provider);
            return before !== undefined && after !== before ? snapshot() : undefined;
        };
        const startedAt = Date.now();
        inFlight.set(controller, { name: full, startedAt, elapsedMs: 0 });
        try {
            const value = await provider.call(operation, (request.args ?? {}), controller.signal);
            const catalog = rebuilt();
            return { id, ok: true, value, ...catalog === undefined ? {} : { catalog } };
        }
        catch (error) {
            if (controller.signal.aborted) {
                return fail('BRIDGE_CALL_ABANDONED', `${full} was abandoned: ${String(controller.signal.reason ?? 'caller gone')}`);
            }
            // A failed call may still have rebuilt the session before failing: the catalog is
            // reported either way, or the kernel would keep a tool list from a dead session.
            return fail('MCP_CALL_FAILED', error instanceof Error ? error.message : String(error), rebuilt());
        }
        finally {
            inFlight.delete(controller);
        }
    };
    const server = createServer(socket => {
        socket.setEncoding('utf8');
        // Calls die with the socket that asked for them: if the kernel process goes away,
        // nothing can ever read those answers either.
        const socketCalls = new Set();
        socket.on('close', () => {
            for (const controller of socketCalls)
                controller.abort(new Error('bridge client disconnected'));
            socketCalls.clear();
        });
        let buffer = '';
        socket.on('data', chunk => {
            buffer += chunk;
            let index;
            while ((index = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 1);
                if (line.trim() === '')
                    continue;
                let parsed;
                try {
                    parsed = JSON.parse(line);
                }
                catch {
                    continue;
                }
                const controller = new AbortController();
                socketCalls.add(controller);
                void handle(parsed, controller)
                    .then(reply => socket.write(`${JSON.stringify(reply)}\n`))
                    .catch(() => { })
                    .finally(() => socketCalls.delete(controller));
            }
        });
        socket.on('error', () => { });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string')
        throw new Error('bridge failed to bind a TCP port');
    return {
        host: '127.0.0.1',
        port: address.port,
        token,
        abandonInFlight(reason) {
            const pending = [...inFlight.entries()];
            inFlight.clear();
            for (const [controller] of pending)
                controller.abort(new Error(reason));
        },
        inFlightCalls() {
            return [...inFlight.values()]
                .map(call => ({ name: call.name, elapsedMs: Date.now() - call.startedAt }))
                .sort((left, right) => right.elapsedMs - left.elapsedMs);
        },
        async close() {
            await new Promise(resolve => server.close(() => resolve()));
        },
    };
}
//# sourceMappingURL=bridge.js.map