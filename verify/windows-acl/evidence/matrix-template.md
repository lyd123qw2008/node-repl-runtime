# Windows Phase 0 evidence matrix — template

A row that is absent, `UNSUPPORTED`, `NOT_STARTED`, or lacks one required fact is
**not supported**.  No Tier 00/10 result can satisfy a Tier 20+ required-path gate.

| Backend / mode | Tier 00 protocol | Tier 10 ABI/preflight | Restricted token + ACL | Explicit final environment | fd 3–7 + handle allowlist | Direct target Job / `treeExited` | Release status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Windows ACL / read-only | reference only | required | required | required | required | required | `unsupported` until every owned gate passes |
| Windows ACL / workspace-write | reference only | required | required | required | required | required | `unsupported` until every owned gate passes |

## Recording rule

`00-unconfined-node-fd7` may be recorded as `REFERENCE_PASS` only in the first
column.  It does not fill any ACL, restricted-token, environment, handle, Job, or
release cell.  `10-native-abi-and-koffi-preflight` may record `UNSUPPORTED` with
its precise missing prerequisite; that remains fail-closed, not a waiver.
