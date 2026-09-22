/**
 * Own the reused node_repl kernel.
 *
 * The kernel itself is `@qwen-code/node-repl-mcp` (Apache-2.0), which already
 * implements the parts that are expensive to get right: a child-process Node kernel
 * with top-level await, bindings that persist and survive a throwing cell, module
 * roots, cancellation, reset, and the cell transform that makes re-declaration
 * semantics work. This package does not reimplement any of it — it starts that
 * kernel, hands it a capability catalog, and runs cells.
 *
 * What we add on top is exactly one thing: a scratch kernel root containing the
 * `nr-cap` bridge module, plus a config snapshot, so a cell can `await
 * import('nr-cap')` and reach the host's MCP catalog.
 *
 * Measured deviation worth knowing (see `docs/02-reuse-spike-results.zh-CN.md`):
 * this kernel rejects a second `let`/`const` for the same name with a SyntaxError,
 * while `var` may be re-declared. That is why the tool description tells the model
 * to prefer `var` for names it may redefine.
 */

import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { Bridge } from './bridge.js'
import type { JsCellBlock, JsCellResult, JsOptions, ProviderConnection } from './types.js'

const BRIDGE_ASSET_DIR = fileURLToPath(new URL('../assets/nr-cap/', import.meta.url))

/**
 * The MCP stdio client deliberately starts children with a small safe environment.
 * A persistent node_repl kernel nevertheless needs the host's explicit outbound
 * routing policy: otherwise a DSH process launched from a stale Windows Explorer
 * environment can bypass its configured proxy while shell commands do not.
 *
 * Keep this allowlist deliberately narrow. Passing all of process.env would leak
 * unrelated host credentials/configuration into code running in the kernel.
 */
const KERNEL_NETWORK_ENV_NAMES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
] as const

function kernelNetworkEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const name of KERNEL_NETWORK_ENV_NAMES) {
    const value = process.env[name]
    if (value !== undefined) environment[name] = value
  }
  return environment
}

/**
 * Where the kernel child lives. Kept scratch: it holds a generated config, not user data.
 *
 * The name is a UUID rather than a timestamp: two runtimes created in the same
 * millisecond would otherwise share a directory, and one runtime's cleanup would delete
 * the other's kernel root mid-run.
 */
export function createKernelRoot(): string {
  const root = join(tmpdir(), `node-repl-runtime-${randomUUID()}`)
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  cpSync(BRIDGE_ASSET_DIR, join(root, 'node_modules', 'nr-cap'), { recursive: true })
  return root
}

interface KernelSession {
  run(code: string, options?: JsOptions): Promise<JsCellResult>
  reset(): Promise<void>
  close(): Promise<void>
}

/** The kernel's own tool result shape, narrowed to what we forward. */
interface KernelCellContent {
  readonly status?: string
  readonly events?: readonly unknown[]
  readonly error?: { readonly name?: string; readonly message?: string; readonly stack?: string }
  readonly stats?: { readonly durationMs?: number }
}

/**
 * The kernel reports a cell as an ordered list of MCP content blocks — text and images
 * interleaved, with consecutive text already coalesced — and its `output-adapter` has
 * validated and budgeted every image by the time it arrives here. So this is a copy, not
 * a gate: flattening it would lose where an image sat between two texts, and
 * re-validating it would create a second source of truth for one policy.
 *
 * Unknown block types are dropped rather than guessed at: an MCP block this runtime does
 * not model is not text, and rendering it as text would be invention.
 */
function collectCellBlocks(content: readonly unknown[] | undefined): JsCellBlock[] {
  const blocks: JsCellBlock[] = []
  for (const raw of content ?? []) {
    const block = raw as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown } | null
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ kind: 'text', text: block.text })
    } else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      blocks.push({ kind: 'image', data: block.data, mimeType: block.mimeType })
    }
  }
  return blocks
}

/**
 * The prose view of a cell's blocks: text segments joined with `\n`, which is exactly what
 * this runtime returned before `blocks` existed. Callers that read only prose see no
 * change; anything that renders content walks `blocks` instead.
 */
function textOf(blocks: readonly JsCellBlock[]): string {
  return blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n')
}

