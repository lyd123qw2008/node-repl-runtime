/**
 * A minimal MCP stdio server that connects and then refuses discovery.
 *
 * It exists to prove one thing: `connectMcpProvider` reaps the client it opened. A server
 * that fails `tools/list` is the single path where the runtime holds a live child process
 * and has no connection to hand back — so if the failing side does not close it, that child
 * is orphaned, once per startup, silently.
 *
 * The pid file is written before the fixture answers anything, so the test observes the
 * process directly instead of racing a timer.
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
    const reply = message.method === 'tools/list'
      ? { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'discovery refused' } }
      : {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            // Echo the client's own version: negotiation is the client's business and this
            // fixture is not what tests it.
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fails-tools-list', version: '0.0.0' },
          },
        }
    process.stdout.write(`${JSON.stringify(reply)}\n`)
  }
})
