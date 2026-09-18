# @lyd123qw2008/node-repl-dsh-adapter

The **two-tool face** for the [node_repl runtime](https://www.npmjs.com/package/@lyd123qw2008/node-repl-runtime) on DeepSeek Harness: the model sees exactly `js` and `js_reset`, however many MCP operations sit behind them.

```text
js         run JavaScript in one persistent kernel; discovers capabilities itself
js_reset   discard kernel state; the catalog is re-installed immediately
```

Tool-declaration cost therefore stops growing with the catalog: a server exposing 67 operations costs the same as one exposing 1.

## Mounting

This package only consumes the runtime — it declares `inject: ['tools', 'nodeReplRuntime']` and stays **pending**, registering nothing, until something provides that service. Pair it with [`@lyd123qw2008/node-repl-dsh-bootstrap`](https://www.npmjs.com/package/@lyd123qw2008/node-repl-dsh-bootstrap), which creates the runtime and provides it:

```yaml
- insert:
    - id: node-repl-runtime-bootstrap
      name: '@lyd123qw2008/node-repl-dsh-bootstrap'
      config:
        providers:
          - id: idea
            label: IntelliJ IDEA
            transport: streamable-http
            url: http://127.0.0.1:64342/stream
    - id: node-repl-runtime-face
      name: '@lyd123qw2008/node-repl-dsh-adapter'
```

Which servers to attach, and which arguments are host-owned, are composition decisions and deliberately do not live in this package.

The `js` description is the API documentation for the whole face — it carries discovery (`capHelp`, `cap.describe`), the output rule (`nodeRepl.write`), binding rules, and the kernel's semicolon requirement. Treat changes there as interface changes.

MIT licensed.
