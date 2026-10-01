/** Public shapes for the runtime. Deliberately small: everything else is a provider's business. */

/**
 * One MCP server, as configuration. This is the entire integration surface — there
 * is no provider-specific code path anywhere in this package.
 */
export interface McpProviderSpec {
  /** Namespace the model uses: `cap.<id>.<operation>`. */
  readonly id: string
  readonly label?: string
  readonly transport: 'streamable-http' | 'stdio'
  /** Required for `streamable-http`. */
  readonly url?: string
  /** Required for `stdio`. */
  readonly command?: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  /** When true, skip this provider without starting or connecting its MCP server. */
  readonly disabled?: boolean
  /**
   * Host-owned constant arguments, added on the host side before the MCP call.
   *
   * These are removed from the model-visible input schema, and a caller that
   * supplies one anyway is refused rather than silently overridden — the model must
   * not be able to redirect a host decision like which project to act on.
   */
  readonly inject?: Readonly<Record<string, unknown>>
  /** Optional exposure narrowing: regular expressions matched against tool names. */
  readonly include?: readonly string[] | null
  /**
   * Budget for one call that reports no progress, in milliseconds. Default 300_000.
   *
   * A *quiet* call is what this bounds: the server's progress notifications renew the deadline, so
   * an operation that keeps reporting stays alive while one that goes silent for this long is
   * cancelled. It is not the real ceiling — the cell's own budget aborts the call, and a hard
   * one-hour ceiling applies regardless.
   */
  readonly timeoutMs?: number
}

/** One operation as the model sees it: the provider's own tool, minus host-owned arguments. */
export interface ProjectedOperation {
  readonly name: string
  readonly summary: string
  /** Informational only. Derived from the server's own declaration; never a gate. */
  readonly safety: 'read' | 'mutate'
  readonly inputSchema: {
    readonly type: 'object'
    readonly properties: Readonly<Record<string, unknown>>
    readonly required: readonly string[]
    readonly additionalProperties: false
  }
  /**
   * The result shape, when the server declares one (`outputSchema`, MCP standard).
   *
   * Relayed verbatim and never interpreted. Without it a cell author can only guess
   * whether a call returns `{items: [...]}`, `{files: [...]}`, or raw content blocks —
   * measured against the IDEA server, 42 of its 67 tools declare one, so dropping it
   * turns a declared contract into guesswork.
   */
  readonly outputSchema?: Readonly<Record<string, unknown>>
}

/**
 * Lifecycle state of one provider's MCP session, as the host sees it.
 *
 * It exists because a session can end without the connection noticing: a streamable-HTTP
 * server that restarts keeps its URL but forgets every session id it issued, and a stdio
 * child can die. Without a state to read, "this capability is broken" and "this capability
 * was never configured" look the same from inside a cell.
 */
export interface ProviderHealth {
  readonly id: string
  readonly label: string
  readonly state: 'connected' | 'reconnecting' | 'failed'
  /**
   * False for a provider that is configured but never got connected in this process.
   *
   * The distinction `state: 'failed'` alone cannot make: "was attached and is currently down"
   * (retry the session) and "never attached" (connect it for the first time) are different
   * situations, and the second is the one a DSH started while the IDE was still closed leaves
   * behind. `reconnect` handles both; this field is how a caller tells which it is looking at.
   */
  readonly attached: boolean
  /**
   * False when the connection owns no session that could be re-opened — a host-supplied
   * connection, or one built directly for a test. Reported rather than guessed at, so
   * `cap.reconnect` can refuse honestly instead of pretending to have done something.
   */
  readonly reconnectable: boolean
  readonly operations: number
  /** Bumped on every successful (re)connect, so a stale catalog is detectable without diffing. */
  readonly generation: number
  /** Sessions rebuilt after this connection's first one. */
  readonly reconnects: number
  /** Why the last re-open failed. Kept rather than logged: the reason is the useful fact. */
  readonly lastError?: string
  /** The endpoint in use now, which a reconnect override may have changed. */
  readonly url?: string
}

export interface ProviderReconnectOptions {
  /**
   * Re-open against this endpoint instead of the spec's `url`.
   *
   * An IDE that picks a new port on restart would otherwise be unreachable for the life of
   * the host process, since provider specs are read once at startup.
   */
  readonly url?: string
}

/**
 * The re-openable half of a connection: what a long-lived client needs in order to survive
 * the server under it restarting.
 */
export interface ProviderSession {
  /** Live state, for a caller that wants to know before it calls. */
  health(): ProviderHealth
  /**
   * Discard the current session, open a new one, and refresh the projected catalog.
   *
   * Single-flight: concurrent callers share one attempt rather than racing to open several
   * sessions. Rejects — with the reason — when the server cannot be reached; the previous
   * failure is never reported as success.
   */
  reconnect(options?: ProviderReconnectOptions): Promise<ProviderHealth>
}

/**
 * One provider as the kernel's catalog carries it: identity and surface, no connection.
 *
 * The kernel never holds a `ProviderConnection` — that lives on the host, behind the bridge —
 * so this is the whole of what crosses over, both in the snapshot the kernel starts with and
 * in the refresh that follows a rebuilt session.
 */
export interface CatalogEntry {
  readonly id: string
  readonly label: string
  readonly operations: readonly ProjectedOperation[]
}

/**
 * A provider call still waiting for an answer that nothing can read any more.
 *
 * Named rather than counted: when a cell runs out of budget mid-operation, "one call was
 * cancelled" leaves the reader guessing whether the casualty was a screenshot or a 20-minute
 * build — and the two call for different next moves.
 */
