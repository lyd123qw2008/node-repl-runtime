/**
 * Spike host: prove that a *reused* node_repl kernel can drive the real IDEA MCP
 * server through an injected capability catalog.
 *
 * Flow:
 *   host ──stdio MCP──▶ @qwen-code/node-repl-mcp  (the reused kernel)
 *     ▲                        │
 *     │  loopback TCP          │ await import('nr-cap')   ← our bridge module
 *     └────────────────────────┘
 *     │
 *     └──streamable HTTP MCP──▶ IDEA MCP
 *
 * The point of the spike is the two things no existing project provides together:
 *   1. a PERSISTENT kernel (reused, not written by us);
 *   2. an MCP capability catalog injected into it as `cap.*`, with host-owned
 *      arguments (`projectPath`) injected on the host side so the model never
 *      sees or supplies them.
 */

import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const KERNEL_ROOT = `${HERE}kernelroot`
const BRIDGE_CONFIG = `${KERNEL_ROOT}/node_modules/nr-cap/config.json`

const IDEA_URL = 'http://127.0.0.1:64342/stream'
const PROJECT = 'D:/liuyongdan/code/fx/git-code/5g-os-server'

// ─── provider configuration: this is the whole "integration" for an MCP server ──
const PROVIDER_CONFIG = [
  {
    id: 'idea',
    label: 'IntelliJ IDEA',
    transport: 'streamable-http',
    url: IDEA_URL,
    /** Host-owned constants. The model never sees these and cannot override them. */
    inject: { projectPath: PROJECT },
    /** Host-side exposure filter, replacing any bespoke review gate. */
    include: null,
  },
]

// ─── MCP side: connect, project tools/list into a catalog ───────────────────────

async function openProvider(config) {
  const client = new Client(
    { name: 'node-repl-runtime', version: '0.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  )
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url)))
  const listed = await client.listTools(undefined, { timeout: 60_000, cacheMode: 'refresh' })
  const tools = config.include === null
    ? listed.tools
    : listed.tools.filter(tool => config.include.some(pattern => new RegExp(pattern).test(tool.name)))
  return { config, client, tools }
}

function projectOperation(tool, config) {
  const injected = Object.keys(config.inject ?? {})
  const properties = { ...(tool.inputSchema?.properties ?? {}) }
  // The model-visible schema must not offer host-owned arguments.
  for (const name of injected) delete properties[name]
  const required = (tool.inputSchema?.required ?? []).filter(name => !injected.includes(name))
  return {
    name: tool.name,
    summary: tool.description ?? tool.name,
    safety: tool.annotations?.readOnlyHint === true ? 'read' : 'mutate',
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
  }
}

// ─── bridge server: the kernel calls back here ─────────────────────────────────

const token = randomBytes(16).toString('hex')
const providers = new Map()

const server = createServer(socket => {
  socket.setEncoding('utf8')
  let buffer = ''
  socket.on('data', async chunk => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim() === '') continue
      let request
      try {
        request = JSON.parse(line)
      } catch {
        continue
      }
      const reply = await handle(request)
      socket.write(`${JSON.stringify(reply)}\n`)
    }
  })
  socket.on('error', () => {})
})

async function handle(request) {
  const id = request.id
  if (request.token !== token) {
    return { id, ok: false, error: { code: 'BRIDGE_UNAUTHORIZED', message: 'bad bridge token' } }
  }
  if (request.kind !== 'call') {
    return { id, ok: false, error: { code: 'BRIDGE_UNSUPPORTED', message: `unsupported kind ${request.kind}` } }
  }
  const separator = String(request.name).indexOf('.')
  const providerId = String(request.name).slice(0, separator)
  const operation = String(request.name).slice(separator + 1)
  const provider = providers.get(providerId)
  if (provider === undefined) {
    return { id, ok: false, error: { code: 'UNKNOWN_PROVIDER', message: `unknown provider ${providerId}` } }
  }
  const tool = provider.tools.find(candidate => candidate.name === operation)
  if (tool === undefined) {
    return { id, ok: false, error: { code: 'UNKNOWN_OPERATION', message: `unknown operation ${request.name}` } }
  }
  // Host-owned arguments are injected here, and a model-supplied value is refused
  // rather than silently overwritten.
  const args = { ...(request.args ?? {}) }
  for (const [key, value] of Object.entries(provider.config.inject ?? {})) {
    if (key in args) {
      return {
        id,
        ok: false,
        error: { code: 'HOST_ARGUMENT_SUPPLIED', message: `${key} is host-owned and may not be supplied by the caller` },
      }
    }
    args[key] = value
  }
  try {
    const result = await provider.client.callTool({ name: operation, arguments: args }, { timeout: 120_000 })
    if (result.isError === true) {
      const text = (result.content ?? []).find(block => block.type === 'text')?.text ?? 'tool error'
      return { id, ok: false, error: { code: 'MCP_TOOL_ERROR', message: text } }
    }
    const value = result.structuredContent ?? result.content ?? null
    return { id, ok: true, value }
  } catch (error) {
    return { id, ok: false, error: { code: 'MCP_CALL_FAILED', message: String(error?.message ?? error) } }
  }
}

// ─── run the spike ─────────────────────────────────────────────────────────────

