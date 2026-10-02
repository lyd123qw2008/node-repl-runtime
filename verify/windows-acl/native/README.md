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
| `job-settlement` | A target is created suspended, assigned to a private Job, resumed, exits, and the Job reports zero active processes. | Restricted-token ownership, final worker-tree settlement, or safe grant revocation in the future launcher. |

The probe does **not** create a restricted token, apply a DACL/Low-integrity label,
create workspace/private-temp grants, or operate as a sandbox launcher. A successful
artifact is only independent native evidence for the individual facts above. It never
changes the `unsupported` state of either Windows ACL mode by itself.

## Artifact contract

The workflow uploads a short-retention artifact containing only:

```text
node-repl-win32-audit.exe
manifest.json
SHA256SUMS.txt
```

`manifest.json` records the source commit, workflow ref, runner image, compiler/SDK
metadata, tested modes, and the SHA-256 of the executable. The local consumer must
verify all three files before execution and must write only a non-release evidence
record. Artifacts, downloaded executables, and raw evidence remain outside Git.

No DSH source, runtime package, credentials, or workspace contents are sent to the
workflow. The source and workflow are public because the repository is public.
