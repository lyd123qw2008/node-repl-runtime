# Pinned DSH Windows ACL comparison (reference only)

This comparison keeps the standalone verifier in `verify/`; it does not import DSH
packages, alter the DSH checkout, or turn the probe into a second sandbox implementation.
The external reference source is DSH revision
`f9d6609d182969c9f57499ef552edb78835cc4e4`. The initial two-mode local observation used
the caller's DSH worktree: the selected ACL/token/runner/test files were clean, but
unrelated paths including the lockfile were dirty, so that result alone did not prove a
fully clean dependency install. In round 2, the workspace-write snapshot was repeated from
a fresh detached clone with `pnpm@11.7.0` and `--frozen-lockfile`; the runner now checks
and hashes root package/workspace/lock manifests as well as the ACL/token/runner/test
files. That clean-clone workspace-write smoke reproduced the temp-only inheritable ACE
under Node `v24.15.0`. The one-shot Windows CI matrix installs the same pinned DSH commit
from its frozen lockfile before running A1 under Node `v22.19.0`.

## Actual DSH final-token observation

`node scripts/run-dsh-token-snapshot.mjs` launched the pinned DSH ACL runner in both modes
on local Windows x64 / Node `v24.15.0`. The final restricted Node process called
`GetTokenInformation(TokenRestrictedSids)`, `GetTokenInformation(TokenDefaultDacl)`, and
`GetTokenInformation(TokenIntegrityLevel)` itself. The checker emits trustee classes
rather than machine-specific account/capability SID values. Result: `REFERENCE_PASS`; the
sanitized raw JSON remains in the caller-selected ignored evidence directory.

| Observation | DSH `read-only` | DSH `workspace-write` |
| --- | --- | --- |
| Restricted SID sequence queried from final token | logon session, World | logon session, World, workspace capability, private-temp capability |
| Integrity queried from final token | Low (`S-1-16-4096`) | Low (`S-1-16-4096`) |
| Added default-DACL ACE at index 0 | Allow World, `FILE_ALL_ACCESS` (`0x001f01ff`), inheritance flags `0x03` (object + container) | Allow private-temp capability, `FILE_ALL_ACCESS` (`0x001f01ff`), inheritance flags `0x03`; no additional World full-access ACE was observed |
| Following observed default-DACL entries | Ambient user, LocalSystem, logon-session entries; masks/order are recorded in raw evidence | Ambient user, LocalSystem, logon-session entries; masks/order are recorded in raw evidence |
| Final worker `TMP` / `TEMP` | Present; not redirected beneath the requested temp root | Present; both redirected beneath the requested temp root |
| Grandchild stdio experiment in final token | inherit / ignore exit 0; pipe returns `EPERM` | inherit / ignore exit 0; pipe returns `EPERM` |

The DSH source explains the ACE inheritance flags: [`token.ts`](../../../../deepseek-harness/packages/sandbox/sandbox-windows-acl/src/token.ts)
merges a full-access ACE for the selected restricting SID into `TokenDefaultDacl`; its
[`buildExplicitAccess()`](../../../../deepseek-harness/packages/sandbox/sandbox-windows-acl/src/acl.ts)
defaults to `SUB_CONTAINERS_AND_OBJECTS_INHERIT`. In read-only, the selected SID falls
back to World; in workspace-write it is the private-temp capability (or workspace SID
if temp writes are absent). The final DSH token snapshot above independently queried the
actual ACE at index 0 and its flags/mask.

## Launch/topology comparison

