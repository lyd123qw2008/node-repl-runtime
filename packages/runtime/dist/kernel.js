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
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { catalogEntries } from './catalog.js';
const BRIDGE_ASSET_DIR = fileURLToPath(new URL('../assets/nr-cap/', import.meta.url));
/**
 * The executable that runs the kernel child.
 *
 * `process.execPath` is right under plain Node and wrong under Electron. A DSH Desktop host
 * runs in `electron.exe`, and the MCP stdio transport starts children with a small safe
 * environment that deliberately does NOT include `ELECTRON_RUN_AS_NODE` — that is the SDK's
 * whitelist, not something this package can patch. Without the flag Electron starts as a GUI
 * application instead of running the script, so the transport closes almost immediately.
 *
 * There is no way to guess a better default here. Electron ships no standalone node binary
 * (measured: its `dist` holds `electron.exe` alone), and `require('electron')` resolves to
 * that same `electron.exe` — running it as the kernel command needs the very flag the
 * transport strips. So an Electron host must pass `kernelCommand` explicitly, and this
 * fallback is a deliberate, documented last resort rather than a working default.
 *
 * The failure is worth recognizing, because everything about it misleads. Measured under the
 * Desktop host: the kernel child gets far enough to create its root and write
 * `nr-cap/config.json`, so discovery looks healthy, and only the install cell dies — as
 * `kernel startup failed: Connection closed`, which names neither the spawn nor Electron.
 * @returns Command for the kernel child, as a path or a PATH-resolvable name.
 */
function resolveKernelCommand() {
    return process.execPath;
}
/**
 * Appended to a cell that lost its kernel, so the model does not call `js_reset` to recover
 * something the runtime has already put back.
 */
const CATALOG_RESTORED_NOTICE = '[node_repl kernel was replaced: bindings lost, capability catalog reinstalled]';
/**
 * What a cell that lost its kernel is told about the catalog.
 *
 * The failure branch is the point. `crashed` already says the cell died, but a catalog that
 * could not be put back leaves every later cell answering `cap is not defined` with no
 * explanation — and the previous version of this code swallowed exactly that error, which is
 * the one case where saying nothing costs the most. Exported because the notice is a pure
 * function of the failure, like the other projections this runtime asserts directly.
 */
export function catalogRecoveryNotice(failure) {
    return failure === undefined
        ? CATALOG_RESTORED_NOTICE
        : `[node_repl kernel was replaced and the capability catalog could not be reinstalled: ${failure}]`;
}
/**
 * What a cell that ended with provider calls still in flight is told about them.
 *
 * Two facts, because both are needed to act: which call was cut off and how long it had been
 * running. A budget ending is then distinguishable from a hung tool, and the fix — a larger
 * `timeoutMs` — is stated where the model reads it rather than left in a document. The caution is
 * not boilerplate: a cancelled call may already have caused part of its side effect, so a blind
 * re-run of a deploy or a command that writes files is the one retry that can make things worse.
 */
export function abandonedCallsNotice(calls, status, budgetMs) {
    if (calls.length === 0)
        return undefined;
    const list = calls
        .map(call => `${call.name} (${(call.elapsedMs / 1000).toFixed(1)} s)`)
        .join(', ');
    return status === 'timeout'
        ? `[cell budget ${budgetMs} ms expired with ${list} still in flight — the call was cancelled; give a longer timeoutMs, and check a side-effecting call's state before re-running]`
        : `[cell ended as ${status} with ${list} still in flight — the call was cancelled and nothing can read its answer]`;
}
/**
 * The MCP stdio client deliberately starts children with a small safe environment.
 * A persistent node_repl kernel nevertheless needs the host's explicit outbound
 * routing policy: otherwise a DSH process launched from a stale Windows Explorer
 * environment can bypass its configured proxy while shell commands do not.
 *
 * Keep this allowlist deliberately narrow. Passing all of process.env would leak
 * unrelated host credentials/configuration into code running in the kernel.
 */
const KERNEL_NETWORK_ENV_NAMES = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
    'NODE_USE_ENV_PROXY',
];
function kernelNetworkEnvironment() {
    const environment = {};
    for (const name of KERNEL_NETWORK_ENV_NAMES) {
        const value = process.env[name];
        if (value !== undefined)
            environment[name] = value;
    }
    return environment;
}
/**
 * Where the kernel child lives. Kept scratch: it holds a generated config, not user data.
 *
 * The name is a UUID rather than a timestamp: two runtimes created in the same
 * millisecond would otherwise share a directory, and one runtime's cleanup would delete
 * the other's kernel root mid-run.
 */
