# Phase 0 source manifest

## Tier 00: own, unconfined protocol fixture

| Component | Source | License | Role |
| --- | --- | --- | --- |
| `fixtures/fd7-worker.mjs`, `lib/unconfined-fd7.mjs`, test and runner | This repository | MIT | Node built-in-only reference transport fixture. |
| Node built-ins (`child_process`, `crypto`, `fs`, `net`, `os`, `path`, `stream`, `test`, `url`) | Node.js runtime | Node.js license | Standard library used only by the verifier. |

No Qwen or DSH source is copied or imported by Tier 00. Its fd 7 fixture remains
Node-built-in-only. Tier 10 separately declares an exact isolated Koffi dependency
and its own lockfile; Tier 00 does not import it.

## Tier 10 owned native binding preflight

| Component | Source | License | Role |
| --- | --- | --- | --- |
| `koffi@3.1.1` | <https://github.com/Koromix/koffi> | MIT | Isolated native FFI dependency for non-production ABI/binding preflight only. |

Its install hook is audited and individually allowed in `pnpm-workspace.yaml`; see
[provenance/THIRD_PARTY_NOTICES.md](provenance/THIRD_PARTY_NOTICES.md). No DSH
package, workspace link, or deep source import is used.

## CI-built own-source native audit probes (non-production)

| Component | Source | License | Role |
| --- | --- | --- | --- |
| `native/win32-audit.cpp`, `native/verify-artifact.mjs` | This repository | MIT | Independently authored Windows x64 ABI / helper-only handle-list sentinel / helper-only Job-accounting oracle. Never a runtime launcher. |
| `native/win32-owned-worker.cpp`, `fixtures/tier20-worker.mjs`, `scripts/run-owned-worker-probe.mjs`, fail-closed contract test | This repository | MIT | Independently authored non-production Tier 20 owned-worker feasibility probe; it uses Win32 APIs and Node built-ins, not DSH runtime packages or copied DSH source. |
| `.github/workflows/windows-acl-native-audit.yml` | This repository | MIT | Pinned `windows-2022` GitHub Actions compilation, self-test, manifest, minimum-Node check, and short-retention artifacts for Tier 10 and Tier 20 probes. |
| Windows SDK headers and MSVC compiler | GitHub-hosted Windows runner | Microsoft license / runner image terms | Compile the ABI helper and non-production Win32 worker probe; no SDK/runtime payload is copied into this repository. |
| `actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09`, `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020`, `actions/upload-artifact@330a01c490aca151604b8cf639adc76d48f6c5d4` | GitHub Actions | Action-specific upstream licenses | SHA-pinned CI checkout, Node 22.19.0 minimum-floor install, and artifact transfer actions. |

The tracked verifier source, docs, and workflow are public because this repository is
public. Only the non-production verification scope is pushed to branch
`ci/windows-acl-native-audit`; no production runtime package/default/profile is changed.
Downloaded EXEs, artifact ZIPs, raw run output, and evidence remain outside Git. The Tier 10
local artifact verifier still requires the exact source commit and validates its manifest
and hashes; all evidence records remain `releaseEligible: false`.

## Tier 10 reference source (executed externally, never imported)

The optional Tier 10 runner invokes only the fixed source test below through a
caller-supplied clean DSH checkout. It imports no DSH package and records a
reference-only result:

- `packages/sandbox/sandbox-windows-acl/tests/control.spec.ts` — nested DSH
  runner/ACL-control reference. It checks final restricted payload marker
  consumption, denied filesystem write, normal stdout/stderr capture, and 256 KiB
  binary fd 7 echo.

## Tier 20 own-source feasibility probe (non-production; not a runtime package)

The native worker, Node fixture, runner, and fail-closed contract are authored in this
repository and use only Windows APIs plus Node built-ins. The core probe passed in
read-only and workspace-write under Node `v22.23.3`
([37014751908](https://github.com/lyd123qw2008/node-repl-runtime/actions/runs/37014751908));
the expanded fd 0–7 plus external-path write/delete matrix passed under the minimum Node
`v22.19.0` ([37018555957](https://github.com/lyd123qw2008/node-repl-runtime/actions/runs/37018555957)).
Earlier minimum-floor runs are [37016397591](https://github.com/lyd123qw2008/node-repl-runtime/actions/runs/37016397591)
and [37015202534](https://github.com/lyd123qw2008/node-repl-runtime/actions/runs/37015202534).
This is `OWNED_WORKER_PROBE_PASS` for the **probe only**, not formal Tier 20 acceptance; `releaseEligible=false` and overall Phase 0
remains incomplete. Workspace-write requires both the temp capability and an additional
World `FILE_ALL_ACCESS` default-DACL ACE on the tested runner; stdout/stderr/dual-piped
cell-owned child spawns still return `EPERM`. The expanded probe also verifies all fd 0–7
are valid, external sibling-root file creation and deletion are denied, and the pre-created
outside sentinel remains readable. These facts and all non-claims are in
[native/README.md](native/README.md) and [evidence/RESULTS.md](evidence/RESULTS.md).

## Future upstream source inventory (not imported into the runtime)

If a later Phase 1 migration copies owned backend source, its upstream reference begins
from the DSH source revision observed during this Phase 0 work:

```text
repository: https://github.com/deepseek-ai/deepseek-harness.git
revision:   f9d6609d182969c9f57499ef552edb78835cc4e4
license:    MIT for the TypeScript packages below
```

- `packages/sandbox/sandbox-windows-acl/src/{index,runner,acl,token,grant,path-boundary,workspace-sid,ffi,win32-abi}.ts`
- `packages/subprocess/win32-process/src/{abi,control-stdio,errors,ffi,koffi,process}.ts`
- `packages/subprocess/subprocess-local/src/{runner-launch,runner-protocol,spawn-runner,windows-job}.ts`

Before any DSH/upstream source is copied into an owned runtime, this manifest must be
extended with exact upstream paths, commit, preserved headers, local patches, equivalent
tests, Koffi pin/license, and any external ACL POC provenance. The own-source Tier 20
feasibility fixture is not such a migration. A DSH checkout is never a production
dependency of node-repl-runtime.