export interface InFlightCall {
  /** `provider.operation`, exactly as the cell asked for it. */
  readonly name: string
  readonly elapsedMs: number
}

/** A live connection to one MCP server, projected for the kernel. */
export interface ProviderConnection {
  readonly id: string
  readonly label: string
  /**
   * What the server advertises *now*.
   *
   * A getter on the real connection, not a snapshot: a session that had to be rebuilt may be
   * serving a different tool list, and a caller that cached the first one would keep offering
   * operations the server no longer has.
   */
  readonly operations: readonly ProjectedOperation[]
  /**
   * One MCP call. `signal` is aborted when the cell that asked for it can no longer
   * read the answer, so a request never outlives its caller: for a provider that
   * serializes work per session (a browser bridge, say), a call left in flight blocks
   * that session's later reads until it eventually settles.
   */
  call(operation: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown>
  /**
   * Absent for a connection with no session to lose.
   *
   * `connectMcpProvider` always provides it; the test seam (`RuntimeOptions.connector`) and any
   * host-supplied connection may not, and saying so by omission is more honest than a
   * `reconnect` that resolves without having reconnected anything.
   */
  readonly session?: ProviderSession
  close(): Promise<void>
}

/**
 * A provider that could not be attached, and the reason it gave.
 *
 * Kept rather than logged and forgotten. The kernel's discovery surface is the only place a
 * model can ask why a capability is missing, and a silent absence is indistinguishable from
 * one that was never configured — measured: a `cua` provider that failed to attach looked
 * exactly like a `cua` provider nobody had written down.
 */
export interface ProviderFailure {
  readonly id: string
  readonly error: string
}

/**
 * A configured provider that is not attached, in the two shapes discovery needs.
 *
 * One record rather than two parallel lists, because the reason a provider is missing and how
 * healthy it looks are the same fact: splitting them is how they end up disagreeing. The label
 * and endpoint come from the spec, which is why the host has to build this — the failure the
 * kernel snapshot carries is only an id and a message.
 */
export interface UnattachedProvider {
  readonly failure: ProviderFailure
  readonly health: ProviderHealth
}

/**
 * One piece of a cell's explicit output, in the order the cell produced it.
 *
 * Text and images share one ordered list because the order is information: a cell that
 * writes findings, emits a screenshot and then writes what it saw means something
 * different from one that emits the screenshot last. The kernel already reports them
 * interleaved — its `output-adapter` coalesces consecutive text and opens a new text
 * block when an image interrupts — so flattening to a string discards a fact the kernel
 * deliberately preserved. See `docs/05-image-content-blocks.zh-CN.md`.
 */
export type JsCellBlock =
  | { readonly kind: 'text'; readonly text: string }
  /**
   * Base64 bytes exactly as the kernel reported them. The kernel validated the MIME
   * against its own png/jpeg/webp allowlist and enforced its budgets before this block
   * existed, so the runtime relays rather than re-validates.
   *
   * There is deliberately no `metadata` field: the kernel emits image metadata as a
   * regular text block immediately before the image, so modelling it again here would
   * record one fact twice.
   */
  | { readonly kind: 'image'; readonly data: string; readonly mimeType: string }

/** Result of one kernel cell. */
export interface JsCellResult {
  /**
   * `running` appears only when a cell outlives the caller's budget: the runtime keeps
   * waiting for it as long as the budget allows and then reports that honestly, rather
   * than passing the kernel's yield note off as a finished result.
   */
  readonly status: 'ok' | 'error' | 'cancelled' | 'timeout' | 'crashed' | 'running'
  /** Everything the cell wrote, in order: `nodeRepl.write(...)` plus captured `console.*`. */
  readonly blocks: readonly JsCellBlock[]
  /**
   * Plain-text rendering of `blocks`: text segments joined with `\n`.
   *
   * Derived, for display and for callers that only read prose. It cannot express where
   * an image sat between two texts, so anything that renders content blocks walks
   * `blocks` instead.
   */
  readonly output: string
  readonly error?: { readonly name: string; readonly message: string; readonly stack?: string }
  readonly durationMs: number
}

export interface JsOptions {
  readonly timeoutMs?: number
  /** Short display-only description of what the cell does. */
  readonly title?: string
}

/** Test seam: swap the MCP connection out for a hermetic fake. */
export type ProviderConnector = (spec: McpProviderSpec) => Promise<ProviderConnection>

export interface RuntimeOptions {
  readonly providers: readonly McpProviderSpec[]
  /** Where the kernel child runs. Defaults to a scratch dir the runtime creates. */
  readonly kernelRoot?: string
  /** Default per-cell budget; the kernel's own default is 30 s. */
  readonly cellTimeoutMs?: number
  /** Override the connection step (tests). */
  readonly connector?: ProviderConnector
  /** Override the kernel entry point (tests). */
  readonly kernelEntry?: string
  /**
   * Node-mode executable for the kernel child.
   *
   * Set this when the runtime is mounted from a host whose `process.execPath` is not Node.
   * Electron is the case that exists: the MCP stdio transport starts children with a safe
   * environment that omits `ELECTRON_RUN_AS_NODE`, so `electron.exe` would open a GUI
   * instead of running the kernel. Defaults to `process.execPath`; Electron hosts must
   * explicitly pass a Node-mode executable.
   */
  readonly kernelCommand?: string
}
