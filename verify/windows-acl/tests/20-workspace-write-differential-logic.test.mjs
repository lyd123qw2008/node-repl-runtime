import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { classifyDshA1, classifyMatrix } from '../scripts/workspace-write-differential-logic.mjs'

function a5Evidence(overrides = {}) {
  return {
    status: 'OWNED_WORKER_PROBE_PASS',
    releaseEligible: false,
    jobOwnership: true,
    targetProcessCreated: true,
    targetProcessExited: true,
    targetResumed: true,
    grantsRevokedAfterQuiescence: true,
    cleanup: true,
    targetReportPass: true,
    targetExitSuccess: true,
    defaultDaclAces: [
      { type: 0, sidClass: 'temp-capability', mask: '0x001f01ff', flags: 0 },
      { type: 0, sidClass: 'world', mask: '0x001f01ff', flags: 0 },
    ],
    native: { targetAssignedToJob: true, jobSettled: true },
    ...overrides,
  }
}

function matrixRows({ a1Outcome = 'dsh-final-worker-failed-checks', a5 = a5Evidence() } = {}) {
  return {
    a1: { outcome: a1Outcome },
    a2: { native: { status: 'FAIL' }, checks: {} },
    a3: { native: { status: 'FAIL' }, checks: {} },
    a4: {
      native: {
        mode: 'workspace-write',
        status: 'FAIL',
        targetExitCode: 0xC0000142,
        targetProcessCreated: true,
        targetProcessExited: true,
        jobSettled: true,
        cleanup: true,
        defaultDaclInheritanceFlags: 0,
        explicitEnvironmentBlock: true,
      },
      checks: { tempCapabilityFullAccessAceObserved: true, worldFullAccessAceObserved: false },
    },
    a5,
  }
}

test('A1 failed child validation is a determinate failure when its snapshot exists', () => {
  const dsh = classifyDshA1({
    host: { nodeVersion: 'v22.19.0' },
    observations: [{
      mode: 'workspace-write',
      status: 'FAIL',
      exitCode: 0,
      snapshot: { nodeVersion: 'v22.19.0', grandchild: { ignore: { status: 0xC0000142 }, pipe: { errorCode: 'EPERM' } } },
    }],
  }, 'v22.19.0')

  assert.equal(dsh.outcome, 'dsh-final-worker-failed-checks')
  assert.equal(dsh.observation.snapshot.grandchild.ignore.status, 0xC0000142)
})

test('A5 reads Job assignment and settlement from nested native evidence', () => {
  const rows = matrixRows()
  const classification = classifyMatrix(rows.a1, rows.a2, rows.a3, rows.a4, rows.a5)

  assert.equal(classification.complete, true)
  assert.equal(classification.checks.a4KnownFailureReproduced, true)
  assert.equal(classification.checks.a5WorldAceControlPassed, true)
  assert.match(classification.decision, /^STOP:/u)
})

test('A5 missing nested Job proof keeps the matrix inconclusive', () => {
  const rows = matrixRows({ a5: a5Evidence({ native: { targetAssignedToJob: true, jobSettled: false } }) })
  const classification = classifyMatrix(rows.a1, rows.a2, rows.a3, rows.a4, rows.a5)

  assert.equal(classification.complete, false)
  assert.equal(classification.checks.a5WorldAceControlPassed, false)
  assert.match(classification.decision, /^MATRIX_INCONCLUSIVE:/u)
})

test('CI stores DSH, A1-A5 matrix, and A5 control under distinct evidence names', async () => {
  const workflowPath = fileURLToPath(new URL('../../../.github/workflows/windows-acl-native-audit.yml', import.meta.url))
  const workflow = await readFile(workflowPath, 'utf8')
  const evidenceNames = [...workflow.matchAll(/-Destination \(Join-Path \$matrixArtifact '([^']+)'\)/gu)].map(match => match[1])

  assert.deepEqual(evidenceNames, [
    'workspace-write-differential.json',
    'dsh-token-snapshot.json',
    'a5-owned-worker-control.json',
  ])
  assert.equal(new Set(evidenceNames).size, evidenceNames.length)
})
