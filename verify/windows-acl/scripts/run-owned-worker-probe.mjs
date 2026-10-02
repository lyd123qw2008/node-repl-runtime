import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const verifierRoot = fileURLToPath(new URL('../', import.meta.url))
const requestedEvidenceRoot = process.env.NODE_REPL_VERIFY_OUT
const evidenceRoot = requestedEvidenceRoot === undefined
  ? join(verifierRoot, 'spike', 'windows-acl-tier20')
  : join(resolve(requestedEvidenceRoot), '20-owned-restricted-token-job')
const nativeExecutable = process.env.NODE_REPL_VERIFY_TIER20_NATIVE
const nodeExecutable = process.env.NODE_REPL_VERIFY_NODE ?? process.execPath
const workerPath = join(verifierRoot, 'fixtures', 'tier20-worker.mjs')
const modes = ['read-only', 'workspace-write']

const nonClaims = [
  'This is a non-production owned-worker feasibility probe, not a runtime launcher.',
  'The probe establishes only the tested Windows ACL/token/Low/Job/fd/environment facts; it does not constrain network egress or ambient process visibility.',
  'Cell-created child processes remain subject to the owned Job but are not a general OS process-visibility policy.',
  'Cell-owned child_process piped stdio may fail with EPERM on a Windows ACL restricted token; it is recorded as a known partial-boundary diagnostic, not claimed as supported.',
  'No result enables sandboxHost required or changes the production/default host.',
]

async function runMode(mode) {
  const parent = await mkdtemp(join(tmpdir(), 'node-repl-tier20-'))
  const workspace = join(parent, 'workspace')
  const privateTemp = join(parent, 'private-temp')
  await mkdir(workspace)
  await mkdir(privateTemp)
  try {
    if (process.platform !== 'win32') {
      return {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        evidenceTier: '20-owned-restricted-token-job',
        suite: '20-owned-restricted-token-job',
        mode,
        status: 'UNSUPPORTED',
        confinement: 'none',
        enforcement: 'none',
        restrictedToken: false,
        jobOwnership: false,
        daclGrant: false,
        osHandleAllowlistProven: false,
        releaseEligible: false,
        nonClaims,
        failure: { code: 'UNSUPPORTED_PLATFORM', message: 'Tier 20 is Windows x64 only.' },
      }
    }
    if (nativeExecutable === undefined) {
      return {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        evidenceTier: '20-owned-restricted-token-job',
        suite: '20-owned-restricted-token-job',
        mode,
        status: 'UNSUPPORTED',
        confinement: 'none',
        enforcement: 'none',
        restrictedToken: false,
        jobOwnership: false,
        daclGrant: false,
        osHandleAllowlistProven: false,
        releaseEligible: false,
        nonClaims,
        failure: { code: 'NATIVE_LAUNCHER_REQUIRED', message: 'NODE_REPL_VERIFY_TIER20_NATIVE must name the exact native fixture.' },
      }
    }

    await writeFile(join(parent, 'tier20-external-sentinel.txt'), 'tier20-external-sentinel\n', { flag: 'wx' })
    const invocation = spawnSync(nativeExecutable, [
      '--mode', mode,
      '--node', nodeExecutable,
      '--worker', workerPath,
      '--workspace', workspace,
      '--private-temp', privateTemp,
    ], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 })
    let native = null
    try {
      native = JSON.parse(`${invocation.stdout ?? ''}`.trim())
    } catch (error) {
      native = {
        status: 'FAIL',
        phase: 'native-json',
        error: error instanceof Error ? error.message : String(error),
        stdout: `${invocation.stdout ?? ''}`.slice(0, 8192),
      }
    }
    const pass = invocation.status === 0 && native?.status === 'PASS'
    return {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      evidenceTier: '20-owned-restricted-token-job',
      suite: '20-owned-restricted-token-job',
      mode,
      status: pass ? 'TIER20_PASS' : 'UNSUPPORTED',
      confinement: pass ? 'partial' : 'none',
      enforcement: pass ? 'partial' : 'none',
      restrictedToken: native?.tokenRestricted === true,
      jobOwnership: native?.jobCreated === true && native?.targetAssignedToJob === true && native?.jobSettled === true,
      targetProcessCreated: native?.targetProcessCreated === true,
      targetProcessExited: native?.targetProcessExited === true,
      daclGrant: native?.daclApplied === true,
      lowLabelApplied: native?.lowLabelApplied === true,
      defaultDaclGrant: native?.defaultDaclGrant === true,
      defaultDaclWorldGrant: native?.defaultDaclWorldGrant === true,
      osHandleAllowlistProven: native?.handleAllowlist === true,
      releaseEligible: false,
      explicitEnvironmentBlock: native?.explicitEnvironmentBlock === true,
      crtDescriptorTable: native?.crtDescriptorTable === true,
      fd3RoundTrip: native?.fd3RoundTrip === true,
      carrierReads: native?.carrierReads === true,
      targetExitSuccess: native?.targetExitSuccess === true,
      lowIntegrity: native?.tokenLowIntegrity === true,
      targetReady: native?.targetReady === true,
      targetReportPass: native?.targetReportPass === true,
      targetResumed: native?.targetResumed === true,
      grantsRevokedAfterQuiescence: native?.grantsRevokedAfterQuiescence === true,
      cleanup: native?.cleanup === true,
      native,
      stderr: `${invocation.stderr ?? ''}`.slice(0, 8192),
      nonClaims,
    }
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
}

