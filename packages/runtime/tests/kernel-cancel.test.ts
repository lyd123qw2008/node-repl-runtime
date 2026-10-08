/**
 * What a stop button has to reach.
 *
 * A cell is not a request: it is a program, and it can keep driving a browser or an IDE for as long
 * as its budget allows. The host's cancellation therefore arrives at the tool call, and these cases
 * pin down what the runtime does with it — stop the cell through the kernel (not merely abandon it),
 * keep the bindings that existed before the cell, roll the cancelled cell's own assignments back, and
 * name the provider calls that were cut off.
 */

import { describe, expect, it } from 'vitest'
import { createCapabilityRuntime, hostCancelledNotice } from '../src/index.js'
import { startIdeaLikeServer } from './support/idea-like-server.js'

describe('host cancellation', () => {
  it('stops the cell, keeps earlier bindings, and rolls the cancelled cell back', async () => {
    const runtime = await createCapabilityRuntime({ providers: [], cellTimeoutMs: 60_000 })
    try {
      // Cells are ESM modules (strict mode), so a binding has to be *declared* — an implicit global
      // assignment is a ReferenceError, and `var` is the declaration later cells can redeclare.
      const before = await runtime.js('var kept = 41;')
      expect(before.status).toBe('ok')

      const controller = new AbortController()
      const started = Date.now()
      const pending = runtime.js(
        'var inside = 1;\n'
        + 'await new Promise(resolve => setTimeout(resolve, 30_000));\n'
        + 'nodeRepl.write("finished");',
        { timeoutMs: 60_000, signal: controller.signal },
      )
      // Long enough that the cell is certainly inside its sleep, short enough to be a stop button.
      await new Promise(resolve => setTimeout(resolve, 1_500))
      controller.abort()
      const result = await pending
      const elapsed = Date.now() - started

      expect(result.status).toBe('cancelled')
      expect(result.output).toContain('the host cancelled this cell')
      expect(result.output).not.toContain('finished')
      // Neither the cell's own 30 s sleep nor its 60 s budget: the stop is what ended it.
      expect(elapsed).toBeLessThan(15_000)

      // The kernel is still there, with the entry bindings: `kept` from before the cell, the
      // cancelled cell's own `inside` rolled back, and the catalog still installed.
      const after = await runtime.js('nodeRepl.write("kept=" + typeof kept + ":" + kept + " inside=" + typeof inside + " cap=" + typeof cap);')
      expect(after.status).toBe('ok')
      expect(after.output).toContain('kept=number:41')
      expect(after.output).toContain('inside=undefined')
      expect(after.output).toContain('cap=object')
    } finally {
      await runtime.dispose()
    }
  }, 120_000)

  it('names the provider call a cancellation cut off', async () => {
    const server = await startIdeaLikeServer()
    const runtime = await createCapabilityRuntime({
      providers: [{ id: 'idea', label: 'Idea-like MCP', transport: 'streamable-http', url: server.url }],
      cellTimeoutMs: 60_000,
    })
    try {
      const controller = new AbortController()
      const pending = runtime.js(
        'await cap.idea.slow({ ms: 30_000 });\nnodeRepl.write("finished");',
        { timeoutMs: 60_000, signal: controller.signal },
      )
      // The call has to be in flight for the notice to have something to name.
      await expect.poll(() => server.calls(), { timeout: 10_000 }).toBeGreaterThan(0)
      controller.abort()
      const result = await pending

      expect(result.status).toBe('cancelled')
      expect(result.output).toContain('the host cancelled this cell')
      expect(result.output).toContain('idea.slow')
      expect(result.output).toContain('has been cancelled')
      expect(result.output).not.toContain('finished')
    } finally {
      await runtime.dispose()
      await server.close()
    }
  }, 120_000)

  it('says who stopped it, and what happened to the state', () => {
    expect(hostCancelledNotice([])).toContain('the host cancelled this cell')
    expect(hostCancelledNotice([])).toContain('rolled its own assignments back')
    const named = hostCancelledNotice([{ name: 'idea.slow', elapsedMs: 1_500 }])
    expect(named).toContain('idea.slow (1.5 s)')
    expect(named).toContain('has been cancelled')
  })
})
