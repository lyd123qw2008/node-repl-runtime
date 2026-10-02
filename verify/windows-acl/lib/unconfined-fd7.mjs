import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CONTROL_ENV = 'NODE_REPL_KERNEL_CONTROL'
export const CONTROL_FD = 7
export const PROTOCOL_VERSION = 1
export const MAX_FRAME_BYTES = 16 * 1024
export const EVIDENCE_TIER = 'unconfined-protocol-reference'

const fixturePath = fileURLToPath(new URL('../fixtures/fd7-worker.mjs', import.meta.url))

export class ProbeFailure extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ProbeFailure'
    this.code = code
  }
}

function fail(code, message, cause) {
  throw new ProbeFailure(code, message, cause)
}

function valueIgnoringCase(environment, expectedName) {
  const expected = expectedName.toUpperCase()
  for (const [name, value] of Object.entries(environment)) {
    if (name.toUpperCase() === expected) return value
  }
  return undefined
}

/**
 * Build the deliberately tiny requested environment used by Tier 00.  It is
 * not a Windows sandbox environment and does not prove the final child has a
 * closed environment: ordinary Windows Node spawning can still materialize
 * ambient system/user values.  The fixture records that fact rather than
 * concealing it.
 */
export function buildRequestedWorkerEnvironment(sourceEnvironment = process.env) {
  const environment = {}
  for (const name of ['SYSTEMROOT', 'WINDIR']) {
    const value = valueIgnoringCase(sourceEnvironment, name)
    if (value !== undefined) environment[name] = value
  }
  environment[CONTROL_ENV] = 'pipe'
  return Object.freeze(environment)
}

function resolveNodeExecutable(candidate) {
  const supplied = candidate ?? process.env.NODE_REPL_VERIFY_NODE
  if (process.versions.electron !== undefined && supplied === undefined) {
    fail('NODE_EXECUTABLE_REQUIRED', 'Electron-hosted verification requires NODE_REPL_VERIFY_NODE to name a real node.exe')
  }
  const executable = supplied ?? process.execPath
  if (!isAbsolute(executable) || basename(executable).toLowerCase() !== 'node.exe') {
    fail('INVALID_NODE_EXECUTABLE', `Tier 00 requires an absolute Node executable ending in node.exe, got ${executable}`)
  }
  try {
    if (!existsSync(executable) || !statSync(executable).isFile()) {
      fail('NODE_EXECUTABLE_UNAVAILABLE', `Tier 00 Node executable is not an existing file: ${executable}`)
    }
  } catch (error) {
    if (error instanceof ProbeFailure) throw error
    fail('NODE_EXECUTABLE_UNAVAILABLE', `Tier 00 could not inspect Node executable ${executable}`, error)
  }
  return executable
}

function boundedCollector(stream, maxBytes) {
  const chunks = []
  let retained = 0
  let total = 0
  let dropped = 0
  let settled = false
  let settle
  const done = new Promise((resolve) => { settle = resolve })

  const finish = () => {
    if (settled) return
    settled = true
    settle({
      text: Buffer.concat(chunks).toString('utf8'),
      retainedBytes: retained,
      totalBytes: total,
      droppedBytes: dropped,
      truncated: dropped > 0,
    })
  }

  stream.on('data', (chunk) => {
    const bytes = Buffer.from(chunk)
    total += bytes.length
    const remaining = Math.max(0, maxBytes - retained)
    if (remaining > 0) {
      const kept = bytes.subarray(0, remaining)
      chunks.push(kept)
      retained += kept.length
      dropped += bytes.length - kept.length
    } else {
      dropped += bytes.length
    }
  })
  stream.once('end', finish)
  stream.once('close', finish)
  stream.once('error', finish)
  return { done }
}

class JsonLineEndpoint {
  #stream
  #maxFrameBytes
  #buffer = ''
  #frames = []
  #waiters = []
  #failure
  #closed = false

