# Qwen kernel source provenance

## Base snapshot

- Upstream repository: <https://github.com/QwenLM/qwen-code>
- Upstream package path: `packages/node-repl`
- Published baseline: `@qwen-code/node-repl-mcp` `0.1.6`
- Source revision: `b7543aeb1bd58537a2216253e8ba5020d4814c9c`
- License: Apache-2.0; the upstream package `LICENSE` is retained in this directory.
- Scope imported: Qwen's Node REPL package source, tests, runtime `.mjs` files, build/test setup, package license, and packaging scripts. Qwen CLI, skills, computer-use/browser SDKs, desktop relay, and Qwen Code core are not included.

The version `0.1.7` visible on upstream GitHub `main` was not the npm-published baseline when this snapshot was selected. Do not silently advance the source base to `main`; review upstream changes and backport individually.

## Local package identity

The source is maintained here as `@lyd123qw2008/node-repl-kernel-engine`. Its version and repository metadata are local. The source-level Qwen copyright/SPDX headers are intentionally retained. The npm MCP wrapper and worker lifecycle are currently included as a compatibility layer; their later extraction is a separate change.

## Local patch ledger

- **Vendor baseline (commit `db23a9b`):** copied from the source revision above. Package identity/scripts are adapted to this workspace.
- **P0-A, snapshot statement terminator (commit `db23a9b`):** `src/cell-transform.ts` inserts a statement terminator before generated snapshot assignments at each parsed source-item boundary. Files: `src/cell-transform.ts`, `src/cell-transform.test.ts`, `src/node-repl.semantics.test.ts`. Tests cover ASI/newline, line/block comments, tagged templates, and no-final-semicolon cells against the real kernel. Related upstream issue [#12167](https://github.com/QwenLM/qwen-code/issues/12167) and unmerged PR [#12168](https://github.com/QwenLM/qwen-code/pull/12168) were reviewed as references; the PR diff was not copied wholesale.
- **P0-B, cross-cell redeclaration (commit `db23a9b`):** current top-level declarations can replace a prior binding; stable reference objects rebind to the new cell's lexical binding, and previous closures dereference that same object. Reference accessor state is captured/restored at statement checkpoints and cell-entry cancellation. Files: `src/cell-bindings.ts`, `src/cell-transform.ts`, `src/runtime/kernel.mjs`. Regression tests in `src/kernel-manager.test.ts` and `src/node-repl.semantics.test.ts` cover `let`/`const`/`var`, function/class, same-cell duplicate lexical errors, const assignment, closure visibility, partial errors, cancellation, and reset.

When a local patch lands, append its commit/hash, upstream/local files touched, reason, and regression tests here.

## Maintenance procedure

1. Keep the source baseline and local patches distinguishable in history and in this ledger.
2. On an upstream release or relevant upstream fix, compare the exact upstream package subtree with this directory; do not overwrite local patches with a wholesale copy.
3. Review semantics and license notices for each backport; add a regression test before adopting behavior.
4. Run the kernel package test/typecheck/build, then this repository's runtime/adapter/bootstrap tests and the MCP/provider integration checks.
5. State explicitly in release notes that this is a maintained Qwen-derived Node kernel, not an upstream-supported package and not an OS sandbox.
