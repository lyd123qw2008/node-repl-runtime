import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_DSH_REVISION = 'f9d6609d182969c9f57499ef552edb78835cc4e4'
const DSH_REFERENCE_TEST = 'packages/sandbox/sandbox-windows-acl/tests/control.spec.ts'
const verifierRoot = fileURLToPath(new URL('../', import.meta.url))
const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID()}`
const requestedEvidenceRoot = process.env.NODE_REPL_VERIFY_OUT
const artifactDirectory = requestedEvidenceRoot === undefined
  ? join(verifierRoot, 'spike', 'windows-acl', runId, '10-dsh-source-baseline')
  : join(resolve(requestedEvidenceRoot), '10-dsh-source-baseline')
const artifactPath = join(artifactDirectory, 'evidence.json')

function run(command, args, cwd) {
  const options = {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    // Never serialize environment values into evidence.  DSH owns its own
    // reference test environment; this script does not claim it is an owned,
    // filtered target environment.
    env: process.env,
  }
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command)) {
    // Node cannot execute a .cmd directly (EINVAL).  Ask cmd.exe to invoke it
    // through `call`, while passing command and fixed test arguments as
    // separate spawn arguments; do not use `shell: true` or concatenate a
    // caller-controlled command string.
    return spawnSync(process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe', ['/d', '/s', '/c', 'call', command, ...args], options)
  }
  return spawnSync(command, args, options)
}

function text(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function commandOnPath(command) {
  const where = spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true })
  if (where.status !== 0) return undefined
  return `${where.stdout ?? ''}`.split(/\r?\n/u).find(line => line.trim() !== '')
}

function validatesPnpmCommand(candidate) {
  if (candidate === undefined || !isAbsolute(candidate)) return false
  const normalized = candidate.toLowerCase()
  if (!normalized.endsWith('pnpm.cmd') && !normalized.endsWith('pnpm.exe')) return false
  try {
    return existsSync(candidate) && statSync(candidate).isFile()
  } catch {
    return false
  }
}

function recordFailure(code, message, detail) {
  return {
    status: 'UNSUPPORTED',
    failure: { code, message, ...(detail === undefined ? {} : { detail }) },
  }
}

const dshRootInput = process.env.NODE_REPL_VERIFY_DSH_ROOT
let outcome
let observedRevision
let dshStatusBefore
let dshStatusAfter
let command
let commandResult

if (process.platform !== 'win32') {
  outcome = recordFailure('UNSUPPORTED_PLATFORM', 'The DSH Windows ACL source baseline is Windows-only.')
} else if (dshRootInput === undefined || !isAbsolute(dshRootInput)) {
  outcome = recordFailure('DSH_ROOT_REQUIRED', 'Set NODE_REPL_VERIFY_DSH_ROOT to an absolute, clean DSH checkout path.')
} else {
  const dshRoot = resolve(dshRootInput)
  const revisionResult = run('git.exe', ['rev-parse', 'HEAD'], dshRoot)
  const statusBeforeResult = run('git.exe', ['status', '--porcelain'], dshRoot)
  observedRevision = `${revisionResult.stdout ?? ''}`.trim()
  dshStatusBefore = `${statusBeforeResult.stdout ?? ''}`.trim()
  if (revisionResult.status !== 0) {
    outcome = recordFailure('INVALID_DSH_ROOT', 'The supplied DSH root is not a readable Git checkout.', digest(text(revisionResult)))
  } else if (dshStatusBefore !== '') {
    outcome = recordFailure('DIRTY_DSH_CHECKOUT', 'The reference checkout must be clean; do not run this baseline against uncommitted DSH work.', digest(dshStatusBefore))
  } else if (observedRevision !== EXPECTED_DSH_REVISION) {
    outcome = recordFailure('SOURCE_REVISION_MISMATCH', `Expected pinned DSH revision ${EXPECTED_DSH_REVISION}, got ${observedRevision}.`)
  } else {
    const explicitPnpm = process.env.NODE_REPL_VERIFY_DSH_PNPM
    const pnpm = explicitPnpm ?? commandOnPath('pnpm.cmd') ?? commandOnPath('pnpm')
    if (!validatesPnpmCommand(pnpm)) {
      outcome = recordFailure('PNPM_UNAVAILABLE', 'Set NODE_REPL_VERIFY_DSH_PNPM to an absolute pnpm.cmd or pnpm.exe path for the reference checkout.')
    } else {
      command = { executable: pnpm, args: ['exec', 'vitest', 'run', DSH_REFERENCE_TEST], cwd: dshRoot }
      commandResult = run(command.executable, command.args, command.cwd)
      const statusAfterResult = run('git.exe', ['status', '--porcelain'], dshRoot)
      dshStatusAfter = `${statusAfterResult.stdout ?? ''}`.trim()
      if (statusAfterResult.status !== 0) {
        outcome = recordFailure('DSH_STATUS_UNAVAILABLE', 'Could not verify the DSH checkout after the reference test.', digest(text(statusAfterResult)))
      } else if (dshStatusAfter !== '') {
        outcome = recordFailure('DSH_CHECKOUT_CHANGED', 'The reference test changed the DSH checkout; inspect and recover it before trusting this baseline.', digest(dshStatusAfter))
      } else if (commandResult.status !== 0 || commandResult.error !== undefined) {
        outcome = recordFailure('REFERENCE_TEST_FAILED', 'The pinned DSH Windows ACL control reference test did not pass.', {
          exitCode: commandResult.status,
          signal: commandResult.signal,
          ...(commandResult.error === undefined ? {} : { spawnErrorCode: commandResult.error.code, spawnError: commandResult.error.message }),
          outputSha256: digest(text(commandResult)),
        })
      } else {
        outcome = { status: 'REFERENCE_PASS' }
      }
    }
  }
}

const artifact = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  evidenceTier: 'dsh-source-reference-only',
  suite: '10-dsh-source-baseline',
  ...outcome,
  confinement: 'none',
  enforcement: 'none',
  restrictedToken: false,
  jobOwnership: false,
  daclGrant: false,
  osHandleAllowlistProven: false,
  releaseEligible: false,
  expectedDshRevision: EXPECTED_DSH_REVISION,
  ...(observedRevision === undefined ? {} : { observedDshRevision: observedRevision }),
  ...(dshStatusBefore === undefined ? {} : { dshCheckoutCleanBefore: dshStatusBefore === '' }),
  ...(dshStatusAfter === undefined ? {} : { dshCheckoutCleanAfter: dshStatusAfter === '' }),
  ...(command === undefined ? {} : {
    command: {
      executableBasename: basename(command.executable),
      args: command.args,
      cwdBasename: basename(command.cwd),
    },
  }),
  ...(commandResult === undefined ? {} : {
    commandResult: {
      exitCode: commandResult.status,
      signal: commandResult.signal,
      outputSha256: digest(text(commandResult)),
    },
  }),
  referenceTestContract: [
    'This is an external DSH source oracle, not a node-repl-runtime implementation or dependency.',
    'At the pinned revision, the invoked DSH test exercises a nested current-token runner and ACL argv runner chain that reaches a final restricted Node payload with captured stdout/stderr and an inherited fd 7 control channel.',
    'The test checks marker consumption, a final-target denied write, ordinary output capture, and a 262144-byte binary fd 7 echo.',
  ],
  nonClaims: [
    'No own direct final-worker process or Job ownership was created or proven.',
    'No own closed/frozen per-lease final-target environment was created or proven.',
    'No explicit CreateProcessAsUserW environment block was proven.',
    'No native OS handle inheritance allowlist or sentinel-handle absence was proven.',
    'No final restricted-target Job quiescence/treeExited proof precedes grant revocation.',
    'This reference-only result cannot enable sandboxHost: required or substitute for Tier 20 owned evidence.',
  ],
}

await mkdir(artifactDirectory, { recursive: true })
await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ status: artifact.status, evidenceTier: artifact.evidenceTier, releaseEligible: artifact.releaseEligible, artifactPath }, null, 2)}\n`)
if (artifact.status !== 'REFERENCE_PASS') process.exitCode = 2