export function createKernelRoot() {
    const root = join(tmpdir(), `node-repl-runtime-${randomUUID()}`);
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    cpSync(BRIDGE_ASSET_DIR, join(root, 'node_modules', 'nr-cap'), { recursive: true });
    return root;
}
/**
 * The kernel reports a cell as an ordered list of MCP content blocks — text and images
 * interleaved, with consecutive text already coalesced — and its `output-adapter` has
 * validated and budgeted every image by the time it arrives here. So this is a copy, not
 * a gate: flattening it would lose where an image sat between two texts, and
 * re-validating it would create a second source of truth for one policy.
 *
 * Unknown block types are dropped rather than guessed at: an MCP block this runtime does
 * not model is not text, and rendering it as text would be invention.
 */
function collectCellBlocks(content) {
    const blocks = [];
    for (const raw of content ?? []) {
        const block = raw;
        if (block === null || typeof block !== 'object')
            continue;
        if (block.type === 'text' && typeof block.text === 'string') {
            blocks.push({ kind: 'text', text: block.text });
        }
        else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
            blocks.push({ kind: 'image', data: block.data, mimeType: block.mimeType });
        }
    }
    return blocks;
}
/**
 * The prose view of a cell's blocks: text segments joined with `\n`, which is exactly what
 * this runtime returned before `blocks` existed. Callers that read only prose see no
 * change; anything that renders content walks `blocks` instead.
 */
