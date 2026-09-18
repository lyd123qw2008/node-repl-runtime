---
name: jetbrains-idea
description: "Use IntelliJ IDEA's own MCP operations through the node_repl kernel (`cap.idea.*`, 67 operations) for IDE-grade work on a Java or IntelliJ project - project-wide search and navigation, run configurations, builds, inspections, the IDE terminal, or IDEA's database reads. IDEA is reachable in every session; there is no preset to choose and no `mcp__idea__*` tool family. There is no language-server fallback."
---

# JetBrains IDEA tools

## How IDEA is reached

The IDE is an MCP provider attached to the node_repl kernel, not a tool family:

- Call an operation from the `js` tool:
  `await cap.idea.search_text({ q: 'class UserService', projectPath: 'D:/path/to/project' })`
- `capHelp('idea')` lists the provider's operations, `cap.list()` lists every attached
  provider, and `cap.describe('idea.search_text')` returns one operation's schema —
  including the schema of its result when the server declares one.
- 25 of the 67 operations declare no `outputSchema`; those answer in content blocks, so
  `read_file` returns `[{ type: 'text', text: 'L1: …' }]` and the cell usually wants just
  that text.
- IDEA is available in every session, so there is nothing to unlock and no reason to
  restart a session to reach the IDE. The former `mcp__idea__*` family and the
  `java-ide-local` preset allowlist were retired on 2026-09-18: the kernel renders the
  whole registry for a single tool declaration, so per-preset catalog shaping no longer
  bought anything.

## Practical quirks (measured against the running server)

- **Parameter names are not uniform**: `read_file` takes `file_path`, while
  `get_file_problems` takes `filePath`. Read the schema with `cap.describe` instead of
  assuming a name from a sibling operation.
- **`projectPath` is session-scoped and the provider cannot inject it.** Pass it on every
  project-scoped call when you know it — IDEA's own operation descriptions say to pass
  this value ALWAYS if you are aware of it. Without it such a call fails with
  `MCP_CALL_FAILED: Unable to determine the target project`; that message lists the
  currently open projects, so a cell that forgot the argument can recover from it alone.
- **This is configuration, not a package dependency.** The kernel connects to IDEA's
  already-enabled MCP endpoint; the three node-repl packages do not depend on an IDEA
  package or a JetBrains checkout. Replacing IDEA with another configured MCP provider
  does not require changing the kernel or its DSH adapter.

## Scope and safety

- These operations act on the project or projects currently open in the local IntelliJ
  IDEA instance that serves the MCP endpoint. An unopened workspace is not addressable;
  project, build, and run calls answer for IDEA's open projects, not for the shell's cwd.
- There is no language-server fallback in this deployment (the `lsp` tool was removed).
  If IDEA has not opened the workspace, use plain file operations, or ask the user to
  open the project first.
- Terminal commands and run configurations may require confirmation. Treat any
  potentially destructive command as high risk and obtain explicit confirmation.
