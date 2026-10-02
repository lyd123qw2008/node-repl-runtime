# Windows native audit probe (non-production)

`win32-audit.cpp` is a deliberately small, own-source Windows x64 evidence helper.
GitHub Actions compiles it with the Microsoft toolchain on `windows-2022`; a local
Windows verifier may download the exact run artifact, validate its manifest and
SHA-256, and execute the three explicit modes.

## Modes

| Mode | What it checks | What it does **not** establish |
| --- | --- | --- |
| `abi` | Windows-header `sizeof` / `offsetof` facts for the narrow records used by the planned launcher. | That a JavaScript/Koffi launcher uses those records correctly. |
| `handle-sentinel` | An inheritable event listed in `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` reaches a child, while a second inheritable sentinel omitted from that list is invalid in the child. | That the future restricted Node target receives only that list, or that fd 4–7 are wired correctly. |
| `job-settlement` | A target is created suspended, assigned to a private Job, resumed, exits, and the Job reports zero active processes under a bounded accounting poll. `TotalTerminatedProcesses` is diagnostic only because voluntary exit need not increment it. | Restricted-token ownership, final worker-tree settlement, or safe grant revocation in the future launcher. |

The probe does **not** create a restricted token, apply a DACL/Low-integrity label,
create workspace/private-temp grants, or operate as a sandbox launcher. A successful
artifact is only independent native evidence for the individual facts above. It never
changes the `unsupported` state of either Windows ACL mode by itself.

## Tier 10 artifact contract

The workflow uploads a short-retention artifact containing only:

```text
node-repl-win32-audit.exe
manifest.json
SHA256SUMS.txt
```

`manifest.json` records the source commit, workflow ref, runner image, compiler/SDK
metadata, tested modes, and the SHA-256 of the executable. The local consumer must
supply independently recorded exact source-commit **and executable SHA-256** values,
require exactly these three regular files, reject an executable over 2 MiB, verify
both hashes and all manifest fields before execution, and write only a non-release
evidence record. This prevents a substituted executable plus a self-consistent
replacement manifest from satisfying the contract. Artifacts, downloaded executables,
and raw evidence remain outside Git.

No DSH source, runtime package, credentials, or workspace contents are sent to the
workflow. The source and workflow are public because the repository is public.

## Tier 20 owned-worker feasibility probe (non-production)

`win32-owned-worker.cpp` is a separate native probe; it does not change the
production launcher or `sandboxHost` support state. The dedicated CI job compiles it
and runs the final `node.exe` fixture in both `read-only` and `workspace-write` modes.
The probe has passed on both the Windows runner Node (`v22.23.3`, core matrix run
[37014751908](https://github.com/lyd123qw2008/node-repl-runtime/actions/runs/37014751908))
and project minimum (`v22.19.0`, exact SID/DACL/Low/pipe inspectors plus fd/outside-path
matrix run [37022202477](https://github.com/lyd123qw2008/node-repl-runtime/actions/runs/37022202477);
previous expanded run [37018555957](https://github.com/lyd123qw2008/node-repl-runtime/actions/runs/37018555957)
and earlier minimum runs [37016397591](https://github.com/lyd123qw2008/node-repl-runtime/actions/runs/37016397591),
[37015202534](https://github.com/lyd123qw2008/node-repl-runtime/actions/runs/37015202534)).
The Tier 20 short-retention CI artifact contains the compiled fixture executable and its
`evidence.json`; raw artifacts are not committed.

The probe records an exact restricted-SID set and Low-integrity token, protected
workspace/temp/staged-file DACLs with queried grant masks, World write/delete denial and
cross-capability SID absence, queried Low labels, explicit environment filtering, the
final token's ordered default-DACL ACE type/flags/mask/trustee-class list, inherited-handle
sentinel exclusion, UCRT fd 0–7 table, fd3/4–6 traffic and verified fd3/fd7 pipe types,
suspended creation → Job assignment → resume, ordinary child-process Job settlement,
mode-specific root writes, external path write/delete denial, and grant cleanup only
after Job quiescence. Its
`OWNED_WORKER_PROBE_PASS` status applies only to this owned-worker feasibility probe, not
formal Tier 20 acceptance; `releaseEligible` remains `false`, and both confinement and
enforcement remain `partial`.

Important measured boundaries:

- The first DACL inspector found inherited capability ACEs in staged files; the final
  helper applies `PROTECTED_DACL_SECURITY_INFORMATION` to the test roots and staged
  files, then re-queries protection state, World write/delete mask, each expected grant
  mask, and absence of the unrelated capability SID.
- The ordered-ACE comparison shows an unresolved source divergence. On hosted Windows
  2022 / Node `v22.19.0`, the earlier probe's temp-capability-only default DACL failed
  Node initialization with `0xC0000142`; its current passing token has non-inheritable
  World/full and temp-capability/full ACEs. The pinned DSH runner, queried locally on
  Node `v24.15.0`, starts with only an inheritable temp-capability/full ACE in
  workspace-write (World/full is used in read-only). The DSH and probe also differ in
  environment delivery and launch topology. This does not isolate the cause. Treat the
  probe World ACE as temporary test-only compatibility evidence, not a production fix.
  The single A1-A5 matrix on Windows 2022 / Node 22.19 was inconclusive due retained-
  artifact/validator defects, but A1 did not pass; the stop rule keeps workspace-write
  unsupported. No rerun or probe expansion follows. See the [measured outcome and
  stop rule](../evidence/RESULTS.md#bounded-a1a5-workspace-write-differential-one-ci-run-inconclusive)
  and the full [DSH comparison](../evidence/DSH-COMPARISON.md).
- A child started with `stdio: 'ignore'` settles under the owned Job. stdout-only,
  stderr-only, and dual-piped `child_process.spawn()` cases return `EPERM`, matching the
  pinned DSH Windows ACL documented/tested boundary. This remains unsupported in v1 and
  is recorded diagnostically; it is not a Phase 0 hard-gate blocker or a reason to relax
  token/Low/Job/default-DACL restrictions.
- The probe does not establish final packaged-engine startup, the complete runtime
  protocol/reset/error suite, concurrent broker/owner isolation, bridge lifecycle, or
  all Windows preflight/negative regressions. It cannot by itself satisfy overall Phase 0
  acceptance, enable `sandboxHost: 'required'`, or change production/default behavior.