  constructor(stream, maxFrameBytes) {
    this.#stream = stream
    this.#maxFrameBytes = maxFrameBytes
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => this.#onData(chunk))
    stream.once('error', (error) => this.#fail(new ProbeFailure('CONTROL_ERROR', `control stream error: ${error.message}`, error)))
    stream.once('end', () => this.#closedNow())
    stream.once('close', () => this.#closedNow())
  }

  send(frame) {
    if (this.#failure !== undefined) throw this.#failure
    if (this.#closed) fail('CONTROL_CLOSED', 'cannot write a closed control stream')
    const encoded = `${JSON.stringify(frame)}\n`
    if (Buffer.byteLength(encoded) > this.#maxFrameBytes) {
      fail('OUTBOUND_FRAME_TOO_LARGE', `outbound frame exceeds ${String(this.#maxFrameBytes)} bytes`)
    }
    if (!this.#stream.write(encoded)) {
      // Tier 00 keeps one message at a time.  A production supervisor must add
      // an explicit bounded queue/drain contract rather than ignore this fact.
      this.#stream.once('drain', () => {})
    }
  }

  end() {
    if (!this.#stream.destroyed && this.#stream.writable) this.#stream.end()
  }

  async next(predicate, deadlineMs, description) {
    const available = this.#take(predicate)
    if (available !== undefined) return available
    if (this.#failure !== undefined) throw this.#failure
    if (this.#closed) fail('CONTROL_EOF', `control stream closed before ${description}`)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#waiters = this.#waiters.filter(waiter => waiter.reject !== reject)
        reject(new ProbeFailure('DEADLINE_EXCEEDED', `timed out waiting for ${description} after ${String(deadlineMs)}ms`))
      }, deadlineMs)
      this.#waiters.push({ predicate, resolve, reject, timeout })
    })
  }

  #onData(chunk) {
    if (this.#failure !== undefined) return
    this.#buffer += chunk
    if (Buffer.byteLength(this.#buffer) > this.#maxFrameBytes && !this.#buffer.includes('\n')) {
      this.#fail(new ProbeFailure('FRAME_TOO_LARGE', `inbound control frame exceeds ${String(this.#maxFrameBytes)} bytes`))
      return
    }
    for (;;) {
      const newline = this.#buffer.indexOf('\n')
      if (newline < 0) return
      const raw = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      if (Buffer.byteLength(raw) > this.#maxFrameBytes) {
        this.#fail(new ProbeFailure('FRAME_TOO_LARGE', `inbound control frame exceeds ${String(this.#maxFrameBytes)} bytes`))
        return
      }
      let frame
      try {
        frame = JSON.parse(raw)
      } catch (error) {
        this.#fail(new ProbeFailure('INVALID_FRAME', 'inbound control frame is not JSON', error))
        return
      }
      if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
        this.#fail(new ProbeFailure('INVALID_FRAME', 'inbound control frame is not an object'))
        return
      }
      this.#frames.push(frame)
      this.#flush()
    }
  }

  #take(predicate) {
    const index = this.#frames.findIndex(predicate)
    if (index < 0) return undefined
    return this.#frames.splice(index, 1)[0]
  }

  #flush() {
    for (const waiter of [...this.#waiters]) {
      const frame = this.#take(waiter.predicate)
      if (frame === undefined) continue
      clearTimeout(waiter.timeout)
      this.#waiters = this.#waiters.filter(candidate => candidate !== waiter)
      waiter.resolve(frame)
    }
  }

  #closedNow() {
    if (this.#closed) return
    this.#closed = true
    this.#flush()
    if (this.#failure !== undefined) return
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timeout)
      waiter.reject(new ProbeFailure('CONTROL_EOF', 'control stream closed before expected frame'))
    }
  }

  #fail(error) {
    if (this.#failure !== undefined) return
    this.#failure = error
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timeout)
      waiter.reject(error)
    }
  }
}

function exitObservation(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }))
  })
}

async function withDeadline(promise, deadlineMs, description) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new ProbeFailure('DEADLINE_EXCEEDED', `timed out waiting for ${description} after ${String(deadlineMs)}ms`)), deadlineMs)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

async function terminateAndObserve(child, exit) {
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL') } catch { /* The direct child already settled. */ }
  }
  return withDeadline(exit, 5_000, 'terminated direct worker exit')
}

