# Third-party notices — current Phase 0 verifier

## Tier 00 and verifier scripts

Tier 00's fd 7 fixture and its runner use only Node.js built-in modules; they do
not load Koffi or any DSH package/source. Node.js is distributed under its own
license; this verifier does not redistribute Node.

## Tier 10 external reference

Tier 10 executes a caller-supplied, clean DSH checkout only after verifying its
fixed source revision. It does not copy or link its source into this repository
and does not make DSH a node-repl-runtime dependency. The referenced DSH
TypeScript package sources are MIT at the recorded revision; see
[../SOURCE-MANIFEST.md](../SOURCE-MANIFEST.md).

## Koffi — Tier 10 native preflight dependency

- Package: `koffi@3.1.1`, exact isolated pin in this verifier's
  [`package.json`](../package.json) and [`pnpm-lock.yaml`](../pnpm-lock.yaml).
- License: MIT.
- Source repository: <https://github.com/Koromix/koffi>.
- Install hook audited before approval: `node ./cnoke.cjs -P . -D src/koffi --prebuild --release`.
- Build policy: [`pnpm-workspace.yaml`](../pnpm-workspace.yaml) permits **only**
  `koffi: true`; it does not approve all lifecycle scripts.

Koffi loading alone cannot establish a Windows security boundary. Its presence is
only a prerequisite for the future owned ABI and native binding probes.

## GitHub Actions / Microsoft Windows audit environment

- The Tier 10 native audit source is authored in this repository and is MIT under
  the repository [`LICENSE`](../../../LICENSE); it does not redistribute Windows
  headers, MSVC, the Windows SDK, or an upstream native helper.
- The public workflow pins `actions/checkout` and `actions/upload-artifact` by full
  source SHA. Their terms and licenses remain those of their respective upstream
  action repositories.
- GitHub-hosted Windows runner, MSVC, and Windows SDK use remain subject to GitHub
  Actions and Microsoft terms. The resulting short-retention executable is a raw
  machine-local evidence artifact and is never committed, packaged, or distributed
  as node-repl-runtime runtime code.

## Before Tier 20 source migration

Before copying/reimplementing any upstream Windows source, list its exact version,
license, source provenance, and any redistributed notice here. Do not add a range
or a dependency inherited from a DSH checkout.
