import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { inspectNativeAbiPreflight } from '../lib/native-abi-preflight.mjs'

const verifierRoot = fileURLToPath(new URL('../', import.meta.url))
const reportOnly = process.argv.includes('--report-only')
const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID()}`
const requestedEvidenceRoot = process.env.NODE_REPL_VERIFY_OUT
const artifactDirectory = requestedEvidenceRoot === undefined
  ? join(verifierRoot, 'spike', 'windows-acl', runId, '10-native-abi-and-koffi-preflight')
  : join(resolve(requestedEvidenceRoot), '10-native-abi-and-koffi-preflight')
const artifactPath = join(artifactDirectory, 'evidence.json')
const repositoryRoot = resolve(verifierRoot, '..', '..')
const evidenceRoot = requestedEvidenceRoot === undefined
  ? join(verifierRoot, 'spike')
  : resolve(requestedEvidenceRoot)

function nodeVersionAtLeast(major, minor) {
  const [actualMajor = 0, actualMinor = 0] = process.versions.node.split('.').map(Number)
  return actualMajor > major || (actualMajor === major && actualMinor >= minor)
}

function findOnPath(command) {
  if (process.platform !== 'win32') return { command, found: false, reason: 'not-windows' }
  const result = spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  const firstPath = output.split(/\r?\n/u).find(line => line.trim() !== '')
  const found = result.status === 0 && firstPath !== undefined
  return {
    command,
    found,
    ...(found ? { path: firstPath } : {}),
    ...(result.error === undefined ? {} : { error: result.error.message }),
  }
}

function volumeObservation(path) {
  const resolved = resolve(path)
  const drive = /^([a-z]):[\\/]/iu.exec(resolved)?.[1]
  if (process.platform !== 'win32' || drive === undefined) {
    return { path: resolved, isNtfs: false, error: 'a Windows drive-letter path is required' }
  }
  const command = `(Get-Volume -DriveLetter '${drive}' -ErrorAction Stop).FileSystem`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const filesystem = `${result.stdout ?? ''}`.trim().split(/\r?\n/u).find(line => line.trim() !== '')
  if (result.status !== 0 || filesystem === undefined) {
    return {
      path: resolved,
      isNtfs: false,
      error: result.error?.message ?? 'Get-Volume did not return a filesystem name',
    }
  }
  return { path: resolved, filesystem, isNtfs: filesystem.toUpperCase() === 'NTFS' }
}

function canonicalExistingDirectory(path) {
  const absolute = resolve(path)
  if (!existsSync(absolute)) return { ok: false, code: 'ROOT_MISSING', absolute }
  try {
    if (!statSync(absolute).isDirectory()) return { ok: false, code: 'ROOT_NOT_DIRECTORY', absolute }
    const canonical = realpathSync.native(absolute)
    const reparseSegments = []
    for (let current = absolute; ; current = dirname(current)) {
      if (lstatSync(current).isSymbolicLink()) reparseSegments.push(current)
      const parsed = parse(current)
      if (current === parsed.root) break
    }
    return { ok: true, absolute, canonical, reparseSegments }
  } catch (error) {
    return { ok: false, code: 'ROOT_INSPECTION_FAILED', absolute, error: error instanceof Error ? error.message : String(error) }
  }
}

function canonicalPlannedDirectory(path) {
  const absolute = resolve(path)
  let existingAncestor = absolute
  const missingSegments = []
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor)
    if (parent === existingAncestor) {
      return { ok: false, code: 'ROOT_ANCESTOR_MISSING', absolute }
    }
    missingSegments.unshift(basename(existingAncestor))
    existingAncestor = parent
  }
  try {
    if (!statSync(existingAncestor).isDirectory()) {
      return { ok: false, code: 'ROOT_ANCESTOR_NOT_DIRECTORY', absolute, existingAncestor }
    }
    const canonicalAncestor = realpathSync.native(existingAncestor)
    const reparseSegments = []
    for (let current = existingAncestor; ; current = dirname(current)) {
      if (lstatSync(current).isSymbolicLink()) reparseSegments.push(current)
      const parsed = parse(current)
      if (current === parsed.root) break
    }
    return {
      ok: true,
      absolute,
      canonical: resolve(canonicalAncestor, ...missingSegments),
      existingAncestor,
      canonicalAncestor,
      reparseSegments,
    }
  } catch (error) {
    return { ok: false, code: 'ROOT_ANCESTOR_INSPECTION_FAILED', absolute, error: error instanceof Error ? error.message : String(error) }
  }
}

function sameOrAncestor(ancestor, descendant) {
  const from = ancestor.replaceAll('/', '\\').toLowerCase()
  const to = descendant.replaceAll('/', '\\').toLowerCase()
  const between = relative(from, to)
  return between === '' || (!between.startsWith('..\\') && between !== '..' && !isAbsolute(between))
}

function aclRootBoundaryObservation(path) {
  if (path === undefined) return { status: 'NOT_CONFIGURED', observation: { configured: false } }
  const candidate = canonicalExistingDirectory(path)
  if (!candidate.ok) {
    return {
      status: 'BLOCKED',
      observation: { configured: true, ...candidate },
      required: 'NODE_REPL_VERIFY_ACL_ROOT must already exist as a repository-external disposable directory before owned ACL tests may run.',
    }
  }
  const repository = canonicalExistingDirectory(repositoryRoot)
  if (!repository.ok) {
    return {
      status: 'BLOCKED',
      observation: { configured: true, candidate, repository },
      required: 'The verifier repository root must be canonicalizable before checking the ACL root boundary.',
    }
  }
  const evidence = canonicalPlannedDirectory(evidenceRoot)
  if (!evidence.ok) {
    return {
      status: 'BLOCKED',
      observation: { configured: true, candidate, repository, evidence },
      required: 'The evidence output root must be canonicalizable through an existing directory ancestor before checking ACL-root disjointness.',
    }
  }
  const overlapsRepository = sameOrAncestor(candidate.canonical, repository.canonical)
    || sameOrAncestor(repository.canonical, candidate.canonical)
  const overlapsEvidence = sameOrAncestor(candidate.canonical, evidence.canonical)
    || sameOrAncestor(evidence.canonical, candidate.canonical)
  if (candidate.reparseSegments.length > 0 || repository.reparseSegments.length > 0 || evidence.reparseSegments.length > 0) {
    return {
      status: 'BLOCKED',
      observation: { configured: true, candidate, repository, evidence },
      required: 'Reparse/junction segments are rejected before an owned ACL test; use canonical non-reparse disposable ACL and evidence roots.',
    }
  }
  if (overlapsRepository || overlapsEvidence) {
    return {
      status: 'BLOCKED',
      observation: { configured: true, candidate, repository, evidence, overlapsRepository, overlapsEvidence },
      required: 'The ACL root must be disjoint from both the node-repl-runtime repository and evidence output roots.',
    }
  }
  return {
    status: 'PENDING_OWNED_ACL_PROBE',
    observation: { configured: true, candidate, repository, evidence },
    required: 'Basic directory/canonical/reparse/disjoint checks passed. Native owner, WRITE_DAC/WRITE_OWNER, Low-readability, AppContainer, and workspace/private-temp checks remain required before launch.',
  }
}

function selectedNodeExecutable() {
  const explicit = process.env.NODE_REPL_VERIFY_NODE
  const path = explicit ?? process.execPath
  let existingFile = false
  try {
    existingFile = isAbsolute(path) && existsSync(path) && statSync(path).isFile()
  } catch {
    existingFile = false
  }
  return {
    path,
    explicit: explicit !== undefined,
    absolute: isAbsolute(path),
    existingFile,
    endsInNodeExe: basename(path).toLowerCase() === 'node.exe',
    electronHost: process.versions.electron !== undefined,
  }
}

const compilerCandidates = [findOnPath('cl.exe'), findOnPath('g++.exe'), findOnPath('clang++.exe')]
const nativeAuditReferenceInput = {
  directory: process.env.NODE_REPL_VERIFY_NATIVE_AUDIT_DIR,
  sourceCommit: process.env.NODE_REPL_VERIFY_NATIVE_AUDIT_COMMIT,
  executableSha256: process.env.NODE_REPL_VERIFY_NATIVE_AUDIT_SHA256,
}
const nativeAuditReference = {
  status: nativeAuditReferenceInput.directory === undefined && nativeAuditReferenceInput.sourceCommit === undefined && nativeAuditReferenceInput.executableSha256 === undefined
    ? 'NOT_RUN'
    : 'SEPARATE_EVIDENCE_REQUIRED',
  input: nativeAuditReferenceInput,
  required: 'Run the separately fail-closed verify:reference:ci-native-audit with an exact GitHub Actions artifact directory and source commit. A pass is independent native ABI/handle-list/Job evidence only; it does not create an owned restricted-token launcher.',
}
const nativeAbi = inspectNativeAbiPreflight()
const nodeExecutable = selectedNodeExecutable()
const verifierVolume = volumeObservation(verifierRoot)
const aclRoot = process.env.NODE_REPL_VERIFY_ACL_ROOT
const aclRootBoundary = aclRootBoundaryObservation(aclRoot)
const aclRootVolume = aclRoot === undefined ? { configured: false } : { configured: true, ...volumeObservation(resolve(aclRoot)) }
const aclRootGate = aclRootBoundary.status !== 'PENDING_OWNED_ACL_PROBE'
  ? aclRootBoundary
  : !aclRootVolume.isNtfs
    ? {
        status: 'BLOCKED',
        observation: { ...aclRootBoundary.observation, volume: aclRootVolume },
        required: 'The repository-external disposable ACL root must be on NTFS before an owned ACL test may run.',
      }
    : {
        ...aclRootBoundary,
        observation: { ...aclRootBoundary.observation, volume: aclRootVolume },
      }

const gates = {
  platform: {
    status: process.platform === 'win32' ? 'PASS' : 'UNSUPPORTED',
    observed: process.platform,
    required: 'win32',
  },
  architecture: {
    status: process.arch === 'x64' ? 'PASS' : 'UNSUPPORTED',
    observed: process.arch,
    required: 'x64',
  },
  node: {
    status: nodeVersionAtLeast(22, 19) && nodeExecutable.absolute && nodeExecutable.existingFile && nodeExecutable.endsInNodeExe && (!nodeExecutable.electronHost || nodeExecutable.explicit) ? 'PASS' : 'BLOCKED',
    observedVersion: process.version,
    required: '>=22.19.0 absolute existing real node.exe; Electron must set NODE_REPL_VERIFY_NODE',
    executable: nodeExecutable,
  },
  koffiNativeAbi: {
    status: nativeAbi.status,
    observation: nativeAbi.observation,
    issues: nativeAbi.issues,
    nonClaims: nativeAbi.nonClaims,
    required: 'Exact isolated koffi@3.1.1 must load, bind the selected Win32 APIs, and match static x64 record layouts. This remains an ABI/loadability fact only.',
  },
  nativeCompiler: {
    status: compilerCandidates.some(candidate => candidate.found) ? 'OBSERVED' : 'NOT_INSTALLED',
    candidates: compilerCandidates,
    required: 'A local compiler is optional. The independent native header/handle-sentinel/Job audit may instead be compiled on the pinned GitHub Actions Windows runner and verified locally as a hash-checked artifact; dynamic Koffi binding alone does not replace that audit.',
  },
  ciNativeAuditReference: nativeAuditReference,
  verifierVolume: {
    status: 'OBSERVED',
    observation: verifierVolume,
    note: 'The verifier repository is never an ACL test root, so its volume type is diagnostic only.',
  },
  aclRoot: aclRootGate,
  ownedRestrictedTokenJobLauncher: {
    status: 'NOT_STARTED',
    required: 'Implement and test an owned restricted-token + Low + DACL lease, private fd 3 runner, target fd 4–6 carriers and fd 7, restricted Job ownership, and isJobEmpty()/range-settlement before grant revocation. Tier 00 intentionally imports neither Koffi nor DSH.',
  },
  restrictedEnvironmentAbi: {
    status: 'NOT_STARTED',
    required: 'Prove a non-null explicit environment block reaches the final CreateProcessAsUserW target before claiming frozen TMP/TEMP or a filtered environment.',
  },
  handleAllowlist: {
    status: 'NOT_STARTED',
    required: 'Prove a native OS-handle allowlist/sentinel absence; CRT descriptor slots alone are insufficient.',
  },
}

const blockingGates = Object.entries(gates)
  .filter(([name, gate]) => name !== 'nativeCompiler' && !['PASS', 'OBSERVED'].includes(gate.status))
  .map(([name, gate]) => ({ name, status: gate.status }))
const artifact = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  evidenceTier: 'native-preflight',
  suite: '10-native-abi-and-koffi-preflight',
  status: blockingGates.length === 0 ? 'PREFLIGHT_PASS' : 'UNSUPPORTED',
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
  blockingGates,
  gates,
  nonClaims: [
    'This preflight performs no ACL/token/Job operation and creates no persistent ACL side effect.',
    'A pass for host prerequisites would still not prove an owned restricted worker.',
    'A local compiler is not required when an exact CI-built native audit artifact is independently verified; that artifact remains a reference fact, not an owned launcher.',
    'A missing preflight gate leaves the Windows owned required path unsupported; it never permits raw-Node fallback.',
    ...nativeAbi.nonClaims,
  ],
}

await mkdir(artifactDirectory, { recursive: true })
await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ status: artifact.status, blockingGates, artifactPath }, null, 2)}\n`)
if (artifact.status !== 'PREFLIGHT_PASS' && !reportOnly) process.exitCode = 2
