/**
 * Providers that were not up when the runtime started.
 *
 * The failure this covers is the sibling of the session-loss one: a host process started while
 * its MCP server was down (an IDE still closed) used to carry that provider as an *absence* for
 * the rest of its life — `cap.idea` did not exist, nothing could create it, and the only fix was
 * restarting the host. `cap.reconnect(id)` is the entry point that closes that gap, and
 * `cap.status()` is how a cell can see the difference between "never attached" and "attached and
 * currently down".
 */

import { describe, expect, it } from 'vitest'
import { createCapabilityRuntime } from '../src/index.js'
import { startIdeaLikeServer } from './support/idea-like-server.js'

/** The call a cell makes once the provider is usable. */
const CALL = 'var r = await cap.idea.echo({ value: "x" });\nnodeRepl.write(JSON.stringify(r));'

/** Start a runtime whose one provider points at an endpoint nothing is listening on. */
async function runtimeWithAbsentServer(url: string) {
  return await createCapabilityRuntime({
    providers: [{ id: 'idea', label: 'Idea-like MCP', transport: 'streamable-http', url }],
    cellTimeoutMs: 20_000,
  })
}

describe('providers that were not up at startup', () => {
  it('attaches on demand once the server appears, without restarting anything', async () => {
    // Reserve the endpoint first, then take it away: this is the real sequence (DSH starts, the
    // IDE's MCP server is not listening yet) with a URL that can be brought back afterwards.
    const reserved = await startIdeaLikeServer()
    const port = reserved.port
    await reserved.close()

    const runtime = await runtimeWithAbsentServer(reserved.url)
    let late: Awaited<ReturnType<typeof startIdeaLikeServer>> | undefined
    try {
      // The provider is configured and visible — it is *not* silently missing, which is the whole
      // reason `failures` and the synthesized health record exist.
      const before = await runtime.js('nodeRepl.write(JSON.stringify(await cap.status()));')
      expect(before.status).toBe('ok')
      expect(before.output).toContain('"id":"idea"')
      expect(before.output).toContain('"attached":false')
      expect(before.output).toContain('"reconnectable":true')
      expect(before.output).toContain('"lastError"')
      // ...and there is no callable namespace yet, because there is nothing to call.
      const missing = await runtime.js('nodeRepl.write("cap.idea=" + typeof cap.idea);')
      expect(missing.output).toContain('cap.idea=undefined')

      // The IDE finishes starting: same endpoint, now listening.
      late = await startIdeaLikeServer({ port })

      const attached = await runtime.js(
        'var health = await cap.reconnect("idea");\n'
        + 'nodeRepl.write("attached=" + health.attached + " state=" + health.state + " operations=" + health.operations);',
      )
      expect(attached.status).toBe('ok')
      expect(attached.output).toContain('attached=true')
      expect(attached.output).toContain('state=connected')
      expect(attached.output).toContain('operations=2')
      // The catalog arrived with the reply, so the namespace exists in this same cell.
      expect(late.sessions()).toBe(1)

      const called = await runtime.js(CALL)
      expect(called.status).toBe('ok')
      expect(called.output).toContain('"x"')
      expect(late.calls()).toBe(1)

      // Discovery stops reporting it as missing, host side and kernel side.
      expect(runtime.failures()).toEqual([])
      const help = await runtime.js('nodeRepl.write(capHelp());')
      expect(help.output).toContain('idea (Idea-like MCP) — 2 operation(s)')
      expect(help.output).not.toContain('NOT ATTACHED')
    } finally {
      await runtime.dispose()
      await late?.close()
    }
  }, 120_000)

  it('keeps a failed attach a readable failure with the latest reason', async () => {
    const reserved = await startIdeaLikeServer()
    await reserved.close()
    const runtime = await runtimeWithAbsentServer(reserved.url)
    try {
      const refused = await runtime.js(
        'try { await cap.reconnect("idea"); }\n'
        + 'catch (error) { nodeRepl.write("caught: " + error.code + " " + error.message); }',
      )
      expect(refused.status).toBe('ok')
      expect(refused.output).toContain('caught: MCP_ATTACH_FAILED')
      expect(refused.output).toContain('idea')
      expect(refused.output).toMatch(/fetch failed|econnrefused/i)

      // The reason survives in discovery, and the failure is still reported as a failure.
      expect(runtime.catalog()).toHaveLength(0)
      expect(runtime.failures().map(failure => failure.id)).toEqual(['idea'])
      const help = await runtime.js('nodeRepl.write(capHelp());')
      expect(help.output).toContain('idea — NOT ATTACHED:')
      const status = await runtime.js('nodeRepl.write(JSON.stringify(await cap.status()));')
      expect(status.output).toContain('"attached":false')
    } finally {
      await runtime.dispose()
    }
  }, 120_000)

  it('refuses a provider the profile switched off, and one that does not exist', async () => {
    const runtime = await createCapabilityRuntime({
      providers: [
        { id: 'blender', label: 'Blender MCP', transport: 'stdio', command: 'unused', disabled: true },
      ],
      cellTimeoutMs: 20_000,
    })
    try {
      const disabled = await runtime.js(
        'try { await cap.reconnect("blender"); }\n'
        + 'catch (error) { nodeRepl.write("disabled: " + error.message); }',
      )
      // "disabled" is an instruction, not a temporary state: attaching it would start a server
      // the operator deliberately switched off.
      expect(disabled.output).toContain('disabled:')
      expect(disabled.output).toContain('disabled: true')

      const unknown = await runtime.js(
        'try { await cap.reconnect("nope"); }\n'
        + 'catch (error) { nodeRepl.write("unknown: " + error.message); }',
      )
      expect(unknown.output).toContain('unknown:')
      expect(unknown.output).toContain('nope')
    } finally {
      await runtime.dispose()
    }
  }, 120_000)

  it('attaches straight to a new endpoint when one is given', async () => {
    // The IDE came back on a different port while the host was already running. The override has
    // to reach the *first* connect: attaching and then re-opening would open two sessions.
    const reserved = await startIdeaLikeServer()
    await reserved.close()
    const runtime = await runtimeWithAbsentServer(reserved.url)
    const moved = await startIdeaLikeServer()
    try {
      const attached = await runtime.js(
        `var health = await cap.reconnect("idea", { url: ${JSON.stringify(moved.url)} });\n`
        + 'nodeRepl.write("attached=" + health.attached + " url=" + health.url);',
      )
      expect(attached.status).toBe('ok')
      expect(attached.output).toContain('attached=true')
      expect(attached.output).toContain(moved.url)
      expect(moved.sessions()).toBe(1)

      expect((await runtime.js(CALL)).output).toContain('"x"')
      expect(moved.calls()).toBe(1)
    } finally {
      await runtime.dispose()
      await moved.close()
    }
  }, 120_000)

  it('still knows an attached provider after the kernel is replaced', async () => {
    // The drift this guards: a fresh kernel process imports `nr-cap` afresh and reads the
    // startup snapshot, which predates the attach — so without install-time reconciliation it
    // would advertise a catalog that no longer matches what the host serves.
    const reserved = await startIdeaLikeServer()
    const port = reserved.port
    await reserved.close()
    const runtime = await runtimeWithAbsentServer(reserved.url)
    let late: Awaited<ReturnType<typeof startIdeaLikeServer>> | undefined
    try {
      late = await startIdeaLikeServer({ port })
      const attached = await runtime.js('await cap.reconnect("idea");\nnodeRepl.write("attached");')
      expect(attached.output).toContain('attached')

      // The kernel child is not this process's child, so its pid comes from the cell API.
      const who = await runtime.js('nodeRepl.write(String(nodeRepl.getHeapStatus().pid));')
      const kernelPid = Number(who.output.match(/(\d+)/)?.[1])
      expect(Number.isSafeInteger(kernelPid) && kernelPid > 0).toBe(true)

      const pending = runtime.js('await new Promise(resolve => setTimeout(resolve, 10_000));', { timeoutMs: 20_000 })
      await new Promise(resolve => setTimeout(resolve, 1_000))
      process.kill(kernelPid, 'SIGKILL')
      const crashed = await pending
      expect(crashed.status).toBe('crashed')

      // A replacement kernel reconciled with the host's live catalog, so the provider attached
      // after startup is still there — and no stale "NOT ATTACHED" line came back with it.
      const after = await runtime.js(
        'nodeRepl.write("idea=" + typeof cap.idea + " ops=" + (cap.idea?.list().length ?? 0) + "\\n" + capHelp());',
      )
      expect(after.status).toBe('ok')
      expect(after.output).toContain('idea=object')
      expect(after.output).toContain('ops=2')
      expect(after.output).not.toContain('NOT ATTACHED')
    } finally {
      await runtime.dispose()
      await late?.close()
    }
  }, 120_000)
})
