import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export const ABI_EXPECTATIONS = Object.freeze({
  pointerSize: 8,
  startupInfoWSize: 104,
  processInformationSize: 24,
  securityAttributesSize: 24,
  jobObjectBasicAccountingInformationSize: 48,
})

function issue(code, message, observed = undefined) {
  return observed === undefined ? { code, message } : { code, message, observed }
}

function normalizeError(error) {
  return error instanceof Error ? error.message : String(error)
}

function loadKoffi() {
  try {
    const module = require('koffi')
    return module.default ?? module
  } catch (error) {
    return { loadError: normalizeError(error) }
  }
}

function bind(library, name, result, args) {
  return library.func('__stdcall', name, result, args)
}

let cachedTypes

function nativeTypes(koffi) {
  if (cachedTypes !== undefined) return cachedTypes
  const pointer = koffi.pointer('void')
  const pointerPointer = koffi.pointer(pointer)
  const startupInfoW = koffi.struct('NODE_REPL_STARTUPINFOW', {
    cb: 'uint32',
    lpReserved: 'char16 *',
    lpDesktop: 'char16 *',
    lpTitle: 'char16 *',
    dwX: 'uint32',
    dwY: 'uint32',
    dwXSize: 'uint32',
    dwYSize: 'uint32',
    dwXCountChars: 'uint32',
    dwYCountChars: 'uint32',
    dwFillAttribute: 'uint32',
    dwFlags: 'uint32',
    wShowWindow: 'uint16',
    cbReserved2: 'uint16',
    lpReserved2: koffi.pointer('uint8'),
    hStdInput: pointer,
    hStdOutput: pointer,
    hStdError: pointer,
  })
  const processInformation = koffi.struct('NODE_REPL_PROCESS_INFORMATION', {
    hProcess: pointer,
    hThread: pointer,
    dwProcessId: 'uint32',
    dwThreadId: 'uint32',
  })
  const securityAttributes = koffi.struct('NODE_REPL_SECURITY_ATTRIBUTES', {
    nLength: 'uint32',
    lpSecurityDescriptor: pointer,
    bInheritHandle: 'int',
  })
  const jobObjectBasicAccountingInformation = koffi.struct('NODE_REPL_JOBOBJECT_BASIC_ACCOUNTING_INFORMATION', {
    TotalUserTime: 'uint64',
    TotalKernelTime: 'uint64',
    ThisPeriodTotalUserTime: 'uint64',
    ThisPeriodTotalKernelTime: 'uint64',
    TotalPageFaultCount: 'uint32',
    TotalProcesses: 'uint32',
    ActiveProcesses: 'uint32',
    TotalTerminatedProcesses: 'uint32',
  })
  cachedTypes = {
    pointer,
    pointerPointer,
    startupInfoW,
    processInformation,
    securityAttributes,
    jobObjectBasicAccountingInformation,
  }
  return cachedTypes
}

/**
 * This proves only that exact Koffi can load selected Win32 exports and that its
 * x64 record layouts match static Windows ABI expectations. It does not create a
 * token, alter a DACL, launch a child, or establish handle inheritance policy.
 */