| Dimension | Pinned DSH mechanism/reference | node-repl Tier 20 feasibility probe |
| --- | --- | --- |
| Token restricting set | DSH `createRestrictedToken()` uses `[logon, World]` in read-only and adds workspace/temp capabilities in workspace-write; the snapshot above checks the final token. | Native probe queries the exact expected set for both modes and emitted ordered default-DACL ACE snapshots in CI run [`37029476316`](https://github.com/lyd123qw2008/node-repl-runtime/actions/runs/37029476316). |
| `TokenDefaultDacl` | DSH measured final ACEs: index 0 is World/full/inheritable in read-only; index 0 is temp-capability/full/inheritable in workspace-write; no extra World ACE in the measured write-mode token. | Windows CI run [`37029476316`](https://github.com/lyd123qw2008/node-repl-runtime/actions/runs/37029476316) queried exact final ACE order: read-only index 0 World/full/flags 0; workspace-write index 0 temp-capability/full/flags 0, index 1 World/full/flags 0. Remaining ambient/user/System/logon ACEs are separately recorded by trustee class and mask. This is a measured probe divergence, not a product decision. |
| Initial/final launch | The Windows `subprocess-local` runner owns a current-token Job and fd 4–6 target carriers (optional fd 7 control), then the ACL runner creates the final restricted child with inherited stdio; DSH `control.spec.ts` passes ordinary host-side stdout/stderr and binary fd 7 through the chain. The ACL runner's `CreateProcessAsUserW` path has `lpEnvironment = NULL`; it changes its own `TMP`/`TEMP` before launch. | Native launcher directly creates the final restricted Node suspended, passes an explicit Unicode environment block and an OS handle allowlist, provides fd 0–7, assigns the final Node to its Job before resume, and observes settlement. |
| Node/version/context | The actual token snapshot and `runner.spec.ts` / `control.spec.ts` were run locally on Node `v24.15.0`; those facts are not the same image/context as hosted CI. | Expanded minimum-floor evidence uses Windows CI Node `v22.19.0`; earlier core evidence covers runner Node `v22.23.3`. |
| Cell-owned piped grandchild | DSH documents `inherit`/`ignore` as available and `stdio: 'pipe'` as `EPERM`; its real runner regression test pins that boundary. | The fixture sees the same result and records it diagnostically. It is an inherited unsupported boundary, **not a Phase 0 completion blocker**. |

Relevant source contracts: DSH [`runner.ts`](../../../../deepseek-harness/packages/sandbox/sandbox-windows-acl/src/runner.ts),
[`index.ts`](../../../../deepseek-harness/packages/sandbox/sandbox-windows-acl/src/index.ts),
[`win32-process/process.ts`](../../../../deepseek-harness/packages/subprocess/win32-process/src/process.ts),
[`control-stdio.ts`](../../../../deepseek-harness/packages/subprocess/win32-process/src/control-stdio.ts),
[`subprocess-local/spawn-runner.ts`](../../../../deepseek-harness/packages/subprocess/subprocess-local/src/spawn-runner.ts),
DSH [`runner.spec.ts`](../../../../deepseek-harness/packages/sandbox/sandbox-windows-acl/tests/runner.spec.ts),
[`control.spec.ts`](../../../../deepseek-harness/packages/sandbox/sandbox-windows-acl/tests/control.spec.ts),
and the documented PowerShell boundary in
[`tool-pwsh/src/index.ts`](../../../../deepseek-harness/packages/shell/tool-pwsh/src/index.ts).

## Interpretation / required restraint

The actual DSH runner starts on local Node `v24.15.0` with a temp-capability-only
workspace-write default-DACL addition, while the earlier owned-worker probe needed an
extra World full-access default ACE on hosted Node `v22.19.0`. The DSH DACL ACE also has
inheritance flags `0x03`; the probe ACEs use flags 0. The launch/environment topology and
host/runtime differ as well. **This comparison does not isolate which difference caused
the earlier `0xC0000142`**, and local Node 24 success must not be generalized to the
minimum Node 22 hosted runner.

Therefore do not migrate or endorse the probe's World ACE, do not guess that a trustee
substitution is sufficient, and do not weaken the restricted token or Job. Treat the
World ACE as a temporary probe-specific compatibility divergence until a controlled
same-runner / same-Node DSH-versus-owned launch matrix identifies the relevant difference.
The next ACL work should be limited to that differential evidence and then alignment with
the DSH token/default-DACL/launch primitives; it should not grow the standalone verifier
into a runner, broker, or alternate sandbox.

The DSH piped-grandchild denial is already documented and test-pinned; keep it as an
unsupported v1 capability, with no retry or privilege relaxation. It is not a reason to
block Phase 0. Overall Phase 0 still has independent acceptance gaps; neither this
reference snapshot nor the Tier 20 fixture enables `sandboxHost: 'required'`.
