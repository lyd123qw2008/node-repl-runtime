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
import { Client, SdkErrorCode, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
/** Project one advertised tool into a model-visible operation. */
export function projectOperation(tool, spec) {
    const injected = Object.keys(spec.inject ?? {});
    const properties = { ...(tool.inputSchema?.properties ?? {}) };
    for (const name of injected)
        delete properties[name];
    const required = (tool.inputSchema?.required ?? []).filter(name => !injected.includes(name));
    return {
        name: tool.name,
        // The server's own description. We never author summaries.
        summary: (tool.description ?? tool.name).trim(),
        // Informational. Relayed from the server's declaration, never invented, and
        // never used to block anything.
        safety: tool.annotations?.readOnlyHint === true ? 'read' : 'mutate',
        inputSchema: { type: 'object', properties, required, additionalProperties: false },
        // `inject` is an input-side concern, so a declared result shape passes through
        // untouched. Its absence is information too: those are the operations that answer
        // in content blocks rather than structured data.
        ...tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema },
    };
}
/** Exposure narrowing, when the operator asked for it. */
export function selectTools(tools, spec) {
    if (spec.include === undefined || spec.include === null)
        return tools;
    const patterns = spec.include.map(pattern => new RegExp(pattern));
    return tools.filter(tool => patterns.some(pattern => pattern.test(tool.name)));
}
/**
 * Merge host-owned arguments into a call, refusing caller-supplied ones.
 *
 * Refusing (rather than overwriting) is deliberate: which project, account or
 * workspace to act on is a host decision, and a cell that tries to redirect it
 * should get an error it can see, not a silently ignored argument.
 */
export function applyInjection(injected, args) {
    for (const name of Object.keys(injected)) {
        if (Object.hasOwn(args, name)) {
            throw new Error(`${name} is host-owned and may not be supplied by the caller`);
        }
    }
    return { ...args, ...injected };
}
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
export const PROVIDER_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const PROVIDER_IMAGE_TOTAL_MAX_BYTES = 8 * 1024 * 1024;
/** The kernel's own allowlist, so the two cannot drift apart silently. */
const PROVIDER_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
/**
 * Admit the image blocks of one MCP result.
 *
 * Exported for tests, like the other pure projections here: it is a function of the
 * server's reply alone, so it can be asserted without a server.
 */
export function collectProviderImages(content) {
    if (!Array.isArray(content))
        return { images: [], dropped: 0 };
    const images = [];
    let total = 0;
    let dropped = 0;
    for (const raw of content) {
        const block = raw;
        if (block === null || typeof block !== 'object' || block.type !== 'image')
            continue;
        const mimeType = typeof block.mimeType === 'string' ? block.mimeType.toLowerCase() : '';
        const data = typeof block.data === 'string' ? block.data : '';
        // Base64 is 4 encoded characters per 3 bytes. Measuring the ceiling this way avoids
        // decoding megabytes only to count them, and a ceiling does not need the exact byte
        // count the way a validator would.
        const bytes = Math.floor(data.length / 4) * 3;
        if (!PROVIDER_IMAGE_MIME_TYPES.has(mimeType)
            || data === ''
            || bytes > PROVIDER_IMAGE_MAX_BYTES
            || total + bytes > PROVIDER_IMAGE_TOTAL_MAX_BYTES) {
            dropped++;
            continue;
        }
        total += bytes;
        images.push({ mimeType, data });
    }
    return { images, dropped };
}
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
export function mergeProviderImages(value, collected) {
    if (collected.images.length === 0 && collected.dropped === 0)
        return value;
    const extras = { _images: collected.images };
    // A drop is reported on the value too. The kernel reports its own drops as visible
    // text; here the value is the only channel the cell reads.
    if (collected.dropped > 0)
        extras._imagesDropped = collected.dropped;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return { ...value, ...extras };
    }
    return { _value: value, ...extras };
}
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
export function classifySessionLoss(error) {
    if (error === null || typeof error !== 'object')
        return undefined;
    const { status, code, message } = error;
    if (status === 404)
        return 'never-ran';
    if (code === SdkErrorCode.NotConnected)
        return 'never-ran';
    // The transport dropped while the client was waiting: in flight, so possibly already executing.
    if (code === SdkErrorCode.ConnectionClosed)
        return 'maybe-ran';
    if (message === 'Not connected')
        return 'never-ran';
    // Undici's report for a request that never completed, which cannot be told apart from one that
    // died mid-response from the caller's side.
    if (error instanceof TypeError && message === 'fetch failed')
        return 'maybe-ran';
    return undefined;
}
/**
 * Whether an error means the session the client is holding is gone.
 *
 * A tool that failed *on the server* is deliberately not in this set: it answers with a result, not
 * with a transport error, and retrying it would repeat a side effect.
 */
