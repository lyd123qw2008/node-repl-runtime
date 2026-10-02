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

## Tier 10 own native audit probe (CI-built, non-production)

| Component | Source | License | Role |
| --- | --- | --- | --- |
| `native/win32-audit.cpp`, `native/verify-artifact.mjs` | This repository | MIT | Independently authored Windows x64 ABI / helper-only handle-list sentinel / helper-only Job-accounting oracle. Never a runtime launcher. |
| `.github/workflows/windows-acl-native-audit.yml` | This repository | MIT | Pinned `windows-2022` GitHub Actions compilation, self-test, manifest, and short-retention artifact workflow. |
| Windows SDK headers and MSVC compiler | GitHub-hosted Windows runner | Microsoft license / runner image terms | Compile-time ABI oracle only; no SDK/runtime payload is copied into this repository. |
| `actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09`, `actions/upload-artifact@330a01c490aca151604b8cf639adc76d48f6c5d4` | GitHub Actions | Action-specific upstream licenses | SHA-pinned CI checkout and artifact transfer actions. |

The tracked source is public because this repository is public. Only the narrow source
and workflow are pushed to branch `ci/windows-acl-native-audit`; downloaded EXEs,
artifact ZIPs, raw run output, and evidence remain outside Git. A local verifier
requires the exact artifact source commit, validates its manifest and hashes, and
still records `releaseEligible: false`.

## Tier 10 reference source (executed externally, never imported)

The optional Tier 10 runner invokes only the fixed source test below through a
caller-supplied clean DSH checkout. It imports no DSH package and records a
reference-only result:

- `packages/sandbox/sandbox-windows-acl/tests/control.spec.ts` — nested DSH
  runner/ACL-control reference. It checks final restricted payload marker
  consumption, denied filesystem write, normal stdout/stderr capture, and 256 KiB
  binary fd 7 echo.

## Planned Tier 20 source inventory (not imported by Tier 00/10)

The future owned source inventory begins from the DSH source revision observed during
this Phase 0 start:

```text
repository: https://github.com/deepseek-ai/deepseek-harness.git
revision:   f9d6609d182969c9f57499ef552edb78835cc4e4
license:    MIT for the TypeScript packages below
```

- `packages/sandbox/sandbox-windows-acl/src/{index,runner,acl,token,grant,path-boundary,workspace-sid,ffi,win32-abi}.ts`
- `packages/subprocess/win32-process/src/{abi,control-stdio,errors,ffi,koffi,process}.ts`
- `packages/subprocess/subprocess-local/src/{runner-launch,runner-protocol,spawn-runner,windows-job}.ts`

Before any Tier 20 source is copied, this manifest must be extended with exact
upstream paths, commit, preserved headers, local patches, equivalent tests, Koffi
pin/license, and any external ACL POC provenance.  A DSH checkout is never a
production dependency of node-repl-runtime.
