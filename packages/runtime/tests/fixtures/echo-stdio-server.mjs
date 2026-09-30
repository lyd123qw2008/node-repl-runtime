/**
 * A minimal MCP stdio server that can be killed on purpose.
 *
 * The stdio twin of the HTTP fixture, and it exists for one shape: when a child exits, the SDK's
 * transport clears the client's transport, so the *next* request is rejected with a plain
 * `Error("Not connected")` — no error code. That is the path a dead browser/Cua/IDE child takes, and
 * it is worth a test of its own: this server writes its pid to the file named on the command line so
 * the test can kill it, and the replacement child writes its own pid there.
 */

import { writeFileSync } from 'node:fs'

const pidFile = process.argv[2]
if (pidFile !== undefined) writeFileSync(pidFile, String(process.pid))

process.stdin.setEncoding('utf8')
let buffer = ''
process.stdin.on('data', chunk => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim() === '') continue
    const message = JSON.parse(line)
    // Notifications carry no id and need no answer.
    if (message.id === undefined) continue

    let result
    if (message.method === 'tools/list') {
      result = {
        tools: [
          {
            name: 'echo',
            description: 'Echo the arguments back.',
            inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
            annotations: { readOnlyHint: true },
          },
          {
            name: 'write_thing',
            description: 'Pretend to change something.',
            inputSchema: { type: 'object', properties: {} },
            annotations: { readOnlyHint: false },
          },
        ],
      }
    } else if (message.method === 'tools/call') {
      result = {
        content: [{ type: 'text', text: 'ok' }],
        // The pid proves which child answered, so a retry after a death is observable.
        structuredContent: { tool: message.params?.name, pid: process.pid },
      }
    } else {
      result = {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'echo-stdio', version: '0.0.0' },
      }
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
  }
})