export async function startKernel(options: {
  root: string
  bridge: Bridge
  providers: ReadonlyMap<string, ProviderConnection>
  entry: string
  defaultTimeoutMs: number
}): Promise<KernelSession> {
  // The kernel reads this snapshot at import time, so it must exist before start.
  writeFileSync(join(options.root, 'node_modules', 'nr-cap', 'config.json'), `${JSON.stringify({
    host: options.bridge.host,
    port: options.bridge.port,
    token: options.bridge.token,
    providers: [...options.providers.values()].map(provider => ({
      id: provider.id,
      label: provider.label,
      operations: provider.operations,
    })),
  }, null, 2)}\n`)

  const client = new Client({ name: 'node-repl-runtime', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [options.entry],
    cwd: options.root,
    env: kernelNetworkEnvironment(),
  }))

  /**
   * The kernel yields control after `yield_time_ms` — 10 s unless asked otherwise —
   * and expects a `node_repl_wait` follow-up. That yield carries a cell id in text and
   * no structured payload, so mistaking it for a finished cell reports `ok` together
   * with a note instead of a result. It is therefore recognized and drained here.
   */
  const RUNNING_CELL_ID = /node_repl cell (\S+) is still running/
  /**
   * The kernel never sends `structuredContent`: it folds its five-way status into
   * `isError` plus a leading `[node_repl <status>]` notice (their adapter says so
   * explicitly — "Preserve the 5-way status that MCP's boolean isError would otherwise
   * lose"). Reading only `isError` would report a kernel timeout as a plain `error`,
   * and leave every non-`ok` cell indistinguishable for the abandonment rule below.
   */
  const KERNEL_STATUS_NOTICE = /^\[node_repl (ok|error|cancelled|timeout|crashed)\]/
  const MAX_YIELD_MS = 60_000
  /** Slack for collecting the terminal result after the caller's budget is spent. */
  const DRAIN_GRACE_MS = 5_000
  /**
   * Cell endings where nothing will ever read an in-flight provider answer. `error` is
   * deliberately absent: a cell that throws may still have deliberately started a call it
   * did not await, and `ok` obviously finishes normally.
   */
  const ABANDONED_CELL_STATUSES = new Set<JsCellResult['status']>(['timeout', 'cancelled', 'crashed', 'running'])

  interface CallOutcome {
    readonly result: JsCellResult
    readonly runningCellId?: string
  }

  const call = async (name: string, args: Record<string, unknown>): Promise<CallOutcome> => {
    const started = Date.now()
    const result = await client.callTool({ name, arguments: args }, { timeout: 900_000 })
    const blocks = collectCellBlocks(result.content)
    const text = textOf(blocks)
    const structured = result.structuredContent as KernelCellContent | undefined
    if (structured?.status !== undefined) {
      return {
        result: {
          status: structured.status as JsCellResult['status'],
          blocks,
          output: text.trimEnd(),
          ...structured.error === undefined ? {} : {
            error: {
              name: structured.error.name ?? 'Error',
              message: structured.error.message ?? 'cell failed',
              ...structured.error.stack === undefined ? {} : { stack: structured.error.stack },
            },
          },
          durationMs: structured.stats?.durationMs ?? Date.now() - started,
        },
      }
    }
    const runningCellId = RUNNING_CELL_ID.exec(text)?.[1]
    if (runningCellId !== undefined) {
      return {
        runningCellId,
        result: { status: 'running' as JsCellResult['status'], blocks, output: text.trimEnd(), durationMs: Date.now() - started },
      }
    }
    // No structured payload: the kernel reports the cell through text and `isError`.
    const failed = result.isError === true
    const notice = KERNEL_STATUS_NOTICE.exec(text)?.[1] as JsCellResult['status'] | undefined
    return {
      result: {
        status: notice ?? (failed ? 'error' : 'ok'),
        blocks,
        output: text.trimEnd(),
        ...failed ? { error: { name: 'Error', message: text.trim() } } : {},
        durationMs: Date.now() - started,
      },
    }
  }

  /**
   * The kernel has one active-cell slot, and `node_repl_reset` refuses while it is
   * occupied. Tracking the id means the slot can always be freed, so a provider call
   * that never answers cannot leave the kernel permanently unusable.
   */
  let activeCellId: string | undefined

  const cancelActiveCell = async (): Promise<void> => {
    if (activeCellId === undefined) return
    const cellId = activeCellId
    activeCellId = undefined
    // Cancelling normally keeps the kernel and its earlier bindings; only a cell that
    // will not stop within the grace period restarts the kernel and discards them.
    await call('node_repl_cancel', { cell_id: cellId, yield_time_ms: 5_000 })
    // Nothing can read what that cell was waiting for now.
    options.bridge.abandonInFlight(`cell ${cellId} was cancelled`)
  }

  const session: KernelSession = {
    run: async (code, runOptions) => {
      // Timed from here, not from the last kernel round trip: a cell that yields once
      // returns through `node_repl_wait`, and reporting that hop's duration would claim a
      // three-second cell took one millisecond.
      const began = Date.now()
      const timeoutMs = runOptions?.timeoutMs ?? options.defaultTimeoutMs
      const deadline = Date.now() + timeoutMs + DRAIN_GRACE_MS
      let outcome = await call('node_repl', {
        code,
        timeout_ms: timeoutMs,
        // Ask for the caller's whole budget up front: an ordinary cell then returns its
        // result in this one round trip instead of yielding at the kernel's 10 s default.
        yield_time_ms: Math.min(Math.max(timeoutMs, 1), MAX_YIELD_MS),
        ...runOptions?.title === undefined ? {} : { title: runOptions.title.slice(0, 80) },
      })
      activeCellId = outcome.runningCellId
      while (outcome.runningCellId !== undefined && Date.now() < deadline) {
        outcome = await call('node_repl_wait', {
          cell_id: outcome.runningCellId,
          yield_time_ms: Math.min(Math.max(deadline - Date.now(), 1), MAX_YIELD_MS),
        })
        activeCellId = outcome.runningCellId
      }
      // The budget is spent and the cell is still going. The kernel has one active-cell
      // slot: leaving it occupied would refuse every later cell — including the install
      // cell of a reset — so the cell is cancelled rather than abandoned.
      if (outcome.runningCellId !== undefined) await cancelActiveCell()
      // A cell the kernel stopped, or one that crashed, cannot read an in-flight provider
      // answer either — and a request left running blocks that provider's session for every
      // later cell. A cell that finished on its own is left alone: it may deliberately have
      // fired a call it never awaited.
      if (ABANDONED_CELL_STATUSES.has(outcome.result.status)) {
        options.bridge.abandonInFlight(`cell ended as ${outcome.result.status}: nothing can read its answers`)
      }
      return { ...outcome.result, durationMs: Date.now() - began }
    },
    reset: async () => {
      // `node_repl_reset` refuses while a cell is active, so clear the slot first.
      await cancelActiveCell()
      await call('node_repl_reset', {})
      // Reset clears every binding, `cap` included, so the catalog has to be put
      // back or the next cell would find a kernel with no capabilities at all.
      await install()
    },
    async close() {
      await client.close().catch(() => {})
      rmSync(options.root, { recursive: true, force: true })
    },
  }

  /**
   * Install the catalog once. Because the kernel persists bindings, every later cell
   * simply has `cap` in scope — the kernel's own persistence removes the import
   * ceremony for the model.
   *
   * The assignments must happen in the CELL, not inside the imported module: an
   * imported module runs on the module global, so a `globalThis` side effect set there
   * is invisible to cell code.
   */
  const install = async (): Promise<void> => {
    const result = await session.run(
      "const mod = await import('nr-cap');\n"
      + 'globalThis.cap = mod.cap;\n'
      + 'globalThis.capHelp = mod.capHelp;\n'
      + "nodeRepl.write('cap ready: ' + cap.list().map(p => p.id + '=' + p.operations).join(','));",
      { timeoutMs: 60_000, title: 'install capability catalog' },
    )
    if (result.status !== 'ok') {
      throw new Error(`capability catalog could not be installed in the kernel: ${result.error?.message ?? result.output}`)
    }
  }

  await install()
  return session
}
