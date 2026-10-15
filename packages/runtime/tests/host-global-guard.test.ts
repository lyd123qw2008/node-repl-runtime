/**
 * Issue #11: the `cap` proxy must not be replaceable, and a replacement must not be silent.
 *
 * Two failures, one cause — `cap` is installed by the outer runtime, so the engine's
 * reserved-name list did not know it:
 *
 *   1. a cell could declare `cap` and the cell *succeeded*; the catalog proxy was gone for every
 *      later cell, and the model only found out when some later call threw
 *      `..._references.cap.value.list is not a function` — a transformed name it never wrote;
 *   2. a replacement that did not come from a declaration (a plain `cap = {}` assignment) passed
 *      every check anyone would think to write, because the value was present and merely wrong.
 *
 * The declaration is now refused up front, and every cell re-asserts the live shape, so the
 * failure is named at the first opportunity instead of surfacing cells later.
 */

import { describe, expect, it } from 'vitest'
import { createCapabilityRuntime } from '../src/index.js'

const CAP_SHAPE = 'nodeRepl.write("list=" + typeof cap.list + " help=" + typeof capHelp);'

describe('the capability catalog global cannot be replaced (issue #11)', () => {
  it('refuses to declare cap or capHelp, and stays usable', async () => {
    const runtime = await createCapabilityRuntime({ providers: [], cellTimeoutMs: 30_000 })
    try {
      for (const name of ['cap', 'capHelp']) {
        const rejected = await runtime.js(`const ${name} = { AR: 1, PR: 2 };`)
        expect(rejected.status, `${name} should be rejected`).toBe('error')
        expect(rejected.error?.message ?? '').toMatch(/shadow/i)
      }

      // The catalog must be untouched by the refused cells.
      const after = await runtime.js(CAP_SHAPE)
      expect(after.status).toBe('ok')
      expect(after.output).toContain('list=function')
      expect(after.output).toContain('help=function')
    } finally {
      await runtime.dispose()
    }
  }, 120_000)

  it('refuses var, let and const alike', async () => {
    const runtime = await createCapabilityRuntime({ providers: [], cellTimeoutMs: 30_000 })
    try {
      for (const keyword of ['var', 'let', 'const']) {
        const rejected = await runtime.js(`${keyword} cap = { AR: 1 };`)
        expect(rejected.status, `${keyword} cap should be rejected`).toBe('error')
      }
      const after = await runtime.js(CAP_SHAPE)
      expect(after.output).toContain('list=function')
    } finally {
      await runtime.dispose()
    }
  }, 120_000)

  it('reports a replacement that did not come from a declaration', async () => {
    const runtime = await createCapabilityRuntime({ providers: [], cellTimeoutMs: 30_000 })
    try {
      // A plain assignment is not a declaration, so no up-front check can see it. This is what
      // the per-cell guard is for: the value is present but wrong.
      const assign = await runtime.js('cap = { AR: 1 };')
      expect(assign.status).toBe('ok')

      const reported = await runtime.js('nodeRepl.write("unreachable");')
      expect(reported.status).toBe('error')
      expect(reported.error?.message ?? '').toMatch(/replaced/i)
      expect(reported.error?.message ?? '').toMatch(/js_reset/)

      // The documented recovery works.
      await runtime.jsReset()
      const healed = await runtime.js(CAP_SHAPE)
      expect(healed.status).toBe('ok')
      expect(healed.output).toContain('list=function')
    } finally {
      await runtime.dispose()
    }
  }, 120_000)

  it('leaves an ordinary object named like nothing special alone', async () => {
    const runtime = await createCapabilityRuntime({ providers: [], cellTimeoutMs: 30_000 })
    try {
      // The guard must not become a general "no objects" rule: shadowing ordinary globals is
      // documented as allowed, and `cap`-adjacent names must keep working.
      const ok = await runtime.js('const caps = { a: 1 }; const capHelper = 2;')
      expect(ok.status).toBe('ok')
      const probe = await runtime.js('nodeRepl.write(caps.a + ":" + capHelper + ":" + typeof cap.list);')
      expect(probe.output).toContain('1:2:function')
    } finally {
      await runtime.dispose()
    }
  }, 120_000)
})
