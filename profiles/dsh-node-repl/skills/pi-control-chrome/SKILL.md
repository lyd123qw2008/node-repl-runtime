---
name: pi-control-chrome
description: "Drive the user's existing Chrome or Edge profile through the node_repl kernel (`cap.chrome.*`, 44 operations) - tabs and logged-in sessions, page inspection and interaction, screenshots, uploads/downloads, dialogs, clipboard, console/network/CDP, tab ownership and cleanup, and Bridge/extension/target diagnostics. Use only when the user asks to use the existing browser, its tabs, its logged-in session, or its UI; use a search capability for ordinary web search, and Playwright/CDP for isolated test profiles."
---

# pi-control-chrome (kernel edition)

## How the browser is reached

There are no `browser_*` tools in this deployment. The browser is an MCP provider
attached to the node_repl kernel, so every operation is a kernel call from the `js`
tool:

```js
await cap.chrome.browser_status({})                       // the small readiness read
const tabs = await cap.chrome.browser_tabs({})            // handles live here
await cap.chrome.browser_snapshot({ handle })             // needs a handle
```

- `capHelp('chrome')` lists the 44 operations with their one-line descriptions,
  `cap.list()` lists every attached provider, and `cap.describe('chrome.browser_tabs')`
  returns one operation's **input and result schema** — read it instead of guessing a
  parameter name or a result field.
- `capHelp` labels every chrome operation `[mutate]`; that tag is not a read-only
  signal here, so judge safety from the operation itself and the rules below.
- **Filter in the cell.** The kernel exists so a large read never reaches the model:
  a full `structured` snapshot is ~20 KB and 100+ elements, while the answer the user
  needs is usually a few lines. `nodeRepl.write(...)` only what you concluded, and keep
  large payloads in bindings for further cells. Measured on a real page: 21,184 B
  structured vs 5,566 B compact for the same read.

## Read shape (this deployment)

`PI_CONTROL_CHROME_READ_POLICY=caller` is set, so page reads default to
`responseMode: "structured"` and the Bridge adds no budget of its own:

- **`structured`** (default) — the semantic model as data: `elements` with their `ref`s,
  element counts, `snapshotId`, `viewport`, truncation flags. The prose rendering
  (`snapshot.text`), the duplicated `snapshot.accessibility` tree and `frameTree` are
  dropped because they restate the same page.
- **`compact`** — the page as prose in `snapshot.state` for a model that will read the
  result directly; this is the only mode that injects budgets (roughly 8,000 chars /
  100 nodes for snapshots, 6,000 chars for extracts).
- **`raw`** — the unprojected Bridge result, for diagnosing the abstraction itself.
  Still bounded by the extension's collection ceilings, still expensive: use it to
  explain a problem, not to read a page.

Ask per call with `responseMode` when the default is wrong; a mode the Bridge accepts is
never silently dropped (the vocabulary has one owner in `bridge/response-modes.mjs`).

## Handles, fences and refs

- A **handle** is the complete tab identity from `browser_tabs`:
  `{ tabId, browserId, windowId, title, url, tabFence, incarnation?, sessionId?, groupId? }`.
  Its schema is `additionalProperties: false` — pass the object back whole, never invent
  fields, and put locator fields in `target`, not in `handle`.
- **A tab-mutating operation returns a refreshed handle.** `browser_navigate`, `browser_click`,
  `browser_new_tab` and friends answer with a `tab` carrying its own `handle` for the state they
  left behind — re-bind to that one instead of reusing the handle you sent. Reusing it after
  your own navigation is what produces `Tab handle is stale: URL changed`.
- **A call without a handle follows whatever tab the user has in front.** Omitting `tabId`/
  `handle` targets the active tab of the focused window, so a user switching tabs redirects the
  operation (or fails with "The selected browser tab changed before the request could start").
  Always pass the handle of the tab you mean.
- The **`tabFence`** and document **`incarnation`** are the document-identity boundary.
  Navigation, reload, document replacement, tab closure, a changed
  fence, or a Bridge restart invalidate observations: re-observe instead of reusing a
  handle, a ref or a `snapshotId` from before the change. An in-app route change is **not** a
  boundary: identity follows the document (`performance.timeOrigin` plus a per-document token),
  not the URL, so a `pushState` route change keeps handles and refs usable.
