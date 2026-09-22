/**
 * `nr-cap` — the kernel-side half of the capability bridge.
 *
 * This module is imported from inside the node_repl kernel. It reads a config
 * snapshot written next to itself by the host, builds a plain namespace tree from
 * it, and proxies calls back to the host over loopback TCP.
 *
 * Design notes that matter:
 *
 * - **Plain objects, not Proxies.** The catalog is known at import time, so
 *   `cap.idea.search_text` is a real enumerable function and `Object.keys(cap.idea)`
 *   lists the surface. A Proxy would hide it from a model exploring the kernel.
 * - **Config lives beside this file, not in the environment.** The cell cannot see
 *   `process`, and an imported module should not depend on how the host happened to
 *   launch the kernel.
 * - **Discovery is answered locally** from the snapshot, so exploring the catalog
 *   costs no round trip. Only `call` crosses the bridge.
 * - **Errors arrive as ordinary thrown `Error`s** carrying a stable `code`, so a
 *   cell can `try`/`catch` them like any other JavaScript failure.
 */

import { readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Re-read the snapshot written by the host. */
export function readConfig() {
  return JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'))
}

const config = readConfig()

let socket = null
let buffer = ''
let nextId = 0
const pending = new Map()

function ensureSocket() {
  if (socket !== null && socket.readyState === 'open') return socket
  socket = createConnection({ host: config.host, port: config.port })
  socket.setEncoding('utf8')
  socket.on('data', chunk => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim() === '') continue
      let reply
      try {
        reply = JSON.parse(line)
      } catch {
        continue
      }
      const waiter = pending.get(reply.id)
      if (waiter === undefined) continue
      pending.delete(reply.id)
      if (reply.ok === true) {
        waiter.resolve(reply.value)
      } else {
        const error = new Error(reply.error?.message ?? 'capability call failed')
        error.code = reply.error?.code ?? 'CAPABILITY_ERROR'
        waiter.reject(error)
      }
    }
  })
  const fail = error => {
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
    socket = null
  }
  socket.on('error', fail)
  socket.on('close', () => fail(new Error('capability bridge closed')))
  return socket
}

function request(payload) {
  return new Promise((resolve, reject) => {
    const id = String(++nextId)
    pending.set(id, { resolve, reject })
    ensureSocket().write(`${JSON.stringify({ id, token: config.token, ...payload })}\n`)
  })
}

const providers = new Map(config.providers.map(provider => [provider.id, provider]))

/** Namespaces per provider: `cap.<provider>.<operation>(args)`. */
const cap = {}

/**
 * Convenience helpers, defined NON-ENUMERABLE and before the provider namespaces, for
 * two reasons: `Object.keys(cap)` then lists only providers (so it is usable for
 * discovery), and a provider that happens to be called `list`, `describe` or `call`
 * wins over the helper rather than being shadowed by it. Providers are data; these are
 * conveniences.
 */
function defineHelper(target, name, value) {
  Object.defineProperty(target, name, { value, enumerable: false, configurable: true, writable: true })
}

defineHelper(cap, 'list', () => config.providers.map(provider => ({
  id: provider.id,
  label: provider.label,
  operations: provider.operations.length,
})))

defineHelper(cap, 'describe', name => {
  const separator = String(name).indexOf('.')
  if (separator <= 0) throw new Error(`expected "provider.operation", got ${name}`)
  const provider = providers.get(String(name).slice(0, separator))
  const operation = provider?.operations.find(candidate => candidate.name === String(name).slice(separator + 1))
  if (operation === undefined) throw new Error(`unknown capability ${name}`)
  return operation
})

defineHelper(cap, 'call', (name, args = {}) => request({ kind: 'call', name, args }))

for (const provider of config.providers) {
  const namespace = {}
  for (const operation of provider.operations) {
    namespace[operation.name] = (args = {}) => request({
      kind: 'call',
      name: `${provider.id}.${operation.name}`,
      args,
    })
  }
  namespace.list = () => provider.operations.map(operation => ({
    name: operation.name,
    summary: operation.summary,
    safety: operation.safety,
  }))
  namespace.describe = operation => {
    const found = provider.operations.find(candidate => candidate.name === operation)
    if (found === undefined) throw new Error(`unknown operation ${provider.id}.${operation}`)
    return found
  }
  cap[provider.id] = namespace
}

/**
 * Providers that failed to attach, keyed by id, from the same snapshot as the catalog.
 *
 * Not capabilities — nothing can be called on them — but a discovery surface that lists
 * only presences cannot answer "where is cua?" at all, which is exactly what it did when
 * this was measured.
 */
const failures = new Map((config.failures ?? []).map(failure => [failure.id, failure.error]))

/**
 * Compact human-readable catalog, so discovery does not require the caller to know
 * how the snapshot is shaped. Exported rather than installed on `globalThis`: an
 * imported module runs on the module global, not the cell's, so a side-effect global
 * set here would be invisible to the cell. The runtime's install cell assigns it.
 */
export function capHelp(providerId) {
  if (providerId === undefined) {
    return [
      ...cap.list().map(provider => `${provider.id} (${provider.label}) — ${provider.operations} operation(s)`),
      ...[...failures].map(([id, error]) => `${id} — NOT ATTACHED: ${error}`),
    ].join('\n')
  }
  const provider = providers.get(providerId)
  if (provider !== undefined) {
    return provider.operations
      .map(operation => `${providerId}.${operation.name} [${operation.safety}] ${operation.summary.split('\n')[0].slice(0, 90)}`)
      .join('\n')
  }
  const failure = failures.get(providerId)
  if (failure !== undefined) return `${providerId} is configured but not attached: ${failure}`
  return `unknown provider ${providerId}; known: ${[...providers.keys(), ...failures.keys()].join(', ')}`
}

export { cap }
export default cap
