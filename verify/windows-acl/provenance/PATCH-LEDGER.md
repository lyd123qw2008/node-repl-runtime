# Patch ledger

| Date | Tier | Upstream source copied? | Local patch | Rationale |
| --- | --- | --- | --- | --- |
| 2026-10-02 | 00 | No | Node built-in-only unconfined fd 7 reference fixture | Establish transport facts without importing a sandbox/backend dependency. |
| 2026-10-02 | 10 | No | Exact isolated `koffi@3.1.1` ABI/loadability preflight with locally authored Win32 declarations | Establish only Koffi load/bind and static x64 layout facts; invoke no token/ACL/Job/child API. |
| 2026-10-02 | 10 | No | Own `win32-audit.cpp`, CI workflow, and strict local artifact verifier | Avoid a local C++ installation while independently compiling Windows-header ABI, helper-only handle-list sentinel, and bounded Job accounting probes on a pinned Windows CI runner. The artifact remains non-production and release-ineligible. |

No upstream TypeScript or native code has been copied at this point.
