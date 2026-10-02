# Windows ACL Phase 0 evidence tiers

This directory defines **what a Phase 0 observation may claim**.  It deliberately
prevents a working Node fd 7 pipe from being described as a working Windows ACL
sandbox.

| Tier | Suite | Purpose | May establish `sandboxHost: 'required'` support? |
| --- | --- | --- | --- |
| `00` | `00-unconfined-node-fd7` | Own Node-only control-protocol fixture: fd 7, framing, marker consumption, bounded ordinary output, deadlines, and direct-child cleanup. | **No.** `confinement`, `enforcement`, token, Job, DACL, and handle isolation are all absent. |
| `10` | `10-dsh-source-baseline` | Optional source-checkout baseline: demonstrates existing DSH behavior and identifies the native handoff gaps. | **No.** It is an external oracle, not a node-repl-runtime implementation. |
| `10` | `10-ci-native-audit-artifact` | Hash-verified GitHub Actions Windows MSVC artifact: narrow Windows-header ABI, helper-only `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` sentinel, and helper-only bounded Job zero-active accounting. | **No.** It is a reference oracle; it does not create a restricted token or ACL lease, launch Node, or prove a future final target's handles/environment/tree cleanup. |
| `10` | `10-native-abi-and-koffi-preflight` | Exact isolated Koffi load/binding and static x64 record-layout preflight, plus external ACL-root boundary checks. | **No.** It invokes no token/ACL/Job/child operation and establishes no isolation property. |
| `20` | `20-owned-restricted-token-job` | Future owned restricted-token launcher with frozen per-lease environment, target carriers, fd 7, owned Job/quiescence, grants, and native handle proof. | **Only candidate tier.** Every declared backend × mode still needs its complete gate row. |

Every generated observation must contain at least:

```json
{
  "evidenceTier": "unconfined-protocol-reference",
  "confinement": "none",
  "enforcement": "none",
  "restrictedToken": false,
  "jobOwnership": false,
  "daclGrant": false,
  "osHandleAllowlistProven": false,
  "releaseEligible": false,
  "nonClaims": []
}
```

`00` observations are successful when their protocol facts are observed.  They
remain **release-ineligible by construction**.  In particular, requested child
environment keys and selected rejected sentinels are not proof of a closed,
restricted, or per-lease environment on Windows.  An absent/failed `20`
observation means Windows ACL stays `unsupported`; it never authorizes a fallback
to plain Node.  See [RESULTS.md](RESULTS.md) for the current Phase 0 execution
record.
