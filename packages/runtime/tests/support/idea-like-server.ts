/**
 * A sessionful streamable-HTTP MCP server that can lose its sessions on command.
 *
 * It exists to reproduce one measured production failure faithfully: IntelliJ IDEA's
 * MCP server keeps its URL across a restart but forgets every `Mcp-Session-Id` it
 * issued, so every later POST answers `404 Streamable HTTP session not found` and the
 * client has no session to fall back to. The wire behaviour is the part that matters,
 * so this is a real HTTP server speaking the streamable-HTTP subset the SDK client
 * uses — initialize, `tools/list`, `tools/call`, notifications — rather than a stub at
 * the connector seam, which would never exercise the session id at all.
 *
 * `restart()` is the IDE restart: the URL stays, the session table does not.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

/** One advertised tool, in the shape `tools/list` returns it. */
interface AdvertisedTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

const DEFAULT_TOOLS: readonly AdvertisedTool[] = [
  {
    name: 'echo',
    description: 'Echo the arguments back.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  },
  {
    name: 'get_file_problems',
    description: 'Problems the IDE found, as the real server reports them.',
    inputSchema: { type: 'object', properties: { projectPath: { type: 'string' } } },
  },
  {
    // The long-operation stand-in: it can answer quietly (which is what the request deadline
    // bounds) or report progress while it works (which is what renews that deadline). Progress has
    // to travel on an SSE response stream, because a notification cannot share one JSON body with
    // the result it precedes.
    name: 'slow',
    description: 'Sleep for `ms`, optionally reporting progress every `progressEveryMs`.',
    inputSchema: {
      type: 'object',
      properties: { ms: { type: 'number' }, progressEveryMs: { type: 'number' } },
    },
  },
]

export interface IdeaLikeServer {
  /** The endpoint, stable across `restart()` — exactly like the IDE's fixed port. */
  readonly url: string
  /** The bound port, so a later server can take the same endpoint over. */
  readonly port: number
  /** MCP sessions this process has opened. One per initialize, so one per (re)connect. */
  sessions(): number
  /** `tools/list` answers. One per connect *and* per reconnect, so single-flight is observable. */
  listings(): number
  /** Tool calls that actually executed. */
  calls(): number
  /** Forget every session id, leaving the URL and the tools in place. */
  restart(): void
  /** Advertise one more tool from now on, as installing a plugin would. */
  addTool(name: string): void
  close(): Promise<void>
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

function send(response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(body)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

export async function startIdeaLikeServer(
  options: { tools?: readonly string[]; port?: number } = {},
): Promise<IdeaLikeServer> {
  const tools: AdvertisedTool[] = options.tools === undefined
    ? [...DEFAULT_TOOLS]
    : options.tools.map(name => ({ name, description: `${name}.`, inputSchema: { type: 'object', properties: {} } }))

  /** Session ids this process currently honours. `restart()` empties it without changing the URL. */
  const liveSessions = new Set<string>()
  let sessionCount = 0
  let listingCount = 0
  let callCount = 0

  const server: Server = createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET' || request.method === 'DELETE') {
        // No server-initiated stream, and sessions are not client-terminable here: both are
        // legal answers (the spec allows 405 for GET), and neither is what this fixture tests.
        send(response, 405, '')
        return
      }
      if (request.method !== 'POST') {
        send(response, 405, '')
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(await readBody(request))
      } catch {
        send(response, 400, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
        return
      }
      const messages = (Array.isArray(parsed) ? parsed : [parsed]) as readonly {
        id?: unknown
        method?: unknown
        params?: { protocolVersion?: unknown }
      }[]

      // The negotiate-era probe arrives before any session exists, so it is answered without
      // one: `method not found` is what tells an auto-negotiating client to fall back to the
      // 2025-era initialize handshake this fixture serves.
      const requestMessage = messages.find(message => message.id !== undefined)
      if (requestMessage?.method === 'server/discover') {
        send(response, 200, JSON.stringify({
          jsonrpc: '2.0',
          id: requestMessage.id,
          error: { code: -32601, message: 'Method not found' },
        }))
        return
      }

      const initialize = messages.find(message => message.method === 'initialize')
      if (initialize !== undefined) {
        const sessionId = randomUUID()
        liveSessions.add(sessionId)
        sessionCount += 1
        send(response, 200, JSON.stringify({
          jsonrpc: '2.0',
          id: initialize.id,
          result: {
            protocolVersion: initialize.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'idea-like', version: '0.0.0' },
          },
        }), { 'mcp-session-id': sessionId })
        return
      }

      // Everything else must carry a session this process still honours. This is the
      // behaviour under test: a stale id is a 404 with the server's own words, never a
      // silent retry and never a fresh session.
      const presented = request.headers['mcp-session-id']
      if (typeof presented !== 'string' || !liveSessions.has(presented)) {
        response.writeHead(404, { 'content-type': 'text/plain' })
        response.end('Streamable HTTP session not found')
        return
      }

      if (requestMessage === undefined) {
        // A notification: accepted, nothing to answer.
        response.writeHead(202)
        response.end()
        return
      }

      if (requestMessage.method === 'tools/list') {
        listingCount += 1
        send(response, 200, JSON.stringify({
          jsonrpc: '2.0',
          id: requestMessage.id,
          result: { tools },
        }))
        return
      }

      if (requestMessage.method === 'tools/call') {
        callCount += 1
        const params = (requestMessage as {
          params?: { name?: string; arguments?: unknown; _meta?: { progressToken?: unknown } }
        }).params ?? {}
        const args = (params.arguments ?? {}) as { ms?: unknown; progressEveryMs?: unknown }
        const ms = typeof args.ms === 'number' ? args.ms : 0

        if (params.name === 'slow') {
          const every = typeof args.progressEveryMs === 'number' && args.progressEveryMs > 0 ? args.progressEveryMs : 0
          const token = params._meta?.progressToken
          const result = {
            jsonrpc: '2.0',
            id: requestMessage.id,
            result: {
              content: [{ type: 'text', text: `slow ok after ${ms} ms` }],
              structuredContent: { sleptMs: ms },
            },
          }

          if (every === 0 || token === undefined) {
            // Quiet: the client's own deadline is the only thing that can stop this.
            await sleep(ms)
            send(response, 200, JSON.stringify(result))
            return
          }

          // Progress has to arrive before the result, so the answer is an SSE stream: one
          // notification per interval, then the terminal result message.
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          // A client that gave up mid-stream (a cell out of budget) closes the socket; writing to it
          // afterwards must not take the fixture down with an unhandled stream error.
          response.on('error', () => {})
          const total = Math.ceil(ms / every)
          let steps = 0
          for (let waited = 0; waited + every <= ms; waited += every) {
            await sleep(every)
            if (response.destroyed || response.writableEnded) return
            steps += 1
            response.write(`data: ${JSON.stringify({
              jsonrpc: '2.0',
              method: 'notifications/progress',
              params: { progressToken: token, progress: steps, total },
            })}\n\n`)
          }
          await sleep(Math.max(0, ms - steps * every))
          if (response.destroyed || response.writableEnded) return
          response.write(`data: ${JSON.stringify(result)}\n\n`)
          response.end()
          return
        }

        send(response, 200, JSON.stringify({
          jsonrpc: '2.0',
          id: requestMessage.id,
          result: {
            content: [{ type: 'text', text: `${String(params.name)} ok` }],
            structuredContent: { tool: params.name, args: params.arguments ?? {} },
          },
        }))
        return
      }

      send(response, 200, JSON.stringify({
        jsonrpc: '2.0',
        id: requestMessage.id,
        error: { code: -32601, message: 'Method not found' },
      }))
    })().catch(() => {
      if (!response.headersSent) send(response, 500, '')
    })
  })

  await new Promise<void>(resolve => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture failed to bind a port')

  return {
    url: `http://127.0.0.1:${address.port}/stream`,
    port: address.port,
    sessions: () => sessionCount,
    listings: () => listingCount,
    calls: () => callCount,
    restart() {
      liveSessions.clear()
    },
    addTool(name: string) {
      tools.push({ name, description: `${name}.`, inputSchema: { type: 'object', properties: {} } })
    },
    close: () => new Promise<void>(resolve => { server.close(() => resolve()) }),
  }
}
