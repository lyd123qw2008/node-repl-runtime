import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifactInput = process.env.NODE_REPL_VERIFY_NATIVE_AUDIT_DIR
const expectedCommit = process.env.NODE_REPL_VERIFY_NATIVE_AUDIT_COMMIT?.toLowerCase()
const expectedExecutableSha256 = process.env.NODE_REPL_VERIFY_NATIVE_AUDIT_SHA256?.toLowerCase()
const requestedEvidenceRoot = process.env.NODE_REPL_VERIFY_OUT
const verifierRoot = fileURLToPath(new URL('../', import.meta.url))
const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID()}`
const artifactDirectory = requestedEvidenceRoot === undefined
  ? join(verifierRoot, 'spike', 'windows-acl', runId, '10-ci-native-audit-artifact')
  : join(resolve(requestedEvidenceRoot), '10-ci-native-audit-artifact')
const artifactPath = join(artifactDirectory, 'evidence.json')
const expectedNames = Object.freeze(['node-repl-win32-audit.exe', 'manifest.json', 'SHA256SUMS.txt'])
const expectedModes = Object.freeze(['abi', 'handle-sentinel', 'job-settlement'])
const maxExecutableBytes = 2 * 1024 * 1024

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message)
}

function outputDigest(result) {
  return sha256(Buffer.concat([
    Buffer.from(result.stdout ?? ''),
    Buffer.from(result.stderr ?? ''),
  ]))
}

function parseFinalJson(output, expectedMode) {
  const lines = `${output}`.split(/\r?\n/u).filter(line => line.trim() !== '')
  requireCondition(lines.length > 0, `${expectedMode} emitted no JSON output`)
  let parsed
  try {
    parsed = JSON.parse(lines.at(-1))
  } catch (error) {
    throw new Error(`${expectedMode} final output was not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  requireCondition(parsed.schemaVersion === 1, `${expectedMode} did not report schemaVersion 1`)
  requireCondition(parsed.tool === 'node-repl-win32-audit', `${expectedMode} did not identify the expected audit tool`)
  requireCondition(parsed.mode === expectedMode, `${expectedMode} reported a mismatched mode`)
  requireCondition(parsed.status === 'PASS', `${expectedMode} reported ${String(parsed.status)}`)
  return parsed
}

function runAudit(executable, mode) {
  const result = spawnSync(executable, [mode], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 64 * 1024,
    shell: false,
  })
  if (result.error !== undefined) {
    throw new Error(`${mode} could not launch: ${result.error.message}`)
  }
  if (result.status !== 0 || result.signal !== null) {
    throw new Error(`${mode} exited status=${String(result.status)} signal=${String(result.signal)} outputSha256=${outputDigest(result)}`)
  }
  parseFinalJson(result.stdout, mode)
  return { mode, outputSha256: outputDigest(result) }
}

function artifactFailure(message) {
  return {
    status: 'UNSUPPORTED',
    failure: { code: 'NATIVE_AUDIT_ARTIFACT_INVALID', message },
  }
}