await mkdir(evidenceRoot, { recursive: true })
const observations = []
for (const mode of modes) observations.push(await runMode(mode))
const passed = observations.every((observation) => observation.status === 'TIER20_PASS')
const artifact = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  evidenceTier: '20-owned-restricted-token-job',
  suite: '20-owned-restricted-token-job',
  status: passed ? 'TIER20_PASS' : 'UNSUPPORTED',
  confinement: passed ? 'partial' : 'none',
  enforcement: passed ? 'partial' : 'none',
  restrictedToken: observations.every((observation) => observation.restrictedToken),
  jobOwnership: observations.every((observation) => observation.jobOwnership),
  targetProcessCreated: observations.every((observation) => observation.targetProcessCreated),
  targetProcessExited: observations.every((observation) => observation.targetProcessExited),
  daclGrant: observations.every((observation) => observation.daclGrant),
  lowLabelApplied: observations.every((observation) => observation.lowLabelApplied),
  defaultDaclGrant: observations.every((observation) => observation.defaultDaclGrant),
  defaultDaclWorldGrant: observations.every((observation) => observation.defaultDaclWorldGrant),
  osHandleAllowlistProven: observations.every((observation) => observation.osHandleAllowlistProven),
  explicitEnvironmentBlock: observations.every((observation) => observation.explicitEnvironmentBlock),
  crtDescriptorTable: observations.every((observation) => observation.crtDescriptorTable),
  fd3RoundTrip: observations.every((observation) => observation.fd3RoundTrip),
  carrierReads: observations.every((observation) => observation.carrierReads),
  targetExitSuccess: observations.every((observation) => observation.targetExitSuccess),
  lowIntegrity: observations.every((observation) => observation.lowIntegrity),
  grantsRevokedAfterQuiescence: observations.every((observation) => observation.grantsRevokedAfterQuiescence),
  cleanup: observations.every((observation) => observation.cleanup),
  releaseEligible: false,
  nonClaims,
  observations,
}
await writeFile(join(evidenceRoot, 'evidence.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({
  status: artifact.status,
  evidencePath: join(evidenceRoot, 'evidence.json'),
  modes: observations.map(({ mode, status }) => ({ mode, status })),
  details: observations.map(({ mode, status, native, failure }) => ({ mode, status, native, failure })),
}, null, 2)}\n`)
if (!passed) process.exitCode = 2