function textOf(blocks) {
    return blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n');
}
export async function startKernel(options) {
    const client = new Client({ name: 'node-repl-runtime', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    // `startKernel()` owns the scratch root from the point it writes the snapshot. A failed
    // connect (notably Electron accidentally launched as the kernel command) used to happen
    // before a KernelSession existed, so its normal `close()` cleanup was unreachable.
    const cleanupFailedStart = async () => {
        await client.close().catch(() => { });
        try {
            rmSync(options.root, { recursive: true, force: true });
        }
        catch {
            // Preserve the startup failure; cleanup is best effort just as session disposal is.
        }
    };
    try {
        // The kernel reads this snapshot at import time, so it must exist before start.
        writeFileSync(join(options.root, 'node_modules', 'nr-cap', 'config.json'), `${JSON.stringify({
            host: options.bridge.host,
            port: options.bridge.port,
            token: options.bridge.token,
            // One shape, built in one place: the same `providers` array a later `cap.refresh()`
            // receives, so a rebuilt session refreshes the kernel's namespaces exactly the way the
            // snapshot created them.
            providers: catalogEntries(options.providers.values()),
            // Not capabilities — nothing can be called on them — but discovery that lists only
            // presences cannot answer "where is cua?" at all.
            failures: options.failures,
        }, null, 2)}\n`);
        await client.connect(new StdioClientTransport({
            command: options.command ?? resolveKernelCommand(),
            args: [options.entry],
            cwd: options.root,
            env: kernelNetworkEnvironment(),
        }));
    }
    catch (error) {
        await cleanupFailedStart();
        throw error;
    }
    /**
     * The kernel yields control after `yield_time_ms` — 10 s unless asked otherwise —
     * and expects a `node_repl_wait` follow-up. That yield carries a cell id in text and
     * no structured payload, so mistaking it for a finished cell reports `ok` together
     * with a note instead of a result. It is therefore recognized and drained here.
     */
    const RUNNING_CELL_ID = /node_repl cell (\S+) is still running/;
    /**
     * The kernel never sends `structuredContent`: it folds its five-way status into
     * `isError` plus a leading `[node_repl <status>]` notice (their adapter says so
     * explicitly — "Preserve the 5-way status that MCP's boolean isError would otherwise
     * lose"). Reading only `isError` would report a kernel timeout as a plain `error`,
     * and leave every non-`ok` cell indistinguishable for the abandonment rule below.
     */
    const KERNEL_STATUS_NOTICE = /^\[node_repl (ok|error|cancelled|timeout|crashed)\]/;
    const MAX_YIELD_MS = 60_000;
    /** Slack for collecting the terminal result after the caller's budget is spent. */
    const DRAIN_GRACE_MS = 5_000;
    /**
     * Cell endings where nothing will ever read an in-flight provider answer. `error` is
     * deliberately absent: a cell that throws may still have deliberately started a call it
     * did not await, and `ok` obviously finishes normally.
     */
    const ABANDONED_CELL_STATUSES = new Set(['timeout', 'cancelled', 'crashed', 'running']);
    const call = async (name, args) => {
        const started = Date.now();
        const result = await client.callTool({ name, arguments: args }, { timeout: 900_000 });
        const blocks = collectCellBlocks(result.content);
        const text = textOf(blocks);
        const structured = result.structuredContent;
        if (structured?.status !== undefined) {
            return {
                result: {
                    status: structured.status,
                    blocks,
                    output: text.trimEnd(),
                    ...structured.error === undefined ? {} : {
                        error: {
                            name: structured.error.name ?? 'Error',
                            message: structured.error.message ?? 'cell failed',
                            ...structured.error.stack === undefined ? {} : { stack: structured.error.stack },
                        },
                    },
                    durationMs: structured.stats?.durationMs ?? Date.now() - started,
                },
            };
        }
        const runningCellId = RUNNING_CELL_ID.exec(text)?.[1];
        if (runningCellId !== undefined) {
            return {
                runningCellId,
                result: { status: 'running', blocks, output: text.trimEnd(), durationMs: Date.now() - started },
            };
        }
        // No structured payload: the kernel reports the cell through text and `isError`.
        const failed = result.isError === true;
        const notice = KERNEL_STATUS_NOTICE.exec(text)?.[1];
        return {
            result: {
                status: notice ?? (failed ? 'error' : 'ok'),
                blocks,
                output: text.trimEnd(),
                ...failed ? { error: { name: 'Error', message: text.trim() } } : {},
                durationMs: Date.now() - started,
            },
        };
    };
    /**
     * The kernel has one active-cell slot, and `node_repl_reset` refuses while it is
     * occupied. Tracking the id means the slot can always be freed, so a provider call
     * that never answers cannot leave the kernel permanently unusable.
     */
    let activeCellId;
    /** Guards the recovery path, which runs a cell (`install`) from inside `run`. */
    let recovering = false;
    /**
     * Put the catalog back after a cell that took the kernel with it.
     *
     * `crashed` is the one status that *tells* us the kernel was replaced — the official
     * reports it exactly when a kernel dies mid-cell, and a replacement starts with no `cap`.
     * Ignoring it turns one lost cell into a lost capability surface: every later cell
     * answers `cap is not defined` until someone guesses `js_reset`. That is reachable in
     * practice, not just in theory: a cell that exhausts the kernel heap is one way to die.
     *
     * `install()` is idempotent, and this runs only on that rare ending, so the cost is one
     * cell. The blind spot is a kernel that dies while *idle*: the next cell then reports
     * `ok` in a fresh kernel with no catalog, which no host-side signal can see — so the tool
     * description tells the model to call `js_reset` when `cap` is undefined.
     *
     * A recovery failure is not reported as the cell's outcome: the crashed result is the
     * more useful fact, and the missing-catalog path above covers the rest.
     */
    const recoverCatalog = async (result) => {
        if (recovering)
            return result;
        recovering = true;
        let failure;
        try {
            await install();
        }
        catch (error) {
            // Reported, not swallowed: the model is about to find a kernel with no `cap`, and the
            // reason is the only thing that distinguishes "retry" from "this runtime is unusable".
            failure = error instanceof Error ? error.message : String(error);
        }
        finally {
            recovering = false;
        }
        const blocks = [...result.blocks, { kind: 'text', text: catalogRecoveryNotice(failure) }];
        return { ...result, blocks, output: textOf(blocks).trimEnd() };
    };
    const cancelActiveCell = async () => {
        if (activeCellId === undefined)
            return;
        const cellId = activeCellId;
        activeCellId = undefined;
        // Cancelling normally keeps the kernel and its earlier bindings; only a cell that
        // will not stop within the grace period restarts the kernel and discards them.
        await call('node_repl_cancel', { cell_id: cellId, yield_time_ms: 5_000 });
        // Nothing can read what that cell was waiting for now.
        options.bridge.abandonInFlight(`cell ${cellId} was cancelled`);
    };
    const session = {
        run: async (code, runOptions) => {
            // Timed from here, not from the last kernel round trip: a cell that yields once
            // returns through `node_repl_wait`, and reporting that hop's duration would claim a
            // three-second cell took one millisecond.
            const began = Date.now();
            const timeoutMs = runOptions?.timeoutMs ?? options.defaultTimeoutMs;
            const deadline = Date.now() + timeoutMs + DRAIN_GRACE_MS;
            let outcome = await call('node_repl', {
                code,
                timeout_ms: timeoutMs,
                // Ask for the caller's whole budget up front: an ordinary cell then returns its
                // result in this one round trip instead of yielding at the kernel's 10 s default.
                yield_time_ms: Math.min(Math.max(timeoutMs, 1), MAX_YIELD_MS),
                ...runOptions?.title === undefined ? {} : { title: runOptions.title.slice(0, 80) },
            });
            activeCellId = outcome.runningCellId;
            while (outcome.runningCellId !== undefined && Date.now() < deadline) {
                outcome = await call('node_repl_wait', {
                    cell_id: outcome.runningCellId,
                    yield_time_ms: Math.min(Math.max(deadline - Date.now(), 1), MAX_YIELD_MS),
                });
                activeCellId = outcome.runningCellId;
            }
            // Nothing can read an in-flight provider answer once the cell is gone, so the calls still
            // waiting are captured *here* — before either path below abandons them — and named in the
            // result. Without that, a cell that ran out of budget mid-build reports a bare timeout and
            // the reader cannot tell "the IDE was still working, give me a bigger budget" from "the tool
            // hung", which are different next moves.
            const abandoned = ABANDONED_CELL_STATUSES.has(outcome.result.status)
                ? options.bridge.inFlightCalls()
                : [];
            // The budget is spent and the cell is still going. The kernel has one active-cell
            // slot: leaving it occupied would refuse every later cell — including the install
            // cell of a reset — so the cell is cancelled rather than abandoned.
            if (outcome.runningCellId !== undefined)
                await cancelActiveCell();
            // A cell the kernel stopped, or one that crashed, cannot read an in-flight provider
            // answer either — and a request left running blocks that provider's session for every
            // later cell. A cell that finished on its own is left alone: it may deliberately have
            // fired a call it never awaited.
            if (abandoned.length > 0 || ABANDONED_CELL_STATUSES.has(outcome.result.status)) {
                options.bridge.abandonInFlight(`cell ended as ${outcome.result.status}: nothing can read its answers`);
            }
            let result = { ...outcome.result, durationMs: Date.now() - began };
            // A crashed cell took the kernel with it; the replacement has no catalog unless this
            // puts one back.
            if (result.status === 'crashed')
                result = await recoverCatalog(result);
            const notice = abandonedCallsNotice(abandoned, result.status, timeoutMs);
            if (notice === undefined)
                return result;
            const blocks = [...result.blocks, { kind: 'text', text: notice }];
            return { ...result, blocks, output: textOf(blocks).trimEnd() };
        },
        reset: async () => {
            // `node_repl_reset` refuses while a cell is active, so clear the slot first.
            await cancelActiveCell();
            await call('node_repl_reset', {});
            // Reset clears every binding, `cap` included, so the catalog has to be put
            // back or the next cell would find a kernel with no capabilities at all.
            await install();
        },
        async close() {
            await client.close().catch(() => { });
            rmSync(options.root, { recursive: true, force: true });
        },
    };
    /**
     * Install the catalog once. Because the kernel persists bindings, every later cell
     * simply has `cap` in scope — the kernel's own persistence removes the import
     * ceremony for the model.
     *
     * The assignments must happen in the CELL, not inside the imported module: an
     * imported module runs on the module global, so a `globalThis` side effect set there
     * is invisible to cell code.
     *
     * The refresh is what keeps a *replaced* kernel honest. `nr-cap` reads `config.json` when it
     * is first imported, and that file was written when this runtime started — but a kernel
     * process that died and came back imports the module afresh, so without this it would
     * advertise the startup catalog while the host serves a different one (a provider attached
     * after startup, or a tool list that changed when a session was rebuilt). Best effort: if the
     * host cannot answer, the snapshot stays the view rather than the catalog failing to install,
     * and `cap.status()` is how to see the difference.
     */
    const install = async () => {
        const result = await session.run("const mod = await import('nr-cap');\n"
            + 'globalThis.cap = mod.cap;\n'
            + 'globalThis.capHelp = mod.capHelp;\n'
            + 'try { await cap.refresh(); } catch (error) { nodeRepl.write("catalog left on the startup snapshot: " + error.message + "\\n"); }\n'
            + "nodeRepl.write('cap ready: ' + cap.list().map(p => p.id + '=' + p.operations).join(','));", { timeoutMs: 60_000, title: 'install capability catalog' });
        if (result.status !== 'ok') {
            throw new Error(`capability catalog could not be installed in the kernel: ${result.error?.message ?? result.output}`);
        }
    };
    await install();
    return session;
}
//# sourceMappingURL=kernel.js.map