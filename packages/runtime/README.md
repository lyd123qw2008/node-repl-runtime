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

## Install

```bash
npm install @lyd123qw2008/node-repl-runtime
```

Node 22.19+ is required. The kernel itself is the Apache-2.0 [`@qwen-code/node-repl-mcp`](https://www.npmjs.com/package/@qwen-code/node-repl-mcp); this package drives it, projects MCP catalogs into it, and owns the provider side.

## API

| | |
| --- | --- |
| `createCapabilityRuntime(options)` | Attach providers, start the kernel, return the runtime. |
| `runtime.js(code, { timeoutMs, title })` | Run one cell. Returns `{ status, output, error?, durationMs }`. |
| `runtime.jsReset()` | Discard bindings and re-install the catalog. |
| `runtime.catalog()` | The projected operations per provider (`{ id, label, operations }`). |
| `runtime.dispose()` | Close kernels, the bridge, and every MCP session. |
| `applyInjection(injected, args)` | Merge host-owned arguments, refusing caller-supplied ones. |

Provider configuration is generic: `id`, `label`, `transport` (`streamable-http` | `stdio`), `url`/`command`+`args`, `env`, optional `inject` (host-owned constants removed from the model-visible schema), and optional `include` narrowing. A provider that fails to attach does not take the others down.

`node packages/runtime/dist/cli.js --id idea --url <endpoint>` attaches one server from the command line; without `--code` it prints the projected catalog.

## Boundaries, stated honestly

- **Not a sandbox.** The kernel gives lifecycle and namespace isolation; imported code and Node built-ins run with normal Node permissions.
- **Top-level statements need an explicit `;`.** The kernel injects snapshot code at each statement boundary, so a missing semicolon fails the whole cell with `SyntaxError: Unexpected identifier '__qwen_repl_..._snapshot'`. This is an upstream kernel behaviour, not a facade rule; see `docs/03-integration-spec.zh-CN.md` in the repository for the source-level analysis.
- **`let`/`const` cannot be re-declared across cells** (`var` can), which is why cells that reuse a name should use `var`.
- **Provider results are relayed, never rewritten.** If a server answers in content blocks, the cell sees content blocks.

MIT licensed.
