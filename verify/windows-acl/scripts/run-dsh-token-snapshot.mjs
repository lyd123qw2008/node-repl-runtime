import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_DSH_REVISION = 'f9d6609d182969c9f57499ef552edb78835cc4e4'
const DSH_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'packages/sandbox/sandbox-windows-acl/src/token.ts',
  'packages/sandbox/sandbox-windows-acl/src/acl.ts',
  'packages/sandbox/sandbox-windows-acl/src/index.ts',
  'packages/sandbox/sandbox-windows-acl/src/runner.ts',
  'packages/sandbox/sandbox-windows-acl/src/spawn.ts',
  'packages/sandbox/sandbox-windows-acl/tests/runner.spec.ts',
  'packages/sandbox/sandbox-windows-acl/tests/control.spec.ts',
  'packages/subprocess/win32-process/src/process.ts',
  'packages/subprocess/win32-process/src/control-stdio.ts',
  'packages/subprocess/subprocess-local/src/runner-protocol.ts',
  'packages/subprocess/subprocess-local/src/spawn-runner.ts',
  'packages/subprocess/subprocess-local/src/runner-launch.ts',
  'packages/shell/tool-pwsh/src/index.ts',
]
const verifierRoot = fileURLToPath(new URL('../', import.meta.url))
const dshRootInput = process.env.NODE_REPL_VERIFY_DSH_ROOT
const requestedEvidenceRoot = process.env.NODE_REPL_VERIFY_OUT
const requestedMode = process.env.NODE_REPL_VERIFY_DSH_MODE
const evidenceDirectory = requestedEvidenceRoot === undefined
  ? join(verifierRoot, 'spike', 'windows-acl', '10-dsh-token-snapshot')
  : join(resolve(requestedEvidenceRoot), '10-dsh-token-snapshot')
const modes = requestedMode === undefined ? ['read-only', 'workspace-write'] : [requestedMode]
const runnerPath = join(dshRootInput ?? '', 'packages', 'sandbox', 'sandbox-windows-acl', 'src', 'runner.ts')
const tokenInspector = join(verifierRoot, 'fixtures', 'inspect-token-default-dacl.mjs')

function run(command, args, cwd, env = process.env) {
  return spawnSync(command, args, { cwd, env, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 })
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex')
}

function exitStatus(status) {
  if (status === null) return { exitCodeUnsigned: null, exitCodeHex: null }
  const unsigned = status >>> 0
  return { exitCodeUnsigned: unsigned, exitCodeHex: `0x${unsigned.toString(16).padStart(8, '0')}` }
}

function failure(code, message, detail = undefined) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    evidenceTier: 'dsh-source-token-snapshot-reference-only',
    suite: '10-dsh-token-snapshot',
    status: 'UNSUPPORTED',
    confinement: 'none',
    enforcement: 'none',
    restrictedToken: false,
    jobOwnership: false,
    daclGrant: false,
    osHandleAllowlistProven: false,
    releaseEligible: false,
    nonClaims: ['A missing or mismatched pinned DSH source reference proves no owned-worker or release support.'],
    failure: { code, message, ...(detail === undefined ? {} : { detail }) },
  }
}

function parseSnapshot(stdout) {
  const line = `${stdout ?? ''}`.split(/\r?\n/u).find(entry => entry.startsWith('TOKEN_SNAPSHOT:'))
  if (line === undefined) throw new Error('final restricted Node did not emit a token snapshot')
  return JSON.parse(line.slice('TOKEN_SNAPSHOT:'.length))
}

