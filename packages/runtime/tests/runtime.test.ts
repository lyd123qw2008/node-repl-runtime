/**
 * Hermetic tests: no network, no IDE.
 *
 * A fake provider connection stands in for an MCP server, so the parts under test are
 * the runtime's own: the TCP capability bridge, the kernel hand-off (including the
 * `cap` install cell), argument injection, and the semantics the tool description
 * promises the model. The kernel child process is real — it is local, and reusing it
 * is the whole point of the design.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applyInjection,
  createCapabilityRuntime,
  projectOperation,
  selectTools,
  type CapabilityRuntime,
  type McpProviderSpec,
  type ProjectedOperation,
  type ProviderConnection,
} from '../src/index.js'

/** A recorded call, so injection can be observed from the provider's side. */
interface SeenCall {
  readonly operation: string
  readonly args: Readonly<Record<string, unknown>>
}

function fakeProvider(spec: McpProviderSpec, seen: SeenCall[]): ProviderConnection {
  const operations: ProjectedOperation[] = [
    {
      name: 'echo',
      summary: 'Echo the arguments back.',
      safety: 'read',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: [], additionalProperties: false },
    },
    {
      name: 'list_things',
      summary: 'Return three things.',
      safety: 'read',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
    {
      name: 'boom',
      summary: 'Always fails.',
      safety: 'mutate',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  ]
  return {
    id: spec.id,
    label: spec.label ?? spec.id,
    operations,
    async call(operation, args) {
      const merged = applyInjection(spec.inject ?? {}, args)
      seen.push({ operation, args: merged })
      if (operation === 'boom') throw new Error('provider said no')
      if (operation === 'list_things') return { items: ['a', 'b', 'c'] }
      return merged
    },
    async close() {},
  }
}

describe('capability runtime (hermetic)', () => {
  const seen: SeenCall[] = []
  let runtime: CapabilityRuntime

  beforeAll(async () => {
    runtime = await createCapabilityRuntime({
      providers: [{ id: 'fake', label: 'Fake MCP', transport: 'streamable-http', url: 'http://127.0.0.1:1/unused' }],
      connector: spec => Promise.resolve(fakeProvider(spec, seen)),
      cellTimeoutMs: 30_000,
    })
  }, 120_000)

  afterAll(async () => {
    await runtime?.dispose()
  })

  it('runs a cell and returns what it wrote', async () => {
    const result = await runtime.js("nodeRepl.write('hello from the kernel');")
    expect(result.status).toBe('ok')
    expect(result.output).toContain('hello from the kernel')
  })

  it('keeps bindings across cells, and scopes output to the cell that produced it', async () => {
    const first = await runtime.js('var total = 40; console.log("set total");')
    // `console.*` is captured alongside `nodeRepl.write`, but only for this cell:
    // output is not cumulative across cells.
    expect(first.output).toContain('set total')

    const second = await runtime.js('nodeRepl.write("total=" + total);')
    expect(second.output).toContain('total=40')
    expect(second.output).not.toContain('set total')
  })

  it('re-declares `var` but rejects a second `let` — the documented deviation', async () => {
    await runtime.js('var again = 1;')
    const redeclared = await runtime.js('var again = 2; nodeRepl.write("again=" + again);')
    expect(redeclared.status).toBe('ok')
    expect(redeclared.output).toContain('again=2')

    await runtime.js('let once = 1;')
    const rejected = await runtime.js('let once = 2;')
    // This is why the tool description tells the model to prefer `var` for names it
    // may redefine. If the reused kernel ever accepts this, the test should change
    // and the description should be simplified.
    expect(rejected.status).toBe('error')
    expect(rejected.error?.message ?? '').toContain('already been declared')
  })

  it('exposes the capability catalog inside the kernel', async () => {
    const result = await runtime.js('nodeRepl.write(String(Object.keys(cap.fake)));')
    expect(result.output).toContain('echo')
    expect(result.output).toContain('list_things')
    const help = await runtime.js('nodeRepl.write(capHelp());')
    expect(help.output).toContain('fake (Fake MCP) — 3 operation(s)')
  })

  it('calls a provider through the bridge and returns its value', async () => {
    const result = await runtime.js(
      'const things = await cap.fake.list_things();\nnodeRepl.write("count=" + things.items.length);',
    )
    expect(result.status).toBe('ok')
    expect(result.output).toContain('count=3')
    expect(seen.at(-1)).toEqual({ operation: 'list_things', args: {} })
  })

  it('surfaces a provider error as a catchable exception', async () => {
    const result = await runtime.js(
      'try { await cap.fake.boom(); } catch (error) { nodeRepl.write("caught: " + error.message); }',
    )
    expect(result.status).toBe('ok')
    expect(result.output).toContain('caught: provider said no')
  })

  it('injects host-owned arguments and refuses caller-supplied ones', async () => {
    const injected = await createCapabilityRuntime({
      providers: [{ id: 'owned', transport: 'streamable-http', url: 'http://127.0.0.1:1/unused', inject: { projectPath: '/host/project' } }],
      connector: spec => Promise.resolve(fakeProvider(spec, seen)),
      cellTimeoutMs: 30_000,
    })
    try {
      // The cell never mentions projectPath; the host supplies it.
      const ok = await injected.js('const r = await cap.owned.echo({ value: "x" });\nnodeRepl.write(JSON.stringify(r));')
      expect(ok.status).toBe('ok')
      expect(ok.output).toContain('/host/project')

      // Supplying it is an error, not a silent override.
      const refused = await injected.js(
        'try { await cap.owned.echo({ value: "x", projectPath: "/other" }); }\n'
        + 'catch (error) { nodeRepl.write("refused: " + error.message); }',
      )
      expect(refused.output).toContain('refused:')
      expect(refused.output).toContain('host-owned')
    } finally {
      await injected.dispose()
    }
  }, 120_000)

  it('clears bindings on js_reset', async () => {
    await runtime.js('var doomed = 1;')
    await runtime.jsReset()
    const result = await runtime.js('nodeRepl.write("doomed=" + (typeof doomed === "undefined" ? "GONE" : doomed));')
    expect(result.output).toContain('doomed=GONE')
    // ...and the catalog is reinstalled, because reset clears it too.
    const help = await runtime.js('nodeRepl.write(capHelp());')
    expect(help.output).toContain('fake (Fake MCP)')
  }, 120_000)

  it('exposes the kernel context object the description mentions', async () => {
    const result = await runtime.js(
      'nodeRepl.write(JSON.stringify({ cwd: typeof nodeRepl.cwd, home: typeof nodeRepl.homeDir, tmp: typeof nodeRepl.tmpDir }));',
    )
    expect(result.status).toBe('ok')
    expect(result.output).toContain('"cwd":"string"')
    expect(result.output).toContain('"home":"string"')
    expect(result.output).toContain('"tmp":"string"')
  })

  it('forwards the narrow outbound proxy policy to the kernel without leaking host environment', async () => {
    const names = [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
      'NODE_USE_ENV_PROXY',
      'DSH_RUNTIME_PROXY_TEST_SECRET',
    ] as const
    const previous = new Map(names.map(name => [name, process.env[name]]))
    let proxied: CapabilityRuntime | undefined
    try {
      process.env.HTTP_PROXY = 'http://127.0.0.1:19795'
      process.env.HTTPS_PROXY = 'http://127.0.0.1:19795'
      process.env.NO_PROXY = 'localhost,127.0.0.1,::1'
      process.env.NODE_USE_ENV_PROXY = '1'
      process.env.DSH_RUNTIME_PROXY_TEST_SECRET = 'must-not-reach-the-kernel'

      proxied = await createCapabilityRuntime({
        providers: [{ id: 'proxy', transport: 'streamable-http', url: 'http://127.0.0.1:1/unused' }],
        connector: spec => Promise.resolve(fakeProvider(spec, [])),
      })
      const readKernelNetworkEnv = () => proxied!.js(
        "const module = await import('node:module');\n"
        + "const require = module.createRequire(import.meta.url);\n"
        + "const childProcess = require('node:process');\n"
        + "nodeRepl.write(JSON.stringify({ http: childProcess.env.HTTP_PROXY, https: childProcess.env.HTTPS_PROXY, noProxy: childProcess.env.NO_PROXY, useEnvProxy: childProcess.env.NODE_USE_ENV_PROXY, hasSecret: Object.prototype.hasOwnProperty.call(childProcess.env, 'DSH_RUNTIME_PROXY_TEST_SECRET') }));",
      )
      const expectedEnvironment = {
        http: 'http://127.0.0.1:19795',
        https: 'http://127.0.0.1:19795',
        noProxy: 'localhost,127.0.0.1,::1',
        useEnvProxy: '1',
        hasSecret: false,
      }
      const observed = await readKernelNetworkEnv()
      expect(observed.status).toBe('ok')
      expect(JSON.parse(observed.output)).toEqual(expectedEnvironment)

      await proxied.jsReset()
      const observedAfterReset = await readKernelNetworkEnv()
      expect(observedAfterReset.status).toBe('ok')
      expect(JSON.parse(observedAfterReset.output)).toEqual(expectedEnvironment)
    } finally {
      await proxied?.dispose()
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  }, 120_000)

  it('stops a cell that overruns its budget and keeps the kernel usable', async () => {
    await runtime.js('var beforeTimeout = "kept";')
    const started = Date.now()
    // The cell would sleep far longer than the budget it is given.
    const overrun = await runtime.js('await new Promise(resolve => setTimeout(resolve, 60_000));', { timeoutMs: 1_500 })
    const elapsed = Date.now() - started

    expect(overrun.status).not.toBe('ok')
    expect(elapsed).toBeLessThan(20_000)
    // The tool description promises earlier bindings survive a stopped cell, and that
    // a stopped cell does not take the kernel down with it.
    const after = await runtime.js('nodeRepl.write("before=" + beforeTimeout);')
    expect(after.status).toBe('ok')
    expect(after.output).toContain('before=kept')
  }, 120_000)

  it('returns the result of a cell that outlives the kernel default yield window', async () => {
    // The kernel hands control back after `yield_time_ms` — 10 s unless the caller asks
    // for more — with a cell id and no result. The runtime must ask for the caller's
    // whole budget instead of reporting that yield as a finished cell.
    const started = Date.now()
    const slow = await runtime.js('await new Promise(resolve => setTimeout(resolve, 11_000)); nodeRepl.write("finished after yielding window");', { timeoutMs: 25_000 })

    expect(slow.status).toBe('ok')
    expect(slow.output).toContain('finished after yielding window')
    expect(Date.now() - started).toBeGreaterThan(10_000)
  }, 120_000)

  it('frees the kernel after a provider call outlives its budget, instead of bricking it', async () => {
    // The kernel has one active-cell slot, and `node_repl_reset` refuses while it is
    // occupied, so an abandoned cell would refuse every later cell — and a reset could
    // not even clear it. A provider call that never answers is exactly how that happens.
    //
    // Stopping the wait is not enough: a request left in flight keeps the provider's
    // session busy for every later cell, so the runtime has to abort it. This records
    // which of the two happened.
    let outcome = 'still running'
    const hanging = await createCapabilityRuntime({
      providers: [{ id: 'hang', label: 'Hanging MCP', transport: 'streamable-http', url: 'http://127.0.0.1:1/unused' }],
      connector: spec => Promise.resolve({
        id: spec.id,
        label: spec.label ?? spec.id,
        operations: [{
          name: 'forever',
          summary: 'Never answers.',
          safety: 'read' as const,
          inputSchema: { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const },
        }],
        call: (_operation: string, _args: Readonly<Record<string, unknown>>, signal?: AbortSignal) =>
          new Promise((_resolve, reject) => {
            if (signal === undefined) {
              outcome = 'no cancellation signal was passed'
              return
            }
            if (signal.aborted) {
              outcome = 'aborted'
              return
            }
            signal.addEventListener('abort', () => {
              outcome = 'aborted'
              reject(new Error('aborted by the runtime'))
            })
          }),
        close: async () => {},
      }),
      cellTimeoutMs: 20_000,
    })
    try {
      const stuck = await hanging.js('await cap.hang.forever();', { timeoutMs: 3_000 })
      // The kernel reports its own timeout through `isError` plus a `[node_repl timeout]`
      // notice; the runtime has to read that notice or every stopped cell looks like a
      // plain error — and the abandonment rule below would never fire.
      expect(stuck.status).toBe('timeout')

      const after = await hanging.js('nodeRepl.write("kernel still usable");')
      expect(after.status).toBe('ok')
      expect(after.output).toContain('kernel still usable')

      // The duration must describe the whole cell, not the last kernel round trip: the
      // terminal outcome arrives through `node_repl_wait`, whose own duration is ~1 ms.
      expect(stuck.durationMs).toBeGreaterThan(2_000)

      // The provider must have been told to stop, not merely ignored.
      expect(outcome).toBe('aborted')

      await hanging.jsReset()
      const afterReset = await hanging.js('nodeRepl.write("cap is " + typeof cap);')
      expect(afterReset.status).toBe('ok')
      expect(afterReset.output).toContain('cap is object')
    } finally {
      await hanging.dispose()
    }
  }, 120_000)
})

describe('multi-provider and exposure narrowing', () => {
  it('attaches several providers as separate namespaces', async () => {
    const runtime = await createCapabilityRuntime({
      providers: [
        { id: 'one', transport: 'streamable-http', url: 'http://127.0.0.1:1/unused' },
        { id: 'two', transport: 'streamable-http', url: 'http://127.0.0.1:1/unused' },
      ],
      connector: spec => Promise.resolve(fakeProvider(spec, [])),
      cellTimeoutMs: 30_000,
    })
    try {
      const result = await runtime.js('nodeRepl.write(Object.keys(cap).sort().join(",") + "|" + cap.list().length);')
      expect(result.output).toContain('one,two')
      expect(result.output).toContain('|2')
      expect(runtime.catalog().map(provider => provider.id)).toEqual(['one', 'two'])
    } finally {
      await runtime.dispose()
    }
  }, 120_000)

  it('keeps working when one provider fails to attach', async () => {
    // A provider that will not connect must not take the runtime down; the model can
    // still work with what did attach. `Object.keys(cap)` lists providers only — the
    // `list`/`describe`/`call` helpers are non-enumerable on purpose.
    const runtime = await createCapabilityRuntime({
      providers: [
        { id: 'good', transport: 'streamable-http', url: 'http://127.0.0.1:1/unused' },
        { id: 'bad', transport: 'streamable-http', url: 'http://127.0.0.1:1/unused' },
      ],
      connector: spec => spec.id === 'bad'
        ? Promise.reject(new Error('connection refused'))
        : Promise.resolve(fakeProvider(spec, [])),
      cellTimeoutMs: 30_000,
    })
    try {
      const result = await runtime.js('nodeRepl.write("providers=" + Object.keys(cap).sort().join(","));')
      expect(result.output).toContain('providers=good')
      expect(result.output).not.toContain('bad')
    } finally {
      await runtime.dispose()
    }
  }, 120_000)

  it('lists only providers for discovery, keeping the helpers out of the way', async () => {
    const runtime = await createCapabilityRuntime({
      providers: [{ id: 'fake', transport: 'streamable-http', url: 'http://127.0.0.1:1/unused' }],
      connector: spec => Promise.resolve(fakeProvider(spec, [])),
      cellTimeoutMs: 30_000,
    })
    try {
      const keys = await runtime.js('nodeRepl.write(Object.keys(cap).join(","));')
      expect(keys.output).toContain('fake')
      expect(keys.output).not.toContain('list')
      // ...but the helpers still work.
      const helper = await runtime.js('nodeRepl.write("n=" + cap.list().length);')
      expect(helper.output).toContain('n=1')
    } finally {
      await runtime.dispose()
    }
  }, 120_000)

  it('refuses to start when nothing attached at all', async () => {
    await expect(createCapabilityRuntime({
      providers: [{ id: 'bad', transport: 'streamable-http', url: 'http://127.0.0.1:1/unused' }],
      connector: () => Promise.reject(new Error('connection refused')),
    })).rejects.toThrow(/no provider connected/)
  })

  it('narrows exposure with include without inventing a review step', () => {
    const tools = [
      { name: 'search_text' },
      { name: 'read_file' },
      { name: 'execute_terminal_command' },
    ]
    const spec = { id: 'p', transport: 'streamable-http' as const, include: ['^search_', '^read_'] }
    expect(selectTools(tools, spec).map(tool => tool.name)).toEqual(['search_text', 'read_file'])
    // Default is everything: the surface follows the server, not a curated list.
    expect(selectTools(tools, { id: 'p', transport: 'streamable-http' })).toHaveLength(3)
    expect(selectTools(tools, { id: 'p', transport: 'streamable-http', include: null })).toHaveLength(3)
  })
})

describe('projection (pure)', () => {  it('strips host-owned arguments from the model-visible schema', () => {
    const operation = projectOperation({
      name: 'search_text',
      description: 'Search project text.',
      inputSchema: {
        properties: { q: { type: 'string' }, projectPath: { type: 'string' } },
        required: ['q', 'projectPath'],
      },
      annotations: { readOnlyHint: true },
    }, { id: 'idea', transport: 'streamable-http', inject: { projectPath: '/host/project' } })

    expect(Object.keys(operation.inputSchema.properties)).toEqual(['q'])
    expect(operation.inputSchema.required).toEqual(['q'])
    expect(operation.inputSchema.additionalProperties).toBe(false)
    expect(operation.safety).toBe('read')
  })

  it('derives safety only from the server declaration, never from prose', () => {
    const annotate = (annotations: unknown) => projectOperation(
      { name: 'x', description: 'requires confirmation unless Brave Mode is enabled', inputSchema: {}, annotations },
      { id: 'p', transport: 'streamable-http' },
    )
    expect(annotate({ readOnlyHint: true }).safety).toBe('read')
    expect(annotate({ readOnlyHint: false }).safety).toBe('mutate')
    // Unannotated and scary-sounding is still `mutate`: the provider owns whether it
    // prompts, and this runtime does not invent a gate.
    expect(annotate(undefined).safety).toBe('mutate')
  })

  it('relays a declared result shape verbatim, and omits the field when there is none', () => {
    const withOutput = projectOperation({
      name: 'search_file',
      description: 'Find files.',
      inputSchema: { properties: { q: { type: 'string' } }, required: ['q'] },
      outputSchema: { type: 'object', properties: { items: { type: 'array' } }, required: ['items'] },
    }, { id: 'idea', transport: 'streamable-http' })

    // Verbatim: the provider's own contract, never a summary we authored. A cell
    // author cannot otherwise know whether a call answers `{items: [...]}` or
    // `{files: [...]}` — the IDEA server declares this for 42 of its 67 tools.
    expect(withOutput.outputSchema).toEqual({
      type: 'object',
      properties: { items: { type: 'array' } },
      required: ['items'],
    })

    // Absence is information too: those operations answer in content blocks.
    const withoutOutput = projectOperation(
      { name: 'read_file', description: 'Read a file.', inputSchema: { properties: {} } },
      { id: 'idea', transport: 'streamable-http' },
    )
    expect(withoutOutput.outputSchema).toBeUndefined()
    expect('outputSchema' in withoutOutput).toBe(false)
  })

  it('injects without mutating the caller input', () => {
    const args = { q: 'x' }
    expect(applyInjection({ projectPath: '/p' }, args)).toEqual({ q: 'x', projectPath: '/p' })
    expect(args).toEqual({ q: 'x' })
    expect(() => applyInjection({ projectPath: '/p' }, { projectPath: '/other' })).toThrow(/host-owned/)
  })
})
