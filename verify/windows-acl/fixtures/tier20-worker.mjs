import { spawn } from 'node:child_process'
import { fstatSync, readFileSync, readSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { resolve, join } from 'node:path'

process.stderr.write('tier20-worker:start\n')

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

async function spawnSettlementProbe(stdio = 'ignore') {
  return await new Promise((resolveResult) => {
    let settled = false
    let child
    try {
      child = spawn(process.execPath, ['-e', 'process.stdout.write("tier20-child-settled\\n"); process.stderr.write("tier20-child-stderr\\n"); setTimeout(() => process.exit(0), 25)'], {
        cwd: process.cwd(),
        env: process.env,
        stdio,
        windowsHide: true,
      })
    } catch (error) {
      resolveResult({
        started: false,
        exitCode: null,
        error: error?.code ?? error?.message ?? String(error),
        win32ErrorCode: error?.win32ErrorCode ?? null,
        syscall: error?.syscall ?? null,
        path: error?.path ?? null,
        stdout: '',
        stderr: '',
      })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    const settle = (result) => {
      if (settled) return
      settled = true
      resolveResult(result)
    }
    child.once('error', (error) => settle({
      started: false,
      exitCode: null,
      error: error?.code ?? error?.message ?? String(error),
      win32ErrorCode: error?.win32ErrorCode ?? null,
      syscall: error?.syscall ?? null,
      path: error?.path ?? null,
      stdout,
      stderr,
    }))
    child.once('close', (exitCode, signal) => settle({ started: true, exitCode, signal, stdout, stderr }))
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
checks.childSettlement = await spawnSettlementProbe('ignore')
if (!checks.childSettlement.started || checks.childSettlement.exitCode !== 0 || checks.childSettlement.signal !== null) {
  checks.ok = false
  checks.failures.push('child-settlement')
}
checks.stdoutPipeSettlement = await spawnSettlementProbe(['ignore', 'pipe', 'ignore'])
if (!checks.stdoutPipeSettlement.started || checks.stdoutPipeSettlement.exitCode !== 0 || checks.stdoutPipeSettlement.signal !== null ||
    checks.stdoutPipeSettlement.stdout !== 'tier20-child-settled\n') {
  checks.ok = false
  checks.failures.push('child-stdout-pipe')
}
checks.stderrPipeSettlement = await spawnSettlementProbe(['ignore', 'ignore', 'pipe'])
if (!checks.stderrPipeSettlement.started || checks.stderrPipeSettlement.exitCode !== 0 || checks.stderrPipeSettlement.signal !== null ||
    checks.stderrPipeSettlement.stderr !== 'tier20-child-stderr\n') {
  checks.ok = false
  checks.failures.push('child-stderr-pipe')
}
checks.dualPipeSettlement = await spawnSettlementProbe(['ignore', 'pipe', 'pipe'])
if (!checks.dualPipeSettlement.started || checks.dualPipeSettlement.exitCode !== 0 || checks.dualPipeSettlement.signal !== null ||
    checks.dualPipeSettlement.stdout !== 'tier20-child-settled\n' || checks.dualPipeSettlement.stderr !== 'tier20-child-stderr\n') {
  checks.ok = false
  checks.failures.push('child-dual-pipe')
}

function readExactly(fd, length) {
  const buffer = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const count = readSync(fd, buffer, offset, length - offset, null)
    if (count === 0) throw new Error(`fd ${fd} reached EOF after ${offset}/${length} bytes`)
    offset += count
  }
  return buffer.toString('utf8')
}

const fd3Input = readExactly(3, Buffer.byteLength('fd3-in\n'))
const fd4Input = readExactly(4, Buffer.byteLength('fd4-in\n'))
const fd5Input = readExactly(5, Buffer.byteLength('fd5-in\n'))
const fd6Input = readExactly(6, Buffer.byteLength('fd6-in\n'))
const fd3RoundTrip = fd3Input === 'fd3-in\n'
if (fd3RoundTrip) writeSync(3, 'fd3-out\n')
checks.carriers = {
  fd3Input,
  fd3RoundTrip,
  fd4Input,
  fd5Input,
  fd6Input,
  carriersRead: fd4Input === 'fd4-in\n' && fd5Input === 'fd5-in\n' && fd6Input === 'fd6-in\n',
}
if (!checks.carriers.fd3RoundTrip || !checks.carriers.carriersRead) {
  checks.ok = false
  checks.failures.push('carrier-content')
}

function writeControl(frame) {
  writeSync(CONTROL_FD, `${JSON.stringify(frame)}\n`)
}

function readControlLine() {
  let raw = ''
  const byte = Buffer.alloc(1)
  for (;;) {
    const count = readSync(CONTROL_FD, byte, 0, 1, null)
    if (count === 0) throw new Error('fd 7 control pipe reached EOF before a complete frame')
    if (byte[0] === 0x0a) return raw
    raw += byte.toString('utf8', 0, count)
    if (Buffer.byteLength(raw) > 16 * 1024) throw new Error('fd 7 frame exceeded 16 KiB')
  }
}

try {
  for (;;) {
    const frame = JSON.parse(readControlLine())
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
      writeControl({ type: 'error', code: 'INVALID_FRAME' })
      process.exitCode = 64
      break
    }
    if (frame.type === 'hello') {
      if (frame.version !== PROTOCOL_VERSION) {
        writeControl({ type: 'error', requestId: frame.requestId ?? null, code: 'UNSUPPORTED_VERSION' })
        process.exitCode = 64
        break
      }
      writeControl({
        type: 'ready',
        version: PROTOCOL_VERSION,
        requestId: frame.requestId ?? null,
        status: checks.ok ? 'PASS' : 'FAIL',
        processId: process.pid,
        nodeVersion: process.version,
        executable: process.execPath,
        checks,
      })
      continue
    }
    if (frame.type === 'close') {
      writeControl({ type: 'closing', requestId: frame.requestId ?? null, status: checks.ok ? 'PASS' : 'FAIL' })
      process.exitCode = checks.ok ? 0 : 70
      break
    }
    writeControl({ type: 'error', requestId: frame.requestId ?? null, code: 'UNKNOWN_TYPE' })
  }
} catch (error) {
  process.stderr.write(`tier20-worker: control failure: ${error?.message ?? String(error)}\n`)
  process.exitCode = 74
}