function assertReady(ready) {
  if (ready.version !== PROTOCOL_VERSION) fail('VERSION_MISMATCH', `expected protocol version ${String(PROTOCOL_VERSION)}`)
  if (ready.markerBeforeConsume !== 'pipe') fail('MARKER_MISSING', 'worker did not receive the owned control marker')
  if (ready.markerVisibleAfterConsume !== false) fail('MARKER_LEAKED', 'worker left the control marker visible after opening fd 7')
  if (ready.parentSentinelVisible !== false) fail('ENV_LEAKED', 'worker received the parent-only sentinel')
  if (ready.dshControlMarkerVisible !== false) fail('ENV_LEAKED', 'worker received a DSH control marker')
  if (ready.nodeOptionsVisible !== false) fail('ENV_LEAKED', 'worker received NODE_OPTIONS')
  if (typeof ready.ambientTempVisible !== 'boolean') fail('INVALID_READY', 'worker did not report its ambient TMP/TEMP diagnostic')
  if (!Number.isSafeInteger(ready.processId) || ready.processId <= 0) fail('INVALID_READY', 'worker did not report a valid process id')
  if (typeof ready.nodeVersion !== 'string' || typeof ready.executable !== 'string') fail('INVALID_READY', 'worker did not report Node identity')
}

/**
 * Run one unconfined direct-child transport probe.  This is deliberately not a
 * sandbox launch: it has neither token nor ACL/Job ownership, and callers must
 * preserve those non-claims in any evidence they produce.
 */
