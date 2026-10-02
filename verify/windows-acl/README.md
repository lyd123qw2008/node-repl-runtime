# Windows ACL Phase 0 verifier (non-production)

This folder is intentionally outside the root `packages/*` workspace.  It must
not alter normal `pnpm test`, the current runtime, default DSH host, bootstrap,
profile patches, or the DSH checkout.  The executed Phase 0 status is recorded in
[evidence/RESULTS.md](evidence/RESULTS.md).

## Isolated install

From the repository root, install this nested verifier **without**
`--ignore-workspace`: its local [`pnpm-workspace.yaml`](pnpm-workspace.yaml)
contains the narrow reviewed approval for the exact Koffi prebuild. This creates
only ignored `verify/windows-acl/node_modules/` and the tracked local lockfile; it
does not edit the root lockfile or add a root workspace package.

```powershell
corepack pnpm --dir verify/windows-acl install --frozen-lockfile
corepack pnpm --dir verify/windows-acl run test
```

## Commit 0: unconfined fd 7 protocol reference

The first suite is deliberately named
[`00-node-unconfined-direct-fd7.reference.test.mjs`](tests/00-node-unconfined-direct-fd7.reference.test.mjs).
It launches an explicit real Node worker with a duplex pipe at descriptor 7 and
checks the small transport facts an eventual owned supervisor will need:

- a host-first, versioned and request-correlated `hello` → `ready` handshake;
- a project-owned `NODE_REPL_KERNEL_CONTROL=pipe` marker that the worker consumes;
- rejection of selected inherited control variables (`NODE_OPTIONS`, DSH marker,
  and a per-run sentinel), while recording—not hiding—ambient Windows variables;
- fixture-local persistent state followed by an in-channel reset (transport
  semantics only, not the production Qwen reset contract);
- frame-size rejection, handshake deadline, duplex EOF/close behavior, bounded
  stdout/stderr collection, and confirmed direct-child cleanup.

Run it directly on Windows:

```powershell
$env:NODE_REPL_VERIFY_NODE = (Get-Command node.exe).Source  # absolute real node.exe; never an Electron process.execPath
node --test .\tests\00-node-unconfined-direct-fd7.reference.test.mjs
node .\scripts\run-unconfined-fd7.mjs
```

The second command writes a machine-local JSON observation beneath
`spike/windows-acl/<run-id>/00-unconfined-node-fd7/` by default; set
`NODE_REPL_VERIFY_OUT` to place evidence outside the repository.  That directory
is ignored by Git.  Its schema and non-claims live in
[evidence/CLAIMS.md](evidence/CLAIMS.md).

On the current Windows/Node reference host, an extra duplex stdio pipe does not
make a child-first write observable until the parent first writes.  The verifier
therefore makes the parent `hello` an explicit protocol transition and then
requires the correlated `ready` response.  A worker `end()` is only a write-half
close; the normal shutdown therefore requires the host to end its write half after
the `closing` acknowledgement, while an error EOF test uses a full destroy.
Likewise, ordinary Node Windows spawn can materialize ambient system/user entries
(including `TMP`/`TEMP`) beyond the requested block.  Tier 00 records this
diagnostic but makes **no closed or per-lease environment claim**.

## Explicit non-claims

This suite has **no confinement**.  It does not create a restricted token, ACL or
DACL grant, Low-integrity label, private temp capability, Job object, native handle
inheritance allowlist, sandboxed process range, or closed restricted-worker
environment.  A passing result proves only that the Node/libuv control transport
can be made explicit and observable on this machine.  It is not a Windows ACL
result and cannot enable `sandboxHost: 'required'`.

## Later Phase 0 tiers

### Tier 10: DSH source baseline (external oracle only)

A separately labelled `10-dsh-source-baseline` may use the fixed DSH checkout
revision recorded in [SOURCE-MANIFEST.md](SOURCE-MANIFEST.md) as a
reference-only oracle for its existing nested runner behavior.  It is not an
owned runtime dependency and is never imported by this verifier.  The explicit
command below requires a clean checkout and produces `UNSUPPORTED`/exit 2 if the
path, pin, or reference test cannot be verified:

```powershell
$env:NODE_REPL_VERIFY_DSH_ROOT = 'D:\liuyd\code\deepseek-harness'
$env:NODE_REPL_VERIFY_OUT = Join-Path $env:LOCALAPPDATA "node-repl-runtime-phase0\$(Get-Date -Format yyyyMMddTHHmmssZ)"
corepack pnpm --dir verify/windows-acl run verify:reference:dsh-source-baseline
```

A `REFERENCE_PASS` says only that the pinned DSH test demonstrated its **nested**
current-token runner → ACL wrapper → final restricted Node path, including captured
ordinary output and binary fd 7 traffic.  It does not establish direct final-worker
ownership, an own filtered environment, OS handle isolation, or final restricted
Job quiescence.  The first tier eligible to establish an owned Windows
implementation is `20-owned-restricted-token-job`, after native source extraction
and all token/environment/Job/ACL/handle gates pass.

