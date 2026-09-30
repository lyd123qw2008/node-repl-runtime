/**
 * What happens to a call when the connection under it dies, split by what can actually be proven.
 *
 * Two endings look alike from a cell and want opposite handling:
 *
 *   - the request never reached a running tool (a session the server does not know, a transport that
 *     was already gone) — re-sending it is a repair;
 *   - the connection failed with the request in flight — the server may have executed it, and for a
 *     mutating operation a blind retry is how one effect becomes two.
 *
 * Both are measured here with real streams rather than mocks: a killable stdio child for the first,
 * and an HTTP fixture that destroys the socket after receiving a call for the second.
 */

import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { classifySessionLoss, connectMcpProvider, createCapabilityRuntime, describeProviderError } from '../src/index.js'
import { startIdeaLikeServer } from './support/idea-like-server.js'

const STDIO_FIXTURE = fileURLToPath(new URL('./fixtures/echo-stdio-server.mjs', import.meta.url))
const STDERR_FIXTURE = fileURLToPath(new URL('./fixtures/fails-with-stderr.mjs', import.meta.url))

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Poll until the killed child is really gone, so the next call cannot race the kill. */
async function waitForDeath(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`pid ${pid} was still alive after ${timeoutMs} ms`)
}

async function runtimeWith(url: string) {
  return await createCapabilityRuntime({
    providers: [{ id: 'idea', label: 'Idea-like MCP', transport: 'streamable-http', url }],
    cellTimeoutMs: 20_000,
  })
}

describe('a connection that dies under a call', () => {
  it('reconnects and retries after a stdio child exits', async () => {
    const pidFile = join(tmpdir(), `nr-echo-stdio-${randomUUID()}.pid`)
    const connection = await connectMcpProvider({
      id: 'echo',
      label: 'Echo',
      transport: 'stdio',
      command: process.execPath,
      args: [STDIO_FIXTURE, pidFile],
    })
    try {
      const first = await connection.call('echo', { value: 'x' }) as { pid: number }
      const firstPid = Number(readFileSync(pidFile, 'utf8'))
      expect(first.pid).toBe(firstPid)

      // The provider dies the way a crashed browser or Cua child does. The SDK's transport clears
      // itself on the child's close, so the next request is rejected with a plain
      // `Error("Not connected")` — the shape that used to go unclassified and leave the provider
      // dead until the host restarted.
      process.kill(firstPid, 'SIGKILL')
      await waitForDeath(firstPid)
      await new Promise(resolve => setTimeout(resolve, 300))

      const second = await connection.call('echo', { value: 'y' }) as { pid: number }
      expect(second.pid).not.toBe(firstPid)
      expect(Number(readFileSync(pidFile, 'utf8'))).toBe(second.pid)
    } finally {
      await connection.close()
    }
  }, 60_000)

  it('does not turn sibling mutations into ambiguous failures when one call reconnects', async () => {
    const server = await startIdeaLikeServer()
    const runtime = await runtimeWith(server.url)
    try {
      // The IDE restarts, then a cell fires several mutating calls at once. One of them meets the
      // dead session and triggers the reconnect; the others are in flight at that moment.
      await runtime.js('nodeRepl.write("warm");')
      server.restart()

      const burst = await runtime.js(
        'const results = await Promise.all(Array.from({ length: 5 }, () =>\n'
        + '  cap.idea.slow({ ms: 0 }).then(() => "ok", error => "err:" + error.message.slice(0, 60))));\n'
        + 'nodeRepl.write(results.join(" | "));',
      )
      // Every call must end up served or repairable. What must NOT happen is a sibling being
      // reported as "may already have run": the client closed it, the server never rejected it, so
      // there is no evidence it ran — and refusing to retry throws away a call that was safe.
      expect(burst.status).toBe('ok')
      // Measured: each sibling gets its own 404 from the restarted server, so each classifies as
      // never-ran and retries on the shared reconnect — all five are served. The pessimistic
      // outcome ("may already have run") would mean the client had closed a call the server never
      // rejected, throwing away a retry that was safe.
      expect(burst.output).not.toContain('err:')
      expect(burst.output.split('|').filter(part => part.trim() === 'ok')).toHaveLength(5)
    } finally {
      await runtime.dispose()
      await server.close()
    }
  }, 60_000)

  it('retries an in-flight connection failure for a read-only operation', async () => {
    const server = await startIdeaLikeServer()
    const runtime = await runtimeWith(server.url)
    try {
      server.dropNextCall()
      const recovered = await runtime.js(
        'var r = await cap.idea.echo({ value: "x" });\nnodeRepl.write("ok:" + JSON.stringify(r));',
      )
      // `echo` declares readOnlyHint, so the ambiguous failure is retried on a new session.
      expect(recovered.status).toBe('ok')
      expect(recovered.output).toContain('ok:')
      expect(server.sessions()).toBe(2)
      expect(server.calls()).toBe(2)
    } finally {
      await runtime.dispose()
      await server.close()
    }
  }, 60_000)

  it('refuses to silently retry a mutating operation whose request may already have run', async () => {
    const server = await startIdeaLikeServer()
    const runtime = await runtimeWith(server.url)
    try {
      server.dropNextCall()
      const refused = await runtime.js(
        'try { await cap.idea.slow({ ms: 0 }); }\n'
        + 'catch (error) { nodeRepl.write("failed: " + error.message); }',
      )
      expect(refused.status).toBe('ok')
      expect(refused.output).toContain('failed:')
      expect(refused.output).toContain('may already have run')
      expect(refused.output).toContain('not retried automatically')
      // The two facts that matter: no reconnect for a mutation, and exactly one attempt reached the
      // server — a retry here would be a second side effect, not a repair.
      expect(server.sessions()).toBe(1)
      expect(server.calls()).toBe(1)
    } finally {
      await runtime.dispose()
      await server.close()
    }
  }, 60_000)
})

