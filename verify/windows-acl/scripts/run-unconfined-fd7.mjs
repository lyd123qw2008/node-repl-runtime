import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

import { EVIDENCE_TIER, runUnconfinedFd7Probe } from '../lib/unconfined-fd7.mjs'

const verifierRoot = fileURLToPath(new URL('../', import.meta.url))
const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID()}`
const requestedEvidenceRoot = process.env.NODE_REPL_VERIFY_OUT
const artifactDirectory = requestedEvidenceRoot === undefined
  ? join(verifierRoot, 'spike', 'windows-acl', runId, '00-unconfined-node-fd7')
  : join(resolve(requestedEvidenceRoot), '00-unconfined-node-fd7')
const artifactPath = join(artifactDirectory, 'evidence.json')

const nonClaims = [
  'No restricted token was created or inspected.',
  'No ACL/DACL grant, capability SID, delete deny, or Low-integrity label was created or inspected.',
  'No Job object or process-range quiescence was created or observed.',
  'No native OS handle inheritance allowlist was used or proven.',
  'No private TMP/TEMP capability or sandbox filesystem boundary was created or tested.',
  'No closed, restricted, or per-lease target environment was proven; ordinary Windows Node spawn may materialize ambient values.',
  'This direct Node child is intentionally unconfined and cannot enable sandboxHost: required.',
]

try {
  const observation = await runUnconfinedFd7Probe()
  const artifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    evidenceTier: EVIDENCE_TIER,
    suite: '00-unconfined-node-fd7',
    status: 'REFERENCE_PASS',
    confinement: 'none',
    enforcement: 'none',
    restrictedToken: false,
    jobOwnership: false,
    daclGrant: false,
    osHandleAllowlistProven: false,
    releaseEligible: false,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    nonClaims,
    observation,
  }
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ status: artifact.status, evidenceTier: artifact.evidenceTier, releaseEligible: artifact.releaseEligible, artifactPath }, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`00-unconfined-node-fd7 failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
}
