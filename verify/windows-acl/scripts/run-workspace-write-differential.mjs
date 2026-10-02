import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const verifierRoot = fileURLToPath(new URL('../', import.meta.url))
const nativeExecutable = process.env.NODE_REPL_VERIFY_TIER20_NATIVE
const nodeExecutable = process.env.NODE_REPL_VERIFY_NODE ?? process.execPath
const dshRoot = process.env.NODE_REPL_VERIFY_DSH_ROOT
const evidenceRootInput = process.env.NODE_REPL_VERIFY_OUT
const evidenceDirectory = evidenceRootInput === undefined
  ? join(verifierRoot, 'spike', 'windows-acl', '20-workspace-write-differential')
  : join(resolve(evidenceRootInput), '20-workspace-write-differential')
const evidenceRoot = evidenceRootInput === undefined ? join(verifierRoot, 'spike', 'windows-acl') : resolve(evidenceRootInput)
const dshSnapshotScript = join(verifierRoot, 'scripts', 'run-dsh-token-snapshot.mjs')
const workerPath = join(verifierRoot, 'fixtures', 'tier20-worker.mjs')
const expectedFailedNodeStatus = 0xC0000142

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex')
}

function asHex(value) {
  if (!Number.isInteger(value)) return null
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`
}

function aceIs(ace, sidClass, flags) {
  return ace?.type === 0 && ace.sidClass === sidClass && ace.mask === '0x001f01ff' && ace.flags === flags
}

function nativeWorkerSettled(native) {
  return native?.targetProcessCreated === true && native.targetProcessExited === true && native.targetReady === true &&
    native.targetReportPass === true && native.targetExitSuccess === true && native.targetAssignedToJob === true &&
    native.targetResumed === true && native.jobSettled === true && native.grantsRevokedAfterQuiescence === true && native.cleanup === true
}

async function runNativeExperiment(name, daclFlags, includeWorldAce, environment) {
  const experimentRoot = await mkdtemp(join(tmpdir(), `node-repl-${name.toLowerCase()}-`))
  try {
    const workspace = join(experimentRoot, 'workspace')
    const privateTemp = join(experimentRoot, 'private-temp')
    await mkdir(workspace)
    await mkdir(privateTemp)
    await writeFile(join(experimentRoot, 'tier20-external-sentinel.txt'), 'tier20-external-sentinel\n', { flag: 'wx' })
    const invocation = spawnSync(nativeExecutable, [
      '--mode', 'workspace-write',
      '--node', nodeExecutable,
      '--worker', workerPath,
      '--workspace', workspace,
      '--private-temp', privateTemp,
      '--default-dacl-inheritance', String(daclFlags),
      '--default-dacl-world-ace', includeWorldAce ? 'yes' : 'no',
      '--environment', environment,
    ], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 })
    let native = null
    let parseFailure = null
    try {
      native = JSON.parse(`${invocation.stdout ?? ''}`.trim())
    } catch (error) {
      parseFailure = error instanceof Error ? error.message : String(error)
    }
    const aces = Array.isArray(native?.defaultDaclAces) ? native.defaultDaclAces : []
    const tempAce = aces.find(ace => aceIs(ace, 'temp-capability', daclFlags))
    const worldFullAce = aces.some(ace => aceIs(ace, 'world', 0) || aceIs(ace, 'world', 3))
    const observed = {
      experiment: name,
      requested: { nodeVersion: process.version, launchPath: 'direct-tier20', defaultDacl: `temp${includeWorldAce ? '+world' : ''},flags=${daclFlags}`, environment },
      process: { status: invocation.status, statusHex: asHex(invocation.status), signal: invocation.signal ?? null, spawnError: invocation.error?.code ?? null, stderrSha256: sha256Text(`${invocation.stderr ?? ''}`) },
      native,
      parseFailure,
      checks: {
        nativeJson: native !== null,
        targetSettledAndCleaned: nativeWorkerSettled(native),
        tempCapabilityFullAccessAceObserved: tempAce !== undefined,
        worldFullAccessAceObserved: worldFullAce,
        requestedEnvironmentModeObserved: native?.environmentMode === environment,
        explicitEnvironmentBlockMatchesRequest: native?.explicitEnvironmentBlock === (environment === 'explicit'),
      },
    }
    return observed
  } finally {
    await rm(experimentRoot, { recursive: true, force: true })
  }
}

function classifyDshA1(evidence) {
  const observation = evidence?.observations?.find(item => item.mode === 'workspace-write')
  if (observation?.status === 'PASS' && observation.snapshot?.nodeVersion === process.version && evidence.host?.nodeVersion === process.version) {
    return { outcome: 'pass', observation }
  }
  if (observation?.snapshot !== undefined) return { outcome: 'dsh-final-worker-failed-checks', observation }
  if (observation?.exitCodeHex === '0xc0000142') return { outcome: 'node-startup-failed-0xc0000142', observation }
  if (observation?.spawnErrorCode !== undefined && observation.spawnErrorCode !== null) return { outcome: 'inconclusive', observation }
  if (observation?.exitCode === 127) return { outcome: 'dsh-runner-failed-exit-127', observation }
  if (observation?.exitCode !== undefined && observation.exitCode !== null && observation.exitCode !== 0) {
    return { outcome: 'dsh-final-worker-failed', observation }
  }
  return { outcome: 'inconclusive', observation: observation ?? null }
}

function classifyMatrix(a1, a2, a3, a4, a5) {
  const a2Pass = a2.native?.status === 'PASS' && nativeWorkerSettled(a2.native) &&
    a2.checks.tempCapabilityFullAccessAceObserved && !a2.checks.worldFullAccessAceObserved &&
    a2.checks.requestedEnvironmentModeObserved && a2.native.defaultDaclInheritanceFlags === 3
  const a3Pass = a3.native?.status === 'PASS' && nativeWorkerSettled(a3.native) &&
    a3.checks.tempCapabilityFullAccessAceObserved && !a3.checks.worldFullAccessAceObserved &&
    a3.checks.requestedEnvironmentModeObserved && a3.checks.explicitEnvironmentBlockMatchesRequest === true
  const a4Reproduced = a4.native?.mode === 'workspace-write' && a4.native?.status === 'FAIL' &&
    a4.native?.targetExitCode === expectedFailedNodeStatus && a4.native?.targetProcessCreated === true &&
    a4.native?.targetProcessExited === true && a4.native?.jobSettled === true && a4.native?.cleanup === true &&
    a4.native?.defaultDaclInheritanceFlags === 0 && a4.native?.explicitEnvironmentBlock === true &&
    a4.checks.tempCapabilityFullAccessAceObserved && !a4.checks.worldFullAccessAceObserved
  const a5Pass = a5?.status === 'OWNED_WORKER_PROBE_PASS' && a5?.releaseEligible === false && a5?.jobOwnership === true &&
    a5?.targetProcessCreated === true && a5?.targetProcessExited === true && a5?.targetAssignedToJob === true &&
    a5?.targetResumed === true && a5?.jobSettled === true && a5?.grantsRevokedAfterQuiescence === true && a5?.cleanup === true &&
    a5?.targetReportPass === true && a5?.targetExitSuccess === true &&
    Array.isArray(a5.defaultDaclAces) && aceIs(a5.defaultDaclAces[0], 'temp-capability', 0) && aceIs(a5.defaultDaclAces[1], 'world', 0)
  const a1Valid = a1.outcome !== 'inconclusive'
  const directTrialsObserved = [a2, a3, a4].every(item => item.native !== null)
  const complete = a1Valid && directTrialsObserved && a4Reproduced && a5Pass
  let decision
  if (!complete) {
    decision = 'MATRIX_INCONCLUSIVE: an expected control or launch observation is missing; do not change the ACL design.'
  } else if (a1.outcome !== 'pass') {
    decision = 'STOP: pinned DSH workspace-write did not pass on Node 22.19. Keep Windows workspace-write unsupported as a Phase 0 route; Node 24 DSH success does not transfer to the minimum runtime.'
  } else if (a2Pass || a3Pass) {
    const candidates = [a2Pass ? 'A2 inheritable temp ACE flags 0x03' : null, a3Pass ? 'A3 DSH-style inherited environment' : null].filter(Boolean)
    decision = `A narrow direct-worker candidate was observed (${candidates.join('; ')}). This is experimental evidence only: security-review the successful single variable before any design change.`
  } else {
    decision = 'DSH workspace-write passed on Node 22.19, but direct temp-only A2/A3 did not; the remaining difference is DSH launch topology. Keep workspace-write unsupported, stop probe expansion, and decide separately whether the DSH private runner is acceptable or Windows should pivot to SRT.'
  }
  return { complete, decision, checks: { a1Valid, directTrialsObserved, a2Pass, a3Pass, a4KnownFailureReproduced: a4Reproduced, a5WorldAceControlPassed: a5Pass } }
}

let artifact
if (process.platform !== 'win32' || process.arch !== 'x64') {
  artifact = { schemaVersion: 1, suite: '20-workspace-write-differential', status: 'MATRIX_INCONCLUSIVE', releaseEligible: false, failure: 'Windows x64 is required.', nonClaims: ['An incomplete matrix proves no support and changes no product behavior.'] }
} else if (nativeExecutable === undefined || dshRoot === undefined || evidenceRootInput === undefined) {
  artifact = { schemaVersion: 1, suite: '20-workspace-write-differential', status: 'MATRIX_INCONCLUSIVE', releaseEligible: false, failure: 'Set the exact native executable, pinned DSH root, and evidence output root.', nonClaims: ['An incomplete matrix proves no support and changes no product behavior.'] }
} else if (process.version !== 'v22.19.0') {
  artifact = { schemaVersion: 1, suite: '20-workspace-write-differential', status: 'MATRIX_INCONCLUSIVE', releaseEligible: false, failure: `Expected one-shot matrix Node v22.19.0; observed ${process.version}.`, nonClaims: ['An incomplete matrix proves no support and changes no product behavior.'] }
} else {
  await mkdir(evidenceDirectory, { recursive: true })
  const a1Env = {
    ...process.env,
    NODE_REPL_VERIFY_DSH_ROOT: dshRoot,
    NODE_REPL_VERIFY_DSH_MODE: 'workspace-write',
    NODE_REPL_VERIFY_OUT: evidenceRoot,
  }
  const a1Invocation = spawnSync(nodeExecutable, [dshSnapshotScript], { cwd: verifierRoot, env: a1Env, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 })
  let a1Evidence = null
  try {
    a1Evidence = JSON.parse(await readFile(join(evidenceRoot, '10-dsh-token-snapshot', 'evidence.json'), 'utf8'))
  } catch {
    // Preserve an explicit inconclusive row below; do not retry this matrix.
  }
  const classifiedA1 = classifyDshA1(a1Evidence)
  const a1 = {
    experiment: 'A1',
    requested: { nodeVersion: process.version, launchPath: 'pinned-DSH-runner', defaultDacl: 'DSH-as-is', environment: 'DSH-as-is' },
    runner: { status: a1Invocation.status, statusHex: asHex(a1Invocation.status), signal: a1Invocation.signal ?? null, spawnError: a1Invocation.error?.code ?? null, stderrSha256: sha256Text(`${a1Invocation.stderr ?? ''}`) },
    outcome: classifiedA1.outcome,
    observation: classifiedA1.observation,
  }

  const a2 = await runNativeExperiment('A2', 3, false, 'explicit')
  const a3 = await runNativeExperiment('A3', 0, false, 'inherit')
  const a4 = await runNativeExperiment('A4', 0, false, 'explicit')
  let a5Evidence = null
  try {
    const standardEvidence = JSON.parse(await readFile(join(evidenceRoot, '20-owned-restricted-token-job', 'evidence.json'), 'utf8'))
    a5Evidence = standardEvidence.observations?.find(item => item.mode === 'workspace-write') ?? null
  } catch {
    // The A5 control is required; missing evidence makes the matrix inconclusive.
  }
  const a5 = a5Evidence
    ? { experiment: 'A5', requested: { nodeVersion: process.version, launchPath: 'direct-tier20', defaultDacl: 'temp+world,flags=0', environment: 'current-explicit' }, ...a5Evidence }
    : null
  const classification = classifyMatrix(a1, a2, a3, a4, a5)
  artifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    evidenceTier: '20-workspace-write-single-variable-differential',
    suite: '20-workspace-write-differential',
    status: classification.complete ? 'MATRIX_COMPLETE' : 'MATRIX_INCONCLUSIVE',
    confinement: 'none',
    enforcement: 'none',
    releaseEligible: false,
    host: { os: process.platform, architecture: process.arch, nodeVersion: process.version, runnerImage: process.env.ImageVersion ?? null },
    dshRevision: a1Evidence?.source?.revision ?? null,
    experiments: { A1: a1, A2: a2, A3: a3, A4: a4, A5: a5 },
    classification,
    ignoredForGoNoGo: ['Cell-owned piped-grandchild stdio is not a matrix gate; its existing EPERM observation is diagnostic only.'],
    nonClaims: [
      'This is one diagnostic matrix, not formal Tier 20 or Phase 0 acceptance.',
      'No result authorizes the probe World ACE as a product design or changes production/default behavior.',
      'A2/A3 success is only a candidate requiring security review, not a supported Windows backend.',
    ],
  }
}

await mkdir(evidenceDirectory, { recursive: true })
await writeFile(join(evidenceDirectory, 'evidence.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({
  status: artifact.status,
  evidencePath: join(evidenceDirectory, 'evidence.json'),
  decision: artifact.classification?.decision ?? artifact.failure,
  outcomes: artifact.experiments === undefined ? null : Object.fromEntries(Object.entries(artifact.experiments).map(([name, item]) => [name, item?.outcome ?? item?.status ?? item?.native?.status ?? null])),
}, null, 2)}\n`)
if (artifact.status !== 'MATRIX_COMPLETE') process.exitCode = 2
