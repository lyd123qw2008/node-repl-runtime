import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { ABI_EXPECTATIONS, inspectNativeAbiPreflight } from '../lib/native-abi-preflight.mjs'

const windowsOnly = process.platform === 'win32'
const verifierRoot = fileURLToPath(new URL('../', import.meta.url))

function childEnvironment(outputRoot) {
  const {
    NODE_REPL_VERIFY_DSH_ROOT: _dshRoot,
    NODE_REPL_VERIFY_ACL_ROOT: _aclRoot,
    NODE_REPL_VERIFY_NATIVE_AUDIT_DIR: _nativeAuditDirectory,
    NODE_REPL_VERIFY_NATIVE_AUDIT_COMMIT: _nativeAuditCommit,
    NODE_REPL_VERIFY_NATIVE_AUDIT_SHA256: _nativeAuditSha256,
    NODE_REPL_VERIFY_TIER20_NATIVE: _tier20Native,
    NODE_REPL_VERIFY_NODE: _nodeExecutable,
    NODE_REPL_VERIFY_OUT: _output,
    ...environment
  } = process.env
  return { ...environment, NODE_REPL_VERIFY_OUT: outputRoot }
}

async function readUnsupportedEvidence(outputRoot, suiteName) {
  const evidencePath = join(outputRoot, suiteName, 'evidence.json')
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'))
  assert.equal(evidence.status, 'UNSUPPORTED')
  assert.equal(evidence.confinement, 'none')
  assert.equal(evidence.enforcement, 'none')
  assert.equal(evidence.restrictedToken, false)
  assert.equal(evidence.jobOwnership, false)
  assert.equal(evidence.daclGrant, false)
  assert.equal(evidence.osHandleAllowlistProven, false)
  assert.equal(evidence.releaseEligible, false)
  assert.ok(Array.isArray(evidence.nonClaims) && evidence.nonClaims.length > 0)
  return evidence
}

async function runFailClosed(scriptName, suiteName) {
  const outputRoot = await mkdtemp(join(tmpdir(), 'node-repl-phase0-contract-'))
  try {
    const result = spawnSync(process.execPath, [join(verifierRoot, 'scripts', scriptName)], {
      cwd: verifierRoot,
      env: childEnvironment(outputRoot),
      encoding: 'utf8',
      windowsHide: true,
    })
    assert.equal(result.status, 2, `${scriptName} must exit 2 when its required owned/reference input is absent`)
    return await readUnsupportedEvidence(outputRoot, suiteName)
  } finally {
    await rm(outputRoot, { recursive: true, force: true })
  }
}

async function runPreflightReport(aclRoot, outputRootOverride = undefined, extraEnvironment = {}) {
  const outputRoot = outputRootOverride ?? await mkdtemp(join(tmpdir(), 'node-repl-phase0-preflight-output-'))
  try {
    const result = spawnSync(process.execPath, [join(verifierRoot, 'scripts', 'run-native-preflight.mjs'), '--report-only'], {
      cwd: verifierRoot,
      env: { ...childEnvironment(outputRoot), NODE_REPL_VERIFY_ACL_ROOT: aclRoot, ...extraEnvironment },
      encoding: 'utf8',
      windowsHide: true,
    })
    assert.equal(result.status, 0, 'report-only preflight must write an unsupported evidence record rather than crashing')
    return await readUnsupportedEvidence(outputRoot, '10-native-abi-and-koffi-preflight')
  } finally {
    if (outputRootOverride === undefined) await rm(outputRoot, { recursive: true, force: true })
  }
}

test('10: DSH reference baseline fails closed without an explicit clean source root', { skip: !windowsOnly }, async () => {
  const evidence = await runFailClosed('run-dsh-source-baseline.mjs', '10-dsh-source-baseline')
  assert.equal(evidence.failure.code, 'DSH_ROOT_REQUIRED')
})

test('10: DSH token snapshot fails closed without a DSH source root', { skip: !windowsOnly }, async () => {
  const evidence = await runFailClosed('run-dsh-token-snapshot.mjs', '10-dsh-token-snapshot')
  assert.equal(evidence.failure.code, 'DSH_ROOT_REQUIRED')
})