### Tier 10: CI-built native audit oracle (compiler stays off the local machine)

The independently authored [`native/win32-audit.cpp`](native/win32-audit.cpp)
probe is built only by the public, pinned
[`windows-acl-native-audit.yml`](../../.github/workflows/windows-acl-native-audit.yml)
workflow on `windows-2022`. It is a small non-production evidence helper, not a
runtime dependency or a sandbox launcher. The workflow artifact contains exactly
`node-repl-win32-audit.exe`, `manifest.json`, and `SHA256SUMS.txt`, with seven-day
retention. It tests only:

- Windows SDK `sizeof`/`offsetof` assertions for the narrow launch records;
- a `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` permitted event versus an omitted,
  deliberately inheritable sentinel; and
- suspended-create → Job assignment → resume plus a bounded poll to zero active
  Job processes.

It does **not** mint a restricted token, grant ACL/DACL access, set Low integrity,
launch Node, establish fd 3–7 wiring, or authorize grant revocation. Accordingly,
its locally verified result remains a Tier 10 reference fact and cannot make either
Windows ACL mode supported.

Download an exact successful workflow artifact outside the repository, then require
its full source commit while verifying it locally. The verifier rejects a missing
commit or independently recorded executable SHA-256, unexpected/missing artifact
files, an executable over 2 MiB, invalid manifest fields, mismatched SHA-256,
unexpected runner/compiler/SDK provenance, or a failing audit mode. It emits
`UNSUPPORTED` and exit `2` rather than executing an untrusted artifact.

```powershell
$run = 36998074826 # replace only with a reviewed successful run
$commit = '94b34a07e637313abecb926351f872d7131c5a60' # exact full source commit for that run
$sha256 = '4520186c6e25f756fd0327a28a75cbbe531efd88f6b938076262a2d861ca38a6' # independently recorded EXE hash
$name = "windows-acl-native-audit-$commit"
$base = Join-Path $env:LOCALAPPDATA "node-repl-runtime-phase0\$commit"
$artifact = Join-Path $base 'github-artifact'
$env:NODE_REPL_VERIFY_OUT = Join-Path $base 'evidence'
$env:NODE_REPL_VERIFY_NATIVE_AUDIT_DIR = $artifact
$env:NODE_REPL_VERIFY_NATIVE_AUDIT_COMMIT = $commit
$env:NODE_REPL_VERIFY_NATIVE_AUDIT_SHA256 = $sha256
New-Item -ItemType Directory -Force -Path $artifact | Out-Null

gh run download $run --repo lyd123qw2008/node-repl-runtime --name $name --dir $artifact
corepack pnpm --dir verify/windows-acl run verify:reference:ci-native-audit
```

The current recorded successful CI run and local result are documented in
[evidence/RESULTS.md](evidence/RESULTS.md); raw artifact/evidence paths stay outside
Git. The local `nativeCompiler` observation is diagnostic only—not a blocker—because
the independent compile occurs in the pinned remote Windows audit environment.

### Tier 10: native preflight (fail-closed by design)

`verify:preflight` loads only the exact isolated `koffi@3.1.1` dependency to verify
selected x64 record layouts and bind (but never invoke) selected `kernel32` /
`advapi32` exports. It does **not** create a token, change an ACL, create a Job, or
launch a restricted process. It records the exact prerequisite gaps and exits `2`
while any required owned-path fact is missing. Give it an **already existing**, disposable,
repository-external directory only; do not point it at this checkout, an evidence
folder, or a real workspace. The current Node-level check rejects missing,
non-directory, reparse/junction, repository-overlapping, or evidence-overlapping
roots; the evidence root itself is canonicalized through its existing ancestor
before the overlap check. It leaves even a valid disjoint NTFS root as
`PENDING_OWNED_ACL_PROBE` until the required native ownership checks exist.

```powershell
$run = "$(Get-Date -Format yyyyMMddTHHmmssZ)-$([guid]::NewGuid().ToString('N'))"
$base = Join-Path $env:LOCALAPPDATA "node-repl-runtime-phase0\$run"
$env:NODE_REPL_VERIFY_ACL_ROOT = Join-Path $base 'roots'
$env:NODE_REPL_VERIFY_OUT = Join-Path $base 'evidence'
New-Item -ItemType Directory -Force -Path $env:NODE_REPL_VERIFY_ACL_ROOT | Out-Null
corepack pnpm --dir verify/windows-acl run verify:preflight
# Exit 2 is expected until the owned native gates are implemented and pass.
```

A `PREFLIGHT_PASS` would still not be a sandbox claim: Tier 20 must additionally
prove the restricted token/DACL/Low lease, explicit final-target environment,
native handle allowlist, final restricted Job ownership/quiescence, and the
read-only/workspace-write matrix.
