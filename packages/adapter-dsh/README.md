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

## Presentation: program-first

A call shows the model-authored `title` (falling back to the code's first non-empty line) with the whole program as `rawInput`, and the completed card carries what the cell wrote, **in order**. That shape is a requirement, not a cosmetic default:

- **The program is the unit of intent.** Order, loops and conditions are where the "why" lives, so a run reads as a script — never as a trace.
- **An execution trace must never be a list detached from the program.** If nested provider calls are shown at all, anchor them to the program's own lines (or leave them out). A flat `tool · first-argument` row per call loses the flow and becomes unreadable at catalog scale — measured 2026-09-28 on a 67-operation server driven through PTC's `run_code`: one inspection rendered as nine detached `cap_help` / `cap_call` rows beside the script card, with nothing tying a row to the line that issued it.
- **Anything shown to the human beyond the model-facing `content` belongs in `presentationMeta` + `presentResult`** (UI-only, persisted with the session log) so the trace costs no model tokens.

Not implemented: the kernel-side per-call source line (`nr-cap` capturing a stack frame at dispatch time) that would let a call log be anchored to the program. Today the trace is simply not shown.

MIT licensed.
