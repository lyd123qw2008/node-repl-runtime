/**
 * The host side of the capability bridge.
 *
 * The kernel cannot reach MCP servers directly, and should not: keeping the call on
 * the host is what lets host-owned arguments be injected and caller-supplied ones be
 * refused. So the kernel talks back over loopback TCP with a per-run token, and this
 * server turns `{provider.operation, args}` into an MCP call.
 *
 * Loopback + random port + random token, because this channel is only reachable from
 * the kernel child process we started. It is not a security boundary between mutually
 * distrusting parties and is not presented as one.
 */

import { createServer, type Server } from 'node:net'
import { randomBytes } from 'node:crypto'
import type { ProviderConnection } from './types.js'

interface BridgeRequest {
  readonly id?: unknown
  readonly token?: unknown
  readonly kind?: unknown
  readonly name?: unknown
  readonly args?: unknown
}

export interface Bridge {
  readonly host: string
  readonly port: number
  readonly token: string
  /**
   * Abort every provider call still waiting for an answer because the cell that asked
   * for it is gone.
   *
   * A cancelled cell cannot read its result, and a call left in flight does not merely
   * waste work: a provider that serializes requests per session — the browser bridge is
   * one — keeps that session's later calls queued behind it. Dropping the caller is not
   * enough; the request itself has to be abandoned. Aborting sends the MCP cancellation
   * notification, so a provider that supports cancellation can stop the work as well.
   */
  abandonInFlight(reason: string): void
  close(): Promise<void>
}

export async function startBridge(providers: ReadonlyMap<string, ProviderConnection>): Promise<Bridge> {
  const token = randomBytes(24).toString('hex')
  /** Provider calls currently running, keyed by the controller that can abort them. */
  const inFlight = new Map<AbortController, string>()

  const handle = async (request: BridgeRequest, controller: AbortController): Promise<unknown> => {
    const id = request.id
    const fail = (code: string, message: string): unknown => ({ id, ok: false, error: { code, message } })
    if (request.token !== token) return fail('BRIDGE_UNAUTHORIZED', 'bad bridge token')
    if (request.kind !== 'call') return fail('BRIDGE_UNSUPPORTED', `unsupported kind ${String(request.kind)}`)

    const full = String(request.name)
    const separator = full.indexOf('.')
    if (separator <= 0) return fail('BRIDGE_BAD_NAME', `expected "provider.operation", got ${full}`)
    const provider = providers.get(full.slice(0, separator))
    if (provider === undefined) return fail('UNKNOWN_PROVIDER', `unknown provider ${full.slice(0, separator)}`)
    const operation = full.slice(separator + 1)
    if (!provider.operations.some(candidate => candidate.name === operation)) {
      return fail('UNKNOWN_OPERATION', `unknown operation ${full}`)
    }

    inFlight.set(controller, full)
    try {
      const value = await provider.call(operation, (request.args ?? {}) as Record<string, unknown>, controller.signal)
      return { id, ok: true, value }
    } catch (error) {
      if (controller.signal.aborted) {
        return fail('BRIDGE_CALL_ABANDONED', `${full} was abandoned: ${String(controller.signal.reason ?? 'caller gone')}`)
      }
      return fail('MCP_CALL_FAILED', error instanceof Error ? error.message : String(error))
    } finally {
      inFlight.delete(controller)
    }
  }

  const server: Server = createServer(socket => {
    socket.setEncoding('utf8')
    // Calls die with the socket that asked for them: if the kernel process goes away,
    // nothing can ever read those answers either.
    const socketCalls = new Set<AbortController>()
    socket.on('close', () => {
      for (const controller of socketCalls) controller.abort(new Error('bridge client disconnected'))
      socketCalls.clear()
    })
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      let index: number
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim() === '') continue
        let parsed: BridgeRequest
        try {
          parsed = JSON.parse(line) as BridgeRequest
        } catch {
          continue
        }
        const controller = new AbortController()
        socketCalls.add(controller)
        void handle(parsed, controller)
          .then(reply => socket.write(`${JSON.stringify(reply)}\n`))
          .catch(() => {})
          .finally(() => socketCalls.delete(controller))
      }
    })
    socket.on('error', () => {})
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('bridge failed to bind a TCP port')

  return {
    host: '127.0.0.1',
    port: address.port,
    token,
    abandonInFlight(reason: string) {
      const pending = [...inFlight.entries()]
      inFlight.clear()
      for (const [controller] of pending) controller.abort(new Error(reason))
    },
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
