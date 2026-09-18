/**
 * `integration:demo` — attach any MCP server and drive it from one persistent kernel.
 *
 * This is the shortest honest proof that integrating an MCP server costs
 * configuration and nothing else: no provider-specific source file exists to add,
 * because this command is the whole adapter.
 *
 *   node packages/runtime/dist/cli.js \
 *     --id idea \
 *     --url http://127.0.0.1:64342/stream \
 *     --inject projectPath=D:/path/to/project \
 *     [--code 'nodeRepl.write(capHelp("idea"));' | --code-file cell.js]
 *
 * Without `--code`/`--code-file` it prints the projected catalog, which is the
 * discovery step.
 */

import { readFileSync } from 'node:fs'
import { createCapabilityRuntime } from './index.js'
import type { McpProviderSpec } from './types.js'

interface Args {
  readonly spec: McpProviderSpec
  readonly code?: string
  readonly timeoutMs: number
}

function parseInjection(text: string): Record<string, string> {
  const separator = text.indexOf('=')
  if (separator <= 0) throw new Error(`--inject expects name=value, got ${text}`)
  return { [text.slice(0, separator)]: text.slice(separator + 1) }
}

function parse(argv: readonly string[]): Args {
  const values = new Map<string, string[]>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (!token.startsWith('--')) continue
    const next = argv[index + 1]
    const list = values.get(token.slice(2)) ?? []
    if (next !== undefined && !next.startsWith('--')) {
      list.push(next)
      index += 1
    }
    values.set(token.slice(2), list)
  }

  const config = values.get('config')?.[0]
  const inline = values.get('code')?.[0]
  const codeFile = values.get('code-file')?.[0]
  if (inline !== undefined && codeFile !== undefined) throw new Error('use --code or --code-file, not both')
  // `--code-file` exists because multi-line cells are painful to pass through a shell,
  // and because quoting bugs there look like kernel syntax errors.
  const code = inline ?? (codeFile === undefined ? undefined : readFileSync(codeFile, 'utf8'))

  if (config !== undefined) {
    const parsed = JSON.parse(readFileSync(config, 'utf8')) as { providers?: McpProviderSpec[] }
    const first = parsed.providers?.[0]
    if (first === undefined) throw new Error(`${config} has no providers[0]`)
    return {
      spec: first,
      ...code === undefined ? {} : { code },
      timeoutMs: Number(values.get('timeout')?.[0] ?? 60_000),
    }
  }

  const id = values.get('id')?.[0]
  if (id === undefined) throw new Error('--id is required (or use --config)')
  const url = values.get('url')?.[0]
  const command = values.get('command')?.[0]
  if (url === undefined && command === undefined) throw new Error('--url (http) or --command (stdio) is required')

  const inject = Object.assign({}, ...(values.get('inject') ?? []).map(parseInjection))
  return {
    spec: {
      id,
      label: values.get('label')?.[0] ?? id,
      transport: url === undefined ? 'stdio' : 'streamable-http',
      ...url === undefined ? {} : { url },
      ...command === undefined ? {} : { command },
      ...values.get('arg') === undefined ? {} : { args: values.get('arg')! },
      ...Object.keys(inject).length === 0 ? {} : { inject },
      ...values.get('include') === undefined ? {} : { include: values.get('include')! },
    },
    ...code === undefined ? {} : { code },
    timeoutMs: Number(values.get('timeout')?.[0] ?? 60_000),
  }
}

const args = parse(process.argv.slice(2))
const runtime = await createCapabilityRuntime({ providers: [args.spec], cellTimeoutMs: args.timeoutMs })

try {
  for (const provider of runtime.catalog()) {
    console.log(`provider ${provider.id} (${provider.label}) — ${provider.operations.length} operation(s)`)
    const injected = Object.keys(args.spec.inject ?? {})
    if (injected.length > 0) console.log(`  host-owned, hidden from the model: ${injected.join(', ')}`)
  }
  const result = await runtime.js(args.code ?? 'nodeRepl.write(capHelp());', { title: 'integration demo' })
  console.log(`\ncell status: ${result.status} (${result.durationMs}ms)`)
  console.log(result.output)
  if (result.status !== 'ok') process.exitCode = 1
} finally {
  await runtime.dispose()
}
