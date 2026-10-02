export const EXPECTED_NODE_STARTUP_STATUS = 0xC0000142

export function aceIs(ace, sidClass, flags) {
  return ace?.type === 0 && ace.sidClass === sidClass && ace.mask === '0x001f01ff' && ace.flags === flags
}

export function nativeWorkerSettled(native) {
  return native?.targetProcessCreated === true && native.targetProcessExited === true && native.targetReady === true &&
    native.targetReportPass === true && native.targetExitSuccess === true && native.targetAssignedToJob === true &&
    native.targetResumed === true && native.jobSettled === true && native.grantsRevokedAfterQuiescence === true && native.cleanup === true
}

export function classifyDshA1(evidence, expectedNodeVersion) {
  const observation = evidence?.observations?.find(item => item.mode === 'workspace-write')
  if (observation?.status === 'PASS' && observation.snapshot?.nodeVersion === expectedNodeVersion && evidence.host?.nodeVersion === expectedNodeVersion) {
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

export function classifyMatrix(a1, a2, a3, a4, a5) {
  const a2Pass = a2.native?.status === 'PASS' && nativeWorkerSettled(a2.native) &&
    a2.checks.tempCapabilityFullAccessAceObserved && !a2.checks.worldFullAccessAceObserved &&
    a2.checks.requestedEnvironmentModeObserved && a2.native.defaultDaclInheritanceFlags === 3
  const a3Pass = a3.native?.status === 'PASS' && nativeWorkerSettled(a3.native) &&
    a3.checks.tempCapabilityFullAccessAceObserved && !a3.checks.worldFullAccessAceObserved &&
    a3.checks.requestedEnvironmentModeObserved && a3.checks.explicitEnvironmentBlockMatchesRequest === true
  const a4Reproduced = a4.native?.mode === 'workspace-write' && a4.native?.status === 'FAIL' &&
    a4.native?.targetExitCode === EXPECTED_NODE_STARTUP_STATUS && a4.native?.targetProcessCreated === true &&
    a4.native?.targetProcessExited === true && a4.native?.jobSettled === true && a4.native?.cleanup === true &&
    a4.native?.defaultDaclInheritanceFlags === 0 && a4.native?.explicitEnvironmentBlock === true &&
    a4.checks.tempCapabilityFullAccessAceObserved && !a4.checks.worldFullAccessAceObserved
  const a5Pass = a5?.status === 'OWNED_WORKER_PROBE_PASS' && a5?.releaseEligible === false && a5?.jobOwnership === true &&
    a5?.targetProcessCreated === true && a5?.targetProcessExited === true && a5?.native?.targetAssignedToJob === true &&
    a5?.targetResumed === true && a5?.native?.jobSettled === true && a5?.grantsRevokedAfterQuiescence === true && a5?.cleanup === true &&
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
