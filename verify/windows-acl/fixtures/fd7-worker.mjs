import { Socket } from 'node:net'

const CONTROL_ENV = 'NODE_REPL_KERNEL_CONTROL'
const CONTROL_FD = 7
const MAX_FRAME_BYTES = 16 * 1024
const fixtureMode = process.argv[2] ?? 'normal'

const markerBeforeConsume = process.env[CONTROL_ENV] ?? null
if (markerBeforeConsume !== 'pipe') {
  process.stderr.write(`phase0-worker: expected ${CONTROL_ENV}=pipe, got ${String(markerBeforeConsume)}\n`)
  process.exitCode = 64
} else {
  delete process.env[CONTROL_ENV]
}

const channel = new Socket({ fd: CONTROL_FD, readable: true, writable: true })
channel.setEncoding('utf8')

let input = ''
let closed = false
let readySent = false
const fixtureState = new Map()

function send(frame) {
  if (closed) return
  const encoded = `${JSON.stringify(frame)}\n`
  if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) {
    throw new Error('fixture attempted to emit a frame above its maximum')
  }
  channel.write(encoded)
}

function close(code = 0) {
  if (closed) return
  closed = true
  process.exitCode = code
  channel.end()
}

function emitBytes(stream, bytes) {
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > 256 * 1024) {
    throw new Error('invalid fixture emit byte count')
  }
  const text = Buffer.alloc(bytes, stream === 'stdout' ? 0x6f : 0x65)
  if (stream === 'stdout') process.stdout.write(text)
  else process.stderr.write(text)
}

function sendReady(requestId) {
  if (readySent) {
    send({ type: 'error', requestId, code: 'DUPLICATE_HELLO' })
    return
  }
  readySent = true
  send({
    type: 'ready',
    version: 1,
    requestId,
    markerBeforeConsume,
    markerVisibleAfterConsume: Object.hasOwn(process.env, CONTROL_ENV),
    parentSentinelVisible: Object.hasOwn(process.env, 'NODE_REPL_PHASE0_PARENT_SENTINEL'),
    dshControlMarkerVisible: Object.hasOwn(process.env, 'DSH_SUBPROCESS_CONTROL'),
    nodeOptionsVisible: Object.hasOwn(process.env, 'NODE_OPTIONS'),
    ambientTempVisible: Object.hasOwn(process.env, 'TMP') || Object.hasOwn(process.env, 'TEMP'),
    processId: process.pid,
    nodeVersion: process.version,
    executable: process.execPath,
  })
}

function receive(frame) {
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
    send({ type: 'error', code: 'INVALID_FRAME' })
    return
  }
  const requestId = typeof frame.requestId === 'string' ? frame.requestId : null
  switch (frame.type) {
    case 'hello':
      if (frame.version !== 1) {
        send({ type: 'error', requestId, code: 'UNSUPPORTED_VERSION' })
        close(64)
      } else if (fixtureMode === 'normal') {
        // On this Windows Node/libuv transport, a child write to an extra
        // duplex stdio descriptor is not observable until the parent first
        // writes.  Make that activation an explicit, correlated protocol step
        // rather than depending on an undocumented timing side effect.
        sendReady(requestId)
      } else if (fixtureMode === 'wrong-version') {
        send({ type: 'ready', version: 2, requestId })
      } else if (fixtureMode === 'invalid-ready') {
        channel.write('{not-json}\n')
      } else if (fixtureMode === 'early-eof') {
        // `end()` closes only the worker's write half. A protocol EOF test
        // needs a full close so the host cannot wait forever on its own write
        // half of the duplex pipe.
        channel.destroy()
      }
      return
    case 'ping':
      send({ type: 'pong', requestId })
      return
    case 'set-state':
      if (typeof frame.key !== 'string' || typeof frame.value !== 'string') {
        send({ type: 'error', requestId, code: 'INVALID_STATE' })
      } else {
        fixtureState.set(frame.key, frame.value)
        send({ type: 'state-set', requestId, key: frame.key })
      }
      return
    case 'get-state':
      if (typeof frame.key !== 'string') {
        send({ type: 'error', requestId, code: 'INVALID_STATE' })
      } else {
        send({ type: 'state', requestId, key: frame.key, present: fixtureState.has(frame.key), value: fixtureState.get(frame.key) ?? null })
      }
      return
    case 'reset-state':
      fixtureState.clear()
      send({ type: 'state-reset', requestId })
      return
    case 'emit':
      try {
        if (frame.stream !== 'stdout' && frame.stream !== 'stderr') throw new Error('invalid stream')
        emitBytes(frame.stream, frame.bytes)
        send({ type: 'emitted', requestId, stream: frame.stream, bytes: frame.bytes })
      } catch (error) {
        send({ type: 'error', requestId, code: 'INVALID_EMIT', message: error instanceof Error ? error.message : String(error) })
      }
      return
    case 'close':
      send({ type: 'closing', requestId })
      close(0)
      return
    default:
      send({ type: 'error', requestId, code: 'UNKNOWN_TYPE' })
  }
}

function parseInput(chunk) {
  input += chunk
  if (Buffer.byteLength(input) > MAX_FRAME_BYTES && !input.includes('\n')) {
    send({ type: 'error', code: 'FRAME_TOO_LARGE' })
    close(65)
    return
  }
  for (;;) {
    const newline = input.indexOf('\n')
    if (newline < 0) return
    const raw = input.slice(0, newline)
    input = input.slice(newline + 1)
    if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) {
      send({ type: 'error', code: 'FRAME_TOO_LARGE' })
      close(65)
      return
    }
    try {
      receive(JSON.parse(raw))
    } catch {
      send({ type: 'error', code: 'INVALID_JSON' })
    }
  }
}

channel.on('data', parseInput)
channel.on('error', (error) => {
  if (!closed) {
    process.stderr.write(`phase0-worker: control error: ${error.message}\n`)
    close(74)
  }
})

process.stdout.write('phase0-worker: stdout-online\n')
process.stderr.write('phase0-worker: stderr-online\n')

if (markerBeforeConsume !== 'pipe') {
  close(64)
} else if (fixtureMode === 'oversized-ready') {
  // Deliberately invalid output for the host's max-frame enforcement test.
  channel.write(`${'x'.repeat(MAX_FRAME_BYTES + 1)}\n`)
} else if (fixtureMode === 'no-ready') {
  // Keep the fixture alive until the host's ready deadline terminates it.
  setInterval(() => {}, 1_000)
} else if (['normal', 'wrong-version', 'invalid-ready', 'early-eof'].includes(fixtureMode)) {
  // The parent sends the versioned, correlated `hello` frame that triggers
  // the mode-specific response. Keeping the first write parent-driven is
  // intentional; see the comment in receive().
} else {
  process.stderr.write(`phase0-worker: unknown fixture mode ${fixtureMode}\n`)
  close(64)
}