export async function runUnconfinedFd7Probe(options = {}) {
  const {
    fixtureMode = 'normal',
    readyDeadlineMs = 3_000,
    exitDeadlineMs = 5_000,
    maxFrameBytes = MAX_FRAME_BYTES,
    outputLimitBytes = 1_024,
    outputBytes = 8 * 1_024,
    sourceEnvironment = {
      ...process.env,
      NODE_REPL_PHASE0_PARENT_SENTINEL: 'must-not-reach-unconfined-fixture',
      DSH_SUBPROCESS_CONTROL: 'must-not-reach-unconfined-fixture',
      NODE_OPTIONS: '--no-warnings',
    },
    nodeExecutable,
  } = options

  if (process.platform !== 'win32') fail('UNSUPPORTED_PLATFORM', 'Tier 00 is a Windows-first verifier')
  const environment = buildRequestedWorkerEnvironment(sourceEnvironment)
  const resolvedNodeExecutable = resolveNodeExecutable(nodeExecutable)
  const child = spawn(resolvedNodeExecutable, [fixturePath, fixtureMode], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'pipe'],
  })
  const exit = exitObservation(child)
  const stdout = boundedCollector(child.stdout, outputLimitBytes)
  const stderr = boundedCollector(child.stderr, outputLimitBytes)
  const controlStream = child.stdio[CONTROL_FD]
  if (controlStream === null || controlStream === undefined) {
    await terminateAndObserve(child, exit)
    fail('CONTROL_MISSING', 'direct Node worker did not receive a parent fd 7 pipe')
  }
  const control = new JsonLineEndpoint(controlStream, maxFrameBytes)

  try {
    const helloRequestId = randomUUID()
    // Windows Node/libuv does not surface a child-first write on this extra
    // duplex descriptor until the parent has written.  The host-first hello is
    // therefore part of the explicit protocol, not a timing workaround.
    control.send({ type: 'hello', version: PROTOCOL_VERSION, requestId: helloRequestId })
    const ready = await control.next(
      frame => frame.type === 'ready' && frame.requestId === helloRequestId,
      readyDeadlineMs,
      'ready handshake',
    )
    assertReady(ready)

    const stateKey = `phase0-${randomUUID()}`
    const stateValue = randomUUID()
    const stateSetRequestId = randomUUID()
    control.send({ type: 'set-state', requestId: stateSetRequestId, key: stateKey, value: stateValue })
    await control.next(frame => frame.type === 'state-set' && frame.requestId === stateSetRequestId, readyDeadlineMs, 'persistent state acknowledgement')

    const stateBeforeResetRequestId = randomUUID()
    control.send({ type: 'get-state', requestId: stateBeforeResetRequestId, key: stateKey })
    const stateBeforeReset = await control.next(
      frame => frame.type === 'state' && frame.requestId === stateBeforeResetRequestId,
      readyDeadlineMs,
      'persistent state read',
    )
    if (stateBeforeReset.present !== true || stateBeforeReset.value !== stateValue) {
      fail('STATE_NOT_PERSISTED', 'direct worker did not retain its fixture state before reset')
    }

    const resetRequestId = randomUUID()
    control.send({ type: 'reset-state', requestId: resetRequestId })
    await control.next(frame => frame.type === 'state-reset' && frame.requestId === resetRequestId, readyDeadlineMs, 'fixture reset acknowledgement')

    const stateAfterResetRequestId = randomUUID()
    control.send({ type: 'get-state', requestId: stateAfterResetRequestId, key: stateKey })
    const stateAfterReset = await control.next(
      frame => frame.type === 'state' && frame.requestId === stateAfterResetRequestId,
      readyDeadlineMs,
      'reset state read',
    )
    if (stateAfterReset.present !== false || stateAfterReset.value !== null) {
      fail('STATE_NOT_RESET', 'direct worker retained fixture state after reset')
    }

    const pingRequestId = randomUUID()
    control.send({ type: 'ping', requestId: pingRequestId })
    const pong = await control.next(frame => frame.type === 'pong' && frame.requestId === pingRequestId, readyDeadlineMs, 'pong')

    const stdoutRequestId = randomUUID()
    control.send({ type: 'emit', requestId: stdoutRequestId, stream: 'stdout', bytes: outputBytes })
    await control.next(frame => frame.type === 'emitted' && frame.requestId === stdoutRequestId, readyDeadlineMs, 'stdout completion')

    const stderrRequestId = randomUUID()
    control.send({ type: 'emit', requestId: stderrRequestId, stream: 'stderr', bytes: outputBytes })
    await control.next(frame => frame.type === 'emitted' && frame.requestId === stderrRequestId, readyDeadlineMs, 'stderr completion')

    const closeRequestId = randomUUID()
    control.send({ type: 'close', requestId: closeRequestId })
    await control.next(frame => frame.type === 'closing' && frame.requestId === closeRequestId, readyDeadlineMs, 'closing acknowledgement')
    // A duplex Windows pipe has two independently owned write ends.  Closing
    // the host write end after the worker acknowledgement makes the expected
    // EOF/exit contract explicit instead of relying on process teardown.
    control.end()
    const outcome = await withDeadline(exit, exitDeadlineMs, 'direct worker exit')
    if (outcome.exitCode !== 0 || outcome.signal !== null) {
      fail('UNEXPECTED_EXIT', `direct worker exited with code ${String(outcome.exitCode)} and signal ${String(outcome.signal)}`)
    }
    const [stdoutObservation, stderrObservation] = await Promise.all([stdout.done, stderr.done])
    if (!stdoutObservation.truncated || !stderrObservation.truncated) {
      fail('OUTPUT_NOT_BOUNDED', 'fixture output did not exercise both bounded collectors')
    }
    return {
      protocol: { version: PROTOCOL_VERSION, fd: CONTROL_FD, maxFrameBytes },
      ready,
      state: {
        persistedBeforeReset: stateBeforeReset.present === true && stateBeforeReset.value === stateValue,
        absentAfterReset: stateAfterReset.present === false && stateAfterReset.value === null,
      },
      pong,
      exit: outcome,
      stdout: stdoutObservation,
      stderr: stderrObservation,
      nodeExecutable: resolvedNodeExecutable,
      requestedEnvironmentNames: Object.keys(environment).sort(),
    }
  } catch (error) {
    let directChildExit
    try {
      directChildExit = await terminateAndObserve(child, exit)
    } catch (cleanupError) {
      throw new ProbeFailure('DIRECT_CHILD_CLEANUP_FAILED', 'could not confirm direct fixture exit after protocol failure', cleanupError)
    }
    if (error instanceof ProbeFailure) error.directChildExit = directChildExit
    throw error
  }
}
