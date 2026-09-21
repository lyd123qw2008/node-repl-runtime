# @lyd123qw2008/node-repl-dsh-bootstrap

Creates the [node_repl runtime](https://www.npmjs.com/package/@lyd123qw2008/node-repl-runtime) from configuration alone and provides it to DeepSeek Harness as the `nodeReplRuntime` service, so that [`@lyd123qw2008/node-repl-dsh-adapter`](https://www.npmjs.com/package/@lyd123qw2008/node-repl-dsh-adapter) can register its two tools.

This package is the piece that was missing from a two-package design: the adapter alone never registers anything, because nothing provides the service it injects.

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

The package also ships a bundle patch (`dsh.bundle.patch`) that inserts both plugins. Do not use the bundle in a profile that composes its own patch, or the two will fight over the same entry ids.

## Provider configuration

Read from, in order:

1. `config.providers` on this plugin's entry,
2. `NODE_REPL_PROVIDERS` (inline JSON),
3. `NODE_REPL_PROVIDERS_FILE` (path to a JSON file).

An empty provider list is valid: the bootstrap starts an empty capability runtime, keeps
`js` / `js_reset` available, and reports an empty `cap` catalog. A provider with
`disabled: true` is skipped before its MCP server is started or connected. Initial
connection failures are non-fatal, matching the optional DSH MCP-client startup policy;
the failed provider contributes no capabilities and the error is logged.

Providers are machine-local facts (endpoints, project paths), which is why they belong in the profile patch or the environment rather than in a package. The load logs a self-proof line:

```text
[node-repl-runtime] mounted idea=67 blender=26 | disabled: cua
```

MIT licensed.