describe('failures that are read by people', () => {
  it('reports why a stdio server died, not just that the connection closed', async () => {
    // The SDK's message for a child that exits is about the connection; the child's own last words
    // are the diagnosis, and they used to go only to the host's stderr — nowhere near `failures`.
    await expect(connectMcpProvider({
      id: 'broken',
      label: 'Broken stdio server',
      transport: 'stdio',
      command: process.execPath,
      args: [STDERR_FIXTURE],
    })).rejects.toThrow(/missing dependency: zod is not installed/)
  }, 30_000)

  it('bounds a provider error body instead of relaying a gateway page', async () => {
    const server = await startIdeaLikeServer()
    const runtime = await runtimeWith(server.url)
    try {
      // 50 KB of "HTML" from a proxy: the SDK folds all of it into its error message, and the
      // runtime must not hand that to the kernel (heap) or the model (context) verbatim.
      server.failNextCall(50_000)
      const failed = await runtime.js(
        'try { await cap.idea.echo({ value: "x" }); }\n'
        + 'catch (error) { nodeRepl.write("failed:" + error.message.length); }',
      )
      expect(failed.status).toBe('ok')
      const reported = Number(failed.output.match(/failed:(\d+)/)?.[1])
      expect(Number.isFinite(reported)).toBe(true)
      expect(reported).toBeLessThan(4_000)
      // A 500 is not a lost session, so nothing was retried: the server saw exactly one call.
      expect(server.calls()).toBe(1)
    } finally {
      await runtime.dispose()
      await server.close()
    }
  }, 30_000)

  it('marks where a bounded error was cut', () => {
    const long = describeProviderError(new Error('y'.repeat(5_000)))
    expect(long.length).toBeLessThan(2_200)
    expect(long).toContain('more characters')
    expect(describeProviderError(new Error('short'))).toBe('short')
  })
})

describe('session-loss classification (shape of the SDK errors)', () => {
  it('separates what never ran from what may have run', () => {
    // The SDK's request path rejects a dead transport with a plain Error and no code
    // (dist/src-D_zzAWoS.mjs:6063) — the shape a dead stdio child produces.
    expect(classifySessionLoss(new Error('Not connected'))).toBe('never-ran')
    // Its own codes: not-connected means nothing was sent, closed means something was in flight.
    expect(classifySessionLoss(Object.assign(new Error('x'), { code: 'NOT_CONNECTED' }))).toBe('never-ran')
    expect(classifySessionLoss(Object.assign(new Error('x'), { code: 'CONNECTION_CLOSED' }))).toBe('maybe-ran')
    // A server that does not know the session rejected the call rather than running it.
    expect(classifySessionLoss(Object.assign(new Error('x'), { status: 404 }))).toBe('never-ran')
    // Undici cannot say which of the two a failed fetch was.
    expect(classifySessionLoss(new TypeError('fetch failed'))).toBe('maybe-ran')
    // A tool that answered with an error is an answer, not a lost session.
    expect(classifySessionLoss(new Error('provider said no'))).toBeUndefined()
    expect(classifySessionLoss(undefined)).toBeUndefined()
  })
})
