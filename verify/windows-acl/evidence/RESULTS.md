# Phase 0 execution record — 2026-10-02

This is a **non-production feasibility record**. It is not a release approval,
not an implementation of `sandboxHost: 'required'`, and not a statement that
Windows ACL confinement is available in node-repl-runtime.

## Result summary

| Tier | Command / source | Result | Allowed conclusion |
| --- | --- | --- | --- |
| `00-unconfined-node-fd7` | `corepack pnpm --dir verify/windows-acl test` | **PASS**: 7 transport/launch cases, 12 Tier 10 preflight/reference fail-closed/ABI/boundary cases, 2 Tier 20 fail-closed contracts, and 4 matrix classifier/artifact contracts (25 total) | The owned Node-only fixture can use an explicit fd 7 protocol on this machine. It is unconfined. |
| `00-unconfined-node-fd7` evidence | `node scripts/run-unconfined-fd7.mjs` with an external `NODE_REPL_VERIFY_OUT` | **REFERENCE_PASS** | Node v24.15.0 x64 used real `node.exe`; the host-first version-1 handshake, marker consumption, state/reset, bounded output, and normal direct-child exit were observed. |
| `10-dsh-source-baseline` | pinned DSH `f9d6609d182969c9f57499ef552edb78835cc4e4`, `sandbox-windows-acl/tests/control.spec.ts` | **REFERENCE_PASS**: 3 tests | The external DSH nested runner reference can reach a final restricted Node payload with captured stdout/stderr and fd 7 binary control. It remains an external oracle only. |
| `10-ci-native-audit-artifact` | GitHub Actions run [`36996109769`](https://github.com/lyd123qw2008/node-repl-runtime/actions/runs/36996109769), then local hash/manifest/mode verification | **NATIVE_AUDIT_PASS**, reference-only | CI MSVC/Windows SDK independently compiled and self-tested ABI, OS handle-list sentinel, and bounded Job-zero-active accounting facts; no token/ACL/Node launcher support follows. |
| `10-native-abi-and-koffi-preflight` | `node scripts/run-native-preflight.mjs` | **UNSUPPORTED**, expected exit `2`; exact isolated Koffi x64 ABI/loadability sub-check passed | The owned Windows required path is fail-closed; a Koffi binding preflight is not token/ACL/Job evidence and no raw-Node fallback is authorized. |
| `20-owned-restricted-token-job` | GitHub Actions run [`37029476316`](https://github.com/lyd123qw2008/node-repl-runtime/actions/runs/37029476316) (`v22.19.0`, exact SID/DACL/Low/pipe inspectors, ordered TokenDefaultDacl ACE snapshots, fd 0–7 and outside-path matrix); earlier `v22.23.3` core run [`37014751908`](https://github.com/lyd123qw2008/node-repl-runtime/actions/runs/37014751908) | **OWNED_WORKER_PROBE_PASS (not formal Tier 20 acceptance)**, both `read-only` and `workspace-write`; artifact reports `releaseEligible=false`, `confinement=enforcement=partial` | Proves only the enumerated fixture facts; it is not Phase 0 overall acceptance or a runtime backend. External sibling-root write/delete are denied, and protected DACL masks/cross-capability exclusion plus default-DACL ACE order/masks/flags are queried. The probe write-mode TokenDefaultDacl still has a probe-only World ACE that diverges from the measured DSH runner. Cell-owned piped child stdio is a DSH-documented unsupported boundary, not a Phase 0 blocker. |
| `20-workspace-write-differential` | One-shot GitHub Actions run [`37038295237`](https://github.com/lyd123qw2008/node-repl-runtime/actions/runs/37038295237) (`windows-2022`, Node `v22.19.0`) | **MATRIX_INCONCLUSIVE**; A1 failed its ignored-grandchild check with `0xC0000142`; A2/A3/A4 native statuses were `FAIL`; same-job A5 evidence passed | Stop using Windows workspace-write as a Phase 0 primary route. The artifact collector overwrote matrix details and the A5 aggregate check used the wrong field path, so A4's exact status/root cause is not established; no rerun is authorized. |
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

### Bounded A1–A5 workspace-write differential (one CI run; inconclusive)

The one sequential matrix ran on a single `windows-2022` runner under Node `v22.19.0`,
with DSH revision `f9d6609d182969c9f57499ef552edb78835cc4e4` installed from its frozen
lockfile: [run 37038295237](https://github.com/lyd123qw2008/node-repl-runtime/actions/runs/37038295237).
A1 invoked the real DSH workspace-write runner. A2/A3 used the existing direct Tier 20
worker with temp-only ACE flags `0x03` or the DSH-style inherited environment. A4 was the
temp-only / flags-0 / explicit-environment control. A5 reused the same-job existing
Tier 20 temp+World / flags-0 evidence; it was not launched twice. No production/default
behavior changed.

**Observed A1:** the top-level DSH token-inspector Node `v22.19.0` process exited 0 and
matched the expected restricted SID set, Low RID 4096, temp-capability `FILE_ALL_ACCESS`
default ACE with flags `0x03`, no World full-access ACE, and TMP/TEMP under the private
temp root. However, the fixture's `stdio: 'ignore'` grandchild exited `3221225794`
(`0xC0000142`), so A1's inherited/ignored-child gate failed. The `stdio: 'pipe'`
grandchild returned `EPERM`, but that check was recorded as diagnostic only and did not
cause A1's failure. A2, A3, and A4 were summarized as native `FAIL`; the run summary did
not retain enough per-case JSON to certify each direct failure detail or A4's exact exit
code.

**A5 control:** the separately uploaded same-job evidence is `OWNED_WORKER_PROBE_PASS`
with temp/full/flags-0 at default-DACL index 0 and World/full/flags-0 at index 1; job
assignment, settlement, quiescent revocation, and cleanup are true. The differential
aggregator nevertheless returned `MATRIX_INCONCLUSIVE`: its A5 validator looked for
`targetAssignedToJob` and `jobSettled` at the wrapper level rather than inside the
`native` result. In addition, CI copied both `evidence.json` files to the same artifact
filename, so the DSH snapshot overwrote the matrix's detailed A2–A4 records. Therefore
the same-run A4 control cannot be certified from the retained artifact, even though its
native status was `FAIL`.

After the run was interpreted, the local matrix collector was corrected so future outputs
use distinct DSH/matrix/A5 artifact filenames and the A5 predicate reads nested native Job
assignment/settlement facts. Pure classifier regression tests cover the observed A1 failure,
valid A5 nested evidence, and fail-closed missing-Job evidence. These post-run fixes do not
repair or replace the missing evidence from run `37038295237`; the matrix was not repeated.

**Decision:** apply the fail-closed stop rule—Windows workspace-write remains unsupported
and is not a Phase 0 primary route. A1 did not pass because a Node 22.19 grandchild using
`stdio: 'ignore'` failed with `0xC0000142`; A2/A3 also reported `FAIL`, and no narrow
candidate was observed. Do not infer the cause of the original direct A4 startup failure:
the matrix is inconclusive because the A4 detail was not retained. No second run or
additional guessed ACL variant will be made. Piped-grandchild `EPERM` remains outside the
go/no-go decision. Formal Tier 20 and Phase 0 remain **NOT ACCEPTED**; keep
`sandboxHost: required` unsupported/fail-closed.

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
| Windows ACL / workspace-write | **unsupported; stopped as the Phase 0 primary route** | A1 failed in the one-shot Node 22.19 DSH run (`stdio: 'ignore'` grandchild status `0xC0000142`); A2/A3/A4 summary statuses were `FAIL`, with A4 detail not retained. Do not infer cause or migrate the probe World ACE. Remaining product gaps include standing workspace grant/recovery/revocation semantics and complete capability-SID negative regression. |

The Tier 20 artifact itself is **not** a Windows ACL backend or formal Tier 20 acceptance.
It is a throw-away native/Node feasibility fixture, with `confinement=enforcement=partial`
and `releaseEligible=false`. It shows that a real restricted Node can launch in both
modes on Node `v22.19.0` and `v22.23.3`, that the exact restricted-SID set, protected
DACLs, queried ACE masks/cross-capability exclusion, Low labels, default-DACL ACEs,
explicit environment, handle allowlist/sentinel, fd 0–7, fd3/4–6 carriers, and fd3/fd7
pipe types are observable. It also records mode-specific root writes, outside-path
write/delete denials, Job assignment/settlement, and cleanup after quiescence. In the
owned-worker fixture, ordinary `stdio: 'ignore'` child creation settles; stdout-only,
stderr-only, and dual-piped child stdio return `EPERM`. This is distinct from DSH A1 in
the one-shot minimum-Node run: there, the ignored grandchild exited `0xC0000142` and A1
failed its child-settlement check.

A one-shot same-runner / Node `v22.19.0` A1–A5 comparison was run (details above). A1 did
not pass, A2/A3/A4 were summarized `FAIL`, and the matrix stayed inconclusive because
A4's details were overwritten in artifact collection and the A5 aggregate predicate read
lifecycle fields at the wrong nesting level. This is sufficient to stop treating Windows
workspace-write as a Phase 0 primary route under the user's stop rule, but not sufficient
to identify the startup failure's cause. No rerun or guessed ACL variant is authorized.
The probe World ACE remains an unresolved test-only divergence, not a production candidate;
do not infer an access to a specific object. This evidence does not enable
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

Keep production/default host behavior unchanged and retain fail-closed semantics. The
A1–A5 differential was run once and is closed: do not rerun it, add guessed ACE variants,
or treat the World-ACE probe path as a product candidate. Phase 0 can still progress on
independent gates without changing production behavior: launch an actual installed/packed
engine; complete runner crash/IPC disconnect/terminate and protocol/reset cases; test
concurrent-owner isolation, capability-broker and DSH-bridge lifecycle; exercise
ACL-capable-volume/owner/reparse/canonical-disjoint preflight; and add negative ACL/SACL/
recovery regressions. Windows ACL `read-only` and `workspace-write` remain unsupported,
and no backend or `sandboxHost: 'required'` support claim is authorized until its full
mode-specific gate passes. See [matrix-template.md](matrix-template.md), [CLAIMS.md](CLAIMS.md),
and [../SOURCE-MANIFEST.md](../SOURCE-MANIFEST.md).
