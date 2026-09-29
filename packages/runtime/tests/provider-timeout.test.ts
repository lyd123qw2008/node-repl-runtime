/**
 * What a provider call's deadline actually bounds.
 *
 * Two measured failures live here. First, a long IDE operation (a full rebuild, a terminal command
 * running a test suite) used to die with `Request timed out` after five minutes while the IDE was
 * still working — because the SDK attaches `_meta.progressToken` only when the caller passes
 * `onprogress`, and resets the deadline on progress only when `resetTimeoutOnProgress` is true
 * (default false). Second, the deadline has to still exist for a call that reports nothing, or
 * "progress renews it" would just mean "nothing ever times out".
 *
 * The fixture answers `slow` on an SSE stream when progress is requested, because a notification
 * cannot share one JSON body with the result it precedes.
 */

import { describe, expect, it } from 'vitest'
import { createCapabilityRuntime } from '../src/index.js'
import { startIdeaLikeServer } from './support/idea-like-server.js'

/** A runtime whose one provider has a deadline short enough to test (ms, not minutes). */
async function runtimeWithDeadline(url: string, timeoutMs: number) {
  return await createCapabilityRuntime({
    providers: [{ id: 'idea', label: 'Idea-like MCP', transport: 'streamable-http', url, timeoutMs }],
    cellTimeoutMs: 30_000,
  })
}

describe('provider call deadlines', () => {
  it('lets a call that reports progress outlive the quiet-call deadline', async () => {
    const server = await startIdeaLikeServer()
    // 1.5 s of work, 150 ms between reports, against a 600 ms deadline: without progress renewal
    // this call is cancelled at 600 ms and the work is thrown away.
    const runtime = await runtimeWithDeadline(server.url, 600)
    try {
      const reported = await runtime.js(
        'var r = await cap.idea.slow({ ms: 1500, progressEveryMs: 150 });\n'
        + 'nodeRepl.write("done:" + JSON.stringify(r));',
      )
      expect(reported.status).toBe('ok')
      expect(reported.output).toContain('"sleptMs":1500')
      // The call was cancelled and retried nowhere: a timeout is not session loss.
      expect(server.sessions()).toBe(1)
    } finally {
      await runtime.dispose()
      await server.close()
    }
  }, 120_000)

  it('still cancels a call that goes quiet for the whole deadline', async () => {
    const server = await startIdeaLikeServer()
    const runtime = await runtimeWithDeadline(server.url, 600)
    try {
      const quiet = await runtime.js(
        'try { await cap.idea.slow({ ms: 1500 }); }\n'
        + 'catch (error) { nodeRepl.write("failed: " + error.message); }',
      )
      expect(quiet.status).toBe('ok')
      expect(quiet.output).toMatch(/failed:.*timed out|failed:.*Request timed out/)
      // A deadline is not a lost session: no reconnect, and the provider is still usable after.
      expect(server.sessions()).toBe(1)
      const after = await runtime.js('nodeRepl.write(JSON.stringify(await cap.idea.echo({ value: "x" })));')
      expect(after.status).toBe('ok')
      expect(after.output).toContain('"x"')
      expect(server.sessions()).toBe(1)
    } finally {
      await runtime.dispose()
      await server.close()
    }
  }, 120_000)
})

describe('a cell that runs out of budget mid-operation', () => {
  it('names the provider call it cancelled instead of reporting a bare timeout', async () => {
    const server = await startIdeaLikeServer()
    const runtime = await createCapabilityRuntime({
      providers: [{ id: 'idea', label: 'Idea-like MCP', transport: 'streamable-http', url: server.url }],
      cellTimeoutMs: 30_000,
    })
    try {
      // The operation outlives the *cell* budget while the provider is still working: the kernel
      // stops the cell, and the answer that was in flight belongs to a call nobody can read.
      const overrun = await runtime.js('await cap.idea.slow({ ms: 5000 });', { timeoutMs: 1_200 })

      expect(overrun.status).toBe('timeout')
      // The two facts a reader needs: which call, and how long it had been running.
      expect(overrun.output).toContain('in flight')
      expect(overrun.output).toContain('idea.slow')
      expect(overrun.output).toMatch(/idea\.slow \(\d+\.\d s\)/)
      // ...and the move that fixes it, plus the caution about a half-applied side effect.
      expect(overrun.output).toContain('longer timeoutMs')
      expect(overrun.output).toContain('side-effecting')

      // A cell that finishes on its own keeps its fire-and-forget calls to itself: no notice.
      const fine = await runtime.js('nodeRepl.write("no notice here");', { timeoutMs: 5_000 })
      expect(fine.output).not.toContain('in flight')
    } finally {
      await runtime.dispose()
      await server.close()
    }
  }, 120_000)
})