test('20: workspace-write differential fails closed without the complete A1-A5 inputs', { skip: !windowsOnly }, async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'node-repl-phase0-workspace-write-matrix-'))
  try {
    const result = spawnSync(process.execPath, [join(verifierRoot, 'scripts', 'run-workspace-write-differential.mjs')], {
      cwd: verifierRoot,
      env: childEnvironment(outputRoot),
      encoding: 'utf8',
      windowsHide: true,
    })
    assert.equal(result.status, 2)
    const evidence = JSON.parse(await readFile(join(outputRoot, '20-workspace-write-differential', 'evidence.json'), 'utf8'))
    assert.equal(evidence.status, 'MATRIX_INCONCLUSIVE')
    assert.equal(evidence.releaseEligible, false)
    assert.match(evidence.failure, /exact native executable, pinned DSH root, and evidence output root/u)
  } finally {
    await rm(outputRoot, { recursive: true, force: true })
  }
})

test('10: CI native artifact verifier fails closed without an exact artifact directory, source commit, and expected hash', { skip: !windowsOnly }, async () => {
  const evidence = await runFailClosed('../native/verify-artifact.mjs', '10-ci-native-audit-artifact')
  assert.equal(evidence.failure.code, 'NATIVE_AUDIT_ARTIFACT_INVALID')
})

test('20: owned-worker probe fails closed without the exact native launcher', { skip: !windowsOnly }, async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'node-repl-phase0-tier20-missing-launcher-'))
  try {
    const result = spawnSync(process.execPath, [join(verifierRoot, 'scripts', 'run-owned-worker-probe.mjs')], {
      cwd: verifierRoot,
      env: childEnvironment(outputRoot),
      encoding: 'utf8',
      windowsHide: true,
    })
    assert.equal(result.status, 2)
    const evidence = JSON.parse(await readFile(join(outputRoot, '20-owned-restricted-token-job', 'evidence.json'), 'utf8'))
    assert.equal(evidence.status, 'UNSUPPORTED')
    assert.equal(evidence.restrictedToken, false)
    assert.equal(evidence.jobOwnership, false)
    assert.equal(evidence.daclGrant, false)
    assert.equal(evidence.osHandleAllowlistProven, false)
    assert.ok(evidence.observations.every(observation => observation.failure?.code === 'NATIVE_LAUNCHER_REQUIRED'))
  } finally {
    await rm(outputRoot, { recursive: true, force: true })
  }
})

test('10: CI native artifact verifier requires an independently supplied executable hash', { skip: !windowsOnly }, async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'node-repl-phase0-ci-audit-hash-contract-'))
  try {
    const result = spawnSync(process.execPath, [join(verifierRoot, 'native', 'verify-artifact.mjs')], {
      cwd: verifierRoot,
      env: {
        ...childEnvironment(outputRoot),
        NODE_REPL_VERIFY_NATIVE_AUDIT_DIR: 'C:\\node-repl-phase0-unneeded-before-hash-check',
        NODE_REPL_VERIFY_NATIVE_AUDIT_COMMIT: '94b34a07e637313abecb926351f872d7131c5a60',
      },
      encoding: 'utf8',
      windowsHide: true,
    })
    assert.equal(result.status, 2)
    const evidence = await readUnsupportedEvidence(outputRoot, '10-ci-native-audit-artifact')
    assert.match(evidence.failure.message, /NODE_REPL_VERIFY_NATIVE_AUDIT_SHA256/u)
  } finally {
    await rm(outputRoot, { recursive: true, force: true })
  }
})

