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

/** A live connection to one MCP server, projected for the kernel. */
export interface ProviderConnection {
  readonly id: string
  readonly label: string
  readonly operations: readonly ProjectedOperation[]
  /**
   * One MCP call. `signal` is aborted when the cell that asked for it can no longer
   * read the answer, so a request never outlives its caller: for a provider that
   * serializes work per session (a browser bridge, say), a call left in flight blocks
   * that session's later reads until it eventually settles.
   */
  call(operation: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown>
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
}
