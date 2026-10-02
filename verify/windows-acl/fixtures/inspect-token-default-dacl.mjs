import koffi from 'koffi'
import { spawnSync } from 'node:child_process'

const PVOID = koffi.pointer('void')
const PPVOID = koffi.pointer(PVOID)
const kernel32 = koffi.load('kernel32.dll')
const advapi32 = koffi.load('advapi32.dll')
const bind = (library, name, result, args) => library.func('__stdcall', name, result, args)

const getCurrentProcess = bind(kernel32, 'GetCurrentProcess', PVOID, [])
const closeHandle = bind(kernel32, 'CloseHandle', 'int', [PVOID])
const getLastError = bind(kernel32, 'GetLastError', 'uint32', [])
const openProcessToken = bind(advapi32, 'OpenProcessToken', 'int', [PVOID, 'uint32', PPVOID])
const getTokenInformation = bind(advapi32, 'GetTokenInformation', 'int', [PVOID, 'int', PVOID, 'uint32', PVOID])
const TOKEN_QUERY = 0x0008
const TokenRestrictedSids = 11
const TokenDefaultDacl = 6
const TokenIntegrityLevel = 25
const tokenSlot = koffi.alloc(PVOID, 1)
const neededSlot = koffi.alloc('uint32', 1)

function fail(api, code = getLastError()) {
  throw new Error(`${api} failed with Win32 ${code}`)
}

function readUint8(pointer, offset = 0) {
  return koffi.decode(pointer, offset, 'uint8')
}

function readUint16(pointer, offset = 0) {
  return koffi.decode(pointer, offset, 'uint16')
}

function readUint32(pointer, offset = 0) {
  return koffi.decode(pointer, offset, 'uint32')
}

function readPointer(pointer, offset = 0) {
  return koffi.decode(pointer, offset, PVOID)
}

function sidString(pointer, offset = 0) {
  const revision = readUint8(pointer, offset)
  const subAuthorityCount = readUint8(pointer, offset + 1)
  let authority = 0n
  for (let index = 0; index < 6; index++) authority = (authority << 8n) | BigInt(readUint8(pointer, offset + 2 + index))
  const parts = [`S-${revision}-${authority}`]
  for (let index = 0; index < subAuthorityCount; index++) parts.push(String(readUint32(pointer, offset + 8 + index * 4)))
  return parts.join('-')
}

function tokenInfo(token, infoClass) {
  koffi.encode(neededSlot, 'uint32', 0)
  getTokenInformation(token, infoClass, null, 0, neededSlot)
  const size = koffi.decode(neededSlot, 'uint32')
  if (size === 0) fail(`GetTokenInformation(${infoClass}) size query`)
  const buffer = Buffer.alloc(size)
  if (getTokenInformation(token, infoClass, buffer, size, neededSlot) === 0) fail(`GetTokenInformation(${infoClass})`)
  return buffer
}

function restrictedSids(token) {
  const info = tokenInfo(token, TokenRestrictedSids)
  const count = readUint32(info, 0)
  const groups = []
  for (let index = 0; index < count; index++) {
    const entry = 8 + index * 16
    const sid = readPointer(info, entry)
    groups.push({ index, sid: sidString(sid), attributes: `0x${readUint32(info, entry + 8).toString(16).padStart(8, '0')}` })
  }
  return groups
}

function sidOffsetForAce(aceType, ace) {
  const objectAceTypes = new Set([5, 6, 7, 8, 11, 12, 15, 16])
  if (!objectAceTypes.has(aceType)) return 8
  const objectFlags = readUint32(ace, 8)
  return 12 + ((objectFlags & 1) !== 0 ? 16 : 0) + ((objectFlags & 2) !== 0 ? 16 : 0)
}