test('10: CI native artifact verifier rejects a self-consistent manifest when the independent expected hash differs', { skip: !windowsOnly }, async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'node-repl-phase0-ci-audit-mismatched-hash-output-'))
  const artifactRoot = await mkdtemp(join(tmpdir(), 'node-repl-phase0-ci-audit-mismatched-hash-artifact-'))
  const sourceCommit = '94b34a07e637313abecb926351f872d7131c5a60'
  const artifactHash = 'a'.repeat(64)
  try {
    await writeFile(join(artifactRoot, 'node-repl-win32-audit.exe'), 'not-an-executable-and-must-not-run', 'utf8')
    await writeFile(join(artifactRoot, 'SHA256SUMS.txt'), `${artifactHash} *node-repl-win32-audit.exe\n`, 'utf8')
    await writeFile(join(artifactRoot, 'manifest.json'), `${JSON.stringify({
      schemaVersion: 1,
      artifact: 'node-repl-win32-audit.exe',
      sha256: artifactHash,
      sourceCommit,
      workflowRef: 'lyd123qw2008/node-repl-runtime/.github/workflows/windows-acl-native-audit.yml@refs/heads/fix/runtime-kernel-and-provider-failures',
      runner: { os: 'Windows', architecture: 'X64' },
      compiler: { version: 'Microsoft test compiler', windowsSdkVersion: '10.0.26100.0' },
      selfTestModes: ['abi', 'handle-sentinel', 'job-settlement'],
    })}\n`, 'utf8')

    const result = spawnSync(process.execPath, [join(verifierRoot, 'native', 'verify-artifact.mjs')], {
      cwd: verifierRoot,
      env: {
        ...childEnvironment(outputRoot),
        NODE_REPL_VERIFY_NATIVE_AUDIT_DIR: artifactRoot,
        NODE_REPL_VERIFY_NATIVE_AUDIT_COMMIT: sourceCommit,
        NODE_REPL_VERIFY_NATIVE_AUDIT_SHA256: 'b'.repeat(64),
      },
      encoding: 'utf8',
      windowsHide: true,
    })
    assert.equal(result.status, 2)
    const evidence = await readUnsupportedEvidence(outputRoot, '10-ci-native-audit-artifact')
    assert.match(evidence.failure.message, /manifest SHA-256 does not equal NODE_REPL_VERIFY_NATIVE_AUDIT_SHA256/u)
  } finally {
    await rm(outputRoot, { recursive: true, force: true })
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test('10: exact Koffi loads and selected x64 Win32 ABI declarations bind without creating a sandbox', { skip: !windowsOnly }, () => {
  const result = inspectNativeAbiPreflight()
  assert.equal(result.status, 'PASS')
  assert.equal(result.observation.version, '3.1.1')
  assert.equal(result.observation.pointerSize, ABI_EXPECTATIONS.pointerSize)
  assert.deepEqual(result.observation.layouts, {
    startupInfoW: ABI_EXPECTATIONS.startupInfoWSize,
    processInformation: ABI_EXPECTATIONS.processInformationSize,
    securityAttributes: ABI_EXPECTATIONS.securityAttributesSize,
    jobObjectBasicAccountingInformation: ABI_EXPECTATIONS.jobObjectBasicAccountingInformationSize,
  })
  assert.equal(result.observation.exports['kernel32!CreatePipe'], 'bound')
  assert.equal(result.observation.exports['advapi32!CreateRestrictedToken'], 'bound')
  assert.equal(result.observation.exports['advapi32!CreateProcessAsUserW'], 'bound')
  assert.ok(result.nonClaims.some(item => item.includes('no restricted token')))
  assert.equal(inspectNativeAbiPreflight().status, 'PASS', 'repeat inspection must reuse Koffi type declarations rather than fail on duplicate names')
})

test('10: owned native preflight remains unsupported before owned launcher gates exist', { skip: !windowsOnly }, async () => {
  const evidence = await runFailClosed('run-native-preflight.mjs', '10-native-abi-and-koffi-preflight')
  assert.equal(evidence.gates.koffiNativeAbi.status, 'PASS')
  assert.equal(evidence.gates.nativeCompiler.status, 'NOT_INSTALLED')
  assert.equal(evidence.gates.ciNativeAuditReference.status, 'NOT_RUN')
  assert.ok(evidence.blockingGates.some(gate => gate.name === 'ownedRestrictedTokenJobLauncher' && gate.status === 'NOT_STARTED'))
  assert.ok(evidence.blockingGates.some(gate => gate.name === 'restrictedEnvironmentAbi' && gate.status === 'NOT_STARTED'))
  assert.ok(evidence.blockingGates.some(gate => gate.name === 'handleAllowlist' && gate.status === 'NOT_STARTED'))
})

test('10: native preflight records CI audit input only as separate evidence', { skip: !windowsOnly }, async () => {
  const aclRoot = await mkdtemp(join(tmpdir(), 'node-repl-phase0-ci-audit-reference-acl-root-'))
  try {
    const evidence = await runPreflightReport(aclRoot, undefined, {
      NODE_REPL_VERIFY_NATIVE_AUDIT_DIR: 'C:\\node-repl-phase0-artifact',
      NODE_REPL_VERIFY_NATIVE_AUDIT_COMMIT: '94b34a07e637313abecb926351f872d7131c5a60',
      NODE_REPL_VERIFY_NATIVE_AUDIT_SHA256: '4520186c6e25f756fd0327a28a75cbbe531efd88f6b938076262a2d861ca38a6',
    })
    assert.equal(evidence.gates.ciNativeAuditReference.status, 'SEPARATE_EVIDENCE_REQUIRED')
    assert.equal(evidence.gates.ciNativeAuditReference.input.sourceCommit, '94b34a07e637313abecb926351f872d7131c5a60')
    assert.equal(evidence.gates.ciNativeAuditReference.input.executableSha256, '4520186c6e25f756fd0327a28a75cbbe531efd88f6b938076262a2d861ca38a6')
    assert.ok(evidence.blockingGates.some(gate => gate.name === 'ciNativeAuditReference' && gate.status === 'SEPARATE_EVIDENCE_REQUIRED'))
  } finally {
    await rm(aclRoot, { recursive: true, force: true })
  }
})

test('10: native preflight rejects a relative Node executable before any owned launch', { skip: !windowsOnly }, async () => {
  const aclRoot = await mkdtemp(join(tmpdir(), 'node-repl-phase0-node-preflight-acl-root-'))
  try {
    const evidence = await runPreflightReport(aclRoot, undefined, { NODE_REPL_VERIFY_NODE: 'node.exe' })
    assert.equal(evidence.gates.node.status, 'BLOCKED')
    assert.equal(evidence.gates.node.executable.absolute, false)
    assert.equal(evidence.gates.node.executable.existingFile, false)
  } finally {
    await rm(aclRoot, { recursive: true, force: true })
  }
})

test('10: native preflight rejects an ACL root that overlaps the repository', { skip: !windowsOnly }, async () => {
  const evidence = await runPreflightReport(verifierRoot)
  assert.equal(evidence.gates.aclRoot.status, 'BLOCKED')
  assert.equal(evidence.gates.aclRoot.observation.overlapsRepository, true)
})

test('10: native preflight rejects an ACL root that overlaps evidence output', { skip: !windowsOnly }, async () => {
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'node-repl-phase0-evidence-root-'))
  const aclRoot = join(evidenceRoot, 'acl-root')
  await mkdir(aclRoot)
  try {
    const evidence = await runPreflightReport(aclRoot, evidenceRoot)
    assert.equal(evidence.gates.aclRoot.status, 'BLOCKED')
    assert.equal(evidence.gates.aclRoot.observation.overlapsEvidence, true)
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true })
  }
})

test('10: native preflight records a disjoint existing ACL root as pending, never supported', { skip: !windowsOnly }, async () => {
  const aclRoot = await mkdtemp(join(tmpdir(), 'node-repl-phase0-disjoint-acl-root-'))
  try {
    const evidence = await runPreflightReport(aclRoot)
    assert.equal(evidence.gates.aclRoot.status, 'PENDING_OWNED_ACL_PROBE')
    assert.equal(evidence.gates.aclRoot.observation.candidate.ok, true)
    assert.equal(evidence.gates.aclRoot.observation.volume.isNtfs, true)
    assert.ok(evidence.blockingGates.some(gate => gate.name === 'aclRoot' && gate.status === 'PENDING_OWNED_ACL_PROBE'))
  } finally {
    await rm(aclRoot, { recursive: true, force: true })
  }
})
