/**
 * Session recovery for streamable-HTTP providers.
 *
 * The failure these tests reproduce is a measured one: IntelliJ IDEA's MCP server
 * keeps its URL across a restart but forgets every session id it issued, so the client
 * keeps POSTing a dead `Mcp-Session-Id` and the server answers
 * `404 Streamable HTTP session not found` for the rest of the DSH process's life.
 * `js_reset()` cannot help — it rebuilds the kernel, not the MCP client.
 *
 * `tests/support/idea-like-server.ts` is the server half: a real sessionful
 * streamable-HTTP MCP server whose sessions can be dropped on command.
 */

import { describe, expect, it } from 'vitest'
import { createCapabilityRuntime, isSessionLoss } from '../src/index.js'
import { SdkError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client'
import { startIdeaLikeServer } from './support/idea-like-server.js'

/** The call a cell makes, as a cell makes it: same shape, through the same bridge. */
const CALL = 'var r = await cap.idea.echo({ value: "x" });\nnodeRepl.write(JSON.stringify(r));'

describe('streamable-HTTP session recovery', () => {
  it('survives the server forgetting the session: reconnect and retry, once', async () => {
    const server = await startIdeaLikeServer()
    const runtime = await createCapabilityRuntime({
      providers: [{ id: 'idea', label: 'Idea-like MCP', transport: 'streamable-http', url: server.url }],
      cellTimeoutMs: 20_000,
    })
    try {
      const first = await runtime.js(CALL)
      expect(first.status).toBe('ok')
      expect(server.sessions()).toBe(1)
      expect(server.listings()).toBe(1)

      // The IDE restart: same URL, no sessions.
      server.restart()

      const recovered = await runtime.js(CALL)
      expect(recovered.status).toBe('ok')
      expect(recovered.output).toContain('"x"')
      // Exactly one new session: the retry went through the reconnect, not a second attempt
      // on the dead one.
      expect(server.sessions()).toBe(2)
      expect(server.listings()).toBe(2)
    } finally {
      await runtime.dispose()
      await server.close()
    }
  }, 120_000)

  it('coalesces concurrent calls into one reconnect, and refreshes the catalog the kernel sees', async () => {
    const server = await startIdeaLikeServer()
    const runtime = await createCapabilityRuntime({
      providers: [{ id: 'idea', label: 'Idea-like MCP', transport: 'streamable-http', url: server.url }],
      cellTimeoutMs: 20_000,
    })
    try {
      await runtime.js(CALL)
      expect(server.sessions()).toBe(1)

      server.restart()
      // A plugin installed while the IDE was down: the next connect must pick it up.
      server.addTool('installed_while_down')

      const burst = await runtime.js(
        'const results = await Promise.all(Array.from({ length: 10 }, () => cap.idea.echo({ value: "x" })));\n'
        + 'nodeRepl.write("calls=" + results.length + " tools=" + cap.idea.list().map(t => t.name).join(","));',
      )
      expect(burst.status).toBe('ok')
      expect(burst.output).toContain('calls=10')
      // One reconnect for ten calls, and its `tools/list` is the one that refreshed the catalog.
      expect(server.sessions()).toBe(2)
      expect(server.listings()).toBe(2)
      expect(burst.output).toContain('installed_while_down')
    } finally {
      await runtime.dispose()
      await server.close()
    }
  }, 120_000)

  it('reconnects to a new endpoint when the old one moved', async () => {
    const first = await startIdeaLikeServer()
    const moved = await startIdeaLikeServer()
    const runtime = await createCapabilityRuntime({
      providers: [{ id: 'idea', label: 'Idea-like MCP', transport: 'streamable-http', url: first.url }],
      cellTimeoutMs: 20_000,
    })
    try {
      expect((await runtime.js(CALL)).status).toBe('ok')
      await first.close()

      // The explicit entry point: a cell can point the provider at wherever the server is now
      // instead of waiting for the whole DSH profile to restart.
      const movedByHand = await runtime.js(
        `const health = await cap.reconnect('idea', { url: ${JSON.stringify(moved.url)} });\n`
        + 'nodeRepl.write("state=" + health.state + " operations=" + health.operations);',
      )
      expect(movedByHand.status).toBe('ok')
      expect(movedByHand.output).toContain('state=connected')
      expect(moved.sessions()).toBe(1)

      const after = await runtime.js(CALL)
      expect(after.status).toBe('ok')
      expect(moved.calls()).toBe(1)
    } finally {
      await runtime.dispose()
      await moved.close()
    }
  }, 120_000)

  it('keeps a genuinely unreachable provider a readable failure, never a fake success', async () => {
    const server = await startIdeaLikeServer()
    const runtime = await createCapabilityRuntime({
      providers: [{ id: 'idea', label: 'Idea-like MCP', transport: 'streamable-http', url: server.url }],
      cellTimeoutMs: 20_000,
    })
    try {
      expect((await runtime.js(CALL)).status).toBe('ok')
      await server.close()

      const failed = await runtime.js(
        'try { await cap.idea.echo({ value: "x" }); }\n'
        + 'catch (error) { nodeRepl.write("failed: " + error.message); }',
      )
      expect(failed.status).toBe('ok')
      expect(failed.output).toContain('failed:')
      // The message has to name the provider and the reason, not swallow either.
      expect(failed.output).toContain('idea')
      expect(failed.output).toMatch(/econnrefused|fetch failed|unable to connect/i)

      const status = await runtime.js('nodeRepl.write(JSON.stringify(await cap.status()));')
      expect(status.output).toContain('"state":"failed"')
      expect(status.output).toContain('"lastError"')
    } finally {
      await runtime.dispose()
    }
  }, 120_000)

  it('reports provider health and the operations it is actually serving', async () => {
    const server = await startIdeaLikeServer()
    const runtime = await createCapabilityRuntime({
      providers: [{ id: 'idea', label: 'Idea-like MCP', transport: 'streamable-http', url: server.url }],
      cellTimeoutMs: 20_000,
    })
    try {
      const status = await runtime.js('nodeRepl.write(JSON.stringify(await cap.status()));')
      expect(status.status).toBe('ok')
      expect(status.output).toContain('"id":"idea"')
      expect(status.output).toContain('"state":"connected"')
      expect(status.output).toContain('"attached":true')
      expect(status.output).toContain('"reconnectable":true')
      expect(status.output).toContain('"operations":2')
    } finally {
      await runtime.dispose()
      await server.close()
    }
  }, 120_000)

  it('refuses an explicit reconnect for a provider that owns no session', async () => {
    const runtime = await createCapabilityRuntime({
      providers: [{ id: 'fake', transport: 'streamable-http', url: 'http://127.0.0.1:1/unused' }],
      connector: spec => Promise.resolve({
        id: spec.id,
        label: spec.id,
        operations: [],
        call: async () => null,
        close: async () => {},
      }),
      cellTimeoutMs: 20_000,
    })
    try {
      const refused = await runtime.js(
        'try { await cap.reconnect("fake"); }\n'
        + 'catch (error) { nodeRepl.write("caught: " + error.message); }',
      )
      expect(refused.output).toContain('caught:')
      expect(refused.output).toContain('fake')
      expect(refused.output).toMatch(/no MCP session|can re-?open/i)
    } finally {
      await runtime.dispose()
    }
  }, 120_000)
})

describe('session-loss classification (pure)', () => {
  it('treats an HTTP 404 and a closed transport as session loss, and nothing else', () => {
    // Measured: SDK 2.0's streamable-HTTP transport reports every non-OK POST as
    // `SdkHttpError` with the same generic code, so the status is the only reliable signal —
    // IDEA answers the stale session with 404 and the words in the message.
    expect(isSessionLoss(new SdkHttpError(
      SdkErrorCode.ClientHttpNotImplemented,
      'Error POSTing to endpoint: Streamable HTTP session not found',
      { status: 404, statusText: 'Not Found', text: 'Streamable HTTP session not found' },
    ))).toBe(true)

    // The other real ending: the transport itself is gone (a closed SSE stream, a dead
    // stdio child), which the SDK reports as a not-connected/closed connection.
    expect(isSessionLoss(new SdkError(SdkErrorCode.NotConnected, 'Not connected'))).toBe(true)
    expect(isSessionLoss(new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed'))).toBe(true)

    // Everything else keeps its own meaning: a tool that failed on the server is a tool
    // failure, and retrying it would repeat a side effect for nothing.
    expect(isSessionLoss(new SdkHttpError(
      SdkErrorCode.ClientHttpNotImplemented,
      'Error POSTing to endpoint: boom',
      { status: 500, statusText: 'Internal Server Error' },
    ))).toBe(false)
    expect(isSessionLoss(new Error('provider said no'))).toBe(false)
    expect(isSessionLoss(undefined)).toBe(false)
  })
})
