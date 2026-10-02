# Phase 0 execution record — 2026-10-02

This is a **non-production feasibility record**. It is not a release approval,
not an implementation of `sandboxHost: 'required'`, and not a statement that
Windows ACL confinement is available in node-repl-runtime.

## Result summary

| Tier | Command / source | Result | Allowed conclusion |
| --- | --- | --- | --- |
| `00-unconfined-node-fd7` | `corepack pnpm --dir verify/windows-acl test` | **PASS**: 7 transport/launch cases plus 12 Tier 10 preflight/reference fail-closed, ABI, or boundary cases and 1 Tier 20 fail-closed contract (20 total) | The owned Node-only fixture can use an explicit fd 7 protocol on this machine. It is unconfined. |
| `00-unconfined-node-fd7` evidence | `node scripts/run-unconfined-fd7.mjs` with an external `NODE_REPL_VERIFY_OUT` | **REFERENCE_PASS** | Node v24.15.0 x64 used real `node.exe`; the host-first version-1 handshake, marker consumption, state/reset, bounded output, and normal direct-child exit were observed. |
| `10-dsh-source-baseline` | pinned DSH `f9d6609d182969c9f57499ef552edb78835cc4e4`, `sandbox-windows-acl/tests/control.spec.ts` | **REFERENCE_PASS**: 3 tests | The external DSH nested runner reference can reach a final restricted Node payload with captured stdout/stderr and fd 7 binary control. It remains an external oracle only. |
| `10-ci-native-audit-artifact` | GitHub Actions run [`36996109769`](https://github.com/lyd123qw2008/node-repl-runtime/actions/runs/36996109769), then local hash/manifest/mode verification | **NATIVE_AUDIT_PASS**, reference-only | CI MSVC/Windows SDK independently compiled and self-tested ABI, OS handle-list sentinel, and bounded Job-zero-active accounting facts; no token/ACL/Node launcher support follows. |
| `10-native-abi-and-koffi-preflight` | `node scripts/run-native-preflight.mjs` | **UNSUPPORTED**, expected exit `2`; exact isolated Koffi x64 ABI/loadability sub-check passed | The owned Windows required path is fail-closed; a Koffi binding preflight is not token/ACL/Job evidence and no raw-Node fallback is authorized. |
| `20-owned-restricted-token-job` | GitHub Actions run [`37029476316`](https://github.com/lyd123qw2008/node-repl-runtime/actions/runs/37029476316) (`v22.19.0`, exact SID/DACL/Low/pipe inspectors, ordered TokenDefaultDacl ACE snapshots, fd 0–7 and outside-path matrix); earlier `v22.23.3` core run [`37014751908`](https://github.com/lyd123qw2008/node-repl-runtime/actions/runs/37014751908) | **OWNED_WORKER_PROBE_PASS (not formal Tier 20 acceptance)**, both `read-only` and `workspace-write`; artifact reports `releaseEligible=false`, `confinement=enforcement=partial` | Proves only the enumerated fixture facts; it is not Phase 0 overall acceptance or a runtime backend. External sibling-root write/delete are denied, and protected DACL masks/cross-capability exclusion plus default-DACL ACE order/masks/flags are queried. The probe write-mode TokenDefaultDacl still has a probe-only World ACE that diverges from the measured DSH runner. Cell-owned piped child stdio is a DSH-documented unsupported boundary, not a Phase 0 blocker. |
| Existing runtime regression | root `pnpm test` | **PASS**: 59 runtime, 15 adapter, 9 bootstrap tests | The isolated `verify/` addition did not alter the existing workspace build/test result. |

Raw JSON observations are machine-local and intentionally ignored. They are
written beneath the caller-selected `NODE_REPL_VERIFY_OUT` (or the verifier's
ignored `spike/` default); only the vocabulary and this summary are tracked.

## Tier 00 facts and boundaries

The `REFERENCE_PASS` observation recorded all of the following on the current
Windows x64 host:

- real Node executable `node.exe`, v24.15.0 (the Node 22.19.x support floor has **not** yet been rerun);
- a duplex channel at fd 7 using max 16 KiB JSON-line frames;
- host-first `hello` / correlated `ready`, version `1`;
- `NODE_REPL_KERNEL_CONTROL=pipe` was visible at startup and absent after the
  worker consumed it;
- injected parent sentinel, DSH control marker, and `NODE_OPTIONS` were absent;
- a fixture-local state value persisted and was absent after its explicit reset;
- stdout and stderr collectors bounded 8 KiB fixture output to 1 KiB each; and
- the direct worker exited normally after the mutual close sequence.

The same suite fail-closed on an oversized frame, missing ready deadline, wrong
protocol version, malformed JSON, and unexpected full control EOF.  On this
host, a child-first fd 7 write did not become observable until the parent first
wrote; the protocol treats the host-first `hello` as a required transition.
A worker `end()` is a write-half close, not a host EOF, so normal shutdown uses
acknowledged mutual close and an error EOF test uses full destroy.

### Mandatory non-claims

Tier 00 has `confinement: none` and `enforcement: none`. It does **not** prove a
restricted token, ACL/DACL/Low-integrity state, capability SID, private temp
root, OS handle inheritance allowlist, Job ownership, `treeExited`, or a closed
worker environment. Windows Node materialized ambient `TMP`/`TEMP` even though
the requested child block did not contain them; the observation records that
fact rather than claiming an allowlisted per-lease environment.

## Tier 10 reference-only result

The source-pinned external DSH test passed on a clean DSH checkout before and
after its recorded execution. Its test contract verifies final-payload marker
consumption, a denied write, ordinary stdout/stderr capture, and a 262,144-byte
binary fd 7 echo through DSH's nested current-token Job runner and ACL argv runner.
The wrapper rechecks cleanliness for every invocation; it reports `UNSUPPORTED`
rather than touching a checkout that has later uncommitted work.

It does **not** prove an owned direct final-worker process/Job, own explicit
`CreateProcessAsUserW` environment delivery, native handle allowlisting, or final
restricted-job quiescence before temporary grant revocation. These missing facts
are not waived by a reference pass.

### Pinned DSH token/default-DACL comparison

The initial `run-dsh-token-snapshot.mjs` reference launched the exact pinned DSH ACL runner
on local Windows x64 / Node `v24.15.0` in both modes, then queried the actual final token's
restricting-SID set, Low integrity, and ordered `TokenDefaultDacl` ACEs. The selected ACL /
token / runner / test source files were clean at DSH revision
`f9d6609d182969c9f57499ef552edb78835cc4e4`, but that caller worktree had unrelated changes
including the lockfile; the initial dependency install was therefore not claimed as wholly
clean or lock-pinned. In round 2, a fresh detached clone at the same revision completed a
frozen `pnpm@11.7.0` install and a workspace-write-only Node `v24.15.0` snapshot. The current
runner now hashes and requires the root package/workspace/lock manifests clean as well as
the ACL/token/runner/test source set.

Observed DSH default-DACL ACE at index 0: read-only grants World `FILE_ALL_ACCESS`
(`0x001f01ff`); workspace-write grants the private-temp capability the same mask and has
no extra World full-access ACE. Both DSH ACEs have inheritance flags `0x03` (object +
container). The same DSH target reports `[logon, World]` in read-only and adds workspace /
temp capability SIDs in workspace-write, with Low RID 4096. In write mode its `TMP` and
`TEMP` point beneath the provided temp root; in read-only they do not. DSH's pinned
`runner.spec.ts` and `control.spec.ts` also passed locally (19 and 3 tests respectively),
including host-side output capture/fd 7 and the documented grandchild `pipe: EPERM`.

The exact probe `TokenDefaultDacl` ACE lists are now included in CI evidence
[`37029476316`](https://github.com/lyd123qw2008/node-repl-runtime/actions/runs/37029476316):
its read-only index 0 is World/full with flags 0; workspace-write index 0 is
Temp-capability/full with flags 0 and index 1 is World/full with flags 0. Therefore the
probe remains different from the DSH source in default-DACL trustee set/order, inheritance
flags, environment construction, launch path, and Node/runner context. Local DSH success at Node `v24.15.0`
does not identify why the earlier hosted Node `v22.19.0` probe required its extra World
ACE. No replacement ACL recipe is inferred; see
[DSH-COMPARISON.md](DSH-COMPARISON.md) for the exact source and test matrix.

### Bounded A1–A5 workspace-write differential (single CI run)

The next and only planned compatibility experiment is one sequential matrix on one
`windows-2022` runner under Node `v22.19.0`; the DSH source is fetched at pinned revision
`f9d6609d182969c9f57499ef552edb78835cc4e4` and installed with its frozen lockfile. A1 runs
the real DSH workspace-write runner. A2 and A3 reuse the existing direct Tier 20 worker,
changing only (respectively) the temp ACE flags to `0x03` or the environment API to
DSH-style parent inheritance. A4 is temp-only / flags 0 / explicit-environment failure
control. A5 is the existing temp+World / flags 0 / explicit-environment pass control
from the same job. No new ACL/Job/handle mechanism is added; the diagnostic selector
defaults preserve the old probe path.

The matrix is valid only if A4 reproduces Node status `0xC0000142` and A5 passes. A1/A2/A3
outcomes are interpreted exactly by the user stop rule. No retry or second guessed ACL
variant will follow an inconclusive or completed matrix. Cell-owned piped stdio is not in
any go/no-go predicate. Until the artifact is inspected, this experiment changes no
acceptance state and authorizes no product workaround.

## CI-built native audit reference

To avoid installing MSVC Build Tools or a Windows SDK locally, the public narrow
workflow [`windows-acl-native-audit.yml`](../../.github/workflows/windows-acl-native-audit.yml)
compiles the own-source probe on `windows-2022`. The source and workflow were pushed
only to the explicit public branch `ci/windows-acl-native-audit`; no release,
published package, production runtime source, DSH checkout, or profile was changed.

The final reviewed run is [`36998074826`](https://github.com/lyd123qw2008/node-repl-runtime/actions/runs/36998074826), dispatched against the same published branch and commit that contains this verifier:

- source commit: `94b34a07e637313abecb926351f872d7131c5a60`;
- runner: Windows Server 2022 / `windows-2022`, x64, image `20260927.320.1`;
- compiler: MSVC `19.44.35229` / Windows SDK `10.0.26100.0`;
- executable: `177,664` bytes, SHA-256
  `4520186c6e25f756fd0327a28a75cbbe531efd88f6b938076262a2d861ca38a6`;
- GitHub artifact archive SHA-256:
  `0e91105e41ba55177d2fd3e341027bb3346251727e907037dbe5bdb04ea80257`;
- artifact ID `11221703622`, retained only through 2026-10-09;
- CI and local re-execution both passed `abi`, `handle-sentinel`, and
  `job-settlement`.

The local verifier requires that exact source commit **and independently recorded
executable SHA-256**, exactly the three expected artifact files, a <=2 MiB
executable, manifest/compiler/SDK/runner checks, both embedded SHA-256 checks, and
all three local modes before writing `NATIVE_AUDIT_PASS`. The final raw local
evidence is
`C:\Users\32664\AppData\Local\node-repl-runtime-phase0\20261002T105600Z-bbabcaaa0ade44f1aec69cfce650872e\evidence\10-ci-native-audit-artifact\evidence.json`.

This removes the **local compiler installation** gap only. It provides a small,
independent Windows-header/handle-list/Job-accounting oracle, not an owned sandbox
backend. The probe does not create a restricted token or ACL lease, launch Node,
prove target fd 3–7 carriage, prove an explicit `CreateProcessAsUserW` environment,
or prove a future final worker tree settles before capability-grant revocation.

## Owned Windows gate status

The Tier 20 owned-worker feasibility probe passes, but the Windows ACL backend/modes
and overall Phase 0 remain **unsupported / not accepted**:

| Backend / mode | Status | Remaining required facts |
| --- | --- | --- |
| Windows ACL / read-only | **unsupported** | final installed/packed engine and supervisor integration; full versioned worker/runner protocol and crash/EOF/terminate/reset matrix; final product preflight, concurrent-owner/broker and bridge-lifecycle gates; document/validate all partial boundaries |
| Windows ACL / workspace-write | **unsupported** | all read-only gaps plus source-aligned TokenDefaultDacl / final launch semantics (the probe-only World ACE and flags-0 ACEs diverge from the measured DSH temp-capability inheritable ACE; run a controlled same-Node/same-runner differential before deciding what to migrate), standing workspace grant/recovery/revocation semantics, and complete capability-SID negative regression |

The Tier 20 artifact itself is **not** a Windows ACL backend or formal Tier 20 acceptance.
It is a throw-away native/Node feasibility fixture, with `confinement=enforcement=partial`
and `releaseEligible=false`. It shows that a real restricted Node can launch in both
modes on Node `v22.19.0` and `v22.23.3`, that the exact restricted-SID set, protected
DACLs, queried ACE masks/cross-capability exclusion, Low labels, default-DACL ACEs,
explicit environment, handle allowlist/sentinel, fd 0–7, fd3/4–6 carriers, and fd3/fd7
pipe types are observable. It also records mode-specific root writes, outside-path
write/delete denials, Job assignment/settlement, and cleanup after quiescence. Ordinary
`stdio: 'ignore'` child creation settles; stdout-only, stderr-only, and dual-piped child
stdio return `EPERM`.

An earlier hosted Windows 2022 / Node `v22.19.0` probe matrix observed Node `0xC0000142`
with a TokenDefaultDacl that only added the private-temp capability. A passing variant
added World `FILE_ALL_ACCESS`. This was only correlation in a different launch/runtime
context; the current pinned DSH workspace-write final token uses an inheritable temp-only
full-access ACE on local Node `v24.15.0`. The DSH-aligned same-Node/same-host differential
is still required before naming a cause or choosing a replacement. Treat the probe World
ACE as an unresolved test-only divergence—not a production candidate—and do not infer
that the failure is an access to a specific object. This evidence does not enable
`sandboxHost: 'required'`.

The first queried DACL run also found capability ACE inheritance on staged files. The
final fixture applies `PROTECTED_DACL_SECURITY_INFORMATION` to roots and staged files,
then verifies `SE_DACL_PROTECTED`, exact workspace/temp grant masks, World write/delete
absence (including `FILE_DELETE_CHILD`), and absence of the unrelated capability SID.

The separate `node scripts/run-native-preflight.mjs` still deliberately exits `2`:
its report-only/preflight inputs do not include the CI-owned-worker executable or a
configured disposable `NODE_REPL_VERIFY_ACL_ROOT`. A previous external NTFS root only
passed the Node-level canonical/reparse/repository-and-evidence-disjoint checks and
remains `PENDING_OWNED_ACL_PROBE`; volume/owner/ACL/preflight, junction behavior, and
full path disjointness remain open. The Koffi sub-check also remains only ABI/loadability
proof and invokes none of the bound token/ACL/Job APIs.

A local `cl.exe`, `g++.exe`, or `clang++.exe` installation is no longer required for
the Tier 20 probe because CI compiles the native fixture. That CI pass does not replace
the outstanding final-engine, protocol, lifecycle, bridge, concurrency, and preflight
acceptance cases.

## Next permitted work

Keep production/default host behavior unchanged and retain fail-closed semantics. Before
any Windows ACL backend or `sandboxHost: 'required'` support claim, complete the remaining
Phase 0 matrix with a real installed/packed engine, runner crash/IPC disconnect/terminate
and protocol/reset cases, concurrent-owner isolation, capability broker and DSH bridge
lifecycle tests, ACL-capable-volume/owner/reparse/canonical-disjoint preflight, and
negative ACL/SACL/recovery regressions. Separately review whether the World default-DACL
compatibility ACE can be narrowed without breaking Node startup and without broadening
object access. See [matrix-template.md](matrix-template.md), [CLAIMS.md](CLAIMS.md), and
[../SOURCE-MANIFEST.md](../SOURCE-MANIFEST.md).
