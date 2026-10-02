import { spawn } from 'node:child_process'
import { fstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { Socket } from 'node:net'

const CONTROL_FD = 7
const PROTOCOL_VERSION = 1
const mode = process.env.NODE_REPL_TIER20_MODE
const workspace = process.env.NODE_REPL_TIER20_WORKSPACE
const privateTemp = process.env.NODE_REPL_TIER20_PRIVATE_TEMP
const markerBeforeConsume = process.env.NODE_REPL_KERNEL_CONTROL ?? null
const parentSentinelVisible = Object.hasOwn(process.env, 'NODE_REPL_PHASE0_PARENT_SENTINEL')
const dshControlMarkerVisible = Object.hasOwn(process.env, 'DSH_SUBPROCESS_CONTROL')
const nodeOptionsVisible = Object.hasOwn(process.env, 'NODE_OPTIONS')
const ambientUserProfileVisible = Object.hasOwn(process.env, 'USERPROFILE')

delete process.env.NODE_REPL_KERNEL_CONTROL

function attemptWrite(path, contents) {
  try {
    writeFileSync(path, contents, { encoding: 'utf8', flag: 'wx' })
    return { ok: true, code: null }
  } catch (error) {
    return { ok: false, code: error?.code ?? String(error) }
  }
}

function cleanup(path) {
  try {
    unlinkSync(path)
  } catch {
    // A denied write leaves no file; cleanup is best effort for an unexpected success.
  }
}

async function spawnSettlementProbe() {
  return await new Promise((resolveResult) => {
    let settled = false
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 25)'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'ignore',
      windowsHide: true,
    })
    const settle = (result) => {
      if (settled) return
      settled = true
      resolveResult(result)
    }
    child.once('error', (error) => settle({ started: false, exitCode: null, error: error?.code ?? error?.message ?? String(error) }))
    child.once('exit', (exitCode, signal) => settle({ started: true, exitCode, signal }))
  })
}

function inspectDescriptors() {
  const descriptors = []
  for (let fd = 3; fd <= 7; fd += 1) {
    try {
      const stats = fstatSync(fd)
      descriptors.push({ fd, valid: true, isFile: stats.isFile(), isFIFO: stats.isFIFO(), size: stats.size })
    } catch (error) {
      descriptors.push({ fd, valid: false, error: error?.code ?? error?.message ?? String(error) })
    }
  }
  return descriptors
}

function runFileAndEnvironmentChecks() {
  const failures = []
  const expectedWritable = mode === 'workspace-write'
  if (mode !== 'read-only' && !expectedWritable) failures.push('invalid-mode')
  if (typeof workspace !== 'string' || typeof privateTemp !== 'string') failures.push('missing-path-environment')

  let seed = null
  try {
    seed = readFileSync(join(workspace, 'tier20-seed.txt'), 'utf8')
  } catch (error) {
    failures.push(`seed-read:${error?.code ?? error?.message ?? String(error)}`)
  }
  if (seed !== 'tier20-seed\n') failures.push('seed-content')

  const rootWritePath = join(workspace, `tier20-root-${process.pid}.txt`)
  const tempWritePath = join(privateTemp, `tier20-temp-${process.pid}.txt`)
  const rootWrite = attemptWrite(rootWritePath, 'tier20-root-write\n')
  const tempWrite = attemptWrite(tempWritePath, 'tier20-temp-write\n')
  if (rootWrite.ok !== expectedWritable) failures.push(`workspace-write:${rootWrite.code ?? 'unexpected-success'}`)
  if (tempWrite.ok !== expectedWritable) failures.push(`private-temp-write:${tempWrite.code ?? 'unexpected-success'}`)
  if (rootWrite.ok) cleanup(rootWritePath)
  if (tempWrite.ok) cleanup(tempWritePath)

  if (process.cwd().toLowerCase() !== resolve(workspace).toLowerCase()) failures.push('cwd-not-workspace')
  if (process.env.TMP !== privateTemp) failures.push('TMP-not-private-temp')
  if (process.env.TEMP !== privateTemp) failures.push('TEMP-not-private-temp')
  if (markerBeforeConsume !== 'pipe') failures.push('control-marker-missing')
  if (Object.hasOwn(process.env, 'NODE_REPL_KERNEL_CONTROL')) failures.push('control-marker-not-consumed')
  if (parentSentinelVisible) failures.push('parent-sentinel-leaked')
  if (dshControlMarkerVisible) failures.push('dsh-control-marker-leaked')
  if (nodeOptionsVisible) failures.push('node-options-leaked')
  if (ambientUserProfileVisible) failures.push('user-profile-leaked')

  return {
    ok: failures.length === 0,
    failures,
    mode,
    cwd: process.cwd(),
    workspace,
    privateTemp,
    seedRead: seed === 'tier20-seed\n',
    workspaceWrite: rootWrite,
    privateTempWrite: tempWrite,
    environment: {
      markerBeforeConsume,
      markerVisibleAfterConsume: Object.hasOwn(process.env, 'NODE_REPL_KERNEL_CONTROL'),
      parentSentinelVisible,
      dshControlMarkerVisible,
      nodeOptionsVisible,
      ambientUserProfileVisible,
      tmp: process.env.TMP ?? null,
      temp: process.env.TEMP ?? null,
    },
    descriptors: inspectDescriptors(),
  }
}