function validateDshSnapshot(mode, snapshot) {
  const expectedRestricted = mode === 'read-only'
    ? ['logon-session', 'world']
    : ['logon-session', 'world', 'workspace-capability', 'temp-capability']
  const ace = snapshot.defaultDacl.aces[0]
  const allAccess = '0x001f01ff'
  const expectedDefaultSid = mode === 'read-only' ? 'world' : 'temp-capability'
  const childPipe = snapshot.grandchild.pipe
  const checks = {
    restrictedSidOrder: snapshot.restrictedSids.map(entry => entry.sidClass).join(',') === expectedRestricted.join(','),
    lowIntegrity: snapshot.integrity.rid === 4096,
    defaultDaclFirstGrant: ace?.type === 0 && ace.flags === '0x03' && ace.mask === allAccess && ace.sidClass === expectedDefaultSid,
    noWorkspaceWriteWorldDefaultAce: mode !== 'workspace-write' || !snapshot.defaultDacl.aces.some(entry => entry.sidClass === 'world' && entry.mask === allAccess),
    tempEnvironmentMatchesMode: mode === 'workspace-write'
      ? snapshot.targetEnvironment.tmpInRequestedTempRoot && snapshot.targetEnvironment.tempInRequestedTempRoot
      : !snapshot.targetEnvironment.tmpInRequestedTempRoot && !snapshot.targetEnvironment.tempInRequestedTempRoot,
    inheritedAndIgnoredChildrenSettle: snapshot.grandchild.inherit.status === 0 && snapshot.grandchild.ignore.status === 0,
    pipedGrandchildDiagnostic: childPipe.status === null && childPipe.errorCode === 'EPERM',
  }
  const gateChecks = Object.entries(checks).filter(([name]) => name !== 'pipedGrandchildDiagnostic')
  return { checks, pass: gateChecks.every(([, value]) => value) }
}

function normalizeTokenSnapshot(snapshot, expectedTempRoot) {
  const env = snapshot.targetEnvironment
  return {
    nodeVersion: snapshot.nodeVersion,
    architecture: snapshot.architecture,
    restrictedSidCount: snapshot.restrictedSidCount,
    restrictedSids: snapshot.restrictedSids,
    integrity: snapshot.integrity,
    defaultDacl: snapshot.defaultDacl,
    environmentFacts: {
      tmpPresent: env.tmpPresent,
      tempPresent: env.tempPresent,
      tmpInRequestedTempRoot: env.tmpInRequestedTempRoot,
      tempInRequestedTempRoot: env.tempInRequestedTempRoot,
    },
    grandchild: snapshot.grandchild,
    expectedTempRootPresent: expectedTempRoot !== undefined,
  }
}