function defaultDacl(token) {
  const info = tokenInfo(token, TokenDefaultDacl)
  const acl = readPointer(info, 0)
  if (acl === null) return { isNull: true, aceCount: null, aces: [] }
  const aceCount = readUint16(acl, 4)
  const aces = []
  for (let index = 0; index < aceCount; index++) {
    const aceSlot = koffi.alloc(PVOID, 1)
    try {
      if (bind(advapi32, 'GetAce', 'int', [PVOID, 'uint32', PPVOID])(acl, index, aceSlot) === 0) fail(`GetAce(${index})`)
      const ace = koffi.decode(aceSlot, PVOID)
      const type = readUint8(ace, 0)
      const flags = readUint8(ace, 1)
      const size = readUint16(ace, 2)
      const mask = readUint32(ace, 4)
      const sidOffset = sidOffsetForAce(type, ace)
      aces.push({
        index,
        type,
        flags: `0x${flags.toString(16).padStart(2, '0')}`,
        size,
        mask: `0x${mask.toString(16).padStart(8, '0')}`,
        sid: sidOffset + 8 <= size ? sidString(ace, sidOffset) : null,
      })
    } finally {
      koffi.free(aceSlot)
    }
  }
  return { isNull: false, aceCount, aces }
}

function integrity(token) {
  const info = tokenInfo(token, TokenIntegrityLevel)
  const sid = readPointer(info, 0)
  const revision = readUint8(sid, 0)
  const subAuthorityCount = readUint8(sid, 1)
  const rid = readUint32(sid, 8 + (subAuthorityCount - 1) * 4)
  return { sid: sidString(sid), rid, revision }
}

let token
try {
  if (openProcessToken(getCurrentProcess(), TOKEN_QUERY, tokenSlot) === 0) fail('OpenProcessToken')
  token = readPointer(tokenSlot)
  if (token === null) fail('OpenProcessToken returned NULL')
  const observedRestrictedSids = restrictedSids(token)
  const sidClasses = new Map([
    ['S-1-1-0', 'world'],
    ['S-1-5-18', 'local-system'],
    ...observedRestrictedSids.map((entry, index) => [entry.sid, ['logon-session', 'world', 'workspace-capability', 'temp-capability'][index] ?? 'restricted-sid']),
  ])
  const observedDefaultDacl = defaultDacl(token)
  const report = {
    marker: 'TOKEN_SNAPSHOT',
    nodeVersion: process.version,
    architecture: process.arch,
    restrictedSidCount: observedRestrictedSids.length,
    restrictedSids: observedRestrictedSids.map(({ index, sid, attributes }) => ({
      index,
      sidClass: sidClasses.get(sid) ?? 'unclassified-restricted-sid',
      attributes,
    })),
    integrity: integrity(token),
    defaultDacl: {
      ...observedDefaultDacl,
      aces: observedDefaultDacl.aces.map(({ sid, ...ace }) => ({
        ...ace,
        sidClass: sid === null ? null : sidClasses.get(sid) ?? 'ambient-other',
      })),
    },
    targetEnvironment: {
      tmpPresent: typeof process.env.TMP === 'string',
      tempPresent: typeof process.env.TEMP === 'string',
      tmpInRequestedTempRoot: typeof process.env.TMP === 'string' && typeof process.env.NODE_REPL_DSH_COMPARE_TEMP_ROOT === 'string'
        ? process.env.TMP.toLowerCase().startsWith(process.env.NODE_REPL_DSH_COMPARE_TEMP_ROOT.toLowerCase())
        : false,
      tempInRequestedTempRoot: typeof process.env.TEMP === 'string' && typeof process.env.NODE_REPL_DSH_COMPARE_TEMP_ROOT === 'string'
        ? process.env.TEMP.toLowerCase().startsWith(process.env.NODE_REPL_DSH_COMPARE_TEMP_ROOT.toLowerCase())
        : false,
    },
    grandchild: Object.fromEntries(['inherit', 'ignore', 'pipe'].map(stdio => {
      const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio, windowsHide: true })
      return [stdio, { status: child.status, signal: child.signal, errorCode: child.error?.code ?? null }]
    })),
  }
  process.stdout.write(`TOKEN_SNAPSHOT:${JSON.stringify(report)}\n`)
} catch (error) {
  process.stderr.write(`TOKEN_SNAPSHOT_ERROR:${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 70
} finally {
  if (token !== undefined && token !== null) closeHandle(token)
  koffi.free(tokenSlot)
  koffi.free(neededSlot)
}