let outcome
let artifact
try {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    outcome = {
      status: 'UNSUPPORTED',
      failure: { code: 'PLATFORM_UNSUPPORTED', message: 'The CI-built native audit artifact may only be verified on win32 x64.' },
    }
  } else if (artifactInput === undefined) {
    outcome = artifactFailure('Set NODE_REPL_VERIFY_NATIVE_AUDIT_DIR to the extracted GitHub Actions artifact directory.')
  } else if (expectedCommit === undefined) {
    outcome = artifactFailure('Set NODE_REPL_VERIFY_NATIVE_AUDIT_COMMIT to the exact full source commit that produced the artifact.')
  } else if (expectedExecutableSha256 === undefined) {
    outcome = artifactFailure('Set NODE_REPL_VERIFY_NATIVE_AUDIT_SHA256 to an independently recorded exact executable SHA-256.')
  } else {
    const inputDirectory = resolve(artifactInput)
    requireCondition(statSync(inputDirectory).isDirectory(), 'The artifact directory is not an existing directory.')
    const rootEntries = await readdir(inputDirectory, { withFileTypes: true })
    requireCondition(
      rootEntries.length === expectedNames.length && rootEntries.every(entry => entry.isFile() && expectedNames.includes(entry.name)),
      'The extracted artifact must contain exactly the three expected regular files and no nested entries.',
    )
    const paths = Object.fromEntries(expectedNames.map(name => [name, join(inputDirectory, name)]))
    for (const [name, path] of Object.entries(paths)) {
      requireCondition(statSync(path).isFile(), `Artifact member is missing or is not a file: ${name}`)
      requireCondition(basename(path) === name, `Artifact member basename is unexpected: ${name}`)
    }
    const executableStats = statSync(paths['node-repl-win32-audit.exe'])
    requireCondition(executableStats.size > 0 && executableStats.size <= maxExecutableBytes, `Artifact executable must be nonempty and no larger than ${maxExecutableBytes} bytes.`)

    const [manifestText, checksumText, executable] = await Promise.all([
      readFile(paths['manifest.json'], 'utf8'),
      readFile(paths['SHA256SUMS.txt'], 'utf8'),
      readFile(paths['node-repl-win32-audit.exe']),
    ])
    const manifest = JSON.parse(manifestText)
    requireCondition(manifest.schemaVersion === 1, 'Artifact manifest schemaVersion must be 1.')
    requireCondition(manifest.artifact === 'node-repl-win32-audit.exe', 'Artifact manifest names an unexpected executable.')
    requireCondition(typeof manifest.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(manifest.sha256), 'Artifact manifest SHA-256 is invalid.')
    requireCondition(typeof manifest.sourceCommit === 'string' && /^[a-f0-9]{40}$/u.test(manifest.sourceCommit), 'Artifact manifest source commit is invalid.')
    requireCondition(typeof manifest.workflowRef === 'string' && manifest.workflowRef.includes('.github/workflows/windows-acl-native-audit.yml'), 'Artifact manifest workflow ref is unexpected.')
    requireCondition(manifest.runner?.os === 'Windows' && manifest.runner?.architecture === 'X64', 'Artifact was not built by the expected Windows x64 runner.')
    requireCondition(typeof manifest.compiler?.version === 'string' && manifest.compiler.version.includes('Microsoft'), 'Artifact manifest does not identify the expected MSVC compiler.')
    requireCondition(/^\d+\.\d+\.\d+\.\d+$/u.test(manifest.compiler?.windowsSdkVersion ?? ''), 'Artifact manifest does not identify a numeric Windows SDK version.')
    requireCondition(Array.isArray(manifest.selfTestModes) && expectedModes.every(mode => manifest.selfTestModes.includes(mode)), 'Artifact manifest omits a required self-test mode.')
    requireCondition(/^[a-f0-9]{40}$/u.test(expectedCommit), 'NODE_REPL_VERIFY_NATIVE_AUDIT_COMMIT must be a full SHA-1 commit id.')
    requireCondition(manifest.sourceCommit === expectedCommit, 'Artifact source commit does not equal NODE_REPL_VERIFY_NATIVE_AUDIT_COMMIT.')
    requireCondition(/^[a-f0-9]{64}$/u.test(expectedExecutableSha256), 'NODE_REPL_VERIFY_NATIVE_AUDIT_SHA256 must be a full SHA-256 digest.')
    requireCondition(manifest.sha256 === expectedExecutableSha256, 'Artifact manifest SHA-256 does not equal NODE_REPL_VERIFY_NATIVE_AUDIT_SHA256.')

    const computedSha256 = sha256(executable)
    requireCondition(computedSha256 === expectedExecutableSha256, 'Artifact executable SHA-256 does not equal NODE_REPL_VERIFY_NATIVE_AUDIT_SHA256.')
    requireCondition(computedSha256 === manifest.sha256, 'Artifact executable SHA-256 does not match manifest.json.')
    requireCondition(
      checksumText.trim() === `${computedSha256} *node-repl-win32-audit.exe`,
      'SHA256SUMS.txt does not exactly match the artifact executable hash.',
    )

    const modes = expectedModes.map(mode => runAudit(paths['node-repl-win32-audit.exe'], mode))
    artifact = {
      sha256: computedSha256,
      sourceCommit: manifest.sourceCommit,
      workflowRef: manifest.workflowRef,
      runner: manifest.runner,
      compiler: manifest.compiler,
      modes,
    }
    outcome = { status: 'NATIVE_AUDIT_PASS' }
  }
} catch (error) {
  outcome = artifactFailure(error instanceof Error ? error.message : String(error))
}

const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  evidenceTier: 'native-audit-artifact-reference',
  suite: '10-ci-native-audit-artifact',
  status: outcome.status,
  ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
  confinement: 'none',
  enforcement: 'none',
  restrictedToken: false,
  jobOwnership: false,
  daclGrant: false,
  osHandleAllowlistProven: false,
  releaseEligible: false,
  ...(artifact === undefined ? {} : { artifact }),
  nonClaims: [
    'This artifact is an independent native ABI/handle-list/Job-accounting oracle, not an owned restricted-token launcher.',
    'The handle-sentinel test proves only the helper invocation path; it does not prove a future Node target received the same OS handle allowlist.',
    'The Job test proves only one direct child reached zero active processes in the helper Job; it does not prove a final worker tree exited before ACL grant revocation.',
    'No artifact result creates a DACL/Low/token lease or enables sandboxHost required.',
  ],
}

await mkdir(artifactDirectory, { recursive: true })
await writeFile(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ status: evidence.status, artifactPath, ...(artifact === undefined ? {} : { sha256: artifact.sha256, sourceCommit: artifact.sourceCommit }) }, null, 2)}\n`)
if (evidence.status !== 'NATIVE_AUDIT_PASS') process.exitCode = 2