async function main() {
  for (const config of PROVIDER_CONFIG) {
    const provider = await openProvider(config)
    providers.set(config.id, provider)
    console.log(`[host] provider ${config.id}: ${provider.tools.length} tool(s)`)
  }

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  console.log(`[host] bridge listening on 127.0.0.1:${address.port}`)

  // The kernel imports the bridge module, which reads this snapshot next to itself.
  writeFileSync(BRIDGE_CONFIG, `${JSON.stringify({
    host: '127.0.0.1',
    port: address.port,
    token,
    providers: PROVIDER_CONFIG.map(config => ({
      id: config.id,
      label: config.label,
      operations: providers.get(config.id).tools.map(tool => projectOperation(tool, config)),
    })),
  }, null, 2)}\n`)
  console.log('[host] wrote bridge config snapshot')

  // ── launch the REUSED kernel ──
  const kernelEntry = `${HERE}node_modules/@qwen-code/node-repl-mcp/dist/index.js`
  const kernel = new Client({ name: 'nr-kernel', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } })
  await kernel.connect(new StdioClientTransport({ command: process.execPath, args: [kernelEntry], cwd: KERNEL_ROOT }))
  const kernelTools = await kernel.listTools(undefined, { timeout: 30_000 })
  console.log(`[host] kernel tools: ${kernelTools.tools.map(tool => tool.name).join(', ')}`)

  const cell = async (label, code, timeoutMs = 60_000) => {
    const started = Date.now()
    const result = await kernel.callTool({ name: 'node_repl', arguments: { code, timeout_ms: timeoutMs, title: label } }, { timeout: 180_000 })
    const text = (result.content ?? []).map(block => block.text ?? '').join('\n')
    console.log(`\n[cell] ${label}  (${Date.now() - started}ms)  isError=${String(result.isError)}`)
    console.log(text.trim().slice(0, 1_200))
    return { result, text }
  }

  // Cell 1: install `cap` as a global. Because kernel bindings persist, this runs
  // ONCE and every later cell simply has `cap` in scope.
  await cell('init: install cap', "globalThis.cap = (await import('nr-cap')).cap;\n"
    + "nodeRepl.write('cap ready; providers=' + Object.keys(cap).join(','));")

  // Cell 2: the payload — a multi-step chain against the real IDE, with no
  // projectPath anywhere in the cell, and in-kernel processing.
  await cell('chain: real IDEA work', `
const hits = await cap.idea.search_text({ q: 'class', limit: 2 });
const problems = await cap.idea.get_file_problems({ filePath: hits.items[0].filePath });
const modules = await cap.idea.get_project_modules();
nodeRepl.write(JSON.stringify({
  hits: hits.items.length,
  more: hits.more,
  first: hits.items[0].filePath,
  problems: problems.errors.length,
  modules: modules.modules.length,
}));
`)

  // Cell 3: prove the kernel persists — discovery is local (no round trip), and
  // the model-visible schema has no host-owned argument in it.
  await cell('persist + discovery', `
nodeRepl.write(JSON.stringify({
  capProviders: Object.keys(cap),
  ideaOperations: Object.keys(cap.idea).length,
  searchTextSchemaProps: Object.keys(cap.describe('idea.search_text').inputSchema.properties),
}));
`)

  // Cells 4-7 probe the semantics we are buying by reusing this kernel, so the
  // reuse decision rests on measurement rather than on its README.
  await cell('semantics: let binding', "let counter = 1; nodeRepl.write('counter=' + counter);")
  await cell('semantics: mutate across cells', "counter = counter + 1; nodeRepl.write('counter=' + counter);")
  await cell('semantics: redeclare let across cells', "let counter = 100; nodeRepl.write('counter=' + counter);")
  await cell('semantics: function persists', "function double(n) { return n * 2; }\nnodeRepl.write('double(21)=' + double(21));")
  await cell('semantics: call fn from later cell', "nodeRepl.write('later double(5)=' + double(5));")
  await cell('semantics: throwing cell', "let survived = 'yes';\nthrow new Error('deliberate');")
  await cell('semantics: after throw', "nodeRepl.write('survived=' + (typeof survived === 'undefined' ? 'GONE' : survived));")
  await cell('semantics: cap still live after throw', "const m = await cap.idea.get_project_modules();\nnodeRepl.write('modules=' + m.modules.length);")

  // The re-declaration question, precisely: node_repl's own doc advertises that
  // top-level bindings "can be redeclared". `let` re-declaration failed above, so
  // pin exactly which forms do and do not work — that determines what the model
  // must be told, or whether the kernel needs patching.
  await cell('redecl: var then var', "var v = 1; nodeRepl.write('v=' + v);")
  await cell('redecl: var again', "var v = 2; nodeRepl.write('v=' + v);")
  await cell('redecl: let then var', "let L = 1; nodeRepl.write('L=' + L);")
  await cell('redecl: var shadowing a let', "var L = 2; nodeRepl.write('L=' + L);")
  await cell('redecl: assignment creates global', "createdByAssignment = 7; nodeRepl.write('ok=' + createdByAssignment);")
  await cell('redecl: read that global later', "nodeRepl.write('later=' + (typeof createdByAssignment === 'undefined' ? 'GONE' : createdByAssignment));")

  await kernel.close()
  for (const provider of providers.values()) await provider.client.close().catch(() => {})
  server.close()
  console.log('\n[host] done')
}

await main()