const checks = runFileAndEnvironmentChecks()
const descriptorFailure = checks.descriptors.filter((item) => !item.valid)
if (descriptorFailure.length > 0) {
  checks.ok = false
  checks.failures.push('descriptor-inheritance')
}
checks.childSettlement = await spawnSettlementProbe()
if (!checks.childSettlement.started || checks.childSettlement.exitCode !== 0 || checks.childSettlement.signal !== null) {
  checks.ok = false
  checks.failures.push('child-settlement')
}

const channel = new Socket({ fd: CONTROL_FD, readable: true, writable: true })
channel.setEncoding('utf8')
let input = ''
let closed = false

function send(frame) {
  if (closed) return
  channel.write(`${JSON.stringify(frame)}\n`)
}

function close(code) {
  if (closed) return
  closed = true
  process.exitCode = code
  channel.end()
}

function receive(frame) {
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
    send({ type: 'error', code: 'INVALID_FRAME' })
    close(64)
    return
  }
  if (frame.type === 'hello') {
    if (frame.version !== PROTOCOL_VERSION) {
      send({ type: 'error', requestId: frame.requestId ?? null, code: 'UNSUPPORTED_VERSION' })
      close(64)
      return
    }
    send({
      type: 'ready',
      version: PROTOCOL_VERSION,
      requestId: frame.requestId ?? null,
      status: checks.ok ? 'PASS' : 'FAIL',
      processId: process.pid,
      nodeVersion: process.version,
      executable: process.execPath,
      checks,
    })
    return
  }
  if (frame.type === 'close') {
    send({ type: 'closing', requestId: frame.requestId ?? null, status: checks.ok ? 'PASS' : 'FAIL' })
    close(checks.ok ? 0 : 70)
    return
  }
  send({ type: 'error', requestId: frame.requestId ?? null, code: 'UNKNOWN_TYPE' })
}

function parseInput(chunk) {
  input += chunk
  for (;;) {
    const newline = input.indexOf('\n')
    if (newline < 0) return
    const raw = input.slice(0, newline)
    input = input.slice(newline + 1)
    try {
      receive(JSON.parse(raw))
    } catch {
      send({ type: 'error', code: 'INVALID_JSON' })
      close(65)
      return
    }
  }
}

channel.on('data', parseInput)
channel.on('error', (error) => {
  if (!closed) {
    process.stderr.write(`tier20-worker: ${error?.message ?? String(error)}\n`)
    close(74)
  }
})
channel.on('end', () => {
  if (!closed) close(checks.ok ? 0 : 70)
})
