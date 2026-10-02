import assert from 'node:assert/strict'
import test from 'node:test'

import { ProbeFailure, runUnconfinedFd7Probe } from '../lib/unconfined-fd7.mjs'

const windowsOnly = process.platform === 'win32'

test('00: explicit real Node worker uses fd 7 without inheriting parent control state', { skip: !windowsOnly }, async () => {
  const result = await runUnconfinedFd7Probe()

  assert.equal(result.protocol.fd, 7)
  assert.equal(result.protocol.version, 1)
  assert.equal(result.ready.markerVisibleAfterConsume, false)
  assert.equal(result.ready.parentSentinelVisible, false)
  assert.equal(result.ready.dshControlMarkerVisible, false)
  assert.equal(result.ready.nodeOptionsVisible, false)
  // Windows Node process creation may materialize ambient system/user TMP/TEMP
  // entries even when the requested block omits them.  Tier 00 records that
  // diagnostic; it must not convert the observation into a closed-env claim.
  assert.equal(typeof result.ready.ambientTempVisible, 'boolean')
  assert.equal(typeof result.ready.processId, 'number')
  assert.match(result.ready.nodeVersion, /^v\d+/)
  assert.match(result.ready.executable, /node\.exe$/i)
  assert.equal(result.state.persistedBeforeReset, true)
  assert.equal(result.state.absentAfterReset, true)
  assert.equal(result.pong.type, 'pong')
  assert.equal(result.exit.exitCode, 0)
  assert.equal(result.exit.signal, null)
  assert.match(result.stdout.text, /phase0-worker: stdout-online/)
  assert.match(result.stderr.text, /phase0-worker: stderr-online/)
  assert.equal(result.stdout.truncated, true)
  assert.equal(result.stderr.truncated, true)
})

test('00: a non-absolute or missing Node executable is rejected before worker launch', { skip: !windowsOnly }, async () => {
  await assert.rejects(
    () => runUnconfinedFd7Probe({ nodeExecutable: 'node.exe' }),
    (error) => error instanceof ProbeFailure && error.code === 'INVALID_NODE_EXECUTABLE',
  )
  await assert.rejects(
    () => runUnconfinedFd7Probe({ nodeExecutable: 'C:\\node-repl-phase0-missing\\node.exe' }),
    (error) => error instanceof ProbeFailure && error.code === 'NODE_EXECUTABLE_UNAVAILABLE',
  )
})

test('00: oversized control output fails closed and terminates the direct fixture', { skip: !windowsOnly }, async () => {
  await assert.rejects(
    () => runUnconfinedFd7Probe({ fixtureMode: 'oversized-ready', readyDeadlineMs: 1_000 }),
    (error) => {
      assert.equal(error instanceof ProbeFailure, true)
      assert.equal(error.code, 'FRAME_TOO_LARGE')
      assert.ok(error.directChildExit)
      assert.notEqual(error.directChildExit.exitCode, 0)
      return true
    },
  )
})

test('00: missing ready frame reaches a bounded deadline and terminates the direct fixture', { skip: !windowsOnly }, async () => {
  await assert.rejects(
    () => runUnconfinedFd7Probe({ fixtureMode: 'no-ready', readyDeadlineMs: 100 }),
    (error) => {
      assert.equal(error instanceof ProbeFailure, true)
      assert.equal(error.code, 'DEADLINE_EXCEEDED')
      assert.ok(error.directChildExit)
      assert.notEqual(error.directChildExit.exitCode, 0)
      return true
    },
  )
})

test('00: a protocol-version mismatch fails closed and terminates the direct fixture', { skip: !windowsOnly }, async () => {
  await assert.rejects(
    () => runUnconfinedFd7Probe({ fixtureMode: 'wrong-version' }),
    (error) => {
      assert.equal(error instanceof ProbeFailure, true)
      assert.equal(error.code, 'VERSION_MISMATCH')
      assert.ok(error.directChildExit)
      return true
    },
  )
})

test('00: malformed control JSON fails closed and terminates the direct fixture', { skip: !windowsOnly }, async () => {
  await assert.rejects(
    () => runUnconfinedFd7Probe({ fixtureMode: 'invalid-ready' }),
    (error) => {
      assert.equal(error instanceof ProbeFailure, true)
      assert.equal(error.code, 'INVALID_FRAME')
      assert.ok(error.directChildExit)
      return true
    },
  )
})

test('00: unexpected control EOF fails closed after direct-child settlement', { skip: !windowsOnly }, async () => {
  await assert.rejects(
    () => runUnconfinedFd7Probe({ fixtureMode: 'early-eof' }),
    (error) => {
      assert.equal(error instanceof ProbeFailure, true)
      assert.equal(error.code, 'CONTROL_EOF')
      assert.ok(error.directChildExit)
      return true
    },
  )
})
