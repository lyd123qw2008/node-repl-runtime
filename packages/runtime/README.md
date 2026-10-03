# @lyd123qw2008/node-repl-runtime

A node_repl-shaped capability runtime: **one persistent JavaScript kernel**, with **any MCP server injected into it as a capability catalog**. Attaching an MCP server costs configuration and no code — there is no per-server branch anywhere in this package.

```js
const runtime = await createCapabilityRuntime({
  providers: [{ id: 'idea', transport: 'streamable-http', url: 'http://127.0.0.1:64342/stream' }],
})

const result = await runtime.js(`
  var modules = await cap.idea.get_project_modules({ projectPath: 'D:/project' });
  nodeRepl.write('modules: ' + modules.modules.length);
`)
console.log(result.status, result.output)
```

Inside a cell, `cap.<provider>.<operation>(args)` calls the MCP tool; `capHelp()` and `cap.describe("provider.operation")` are the discovery path, and they carry the server's own input **and** (when declared) result schema. The result of the whole session is `cap` — the provider's own names, never renamed.

Four non-enumerable helpers sit on `cap` beside the providers (`Object.keys(cap)` lists providers only):

| | |
| --- | --- |
| `cap.list()` | Providers and operation counts, from the kernel's own snapshot — no round trip. |
| `cap.status()` | Live per-provider health: `state`, `attached`, `operations`, `generation`, `reconnects`, `lastError`, `url`. Includes providers that are configured but never attached, with the reason. |
| `cap.refresh()` | Ask the host for the catalog as it is *now* and rebuild the namespaces from it. |
| `cap.reconnect(id, { url })` | Make one provider usable again: re-open its session, or connect it for the first time (the endpoint override applies to the first connect too). |

A provider whose server restarted is reconnected and retried **once, transparently**, inside the failing call; the refreshed catalog rides back with the reply, so the next statement in the same cell sees it. `cap.reconnect` is the explicit exit for the rest — a provider the host could not reach at startup, or an endpoint that moved.

Whether that retry happens depends on what the failure proves. A call the server rejected (a session it no longer knows) or one whose transport was already gone never reached the tool, so it is re-sent — that includes a dead stdio child, whose next request the SDK reports as a plain `Error("Not connected")`. A connection that failed with the request *in flight* proves nothing about whether the tool started, so those are retried only when the operation declares `readOnlyHint`; a mutating operation gets an error saying the call may already have run, because a blind retry of a deploy is how one effect becomes two.

## Install

```bash
npm install @lyd123qw2008/node-repl-runtime
```

Node 22.19+ is required. The kernel engine is maintained here as [`@lyd123qw2008/node-repl-kernel-engine`](../kernel-engine/README.md), based on Qwen's Apache-2.0 `0.1.6` source snapshot; provenance and the local patch ledger are in [`UPSTREAM.md`](../kernel-engine/UPSTREAM.md). This runtime starts its compatibility MCP entry, projects MCP catalogs into the kernel, and owns the provider side.

## API

| | |
| --- | --- |
| `createCapabilityRuntime(options)` | Attach providers, start the kernel, return the runtime. |
| `runtime.js(code, { timeoutMs, title })` | Run one cell. Returns `{ status, output, error?, durationMs }`. |
| `runtime.jsReset()` | Discard bindings and re-install the catalog. |
| `runtime.catalog()` | The projected operations per provider (`{ id, label, operations }`). |
| `runtime.failures()` | Providers that are configured but not attached, with the latest reason. |
| `runtime.dispose()` | Close kernels, the bridge, and every MCP session. |
| `applyInjection(injected, args)` | Merge host-owned arguments, refusing caller-supplied ones. |

Provider configuration is generic: `id`, `label`, `transport` (`streamable-http` | `stdio`), `url`/`command`+`args`, `env`, optional `disabled` (skip the provider before connecting), optional `inject` (host-owned constants removed from the model-visible schema), optional `include` narrowing, and optional `timeoutMs` (budget for one *quiet* call, default 300 s). A provider that fails to attach does not take the others down; an empty provider catalog is a valid runtime state. Its spec is kept, though, so a provider that was simply not up yet can be attached later with `cap.reconnect(id)` instead of a host restart — `disabled` is the one exception, and stays refused.

Providers connect **concurrently** at startup, so mounting three servers costs the slowest handshake rather than their sum. A call's deadline follows the work: the runtime requests progress notifications (`onprogress`, which is what makes the SDK attach `_meta.progressToken` at all) and lets each one renew the deadline (`resetTimeoutOnProgress`, which the SDK defaults to off). That is what keeps a five-minute IDE rebuild from being cancelled at the 300 s mark while the IDE is still working; a one-hour hard ceiling applies regardless, and the cell's own budget is the bound that normally matters.

When a cell does end with provider calls still in flight — out of budget, cancelled, or crashed — the result names them (`idea.build_project (28.4 s)`) instead of reporting a bare timeout, because "the IDE was still working" and "the tool hung" call for different next moves. The cell budget default stays deliberately short for the same reason it exists: the kernel has one active-cell slot for the whole host process, so a larger default would let one stuck cell hold up every session.

`node packages/runtime/dist/cli.js --id idea --url <endpoint>` attaches one server from the command line; without `--code` it prints the projected catalog.

## Boundaries, stated honestly

- **Not a sandbox.** The kernel gives lifecycle and namespace isolation; imported code and Node built-ins run with normal Node permissions.
- **The kernel lives as long as the host process.** Nothing reclaims it on a timer, there is no heap ceiling set by this runtime, and `js_reset` is the only lever that releases bindings (measured ~115 ms — the same MCP sessions survive). Part of the growth is the reused kernel's own per-cell module machinery, which no JS-level GC can reclaim, so the honest model is the browser's: read `nodeRepl.getHeapStatus()` when it matters, drop what you no longer need (`x = null`), reset deliberately. The full decision record, including what was rejected and why, is `docs/06-kernel-boundaries.zh-CN.md`.
- **Semicolons are optional wherever JavaScript/ASI permits omission.** The owned transform terminates source statements before inserting checkpoint snapshots; it does not change the user's parsed statement boundaries.
- **Top-level bindings can be redeclared across cells.** Earlier closures observe the newest binding. Assigning to a current `const` remains an error, and duplicate lexical declarations in one cell remain syntax errors.
- **Provider results are relayed, never rewritten.** If a server answers in content blocks, the cell sees content blocks.

MIT licensed.