export function isSessionLoss(error) {
    return classifySessionLoss(error) !== undefined;
}
/** One line about a failure, for a message that has to carry two of them. */
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
/** How much of a provider's error text is relayed. A gateway's HTML page is not a diagnosis. */
const MAX_PROVIDER_ERROR_CHARS = 2_000;
/**
 * One line about a provider failure, bounded.
 *
 * The SDK builds its HTTP error message out of the whole response body — `Error POSTing to
 * endpoint: ${body}` — with no cap (dist/index.mjs:5360,5382). Relayed verbatim, a proxy or a
 * gateway answering with an HTML page would arrive as kilobytes: into the kernel's heap, and from
 * there into the model's context. The cut is marked, because a reader has to know the message is
 * not the whole story.
 */
export function describeProviderError(error) {
    const text = describe(error);
    if (text.length <= MAX_PROVIDER_ERROR_CHARS)
        return text;
    return `${text.slice(0, MAX_PROVIDER_ERROR_CHARS)}… [${text.length - MAX_PROVIDER_ERROR_CHARS} more characters]`;
}
/**
 * Budget for one provider call that reports no progress. Overridable per provider.
 *
 * It is deliberately not the real ceiling: the cell's own deadline aborts the call (and the SDK
 * then cancels it on the server), so this only has to be long enough that an operation which is
 * *silently* working — an IDE indexing a project, a browser waiting on a page — is not killed
 * while it is still making progress. Progress notifications renew it; see `call()`.
 */
const DEFAULT_PROVIDER_TIMEOUT_MS = 300_000;
/**
 * Hard ceiling for one provider call, progress or not.
 *
 * A backstop for the pathological case — a server that reports progress forever — rather than a
 * policy: the cell's budget normally fires far earlier, and nobody is waiting for this call by
 * then.
 */
const MAX_PROVIDER_TOTAL_TIMEOUT_MS = 3_600_000;
/** What the server advertises now, projected into model-visible operations. */
async function discoverOperations(client, spec) {
    const listed = await client.listTools(undefined, { timeout: 60_000, cacheMode: 'refresh' });
    return selectTools(listed.tools, spec).map(tool => projectOperation(tool, spec));
}
/**
 * The catalog as the kernel receives it.
 *
 * One builder for both directions — the snapshot written before the kernel starts, and the
 * refresh that follows a rebuilt session — because a drift between them would be invisible
 * until a restart, which is precisely the class of bug this file just grew a fix for.
 */
export function catalogEntries(providers) {
    return [...providers].map(provider => ({
        id: provider.id,
        label: provider.label,
        operations: provider.operations,
    }));
}
/**
 * Health for a connection, including one that owns no session.
 *
 * A connection without a `session` is not unhealthy — it simply has nothing to re-open, and
 * `reconnectable: false` is how a caller can tell that apart from a provider whose session is
 * currently down. Reporting it at all (rather than omitting it) keeps `cap.status()` a complete
 * picture of the catalog, which is what makes an absence explicable.
 */
