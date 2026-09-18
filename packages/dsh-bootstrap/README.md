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

**Finding nothing is a load failure, not an empty runtime.** A profile that silently came up with no capabilities would look like a working setup and quietly do nothing.

Providers are machine-local facts (endpoints, project paths), which is why they belong in the profile patch or the environment rather than in a package. The load logs a self-proof line:

```text
[node-repl-runtime] mounted idea=67 | host-owned args injected: projectPath
```

MIT licensed.