export function inspectNativeAbiPreflight() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    return {
      status: 'UNSUPPORTED',
      issues: [issue('PLATFORM_UNSUPPORTED', 'Native ABI preflight requires win32 x64.')],
      nonClaims: ['No native library was loaded for an unsupported platform.'],
    }
  }

  const koffi = loadKoffi()
  if ('loadError' in koffi) {
    return {
      status: 'BLOCKED',
      issues: [issue('KOFFI_LOAD_FAILED', 'The exact isolated koffi dependency could not be loaded.', koffi.loadError)],
      nonClaims: ['Koffi load failure leaves the owned Windows path unsupported.'],
    }
  }

  try {
  const issues = []
  const observation = {
    version: koffi.version,
    pointerSize: koffi.sizeof('void *'),
    libraries: {},
    exports: {},
    layouts: {},
  }

  if (koffi.version !== '3.1.1') {
    issues.push(issue('KOFFI_VERSION_MISMATCH', 'The verifier requires exact koffi@3.1.1.', koffi.version))
  }
  if (observation.pointerSize !== ABI_EXPECTATIONS.pointerSize) {
    issues.push(issue('POINTER_SIZE_MISMATCH', 'The owned x64 probe requires 8-byte pointers.', observation.pointerSize))
  }

  let kernel32
  let advapi32
  try {
    kernel32 = koffi.load('kernel32.dll')
    observation.libraries.kernel32 = 'loaded'
  } catch (error) {
    observation.libraries.kernel32 = `failed: ${normalizeError(error)}`
    issues.push(issue('KERNEL32_LOAD_FAILED', 'Could not load kernel32.dll.', normalizeError(error)))
  }
  try {
    advapi32 = koffi.load('advapi32.dll')
    observation.libraries.advapi32 = 'loaded'
  } catch (error) {
    observation.libraries.advapi32 = `failed: ${normalizeError(error)}`
    issues.push(issue('ADVAPI32_LOAD_FAILED', 'Could not load advapi32.dll.', normalizeError(error)))
  }

  const {
    pointer,
    pointerPointer,
    startupInfoW,
    processInformation,
    securityAttributes,
    jobObjectBasicAccountingInformation,
  } = nativeTypes(koffi)

  const layouts = {
    startupInfoW: koffi.sizeof(startupInfoW),
    processInformation: koffi.sizeof(processInformation),
    securityAttributes: koffi.sizeof(securityAttributes),
    jobObjectBasicAccountingInformation: koffi.sizeof(jobObjectBasicAccountingInformation),
  }
  observation.layouts = layouts
  for (const [name, expected] of Object.entries({
    startupInfoW: ABI_EXPECTATIONS.startupInfoWSize,
    processInformation: ABI_EXPECTATIONS.processInformationSize,
    securityAttributes: ABI_EXPECTATIONS.securityAttributesSize,
    jobObjectBasicAccountingInformation: ABI_EXPECTATIONS.jobObjectBasicAccountingInformationSize,
  })) {
    if (layouts[name] !== expected) {
      issues.push(issue('STRUCT_LAYOUT_MISMATCH', `${name} layout differs from the x64 ABI expectation.`, { expected, observed: layouts[name] }))
    }
  }

  const targetExports = [
    ['kernel32', kernel32, 'CreatePipe', 'int', [pointerPointer, pointerPointer, pointer, 'uint32']],
    ['kernel32', kernel32, 'SetHandleInformation', 'int', [pointer, 'uint32', 'uint32']],
    ['kernel32', kernel32, 'CreateJobObjectW', pointer, [pointer, 'char16 *']],
    ['kernel32', kernel32, 'AssignProcessToJobObject', 'int', [pointer, pointer]],
    ['kernel32', kernel32, 'QueryInformationJobObject', 'int', [pointer, 'int', pointer, 'uint32', pointer]],
    ['kernel32', kernel32, 'ResumeThread', 'uint32', [pointer]],
    ['kernel32', kernel32, 'CloseHandle', 'int', [pointer]],
    ['advapi32', advapi32, 'CreateRestrictedToken', 'int', [pointer, 'uint32', 'uint32', pointer, 'uint32', pointer, 'uint32', pointer, pointerPointer]],
    ['advapi32', advapi32, 'CreateProcessAsUserW', 'int', [pointer, 'char16 *', 'char16 *', pointer, pointer, 'int', 'uint32', pointer, 'char16 *', koffi.pointer(startupInfoW), koffi.pointer(processInformation)]],
  ]
  for (const [libraryName, library, name, result, args] of targetExports) {
    const key = `${libraryName}!${name}`
    if (library === undefined) {
      observation.exports[key] = 'not-attempted: library unavailable'
      continue
    }
    try {
      bind(library, name, result, args)
      observation.exports[key] = 'bound'
    } catch (error) {
      const message = normalizeError(error)
      observation.exports[key] = `failed: ${message}`
      issues.push(issue('WIN32_EXPORT_BIND_FAILED', `Could not bind ${key}.`, message))
    }
  }

  return {
    status: issues.length === 0 ? 'PASS' : 'BLOCKED',
    observation,
    issues,
    nonClaims: [
      'This is an ABI/loadability preflight only: no restricted token, ACL/DACL/Low label, Job, or child process was created.',
      'Binding CreateProcessAsUserW does not prove the explicit non-null environment reaches a final restricted target.',
      'Binding CreatePipe and SetHandleInformation does not prove a native OS handle allowlist or sentinel non-leak.',
      'No release or sandboxHost required eligibility follows from this result.',
    ],
  }
  } catch (error) {
    return {
      status: 'BLOCKED',
      issues: [issue('KOFFI_ABI_INSPECTION_FAILED', 'The exact Koffi native ABI inspection did not complete.', normalizeError(error))],
      nonClaims: [
        'A failed Koffi ABI inspection establishes no token, ACL/DACL/Low label, Job, child-process, environment, or handle-isolation fact.',
        'The owned Windows required path remains unsupported and must not fall back to raw Node.',
      ],
    }
  }
}