export function providerHealth(provider) {
    return provider.session?.health() ?? {
        id: provider.id,
        label: provider.label,
        state: 'connected',
        attached: true,
        reconnectable: false,
        operations: provider.operations.length,
        generation: 0,
        reconnects: 0,
    };
}
/**
 * Health for a provider that is configured but not attached.
 *
 * Synthesized from the spec rather than from a connection, because there is no connection —
 * that is the whole point. It is what lets `cap.status()` answer "where is idea?" with a reason
 * instead of an absence, and `reconnectable: true` is a promise the attach path has to keep.
 */
export function unattachedHealth(spec, error) {
    return {
        id: spec.id,
        label: spec.label ?? spec.id,
        state: 'failed',
        attached: false,
        reconnectable: true,
        operations: 0,
        generation: 0,
        reconnects: 0,
        lastError: error,
        ...spec.url === undefined ? {} : { url: spec.url },
    };
}
/**
 * Connect one client, and reap it if it cannot be used.
 *
 * A server that connects and then fails discovery would otherwise leave its client running with
 * nothing holding a reference to close it — and for stdio that is an orphaned child process per
 * attempt. The caller only sees the throw, so the cleanup has to happen on this side of it.
 */
async function openClient(spec, url, lifecycle) {
    const client = new Client({ name: 'node-repl-runtime', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    // The SDK can report a peer's late exit after the call that used the client has settled.
    // Keep that failure inside this provider rather than letting it escape the host event loop.
    client.onerror = error => { lifecycle.report(client, error); };
    client.onclose = () => { lifecycle.report(client, new Error('transport closed')); };
    /** Reads out the child's stderr tail. Empty for HTTP, and until something is written. */
    let stderrTail = () => '';
    try {
        if (spec.transport === 'streamable-http') {
            if (url === undefined)
                throw new Error(`provider ${spec.id}: transport streamable-http requires url`);
            await client.connect(new StreamableHTTPClientTransport(new URL(url)));
        }
        else {
            if (spec.command === undefined)
                throw new Error(`provider ${spec.id}: transport stdio requires command`);
            const transport = new StdioClientTransport({
                command: spec.command,
                args: [...(spec.args ?? [])],
                ...spec.cwd === undefined ? {} : { cwd: spec.cwd },
                ...spec.env === undefined ? {} : { env: { ...spec.env } },
                // Piped rather than the SDK's `inherit` default, so a server that dies at startup can say
                // why in `failures`/`capHelp()` — the host's own stderr is not where anyone looks when a
                // capability is simply missing. `forwardStderr` still writes the bytes through to stderr, so
                // a live child's output stays exactly as visible as it was.
                stderr: 'pipe',
            });
            // Attached before `connect()`: the SDK hands back the stream immediately precisely so early
            // output is not lost.
            stderrTail = forwardStderr(transport.stderr);
            await client.connect(transport);
        }
        return client;
    }
    catch (error) {
        await lifecycle.close(client);
        const tail = stderrTail();
        // The SDK's own message for a child that exited is about the connection; the child's last words
        // are the diagnosis. Both, with the tail last so it reads as the epilogue.
        if (tail === '')
            throw error;
        throw new Error(`${describeProviderError(error)}\n[stderr] ${tail}`);
    }
}
/** How much of a failed child's stderr to keep. Enough for a stack trace's point, not for a novel. */
const STDERR_TAIL_CHARS = 2_000;
/**
 * Follow a child's stderr, and hand back a reader for its last {@link STDERR_TAIL_CHARS}.
 *
 * The bytes are still written through to this host's stderr, which is what the SDK's `inherit`
 * default did: capturing them must not make a live server's logging disappear, only make the last
 * words available to a failure message.
 */
function forwardStderr(stream) {
    const readable = stream;
    if (readable === null || typeof readable?.on !== 'function')
        return () => '';
    let tail = '';
    readable.setEncoding?.('utf8');
    readable.on('data', (chunk) => {
        process.stderr.write(chunk);
        tail = (tail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    readable.on('error', () => { });
    return () => tail.trim();
}
/** Open one MCP session, with the recovery a long-lived host needs. Nothing is persisted. */
export async function connectMcpProvider(spec) {
    const live = {
        spec,
        url: spec.url,
        client: undefined,
        operations: [],
        generation: 0,
        reconnects: 0,
        state: 'connected',
        lastError: undefined,
        pending: undefined,
        closed: false,
    };
    /**
     * Calls in flight per client, so a client that has been replaced can close once it is quiet.
     *
     * Keyed by the client itself rather than counted globally: the question is always "does *this*
     * one still have a reader".
     */
    const inFlightByClient = new WeakMap();
    /** Clients a runtime-decided reconnect set aside; closed as soon as their last call settles. */
    const retiring = new Set();
    // The SDK can notify `onerror` / `onclose` after a caller has stopped awaiting a client.
    // Keep those failures inside this provider: an escaped rejection makes the DSH bootstrap fiber
    // fail and silently prevents the injected `js` / `js_reset` tools from registering. A client is
    // reportable only after discovery completed; setup failures already have a direct caller that
    // records them in `failures`. Intentional close paths are suppressed so normal disposal and
    // reconnect cleanup do not look like transport failures.
    const activeClients = new WeakSet();
    const intentionalCloses = new WeakSet();
    const reportedFailures = new WeakSet();
    const lifecycle = {
        async close(client) {
            intentionalCloses.add(client);
            await client.close().catch(() => { });
        },
        report(client, error) {
            if (!activeClients.has(client) || intentionalCloses.has(client) || reportedFailures.has(client))
                return;
            reportedFailures.add(client);
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[node-repl-runtime] provider ${spec.id} transport error after setup: ${message}`);
        },
    };
    const retire = (client) => {
        if ((inFlightByClient.get(client) ?? 0) === 0) {
            void lifecycle.close(client);
            return;
        }
        retiring.add(client);
    };
    const release = (client) => {
        const remaining = (inFlightByClient.get(client) ?? 1) - 1;
        inFlightByClient.set(client, remaining);
        // The detached client's last caller has its answer: nothing will read anything else from it.
        if (remaining <= 0 && retiring.delete(client))
            void lifecycle.close(client);
    };
    /** Connect and discover as one unit: a client without a catalog is not a session yet. */
    const establish = async (url) => {
        const client = await openClient(spec, url, lifecycle);
        try {
            const operations = await discoverOperations(client, spec);
            activeClients.add(client);
            return { client, operations };
        }
        catch (error) {
            await lifecycle.close(client);
            throw error;
        }
    };
    /**
     * The re-open itself, without the single-flight wrapper.
     *
     * What happens to the old client depends on *who* asked, and the difference is not cosmetic:
     *
     *   - a reconnect the runtime decided on (a call found the session gone) **detaches** it — the
     *     old client stays open until the calls still in flight on it settle, then closes itself.
     *     Closing immediately aborts those calls, and an aborted call is indistinguishable from a
     *     connection that died mid-request: `maybe-ran`, which for a mutating operation means
     *     refusing a retry the server would have allowed. Measured: without this, one of five
     *     concurrent mutations failed that way, and the server had never rejected it;
     *   - an operator's `cap.reconnect(id)` **closes** it, because "reset this provider" is the
     *     request and the old session is exactly what is being thrown away. For stdio that also
     *     reaps the child, which a detach would leak.
     *
     * Validation happens before either, so a bad `url` override cannot cost a session that still
     * works.
     */
    const reopen = async (options) => {
        if (live.closed)
            throw new Error(`provider ${spec.id} is closed`);
        const url = options?.url ?? live.url;
        if (spec.transport === 'streamable-http' && url === undefined) {
            throw new Error(`provider ${spec.id}: transport streamable-http requires url`);
        }
        if (spec.transport === 'stdio' && spec.command === undefined) {
            throw new Error(`provider ${spec.id}: transport stdio requires command`);
        }
        live.state = 'reconnecting';
        const previous = live.client;
        live.client = undefined;
        if (previous !== undefined) {
            if (options?.closePrevious === true)
                await lifecycle.close(previous);
            else
                retire(previous);
        }
        try {
            const opened = await establish(url);
            // Disposal can land mid-reconnect: this process is going away, so the session that was
            // just opened must be reaped here or it outlives the runtime — for stdio, as a child.
            if (live.closed) {
                await lifecycle.close(opened.client);
                throw new Error(`provider ${spec.id} is closed`);
            }
            // Published together, so a caller never observes a new client whose catalog belongs to
            // the old session.
            live.client = opened.client;
            live.operations = opened.operations;
            live.url = url;
            live.generation += 1;
            live.reconnects += 1;
            live.state = 'connected';
            live.lastError = undefined;
        }
        catch (error) {
            live.state = 'failed';
            live.lastError = describe(error);
            throw error;
        }
    };
    const reconnect = (options) => {
        if (live.pending !== undefined)
            return live.pending;
        const attempt = reopen(options).finally(() => {
            if (live.pending === attempt)
                live.pending = undefined;
        });
        live.pending = attempt;
        return attempt;
    };
    const health = () => ({
        id: spec.id,
        label: spec.label ?? spec.id,
        state: live.state,
        attached: true,
        reconnectable: true,
        operations: live.operations.length,
        generation: live.generation,
        reconnects: live.reconnects,
        ...live.lastError === undefined ? {} : { lastError: live.lastError },
        ...live.url === undefined ? {} : { url: live.url },
    });
    /**
     * What the server declared about an operation's side effects.
     *
     * Informational by design — `readOnlyHint` is the server's own claim and never a gate on calling
     * the operation. It is a gate on *retrying* it, though, and absence means "assume it mutates":
     * that costs a retry after an ambiguous failure and never doubles a side effect.
     */
    const operationSafety = (operation) => live.operations.find(candidate => candidate.name === operation)?.safety ?? 'mutate';
    const call = async (operation, args, signal) => {
        // Refusing a caller-supplied host-owned argument happens before anything is opened or sent:
        // it is a bug in the cell, not in the provider's session.
        const withInjected = applyInjection(spec.inject ?? {}, args);
        const invoke = async () => {
            const client = live.client;
            if (client === undefined)
                throw new Error(`provider ${spec.id} has no open session`);
            // Counted per client and released in `finally`: a client that gets replaced while this call is
            // in flight stays open until the call settles, so the reconnect cannot abort it into an
            // ambiguous failure.
            inFlightByClient.set(client, (inFlightByClient.get(client) ?? 0) + 1);
            try {
                return await callOn(client);
            }
            finally {
                release(client);
            }
        };
        const callOn = async (client) => {
            const result = await client.callTool({ name: operation, arguments: withInjected }, {
                // A long IDE operation — a full rebuild, a terminal command running a test suite —
                // reports progress for minutes, so the deadline has to follow the work rather than the
                // wall clock. That takes two options, and neither works alone:
                //
                //   - `onprogress` is what makes the SDK attach `_meta.progressToken` at all. Without
                //     it a compliant server has no token to report against, so no progress ever arrives;
                //   - `resetTimeoutOnProgress` is what lets each notification push the deadline out. The
                //     SDK defaults it to false, which is why a five-minute build used to die with
                //     `Request timed out` while the IDE was still working.
                //
                // The handler itself is empty on purpose: progress is a liveness signal here, not content
                // the cell asked for. Surfacing it would need a push channel from the bridge.
                onprogress: () => { },
                resetTimeoutOnProgress: true,
                timeout: spec.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
                maxTotalTimeout: MAX_PROVIDER_TOTAL_TIMEOUT_MS,
                // Aborting this request sends the MCP cancellation notification, so a provider
                // that supports it can stop the work instead of finishing it for nobody.
                ...signal === undefined ? {} : { signal },
            });
            if (result.isError === true) {
                const text = (result.content ?? [])
                    .filter((block) => block.type === 'text')
                    .map(block => block.text)
                    .join('\n');
                throw new Error(text.trim() === '' ? `${spec.id}.${operation} failed` : text);
            }
            // `structuredContent` when the server sends it, otherwise the content blocks.
            // Passed through verbatim: this runtime never rewrites a provider's result. The one
            // addition is additive and conditional — images the server actually sent are parked
            // on the value as `_images`, because a `??` on the structured payload would drop
            // them entirely (they ride in a separate image content block).
            const value = result.structuredContent ?? result.content ?? null;
            return mergeProviderImages(value, collectProviderImages(result.content));
        };
        // A previous re-open failed and left no session. Try again before reporting a missing
        // session as if the provider had never been connected.
        if (live.client === undefined)
            await reconnect();
        try {
            return await invoke();
        }
        catch (error) {
            // An aborted call is the caller's own doing, not a lost session: nothing can read the
            // answer, so re-sending the request would be work done for nobody.
            const loss = signal?.aborted === true ? undefined : classifySessionLoss(error);
            if (loss === undefined)
                throw error;
            const lost = error;
            // Whether a retry is provably free of side effects depends on *how* the session was lost.
            // A call the server rejected (404) or one whose transport was already gone was never sent,
            // so re-sending it is a repair. A connection that failed with the request in flight proves
            // nothing about whether the tool started — and for a mutating operation a blind retry is how
            // one deploy becomes two. Those follow the rule this file already applies to server-reported
            // errors (`isError` is an answer, not a transport failure): read-only calls retry, mutations
            // get an error that says what is actually known.
            if (loss === 'maybe-ran' && operationSafety(operation) !== 'read') {
                throw new Error(`provider ${spec.id}: ${describeProviderError(lost)} — the connection failed with the request in flight, `
                    + 'so it may already have run; not retried automatically (check the operation\'s effect and re-run it only if it did not happen)');
            }
            try {
                await reconnect();
            }
            catch (reconnectError) {
                // Both facts matter and neither is optional: the session was lost, and the provider
                // would not come back. A message naming only one of them sends the reader to the wrong
                // place — "session not found" alone reads as a client bug when the real news is that
                // nothing is listening.
                throw new Error(`provider ${spec.id}: ${describeProviderError(lost)} (reconnecting did not help: ${describeProviderError(reconnectError)})`);
            }
            // Exactly one retry, on the fresh session. A second failure is reported as it stands:
            // retrying a non-idempotent tool more than once is how one side effect becomes three.
            return await invoke();
        }
    };
    const opened = await establish(live.url);
    live.client = opened.client;
    live.operations = opened.operations;
    live.generation = 1;
    return {
        id: spec.id,
        label: spec.label ?? spec.id,
        get operations() {
            return live.operations;
        },
        session: {
            health,
            async reconnect(options) {
                // Explicit, so the old session goes for good: this is the operator's "reset the provider",
                // not the runtime repairing one a call found dead (which detaches instead — see `reopen`).
                await reconnect({ ...options, closePrevious: true });
                return health();
            },
        },
        call,
        async close() {
            live.closed = true;
            if (live.client !== undefined)
                await lifecycle.close(live.client);
            live.client = undefined;
            // A detached client outlives its replacement by design; shutting down still reaps it, or a
            // stdio child would survive the runtime that started it.
            for (const client of retiring)
                await lifecycle.close(client);
            retiring.clear();
        },
    };
}
//# sourceMappingURL=catalog.js.map