- **`eN`** page-map refs are **document-scoped**: an element keeps its number for the life of the
  document, so re-observing never renumbers it and a ref outlives the observation that published it
  (`resolvedBy: document_registry`). An **`aN`** AX ref and a DOM-CUA **`node_id`** are
  **observation-scoped** instead: pass their matching `snapshotId`. A visible-DOM node also carries
  the `ref` of its element when a snapshot already named it, so keep that one if you will act again.
- If more than one target is ready, select the requested `browserId` explicitly. Never
  pick the newest connection, the active window, or the first list entry as a guess.
- Omit unused optional fields, and never send `index: -1` or an empty selector.

## Observation and action

- Inspect before acting: `browser_snapshot` (semantic page map) or
  `browser_accessibility_snapshot` (AX tree, `full`/`diff`/`unchanged`; use
  `disableDiffing: true` when a full tree is required). Then act, then verify with a
  fresh observation.
- `browser_wait` states: `load`, `url`, `text`, `text_gone`, `visible`, `hidden`,
  `enabled`. Use `textAny` for several terminal literals and `failureTextAny` to return a
  failure terminal state immediately. For an externally refreshed status page, wait with
  `reload: true` plus `reloadIntervalMs` rather than asking the user to reload.
- Prefer role/name, label or accessible text for semantic targets; those resolve
  AX-first. CSS selectors, test ids and placeholders stay DOM-driven. Apply an explicit
  zero-based `index` after visibility filtering when a page has hidden duplicates.
- `browser_extract` is the bounded text read: `scope: "primary" | "log" | "body"`,
  `tail: true`, `logMatch`, `maxChars`. For log-like pages read with
  `scope: "log", tail: true, logMatch` and a small budget instead of pulling the page.
- `browser_snapshot`, `browser_extract` and `browser_dom_cua({ action: "get_visible_dom" })`
  include readable same-origin iframe text plus bounded `frames` metadata; use
  `includeFrames: false` when embedded documents are out of scope. Cross-origin or
  still-loading frames report a reason (`frameLoading`) instead of being silently
  dropped — wait and re-observe.
- A truncated read is an **incomplete answer**: `truncated` appears with `omitted` counts
  and a `nextAction`/`recommendation`. Narrow with `selector`/`target`, or raise
  `maxChars`/`maxNodes` when a target is genuinely missing. Complete reads omit
  `truncated` rather than publishing `false`.
- For click-after-failure, disappearing UI, white-screen or state/screenshot mismatch,
  use one explicit `browser_probe_interaction` call — despite the name it performs a real
  action (`operation` is required). It returns the before/after document identity and the
  post-action target state, and it never replays an uncertain side effect.
- `browser_console` with `only: "errors"` and its `nextSince` cursor gives an incremental
  log read. A clean pre-action console is never evidence that an action is safe.
- Use `browser_evaluate` or `browser_cdp` only when the higher-level operations cannot
  express the task, and keep the evaluation bounded and page-visible.

## Uncertainty and recovery

- Structured failures carry `actionState`, `retryable`, `inspectFirst`, `nextAction` and
  `recommendation`: follow the one safe step they name instead of guessing.
- `BROWSER_OPERATION_UNCERTAIN` means a side effect was dispatched and its outcome could
  not be confirmed. Inspect the page, never replay the action automatically.
- Read-only observations may absorb one transient Bridge/target reconnect and one
  document-change retry internally; side-effecting requests never take that path. That
  asymmetry is why a page read can succeed while the very next action is refused.
- **Acknowledge the target whenever the connection generation changes** — after a Bridge
  restart, an extension reload, a browser reconnect, or a `TARGET_CONNECTION_CHANGED`
  refusal. Until you do, listing tabs and every side-effecting call stays refused:

  ```js
  await cap.chrome.browser_status({ acknowledgeBrowserId: '<browserId>' })
  ```

  Read the id from `browser_status` or `browser_doctor`; afterwards
  `targetStability.acknowledged` is true and `requiresAcknowledgement` false. Acknowledge
  **before** dispatching a lifecycle call such as `browser_reload_extension`, not after it
  refuses — and expect to acknowledge again after it completes, because a reload mints a new
  extension runtime and therefore a new generation.