let artifact
if (process.platform !== 'win32' || process.arch !== 'x64') {
  artifact = failure('UNSUPPORTED_PLATFORM', 'DSH token snapshot requires Windows x64.')
} else if (dshRootInput === undefined) {
  artifact = failure('DSH_ROOT_REQUIRED', 'Set NODE_REPL_VERIFY_DSH_ROOT to the pinned DSH source checkout.')
} else if (!isAbsolute(dshRootInput)) {
  artifact = failure('DSH_ROOT_REQUIRED', 'NODE_REPL_VERIFY_DSH_ROOT must be an absolute Windows path.')
} else if (modes.length === 0 || modes.some(mode => mode !== 'read-only' && mode !== 'workspace-write')) {
  artifact = failure('DSH_MODE_INVALID', 'NODE_REPL_VERIFY_DSH_MODE must be read-only or workspace-write.')
} else {
  const dshRoot = resolve(dshRootInput)
  const revisionResult = run('git.exe', ['rev-parse', 'HEAD'], dshRoot)
  const revision = `${revisionResult.stdout ?? ''}`.trim()
  const fileStatus = run('git.exe', ['status', '--porcelain', '--', ...DSH_FILES], dshRoot)
  const dirtyDshFiles = `${fileStatus.stdout ?? ''}`.trim()
  if (revisionResult.status !== 0 || revision !== EXPECTED_DSH_REVISION) {
    artifact = failure('SOURCE_REVISION_MISMATCH', `Expected DSH revision ${EXPECTED_DSH_REVISION}; observed ${revision || 'unavailable'}.`)
  } else if (fileStatus.status !== 0 || dirtyDshFiles !== '') {
    artifact = failure('DSH_SOURCE_FILES_DIRTY', 'The DSH ACL/token/runner source files used for comparison must be clean.', dirtyDshFiles)
  } else {
    const sourceHashes = Object.fromEntries(DSH_FILES.map(path => [path, sha256(join(dshRoot, path))]))
    const root = mkdtempSync(join(tmpdir(), 'node-repl-dsh-token-compare-'))
    const observations = []
    try {
      for (const mode of modes) {
        const workspace = join(root, `${mode}-workspace`)
        const tempRoot = join(root, `${mode}-temp-root`)
        mkdirSync(workspace)
        mkdirSync(tempRoot)
        const env = { ...process.env, NODE_REPL_DSH_COMPARE_TEMP_ROOT: tempRoot }
        const invocation = run(process.execPath, [
          '--import', 'tsx/esm', runnerPath,
          '--workspace', workspace,
          '--temp', tempRoot,
          '--mode', mode,
          '--', process.execPath, tokenInspector,
        ], dshRoot, env)
        let snapshot
        try {
          snapshot = parseSnapshot(invocation.stdout)
        } catch (error) {
          observations.push({
            mode,
            status: 'FAIL',
            exitCode: invocation.status,
            ...exitStatus(invocation.status),
            spawnErrorCode: invocation.error?.code,
            signal: invocation.signal ?? null,
            stdoutSha256: sha256Text(`${invocation.stdout ?? ''}`),
            stderrSha256: sha256Text(`${invocation.stderr ?? ''}`),
            failure: error instanceof Error ? error.message : String(error),
          })
          continue
        }
        const snapshotJson = normalizeTokenSnapshot(snapshot, tempRoot)
        const validation = validateDshSnapshot(mode, snapshot)
        observations.push({
          mode,
          status: invocation.status === 0 && validation.pass ? 'PASS' : 'FAIL',
          exitCode: invocation.status,
          ...exitStatus(invocation.status),
          signal: invocation.signal ?? null,
          snapshot: snapshotJson,
          validation,
          stderrSha256: sha256Text(`${invocation.stderr ?? ''}`),
        })
      }
      const passed = observations.length === modes.length && observations.every(observation => observation.status === 'PASS')
      artifact = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        evidenceTier: 'dsh-source-token-snapshot-reference-only',
        suite: '10-dsh-token-default-dacl-comparison',
        status: passed ? 'REFERENCE_PASS' : 'UNSUPPORTED',
        confinement: 'none',
        enforcement: 'none',
        releaseEligible: false,
        source: {
          revision,
          files: sourceHashes,
        },
        host: { nodeVersion: process.version, architecture: process.arch },
        observations,
        comparisonLimitations: [
          `This DSH target ran under Node ${process.version}. The one-shot A1-A5 workflow invokes DSH and direct-worker cases on the same Windows runner and Node version; separately collected runs are not same-host parity evidence.`,
          'The DSH source snapshot checks the actual final token SIDs and TokenDefaultDacl trustee classes, masks, ACE order, and inheritance flags. The one-shot direct cases also query their actual final token; compare functional trustee classes, not machine-specific account/capability SID values.',
          'DSH target startup mutates the runner TMP/TEMP then uses CreateProcessAsUserW with lpEnvironment=NULL; the direct-worker control cases explicitly select either the existing environment block or a DSH-style inherited block. The other launch-topology differences remain visible and are not attributed to a single cause.',
          'No DSH source or runtime package is imported by node-repl-runtime production code; this script invokes only the pinned source runner as an external reference.',
          'Only the root package/workspace/lock manifests and enumerated ACL/token/runner/test files are required clean and hashed; unrelated paths outside that set are not used as evidence.',
          'This comparison does not accept formal Tier 20 or Phase 0 and does not authorize migrating the World-ACE workaround.',
        ],
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

await mkdir(evidenceDirectory, { recursive: true })
await writeFile(join(evidenceDirectory, 'evidence.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({
  status: artifact.status,
  evidencePath: join(evidenceDirectory, 'evidence.json'),
  observations: artifact.observations?.map(({ mode, status, snapshot }) => ({ mode, status, snapshot })),
  failure: artifact.failure,
}, null, 2)}\n`)
if (artifact.status !== 'REFERENCE_PASS') process.exitCode = 2
