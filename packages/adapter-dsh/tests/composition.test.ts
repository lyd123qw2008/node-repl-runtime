/**
 * Composition test: does the two-tool face actually register through Cordis?
 *
 * The face tests check the definitions in isolation. This one mounts them the way a
 * profile does — a runtime service supplied by a bootstrap, then the adapter plugin —
 * and asserts the model-visible surface is exactly `js` and `js_reset`. That is the
 * property the whole design rests on, so it should fail loudly if a stray tool ever
 * appears or the service wiring breaks.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { CapabilityRuntime } from '@node-repl-runtime/runtime'
import * as adapter from '../src/index.js'

function fakeRuntime(): CapabilityRuntime {
  return {
    js: vi.fn(async () => ({ status: 'ok' as const, output: 'mounted', durationMs: 1 })),
    jsReset: vi.fn(async () => {}),
    catalog: () => [],
    dispose: vi.fn(async () => {}),
  } as CapabilityRuntime
}

/** Compose exactly the way a profile does: runtime service first, then the adapter. */
async function compose() {
  const ctx = new Context()
  const promptFiber = await ctx.plugin(SystemPrompt)
  const toolFiber = await ctx.plugin(ToolRuntime)
  const runtime = fakeRuntime()
  await ctx.plugin({
    name: 'test-bootstrap',
    apply(inner: Context) {
      inner.provide('nodeReplRuntime', runtime)
    },
  })
  const adapterFiber = await ctx.plugin(adapter)
  return {
    ctx,
    runtime,
    schemas: ctx.tools.schemas(),
    async dispose() {
      await adapterFiber.dispose()
      await toolFiber.dispose()
      await promptFiber.dispose()
      await ctx.fiber.dispose()
    },
  }
}

describe('two-tool face through Cordis', () => {
  it('registers exactly js and js_reset, and nothing provider-shaped', async () => {
    const preset = await compose()
    try {
      const names = preset.schemas.map(schema => schema.name)
      expect(names).toEqual(['js', 'js_reset'])
      // The MCP surface must not leak into the model's tool list, however many
      // servers are attached.
      expect(names.filter(name => name.startsWith('mcp__'))).toEqual([])
      expect(names.filter(name => name.includes('cap_'))).toEqual([])
    } finally {
      await preset.dispose()
    }
  })

  it('declares a host-owned-argument warning instead of a provider argument', async () => {
    const preset = await compose()
    try {
      const js = preset.ctx.tools.get('js')
      expect(js).toBeDefined()
      const serialized = JSON.stringify(preset.schemas)
      // No provider argument names may appear in the declarations.
      expect(serialized).not.toContain('projectPath')
      expect(serialized).toContain('host-owned')
    } finally {
      await preset.dispose()
    }
  })

  it('stays dormant until a runtime service exists', async () => {
    // The adapter must not register a broken face when nothing provides the runtime;
    // it waits, exactly like the old facade did.
    const ctx = new Context()
    const promptFiber = await ctx.plugin(SystemPrompt)
    const toolFiber = await ctx.plugin(ToolRuntime)
    const adapterFiber = await ctx.plugin(adapter)
    try {
      expect(ctx.tools.schemas().map(schema => schema.name)).toEqual([])
    } finally {
      await adapterFiber.dispose()
      await toolFiber.dispose()
      await promptFiber.dispose()
      await ctx.fiber.dispose()
    }
  })
})