- `BROWSER_TAB_FENCE_CHANGED` / `EXTENSION_OFFLINE`: stop and read `browser_status` (small:
  identity, target stability, Bridge summary), then `browser_doctor` (capability map,
  targets, metrics, leases, recent events, `recovery`). Expect `EXTENSION_OFFLINE` for the
  first seconds after a Bridge restart while the extension reconnects.
- A loaded runtime can outlive a code update: compare `browser_status`'s
  `capabilityRevision` with `browser_doctor`'s `runtime.requiredCapabilityRevision`. An
  older revision is an `extension_runtime_stale` problem, not a page problem — do not
  fall back silently and do not re-run a side effect to "refresh" state.
- `BROWSER_TAB_RUNTIME_INHERITED` means an ownership record outlives the extension
  runtime that wrote it: close it with `browser_close_tab` for an Agent tab, or drop the
  record with `browser_release` for a claimed one, instead of retrying the blocked call.
- Bridge restart is a last resort, needs **explicit user authorization**, and
  `browser_restart` requires `arguments.confirmed: true`. It restarts the shared Bridge
  only — never DSH, never the browser. Never invoke a DSH restart, `taskkill`, or a
  replacement server yourself.

## Ownership and cleanup

- Treat existing tabs as user-owned. Do not close, navigate, move or claim one unless the
  task requires it or the user asked. Prefer `browser_new_tab` for exploration.
- Agent-owned tabs are temporary unless marked with `browser_mark_handoff` or
  `browser_mark_deliverable`; marks are turn-scoped and must be repeated when needed.
- Choose tabs by `owner`, `sessionId` and `sessionScope` — never by `groupId` alone,
  because the browser group can be shared between sessions.
- `browser_release` drops a claim without closing a user tab. `browser_cleanup` and
  `browser_context_reset` close or reset session-owned state: use them only when the user
  explicitly asks. Browser target leases are scoped by session, target, tab fence, attach
  epoch and CDP target; `browser_target_lease` inspects or releases one explicitly.

## Operations by group

- **bootstrap** — `browser_doctor`, `browser_status`, `browser_targets`
- **observe** — `browser_tabs`, `browser_selected`, `browser_snapshot`, `browser_extract`,
  `browser_accessibility_snapshot`
- **navigate** — `browser_navigate`, `browser_wait`, `browser_back`, `browser_forward`,
  `browser_reload`
- **interact** — `browser_probe_interaction`, `browser_click`, `browser_double_click`,
  `browser_fill`, `browser_type`, `browser_press_key`, `browser_scroll`, `browser_screenshot`
- **advanced** — `browser_locator`, `browser_dom_cua`, `browser_cua`, `browser_console`,
  `browser_network`, `browser_dialog`, `browser_upload`, `browser_clipboard`,
  `browser_download`, `browser_evaluate`, `browser_cdp`
- **lifecycle** — `browser_restart`, `browser_target_lease`, `browser_reload_extension`,
  `browser_claim_tab`, `browser_select_tab`, `browser_new_tab`, `browser_close_tab`,
  `browser_release`, `browser_mark_handoff`, `browser_mark_deliverable`,
  `browser_cleanup`, `browser_context_reset`

## Boundaries

- This is a capability layer, not a site adapter: it provides page structure, refs and
  handles, waits, extraction, log matching, tab ownership and the security boundaries.
  Product-specific field names, status vocabulary and layout belong in the calling
  workflow — parse the page's own DOM or read the region you already know.
- Do not expose passwords, cookies, access tokens, private keys, pairing tokens or
  unrelated page data, and do not inspect browser storage, cookies, passwords or session
  stores as a discovery shortcut.
- Do not upload files, download sensitive data, change account security, or submit
  irreversible actions without an explicit user request. Verify the target and the
  intended value immediately before an externally visible side effect.
- This Skill is the kernel edition. The retired plugin facade's tools
  (`browser_call`, `browser_capabilities`, `browser_status` as a fixed tool, and the
  `/chrome` commands) no longer exist, and they were removed on 2026-09-18.
