// SPDX-License-Identifier: MIT
//
// Non-production Tier 20 Windows owned-worker feasibility probe.
// This helper is an evidence fixture only. It is not linked into the runtime.
// It creates a restricted primary token, applies an explicit DACL/Low label,
// passes a real Node target an explicit Unicode environment and CRT fd 3-7
// table, assigns the target to an owned Job, and revokes temporary grants only
// after bounded Job quiescence.

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <jobapi2.h>
#include <processthreadsapi.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <cwchar>
#include <cstdio>
#include <initializer_list>
#include <limits>
#include <sstream>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#pragma comment(lib, "advapi32.lib")

static_assert(sizeof(void*) == 8, "Tier 20 Windows probe is x64-only.");
static_assert(sizeof(STARTUPINFOW) == 104, "Unexpected STARTUPINFOW layout.");
static_assert(sizeof(PROCESS_INFORMATION) == 24, "Unexpected PROCESS_INFORMATION layout.");
static_assert(sizeof(SECURITY_ATTRIBUTES) == 24, "Unexpected SECURITY_ATTRIBUTES layout.");

namespace {

constexpr wchar_t kToolName[] = L"node-repl-win32-owned-worker";
constexpr DWORD kReadyTimeoutMs = 15'000;
constexpr DWORD kExitTimeoutMs = 15'000;
constexpr DWORD kJobSettlementTimeoutMs = 3'000;
constexpr DWORD kJobSettlementPollMs = 10;
constexpr size_t kOutputLimitBytes = 64 * 1024;
constexpr unsigned char kFopen = 0x01;
constexpr unsigned char kFpipe = 0x08;

class ScopedHandle {
 public:
  explicit ScopedHandle(HANDLE handle = nullptr) : handle_(handle) {}
  ~ScopedHandle() { reset(); }
  ScopedHandle(const ScopedHandle&) = delete;
  ScopedHandle& operator=(const ScopedHandle&) = delete;
  ScopedHandle(ScopedHandle&& other) noexcept : handle_(other.release()) {}
  ScopedHandle& operator=(ScopedHandle&& other) noexcept {
    if (this != &other) reset(other.release());
    return *this;
  }

  HANDLE get() const { return handle_; }
  bool valid() const { return handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE; }
  HANDLE release() {
    HANDLE result = handle_;
    handle_ = nullptr;
    return result;
  }
  void reset(HANDLE replacement = nullptr) {
    if (valid()) CloseHandle(handle_);
    handle_ = replacement;
  }

 private:
  HANDLE handle_ = nullptr;
};

class LocalAcl {
 public:
  LocalAcl() = default;
  ~LocalAcl() {
    if (acl_ != nullptr) LocalFree(acl_);
  }
  LocalAcl(const LocalAcl&) = delete;
  LocalAcl& operator=(const LocalAcl&) = delete;
  PACL* out() { return &acl_; }
  PACL get() const { return acl_; }

 private:
  PACL acl_ = nullptr;
};

class SidBuffer {
 public:
  bool initialize(WELL_KNOWN_SID_TYPE type, DWORD* error) {
    DWORD bytes = 0;
    if (CreateWellKnownSid(type, nullptr, nullptr, &bytes) != FALSE ||
        GetLastError() != ERROR_INSUFFICIENT_BUFFER || bytes == 0) {
      *error = GetLastError();
      return false;
    }
    bytes_.resize(bytes);
    if (CreateWellKnownSid(type, nullptr, bytes_.data(), &bytes) == FALSE) {
      *error = GetLastError();
      bytes_.clear();
      return false;
    }
    return true;
  }
  PSID get() const { return const_cast<BYTE*>(bytes_.data()); }
  DWORD length() const { return bytes_.empty() ? 0 : GetLengthSid(get()); }
  bool valid() const { return !bytes_.empty() && IsValidSid(get()) != FALSE; }

  bool copyFrom(PSID source, DWORD* error) {
    if (source == nullptr || IsValidSid(source) == FALSE) {
      *error = ERROR_INVALID_SID;
      return false;
    }
    const DWORD bytes = GetLengthSid(source);
    if (bytes == 0) {
      *error = GetLastError();
      return false;
    }
    bytes_.resize(bytes);
    if (CopySid(bytes, get(), source) == FALSE) {
      *error = GetLastError();
      bytes_.clear();
      return false;
    }
    return true;
  }

  bool initializeCustom(std::initializer_list<DWORD> subAuthorities, DWORD* error) {
    if (subAuthorities.size() == 0 || subAuthorities.size() > SID_MAX_SUB_AUTHORITIES) {
      *error = ERROR_INVALID_PARAMETER;
      return false;
    }
    SID_IDENTIFIER_AUTHORITY authority = {{0, 0, 0, 0, 0, 4}};
    bytes_.resize(GetSidLengthRequired(static_cast<BYTE>(subAuthorities.size())));
    if (InitializeSid(get(), &authority, static_cast<BYTE>(subAuthorities.size())) == FALSE) {
      *error = GetLastError();
      bytes_.clear();
      return false;
    }
    DWORD index = 0;
    for (DWORD value : subAuthorities) {
      *GetSidSubAuthority(get(), index++) = value & 0x3fffffff;
    }
    return true;
  }

 private:
  std::vector<BYTE> bytes_;
};

struct Options {
  std::wstring mode;
  std::wstring node;
  std::wstring worker;
  std::wstring workspace;
  std::wstring privateTemp;
};

struct ProbeResult {
  bool pass = false;
  bool tokenRestricted = false;
  bool tokenLow = false;
  bool daclApplied = false;
  bool lowLabelApplied = false;
  bool defaultDaclGrant = false;
  bool defaultDaclWorldGrant = false;
  bool explicitEnvironmentBlock = false;
  bool handleAllowlist = false;
  bool crtDescriptorTable = false;
  bool fd3RoundTrip = false;
  bool carrierReads = false;
  bool jobCreated = false;
  bool targetProcessCreated = false;
  bool targetProcessExited = false;
  bool targetAssignedToJob = false;
  bool targetResumed = false;
  bool jobSettled = false;
  bool grantsRevokedAfterQuiescence = false;
  bool cleanup = false;
  bool targetReady = false;
  bool targetReportPass = false;
  bool targetExitSuccess = false;
  DWORD error = ERROR_SUCCESS;
  std::string phase;
  std::string targetReadyLine;
  std::string childStdout;
  std::string childStderr;
  DWORD targetExitCode = STILL_ACTIVE;
};

std::string jsonBool(bool value) { return value ? "true" : "false"; }

std::string jsonEscape(const std::string& value) {
  std::string result;
  result.reserve(value.size() + 8);
  for (unsigned char ch : value) {
    switch (ch) {
      case '\\': result += "\\\\"; break;
      case '"': result += "\\\""; break;
      case '\n': result += "\\n"; break;
      case '\r': result += "\\r"; break;
      case '\t': result += "\\t"; break;
      default:
        if (ch < 0x20) {
          char buffer[7]{};
          std::snprintf(buffer, sizeof(buffer), "\\u%04x", static_cast<unsigned int>(ch));
          result += buffer;
        } else {
          result.push_back(static_cast<char>(ch));
        }
    }
  }
  return result;
}

std::string narrow(const std::wstring& value) {
  if (value.empty()) return {};
  int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (bytes <= 0) return {};
  std::string result(static_cast<size_t>(bytes), '\0');
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), bytes, nullptr, nullptr);
  return result;
}

bool equalInsensitive(const std::wstring& left, const std::wstring& right) {
  if (left.size() != right.size()) return false;
  return CompareStringOrdinal(left.data(), static_cast<int>(left.size()), right.data(), static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}

bool pathUnder(const std::wstring& ancestor, const std::wstring& candidate) {
  std::wstring a = ancestor;
  std::wstring c = candidate;
  while (!a.empty() && (a.back() == L'\\' || a.back() == L'/')) a.pop_back();
  while (!c.empty() && (c.back() == L'\\' || c.back() == L'/')) c.pop_back();
  if (c.size() <= a.size()) return equalInsensitive(a, c);
  return CompareStringOrdinal(c.data(), static_cast<int>(a.size()), a.data(), static_cast<int>(a.size()), TRUE) == CSTR_EQUAL &&
      (c[a.size()] == L'\\' || c[a.size()] == L'/');
}

bool disjointPaths(const std::wstring& left, const std::wstring& right) {
  return !pathUnder(left, right) && !pathUnder(right, left);
}

std::wstring joinPath(const std::wstring& left, const std::wstring& right) {
  if (left.empty()) return right;
  if (left.back() == L'\\' || left.back() == L'/') return left + right;
  return left + L"\\" + right;
}

bool existingDirectory(const std::wstring& path, DWORD* error) {
  DWORD attributes = GetFileAttributesW(path.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES) {
    *error = GetLastError();
    return false;
  }
  if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    *error = ERROR_INVALID_NAME;
    return false;
  }
  return true;
}

bool enablePrivilege(const wchar_t* name, DWORD* error) {
  HANDLE rawToken = nullptr;
  if (OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &rawToken) == FALSE) {
    *error = GetLastError();
    return false;
  }
  ScopedHandle processToken(rawToken);
  LUID luid{};
  if (LookupPrivilegeValueW(nullptr, name, &luid) == FALSE) {
    *error = GetLastError();
    return false;
  }
  TOKEN_PRIVILEGES privileges{};
  privileges.PrivilegeCount = 1;
  privileges.Privileges[0].Luid = luid;
  privileges.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
  SetLastError(ERROR_SUCCESS);
  if (AdjustTokenPrivileges(processToken.get(), FALSE, &privileges, sizeof(privileges), nullptr, nullptr) == FALSE) {
    *error = GetLastError();
    return false;
  }
  *error = GetLastError();
  return *error == ERROR_SUCCESS;
}

bool initializeSid(SidBuffer* sid, WELL_KNOWN_SID_TYPE type, DWORD* error) {
  return sid->initialize(type, error);
}

bool findLogonSid(HANDLE token, SidBuffer* sid, DWORD* error) {
  DWORD bytes = 0;
  GetTokenInformation(token, TokenGroups, nullptr, 0, &bytes);
  if (bytes == 0) {
    *error = GetLastError();
    return false;
  }
  std::vector<BYTE> groups(bytes);
  if (GetTokenInformation(token, TokenGroups, groups.data(), bytes, &bytes) == FALSE) {
    *error = GetLastError();
    return false;
  }
  auto* tokenGroups = reinterpret_cast<PTOKEN_GROUPS>(groups.data());
  for (DWORD index = 0; index < tokenGroups->GroupCount; ++index) {
    const auto& group = tokenGroups->Groups[index];
    if ((group.Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID) {
      return sid->copyFrom(group.Sid, error);
    }
  }
  *error = ERROR_NOT_FOUND;
  return false;
}

void setExplicitAccess(EXPLICIT_ACCESSW* access, PSID sid, DWORD permissions, ACCESS_MODE mode, DWORD inheritance) {
  ZeroMemory(access, sizeof(*access));
  access->grfAccessPermissions = permissions;
  access->grfAccessMode = mode;
  access->grfInheritance = inheritance;
  access->Trustee.TrusteeForm = TRUSTEE_IS_SID;
  access->Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
  access->Trustee.ptstrName = reinterpret_cast<LPWSTR>(sid);
}

bool applyOwnedAcl(const std::wstring& path, const std::wstring& mode, PSID administratorSid, PSID worldSid, PSID logonSid, PSID authenticatedSid, PSID capabilitySid, PSID lowSid, DWORD* error) {
  constexpr DWORD inherited = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
  std::array<EXPLICIT_ACCESSW, 5> entries{};
  size_t count = 0;
  setExplicitAccess(&entries[count++], administratorSid, GENERIC_ALL, SET_ACCESS, inherited);
  setExplicitAccess(&entries[count++], worldSid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, SET_ACCESS, inherited);
  setExplicitAccess(&entries[count++], logonSid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, SET_ACCESS, inherited);
  if (mode == L"read-only") {
    setExplicitAccess(&entries[count++], authenticatedSid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, SET_ACCESS, inherited);
  } else {
    // Authenticated Users passes the normal-token check; the separate
    // restricting capability SID must pass the WRITE_RESTRICTED check too.
    constexpr DWORD writable = FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE | FILE_DELETE_CHILD;
    setExplicitAccess(&entries[count++], authenticatedSid, writable, SET_ACCESS, inherited);
  }
  if (mode == L"read-only") {
    setExplicitAccess(&entries[count++], capabilitySid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, SET_ACCESS, inherited);
  } else {
    constexpr DWORD writable = FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE | FILE_DELETE_CHILD;
    setExplicitAccess(&entries[count++], capabilitySid, writable, SET_ACCESS, inherited);
  }

  LocalAcl dacl;
  DWORD result = SetEntriesInAclW(static_cast<ULONG>(count), entries.data(), nullptr, dacl.out());
  if (result != ERROR_SUCCESS) {
    *error = result;
    return false;
  }

  const DWORD sidLength = GetLengthSid(lowSid);
  const DWORD labelBytes = sizeof(ACL) + sizeof(ACE_HEADER) + sizeof(ACCESS_MASK) + sidLength;
  std::vector<BYTE> labelStorage(labelBytes);
  PACL label = reinterpret_cast<PACL>(labelStorage.data());
  if (InitializeAcl(label, labelBytes, ACL_REVISION) == FALSE ||
      AddMandatoryAce(label, ACL_REVISION, inherited, SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, lowSid) == FALSE) {
    *error = GetLastError();
    return false;
  }
  result = SetNamedSecurityInfoW(
      const_cast<LPWSTR>(path.c_str()),
      SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
      nullptr,
      nullptr,
      dacl.get(),
      label);
  if (result != ERROR_SUCCESS) {
    *error = result;
    return false;
  }
  return true;
}

bool queryLowLabel(const std::wstring& path, PSID lowSid, bool* present, DWORD* error) {
  PACL sacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  DWORD result = GetNamedSecurityInfoW(
      const_cast<LPWSTR>(path.c_str()),
      SE_FILE_OBJECT,
      LABEL_SECURITY_INFORMATION,
      nullptr,
      nullptr,
      nullptr,
      &sacl,
      &descriptor);
  if (result != ERROR_SUCCESS) {
    *error = result;
    return false;
  }
  *present = false;
  if (sacl != nullptr && IsValidAcl(sacl) != FALSE) {
    for (DWORD index = 0; index < sacl->AceCount; ++index) {
      LPVOID rawAce = nullptr;
      if (GetAce(sacl, index, &rawAce) == FALSE) {
        *error = GetLastError();
        if (descriptor != nullptr) LocalFree(descriptor);
        return false;
      }
      auto* header = reinterpret_cast<PACE_HEADER>(rawAce);
      if (header->AceType != SYSTEM_MANDATORY_LABEL_ACE_TYPE) continue;
      auto* fields = reinterpret_cast<PACCESS_ALLOWED_ACE>(rawAce);
      PSID aceSid = reinterpret_cast<PSID>(&fields->SidStart);
      if ((fields->Mask & SYSTEM_MANDATORY_LABEL_NO_WRITE_UP) != 0 && EqualSid(aceSid, lowSid) != FALSE) {
        *present = true;
        break;
      }
    }
  }
  if (descriptor != nullptr) LocalFree(descriptor);
  return true;
}

bool setTokenDefaultDaclGrant(HANDLE token, PSID grantSid, PSID additionalWorldSid, DWORD* error) {
  DWORD bytes = 0;
  GetTokenInformation(token, TokenDefaultDacl, nullptr, 0, &bytes);
  if (bytes == 0) {
    *error = GetLastError();
    return false;
  }
  std::vector<BYTE> current(bytes);
  if (GetTokenInformation(token, TokenDefaultDacl, current.data(), bytes, &bytes) == FALSE) {
    *error = GetLastError();
    return false;
  }
  auto* currentDacl = reinterpret_cast<PTOKEN_DEFAULT_DACL>(current.data());
  std::array<EXPLICIT_ACCESSW, 2> entries{};
  setExplicitAccess(&entries[0], grantSid, FILE_ALL_ACCESS, GRANT_ACCESS, 0);
  ULONG entryCount = 1;
  if (additionalWorldSid != nullptr && EqualSid(additionalWorldSid, grantSid) == FALSE) {
    setExplicitAccess(&entries[entryCount++], additionalWorldSid, FILE_ALL_ACCESS, GRANT_ACCESS, 0);
  }
  LocalAcl merged;
  DWORD result = SetEntriesInAclW(entryCount, entries.data(), currentDacl->DefaultDacl, merged.out());
  if (result != ERROR_SUCCESS) {
    *error = result;
    return false;
  }
  TOKEN_DEFAULT_DACL replacement{merged.get()};
  if (SetTokenInformation(token, TokenDefaultDacl, &replacement, sizeof(replacement)) == FALSE) {
    *error = GetLastError();
    return false;
  }
  return true;
}

bool restoreAclForCleanup(const std::wstring& path, DWORD* error) {
  // The parent is an administrator and the probe has already established Job
  // quiescence. A NULL DACL is temporary cleanup state, never target state.
  DWORD result = SetNamedSecurityInfoW(
      const_cast<LPWSTR>(path.c_str()),
      SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
      nullptr,
      nullptr,
      nullptr,
      nullptr);
  if (result != ERROR_SUCCESS) {
    *error = result;
    return false;
  }
  return true;
}

bool writeSeed(const std::wstring& path, DWORD* error) {
  ScopedHandle file(CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (!file.valid()) {
    *error = GetLastError();
    return false;
  }
  const char contents[] = "tier20-seed\n";
  DWORD written = 0;
  if (WriteFile(file.get(), contents, static_cast<DWORD>(sizeof(contents) - 1), &written, nullptr) == FALSE || written != sizeof(contents) - 1) {
    *error = GetLastError();
    return false;
  }
  return true;
}

struct DuplexPipe {
  ScopedHandle parent;
  ScopedHandle child;
};

std::wstring pipeName(const wchar_t* suffix) {
  std::wstringstream stream;
  stream << L"\\\\.\\pipe\\node-repl-tier20-" << GetCurrentProcessId() << L"-" << GetTickCount64() << L"-" << suffix;
  return stream.str();
}

bool createDuplexPipe(const wchar_t* suffix, DuplexPipe* result, DWORD* error) {
  SECURITY_ATTRIBUTES security{};
  security.nLength = sizeof(security);
  security.bInheritHandle = TRUE;
  const std::wstring name = pipeName(suffix);
  ScopedHandle server(CreateNamedPipeW(
      name.c_str(),
      PIPE_ACCESS_DUPLEX,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
      1,
      64 * 1024,
      64 * 1024,
      0,
      &security));
  if (!server.valid()) {
    *error = GetLastError();
    return false;
  }
  ScopedHandle client(CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (!client.valid()) {
    *error = GetLastError();
    return false;
  }
  BOOL connected = ConnectNamedPipe(server.get(), nullptr);
  if (connected == FALSE && GetLastError() != ERROR_PIPE_CONNECTED) {
    *error = GetLastError();
    return false;
  }
  if (SetHandleInformation(server.get(), HANDLE_FLAG_INHERIT, 0) == FALSE) {
    *error = GetLastError();
    return false;
  }
  result->parent = std::move(server);
  result->child = std::move(client);
  return true;
}

bool createChildReadPipe(ScopedHandle* parentWrite, ScopedHandle* childRead, DWORD* error) {
  SECURITY_ATTRIBUTES security{};
  security.nLength = sizeof(security);
  security.bInheritHandle = TRUE;
  HANDLE readHandle = nullptr;
  HANDLE writeHandle = nullptr;
  if (CreatePipe(&readHandle, &writeHandle, &security, 0) == FALSE) {
    *error = GetLastError();
    return false;
  }
  ScopedHandle read(readHandle);
  ScopedHandle write(writeHandle);
  if (SetHandleInformation(write.get(), HANDLE_FLAG_INHERIT, 0) == FALSE) {
    *error = GetLastError();
    return false;
  }
  *parentWrite = std::move(write);
  *childRead = std::move(read);
  return true;
}

bool createStdoutPipe(ScopedHandle* parentRead, ScopedHandle* childWrite, DWORD* error) {
  SECURITY_ATTRIBUTES security{};
  security.nLength = sizeof(security);
  security.bInheritHandle = TRUE;
  HANDLE readHandle = nullptr;
  HANDLE writeHandle = nullptr;
  if (CreatePipe(&readHandle, &writeHandle, &security, 0) == FALSE) {
    *error = GetLastError();
    return false;
  }
  ScopedHandle read(readHandle);
  ScopedHandle write(writeHandle);
  if (SetHandleInformation(read.get(), HANDLE_FLAG_INHERIT, 0) == FALSE) {
    *error = GetLastError();
    return false;
  }
  *parentRead = std::move(read);
  *childWrite = std::move(write);
  return true;
}

bool createNullInput(ScopedHandle* handle, DWORD* error) {
  SECURITY_ATTRIBUTES security{};
  security.nLength = sizeof(security);
  security.bInheritHandle = TRUE;
  HANDLE raw = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (raw == INVALID_HANDLE_VALUE) {
    *error = GetLastError();
    return false;
  }
  *handle = ScopedHandle(raw);
  return true;
}

std::wstring quoteWindowsArgument(const std::wstring& value) {
  std::wstring result = L"\"";
  size_t backslashes = 0;
  for (wchar_t ch : value) {
    if (ch == L'\\') {
      ++backslashes;
    } else if (ch == L'\"') {
      result.append(backslashes * 2 + 1, L'\\');
      result.push_back(L'\"');
      backslashes = 0;
    } else {
      result.append(backslashes, L'\\');
      backslashes = 0;
      result.push_back(ch);
    }
  }
  result.append(backslashes * 2, L'\\');
  result.push_back(L'\"');
  return result;
}

std::vector<wchar_t> explicitEnvironment(const Options& options) {
  std::vector<std::pair<std::wstring, std::wstring>> values;
  auto addExisting = [&](const wchar_t* name) {
    DWORD required = GetEnvironmentVariableW(name, nullptr, 0);
    if (required == 0) return;
    std::vector<wchar_t> buffer(required);
    DWORD length = GetEnvironmentVariableW(name, buffer.data(), required);
    if (length > 0) values.emplace_back(name, std::wstring(buffer.data(), length));
  };
  addExisting(L"SystemRoot");
  addExisting(L"WINDIR");
  values.emplace_back(L"TMP", options.privateTemp);
  values.emplace_back(L"TEMP", options.privateTemp);
  values.emplace_back(L"NODE_REPL_KERNEL_CONTROL", L"pipe");
  values.emplace_back(L"NODE_REPL_TIER20_MODE", options.mode);
  values.emplace_back(L"NODE_REPL_TIER20_WORKSPACE", options.workspace);
  values.emplace_back(L"NODE_REPL_TIER20_PRIVATE_TEMP", options.privateTemp);
  std::sort(values.begin(), values.end(), [](const auto& left, const auto& right) {
    return CompareStringOrdinal(left.first.data(), static_cast<int>(left.first.size()), right.first.data(), static_cast<int>(right.first.size()), TRUE) == CSTR_LESS_THAN;
  });
  std::vector<wchar_t> block;
  for (const auto& [name, value] : values) {
    block.insert(block.end(), name.begin(), name.end());
    block.push_back(L'=');
    block.insert(block.end(), value.begin(), value.end());
    block.push_back(L'\0');
  }
  block.push_back(L'\0');
  return block;
}

std::vector<BYTE> crtDescriptorBlock(const std::vector<HANDLE>& childHandles) {
  const int count = 8;
  const size_t bytes = sizeof(int) + static_cast<size_t>(count) + static_cast<size_t>(count) * sizeof(intptr_t);
  std::vector<BYTE> block(bytes, 0);
  std::memcpy(block.data(), &count, sizeof(count));
  auto* fileFlags = block.data() + sizeof(int);
  auto* handles = block.data() + sizeof(int) + count;
  for (int fd = 0; fd < count; ++fd) {
    unsigned char flags = 0;
    intptr_t handle = reinterpret_cast<intptr_t>(INVALID_HANDLE_VALUE);
    if (fd >= 3 && static_cast<size_t>(fd) < childHandles.size()) {
      flags = kFopen | kFpipe;
      handle = reinterpret_cast<intptr_t>(childHandles[static_cast<size_t>(fd)]);
    }
    fileFlags[fd] = flags;
    std::memcpy(handles + static_cast<size_t>(fd) * sizeof(intptr_t), &handle, sizeof(handle));
  }
  return block;
}

bool writeAll(HANDLE handle, const std::string& text, DWORD* error) {
  size_t offset = 0;
  while (offset < text.size()) {
    DWORD written = 0;
    DWORD requested = static_cast<DWORD>(std::min<size_t>(text.size() - offset, std::numeric_limits<DWORD>::max()));
    if (WriteFile(handle, text.data() + offset, requested, &written, nullptr) == FALSE || written == 0) {
      *error = GetLastError();
      return false;
    }
    offset += written;
  }
  return true;
}

bool readLine(HANDLE handle, std::string* line, DWORD timeoutMs, DWORD* error) {
  line->clear();
  const ULONGLONG deadline = GetTickCount64() + timeoutMs;
  std::array<char, 4096> buffer{};
  while (GetTickCount64() < deadline) {
    DWORD available = 0;
    if (PeekNamedPipe(handle, nullptr, 0, nullptr, &available, nullptr) == FALSE) {
      *error = GetLastError();
      return false;
    }
    if (available == 0) {
      Sleep(5);
      continue;
    }
    DWORD read = 0;
    const DWORD requested = std::min<DWORD>(available, static_cast<DWORD>(buffer.size()));
    if (ReadFile(handle, buffer.data(), requested, &read, nullptr) == FALSE || read == 0) {
      *error = GetLastError();
      return false;
    }
    line->append(buffer.data(), read);
    const size_t newline = line->find('\n');
    if (newline != std::string::npos) {
      line->resize(newline);
      return true;
    }
    if (line->size() > kOutputLimitBytes) {
      *error = ERROR_BUFFER_OVERFLOW;
      return false;
    }
  }
  *error = WAIT_TIMEOUT;
  return false;
}

struct DrainState {
  ScopedHandle handle;
  std::string output;
  std::thread thread;

  void start() {
    HANDLE raw = handle.get();
    thread = std::thread([this, raw]() {
      std::array<char, 4096> buffer{};
      for (;;) {
        DWORD read = 0;
        if (ReadFile(raw, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr) == FALSE || read == 0) break;
        if (output.size() < kOutputLimitBytes) {
          const size_t keep = std::min<size_t>(read, kOutputLimitBytes - output.size());
          output.append(buffer.data(), keep);
        }
      }
    });
  }

  void join() {
    if (thread.joinable()) thread.join();
  }
};

bool queryTokenFacts(HANDLE process, const std::array<PSID, 4>& expectedRestrictedSids, DWORD expectedRestrictedCount, PSID expectedDefaultDaclSid, PSID expectedWorldSid, bool* restricted, bool* defaultDaclGrant, bool* defaultDaclWorldGrant, bool* low, DWORD* error) {
  ScopedHandle token;
  HANDLE raw = nullptr;
  if (OpenProcessToken(process, TOKEN_QUERY, &raw) == FALSE) {
    *error = GetLastError();
    return false;
  }
  token = ScopedHandle(raw);
  BOOL isRestricted = FALSE;
  DWORD returned = 0;
  if (GetTokenInformation(token.get(), TokenIsRestricted, &isRestricted, sizeof(isRestricted), &returned) == FALSE) {
    *error = GetLastError();
    return false;
  }
  *restricted = isRestricted != FALSE;

  DWORD restrictedSize = 0;
  GetTokenInformation(token.get(), TokenRestrictedSids, nullptr, 0, &restrictedSize);
  if (restrictedSize == 0) {
    *error = GetLastError();
    return false;
  }
  std::vector<BYTE> restrictedInfo(restrictedSize);
  if (GetTokenInformation(token.get(), TokenRestrictedSids, restrictedInfo.data(), restrictedSize, &restrictedSize) == FALSE) {
    *error = GetLastError();
    return false;
  }
  auto* restrictedSids = reinterpret_cast<PTOKEN_GROUPS>(restrictedInfo.data());
  std::array<bool, 4> foundExpected{};
  for (DWORD index = 0; index < restrictedSids->GroupCount; ++index) {
    for (DWORD expected = 0; expected < expectedRestrictedCount; ++expected) {
      if (EqualSid(restrictedSids->Groups[index].Sid, expectedRestrictedSids[expected]) != FALSE) {
        foundExpected[expected] = true;
      }
    }
  }
  bool allExpectedSidsFound = true;
  for (DWORD expected = 0; expected < expectedRestrictedCount; ++expected) allExpectedSidsFound = allExpectedSidsFound && foundExpected[expected];
  *restricted = *restricted && allExpectedSidsFound;

  DWORD defaultDaclSize = 0;
  GetTokenInformation(token.get(), TokenDefaultDacl, nullptr, 0, &defaultDaclSize);
  if (defaultDaclSize == 0) {
    *error = GetLastError();
    return false;
  }
  std::vector<BYTE> defaultDaclInfo(defaultDaclSize);
  if (GetTokenInformation(token.get(), TokenDefaultDacl, defaultDaclInfo.data(), defaultDaclSize, &defaultDaclSize) == FALSE) {
    *error = GetLastError();
    return false;
  }
  auto* tokenDefaultDacl = reinterpret_cast<PTOKEN_DEFAULT_DACL>(defaultDaclInfo.data());
  *defaultDaclGrant = false;
  *defaultDaclWorldGrant = false;
  if (tokenDefaultDacl->DefaultDacl != nullptr && IsValidAcl(tokenDefaultDacl->DefaultDacl) != FALSE) {
    for (DWORD index = 0; index < tokenDefaultDacl->DefaultDacl->AceCount; ++index) {
      LPVOID rawAce = nullptr;
      if (GetAce(tokenDefaultDacl->DefaultDacl, index, &rawAce) == FALSE) {
        *error = GetLastError();
        return false;
      }
      auto* header = reinterpret_cast<PACE_HEADER>(rawAce);
      if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) continue;
      auto* allow = reinterpret_cast<PACCESS_ALLOWED_ACE>(rawAce);
      PSID aceSid = reinterpret_cast<PSID>(&allow->SidStart);
      if ((allow->Mask & FILE_ALL_ACCESS) != FILE_ALL_ACCESS) continue;
      if (EqualSid(aceSid, expectedDefaultDaclSid) != FALSE) *defaultDaclGrant = true;
      if (EqualSid(aceSid, expectedWorldSid) != FALSE) *defaultDaclWorldGrant = true;
    }
  }

  DWORD size = 0;
  GetTokenInformation(token.get(), TokenIntegrityLevel, nullptr, 0, &size);
  if (size == 0) {
    *error = GetLastError();
    return false;
  }
  std::vector<BYTE> integrity(size);
  if (GetTokenInformation(token.get(), TokenIntegrityLevel, integrity.data(), size, &size) == FALSE) {
    *error = GetLastError();
    return false;
  }
  auto* label = reinterpret_cast<PTOKEN_MANDATORY_LABEL>(integrity.data());
  DWORD count = *GetSidSubAuthorityCount(label->Label.Sid);
  DWORD rid = *GetSidSubAuthority(label->Label.Sid, count - 1);
  *low = rid == SECURITY_MANDATORY_LOW_RID;
  return true;
}

bool queryJobSettled(HANDLE job, bool* settled, DWORD* error) {
  const ULONGLONG deadline = GetTickCount64() + kJobSettlementTimeoutMs;
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  *settled = false;
  do {
    if (QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr) == FALSE) {
      *error = GetLastError();
      return false;
    }
    *settled = accounting.ActiveProcesses == 0 && accounting.TotalProcesses >= 1;
    if (*settled || GetTickCount64() >= deadline) return true;
    Sleep(kJobSettlementPollMs);
  } while (true);
}

bool omittedHandleAbsent(HANDLE process, HANDLE sentinel, bool* absent, DWORD* error) {
  HANDLE duplicate = nullptr;
  SetLastError(ERROR_SUCCESS);
  BOOL duplicated = DuplicateHandle(process, sentinel, GetCurrentProcess(), &duplicate, 0, FALSE, DUPLICATE_SAME_ACCESS);
  if (duplicated != FALSE) {
    if (duplicate != nullptr) CloseHandle(duplicate);
    *absent = false;
    *error = ERROR_INVALID_HANDLE;
    return true;
  }
  DWORD duplicateError = GetLastError();
  if (duplicateError == ERROR_INVALID_HANDLE || duplicateError == ERROR_INVALID_PARAMETER) {
    *absent = true;
    *error = ERROR_SUCCESS;
    return true;
  }
  *absent = false;
  *error = duplicateError;
  return false;
}

bool parseArgs(int argc, wchar_t** argv, Options* options, DWORD* error) {
  for (int index = 1; index < argc; ++index) {
    const std::wstring argument = argv[index];
    auto next = [&](std::wstring* destination) {
      if (index + 1 >= argc) return false;
      *destination = argv[++index];
      return true;
    };
    if (argument == L"--mode") {
      if (!next(&options->mode)) { *error = ERROR_INVALID_PARAMETER; return false; }
    } else if (argument == L"--node") {
      if (!next(&options->node)) { *error = ERROR_INVALID_PARAMETER; return false; }
    } else if (argument == L"--worker") {
      if (!next(&options->worker)) { *error = ERROR_INVALID_PARAMETER; return false; }
    } else if (argument == L"--workspace") {
      if (!next(&options->workspace)) { *error = ERROR_INVALID_PARAMETER; return false; }
    } else if (argument == L"--private-temp") {
      if (!next(&options->privateTemp)) { *error = ERROR_INVALID_PARAMETER; return false; }
    } else {
      *error = ERROR_INVALID_PARAMETER;
      return false;
    }
  }
  if ((options->mode != L"read-only" && options->mode != L"workspace-write") || options->node.empty() || options->worker.empty() || options->workspace.empty() || options->privateTemp.empty()) {
    *error = ERROR_INVALID_PARAMETER;
    return false;
  }
  return true;
}

int printResult(const Options& options, const ProbeResult& result) {
  const std::string status = result.pass ? "PASS" : "FAIL";
  std::printf(
      "{\"schemaVersion\":2,\"tool\":\"%s\",\"mode\":\"%s\",\"status\":\"%s\","
      "\"tokenRestricted\":%s,\"tokenLowIntegrity\":%s,\"daclApplied\":%s,\"lowLabelApplied\":%s,\"defaultDaclGrant\":%s,\"defaultDaclWorldGrant\":%s,"
      "\"explicitEnvironmentBlock\":%s,\"handleAllowlist\":%s,\"crtDescriptorTable\":%s,\"fd3RoundTrip\":%s,\"carrierReads\":%s,"
      "\"jobCreated\":%s,\"targetProcessCreated\":%s,\"targetProcessExited\":%s,\"targetAssignedToJob\":%s,\"targetResumed\":%s,\"jobSettled\":%s,"
      "\"grantsRevokedAfterQuiescence\":%s,\"cleanup\":%s,\"targetReady\":%s,\"targetReportPass\":%s,\"targetExitSuccess\":%s,"
      "\"error\":%lu,\"phase\":\"%s\",\"targetExitCode\":%lu,\"targetReadyLine\":\"%s\",\"childStdout\":\"%s\",\"childStderr\":\"%s\"}\n",
      "node-repl-win32-owned-worker",
      jsonEscape(narrow(options.mode)).c_str(),
      status.c_str(),
      jsonBool(result.tokenRestricted).c_str(),
      jsonBool(result.tokenLow).c_str(),
      jsonBool(result.daclApplied).c_str(),
      jsonBool(result.lowLabelApplied).c_str(),
      jsonBool(result.defaultDaclGrant).c_str(),
      jsonBool(result.defaultDaclWorldGrant).c_str(),
      jsonBool(result.explicitEnvironmentBlock).c_str(),
      jsonBool(result.handleAllowlist).c_str(),
      jsonBool(result.crtDescriptorTable).c_str(),
      jsonBool(result.fd3RoundTrip).c_str(),
      jsonBool(result.carrierReads).c_str(),
      jsonBool(result.jobCreated).c_str(),
      jsonBool(result.targetProcessCreated).c_str(),
      jsonBool(result.targetProcessExited).c_str(),
      jsonBool(result.targetAssignedToJob).c_str(),
      jsonBool(result.targetResumed).c_str(),
      jsonBool(result.jobSettled).c_str(),
      jsonBool(result.grantsRevokedAfterQuiescence).c_str(),
      jsonBool(result.cleanup).c_str(),
      jsonBool(result.targetReady).c_str(),
      jsonBool(result.targetReportPass).c_str(),
      jsonBool(result.targetExitSuccess).c_str(),
      static_cast<unsigned long>(result.error),
      jsonEscape(result.phase).c_str(),
      static_cast<unsigned long>(result.targetExitCode),
      jsonEscape(result.targetReadyLine).c_str(),
      jsonEscape(result.childStdout).c_str(),
      jsonEscape(result.childStderr).c_str());
  return result.pass ? 0 : 1;
}

int usage() {
  std::fwprintf(stderr, L"Usage: %ls --mode <read-only|workspace-write> --node <node.exe> --worker <worker.mjs> --workspace <root> --private-temp <root>\n", kToolName);
  return 64;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  Options options;
  DWORD error = ERROR_SUCCESS;
  if (!parseArgs(argc, argv, &options, &error)) return usage();

  ProbeResult result;
  result.phase = "initialization";
  if (SetEnvironmentVariableW(L"NODE_REPL_PHASE0_PARENT_SENTINEL", L"must-not-reach-worker") == FALSE ||
      SetEnvironmentVariableW(L"DSH_SUBPROCESS_CONTROL", L"must-not-reach-worker") == FALSE ||
      SetEnvironmentVariableW(L"NODE_OPTIONS", L"--no-warnings") == FALSE) {
    result.error = GetLastError();
    result.phase = "prepare-environment-sentinels";
    return printResult(options, result);
  }
  // Hosted Windows runners do not necessarily assign every privilege to the
  // runner token. CreateProcessAsUserW may enable the privileges it needs when
  // the restricted token is used, while DACL ownership is checked at the exact
  // API boundary below. Treat ERROR_NOT_ALL_ASSIGNED here as diagnostic rather
  // than claiming that a missing privilege is already a backend failure.
  (void)enablePrivilege(SE_ASSIGNPRIMARYTOKEN_NAME, &error);
  (void)enablePrivilege(SE_INCREASE_QUOTA_NAME, &error);
  (void)enablePrivilege(SE_TAKE_OWNERSHIP_NAME, &error);
  (void)enablePrivilege(SE_RESTORE_NAME, &error);
  error = ERROR_SUCCESS;
  if (!existingDirectory(options.workspace, &error) || !existingDirectory(options.privateTemp, &error) || !disjointPaths(options.workspace, options.privateTemp)) {
    result.error = error == ERROR_SUCCESS ? ERROR_INVALID_NAME : error;
    result.phase = "root-preflight";
    return printResult(options, result);
  }
  if (GetFileAttributesW(options.node.c_str()) == INVALID_FILE_ATTRIBUTES || GetFileAttributesW(options.worker.c_str()) == INVALID_FILE_ATTRIBUTES) {
    result.error = GetLastError();
    result.phase = "target-preflight";
    return printResult(options, result);
  }

  DWORD sidError = ERROR_SUCCESS;
  SidBuffer administratorSid;
  SidBuffer worldSid;
  SidBuffer authenticatedSid;
  SidBuffer logonSid;
  SidBuffer workspaceCapabilitySid;
  SidBuffer tempCapabilitySid;
  SidBuffer lowSid;
  DWORD runTag = 0;
  DWORD secondTag = 0;
  DWORD workspaceFirst = 0;
  DWORD workspaceSecond = 0;
  DWORD tempFirst = 0;
  DWORD tempSecond = 0;
  if (!initializeSid(&administratorSid, WinBuiltinAdministratorsSid, &sidError) ||
      !initializeSid(&worldSid, WinWorldSid, &sidError) ||
      !initializeSid(&authenticatedSid, WinAuthenticatedUserSid, &sidError)) {
    result.error = sidError;
    result.phase = "sid-preflight";
    return printResult(options, result);
  }

  ScopedHandle currentToken;
  HANDLE rawCurrentToken = nullptr;
  const std::wstring seedPath = joinPath(options.workspace, L"tier20-seed.txt");
  const std::wstring targetNodePath = joinPath(options.workspace, L"tier20-node.exe");
  const std::wstring targetWorkerPath = joinPath(options.workspace, L"tier20-worker.mjs");
  if (OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID, &rawCurrentToken) == FALSE) {
    result.error = GetLastError();
    result.phase = "open-current-token";
    goto cleanup;
  }
  currentToken = ScopedHandle(rawCurrentToken);
  if (!findLogonSid(currentToken.get(), &logonSid, &error)) {
    result.error = error;
    result.phase = "find-logon-sid";
    goto cleanup;
  }
  runTag = static_cast<DWORD>((GetTickCount64() ^ (static_cast<ULONGLONG>(GetCurrentProcessId()) << 16) ^ 0x6d2b79f5ULL) & 0x3fffffff);
  secondTag = static_cast<DWORD>(((GetTickCount64() >> 17) ^ GetCurrentThreadId() ^ 0x1b873593ULL) & 0x3fffffff);
  workspaceFirst = runTag == 0 ? 1 : runTag;
  workspaceSecond = secondTag == 0 || secondTag == workspaceFirst ? ((workspaceFirst + 17) & 0x3fffffff) : secondTag;
  tempFirst = (workspaceSecond + 0x15555555) & 0x3fffffff;
  tempSecond = (workspaceFirst + 0x2aaaaaaa) & 0x3fffffff;
  if (!workspaceCapabilitySid.initializeCustom({workspaceFirst, workspaceSecond == 0 ? 2 : workspaceSecond}, &error) ||
      !tempCapabilitySid.initializeCustom({tempFirst == 0 ? 3 : tempFirst, tempSecond == 0 ? 4 : tempSecond, 1}, &error) ||
      !initializeSid(&lowSid, WinLowLabelSid, &error)) {
    result.error = error;
    result.phase = "capability-sid";
    goto cleanup;
  }
  // Stage the executable, script, and seed before the candidate roots receive
  // their closed, mode-specific DACLs and Low-integrity labels.
  if (CopyFileW(options.node.c_str(), targetNodePath.c_str(), TRUE) == FALSE) {
    result.error = GetLastError();
    result.phase = "copy-node";
    goto cleanup;
  }
  if (CopyFileW(options.worker.c_str(), targetWorkerPath.c_str(), TRUE) == FALSE) {
    result.error = GetLastError();
    result.phase = "copy-worker";
    goto cleanup;
  }
  if (!applyOwnedAcl(targetNodePath, L"read-only", administratorSid.get(), worldSid.get(), logonSid.get(), authenticatedSid.get(), worldSid.get(), lowSid.get(), &error)) {
    result.error = error;
    result.phase = "acl-node";
    goto cleanup;
  }
  if (!applyOwnedAcl(targetWorkerPath, L"read-only", administratorSid.get(), worldSid.get(), logonSid.get(), authenticatedSid.get(), worldSid.get(), lowSid.get(), &error)) {
    result.error = error;
    result.phase = "acl-worker";
    goto cleanup;
  }
  if (!writeSeed(seedPath, &error) || !applyOwnedAcl(seedPath, L"read-only", administratorSid.get(), worldSid.get(), logonSid.get(), authenticatedSid.get(), worldSid.get(), lowSid.get(), &error)) {
    result.error = error == ERROR_SUCCESS ? GetLastError() : error;
    result.phase = "seed-acl";
    goto cleanup;
  }
  if (!applyOwnedAcl(options.workspace, options.mode, administratorSid.get(), worldSid.get(), logonSid.get(), authenticatedSid.get(), workspaceCapabilitySid.get(), lowSid.get(), &error) ||
      !applyOwnedAcl(options.privateTemp, options.mode, administratorSid.get(), worldSid.get(), logonSid.get(), authenticatedSid.get(), tempCapabilitySid.get(), lowSid.get(), &error)) {
    result.error = error;
    result.phase = "apply-dacl";
    goto cleanup;
  }
  result.daclApplied = true;
  {
    bool nodeLabel = false;
    bool workerLabel = false;
    bool seedLabel = false;
    bool workspaceLabel = false;
    bool tempLabel = false;
    if (!queryLowLabel(targetNodePath, lowSid.get(), &nodeLabel, &error) ||
        !queryLowLabel(targetWorkerPath, lowSid.get(), &workerLabel, &error) ||
        !queryLowLabel(seedPath, lowSid.get(), &seedLabel, &error) ||
        !queryLowLabel(options.workspace, lowSid.get(), &workspaceLabel, &error) ||
        !queryLowLabel(options.privateTemp, lowSid.get(), &tempLabel, &error)) {
      result.error = error;
      result.phase = "inspect-low-label";
      goto cleanup;
    }
    result.lowLabelApplied = nodeLabel && workerLabel && seedLabel && workspaceLabel && tempLabel;
    if (!result.lowLabelApplied) {
      result.error = ERROR_INVALID_SECURITY_DESCR;
      result.phase = "low-label-missing";
      goto cleanup;
    }
  }
  {
    std::array<SID_AND_ATTRIBUTES, 4> restrictingAttributes{};
    restrictingAttributes[0] = SID_AND_ATTRIBUTES{logonSid.get(), 0};
    restrictingAttributes[1] = SID_AND_ATTRIBUTES{worldSid.get(), 0};
    // A previous hosted-runner probe found that the Temp capability alone in
    // TokenDefaultDacl caused Node startup 0xC0000142. Workspace-write retains
    // both capability SIDs and adds a World compatibility ACE; both grants are
    // reported and inspected rather than silently weakening the evidence.
    DWORD restrictingCount = 2;
    if (options.mode == L"workspace-write") {
      restrictingAttributes[2] = SID_AND_ATTRIBUTES{workspaceCapabilitySid.get(), 0};
      restrictingAttributes[3] = SID_AND_ATTRIBUTES{tempCapabilitySid.get(), 0};
      restrictingCount = 4;
    }
    HANDLE rawRestrictedToken = nullptr;
    constexpr DWORD restrictedFlags = DISABLE_MAX_PRIVILEGE | 0x00000004 /* LUA_TOKEN */ | 0x00000008 /* WRITE_RESTRICTED */;
    BOOL created = CreateRestrictedToken(currentToken.get(), restrictedFlags, 0, nullptr, 0, nullptr, restrictingCount, restrictingAttributes.data(), &rawRestrictedToken);
    if (created == FALSE) {
      result.error = GetLastError();
      result.phase = "create-restricted-token";
      goto cleanup;
    }
    ScopedHandle restrictedToken(rawRestrictedToken);
    TOKEN_MANDATORY_LABEL label{};
    label.Label.Sid = lowSid.get();
    label.Label.Attributes = SE_GROUP_INTEGRITY | SE_GROUP_INTEGRITY_ENABLED;
    if (SetTokenInformation(restrictedToken.get(), TokenIntegrityLevel, &label, sizeof(label) + lowSid.length()) == FALSE) {
      result.error = GetLastError();
      result.phase = "set-low-integrity";
      goto cleanup;
    }
    PSID defaultDaclCapability = options.mode == L"workspace-write" ? tempCapabilitySid.get() : worldSid.get();
    PSID defaultDaclWorldSid = options.mode == L"workspace-write" ? worldSid.get() : nullptr;
    if (!setTokenDefaultDaclGrant(restrictedToken.get(), defaultDaclCapability, defaultDaclWorldSid, &error)) {
      result.error = error;
      result.phase = "set-default-dacl";
      goto cleanup;
    }

    DuplexPipe fd3;
    DuplexPipe fd7;
    if (!createDuplexPipe(L"fd3", &fd3, &error) || !createDuplexPipe(L"fd7", &fd7, &error)) {
      result.error = error;
      result.phase = "create-duplex-pipe";
      goto cleanup;
    }
    std::array<ScopedHandle, 3> carrierParent;
    std::array<ScopedHandle, 3> carrierChild;
    for (size_t index = 0; index < carrierParent.size(); ++index) {
      if (!createChildReadPipe(&carrierParent[index], &carrierChild[index], &error)) {
        result.error = error;
        result.phase = "create-carrier-pipe";
        goto cleanup;
      }
    }
    ScopedHandle stdoutRead;
    ScopedHandle stdoutChild;
    ScopedHandle stderrRead;
    ScopedHandle stderrChild;
    ScopedHandle stdinChild;
    if (!createStdoutPipe(&stdoutRead, &stdoutChild, &error) ||
        !createStdoutPipe(&stderrRead, &stderrChild, &error) ||
        !createNullInput(&stdinChild, &error)) {
      result.error = error;
      result.phase = "create-stdio";
      goto cleanup;
    }
    ScopedHandle sentinel(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (!sentinel.valid()) {
      result.error = GetLastError();
      result.phase = "create-sentinel";
      goto cleanup;
    }
    if (SetHandleInformation(sentinel.get(), HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) == FALSE) {
      result.error = GetLastError();
      result.phase = "mark-sentinel-inheritable";
      goto cleanup;
    }

    std::vector<HANDLE> childHandles;
    childHandles.reserve(8);
    childHandles.push_back(stdinChild.get());
    childHandles.push_back(stdoutChild.get());
    childHandles.push_back(stderrChild.get());
    childHandles.push_back(fd3.child.get());
    childHandles.push_back(carrierChild[0].get());
    childHandles.push_back(carrierChild[1].get());
    childHandles.push_back(carrierChild[2].get());
    childHandles.push_back(fd7.child.get());
    std::vector<BYTE> descriptorBlock = crtDescriptorBlock(childHandles);
    std::vector<wchar_t> environment = explicitEnvironment(options);

    SIZE_T attributeBytes = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeBytes);
    if (attributeBytes == 0) {
      result.error = GetLastError();
      result.phase = "attribute-size";
      goto cleanup;
    }
    std::vector<BYTE> attributeStorage(attributeBytes);
    auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeStorage.data());
    if (InitializeProcThreadAttributeList(attributes, 1, 0, &attributeBytes) == FALSE ||
        UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, childHandles.data(), childHandles.size() * sizeof(HANDLE), nullptr, nullptr) == FALSE) {
      result.error = GetLastError();
      result.phase = "handle-allowlist";
      goto cleanup;
    }

    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdinChild.get();
    startup.StartupInfo.hStdOutput = stdoutChild.get();
    startup.StartupInfo.hStdError = stderrChild.get();
    startup.StartupInfo.cbReserved2 = static_cast<WORD>(descriptorBlock.size());
    startup.StartupInfo.lpReserved2 = descriptorBlock.data();
    startup.lpAttributeList = attributes;
    PROCESS_INFORMATION processInformation{};
    std::wstring commandLine = quoteWindowsArgument(targetNodePath) + L" " + quoteWindowsArgument(targetWorkerPath);
    std::vector<wchar_t> mutableCommand(commandLine.begin(), commandLine.end());
    mutableCommand.push_back(L'\0');

    result.explicitEnvironmentBlock = true;
    DWORD creationFlags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | CREATE_SUSPENDED;
    if (CreateProcessAsUserW(
            restrictedToken.get(),
            targetNodePath.c_str(),
            mutableCommand.data(),
            nullptr,
            nullptr,
            TRUE,
            creationFlags,
            environment.data(),
            options.workspace.c_str(),
            &startup.StartupInfo,
            &processInformation) == FALSE) {
      result.error = GetLastError();
      result.phase = "create-restricted-node";
      goto cleanup;
    }
    result.targetProcessCreated = true;
    ScopedHandle targetProcess(processInformation.hProcess);
    ScopedHandle targetThread(processInformation.hThread);
    // Close the parent's copies of every child-side handle immediately after
    // CreateProcessAsUserW. Otherwise the stdout/stderr drainers would retain
    // an open write end and could never observe EOF after the target exits.
    stdinChild.reset();
    stdoutChild.reset();
    stderrChild.reset();
    fd3.child.reset();
    fd7.child.reset();
    for (auto& carrier : carrierChild) carrier.reset();
    result.tokenRestricted = false;
    result.tokenLow = false;
    std::array<PSID, 4> expectedRestrictedSids{logonSid.get(), worldSid.get(), workspaceCapabilitySid.get(), tempCapabilitySid.get()};
    const DWORD expectedRestrictedCount = options.mode == L"workspace-write" ? 4 : 2;
    if (!queryTokenFacts(targetProcess.get(), expectedRestrictedSids, expectedRestrictedCount, defaultDaclCapability, worldSid.get(), &result.tokenRestricted, &result.defaultDaclGrant, &result.defaultDaclWorldGrant, &result.tokenLow, &error)) {
      result.error = error;
      result.phase = "inspect-target-token";
      TerminateProcess(targetProcess.get(), 1);
      result.targetProcessExited = WaitForSingleObject(targetProcess.get(), kExitTimeoutMs) == WAIT_OBJECT_0;
      goto cleanup;
    }

    ScopedHandle job(CreateJobObjectW(nullptr, nullptr));
    if (!job.valid()) {
      result.error = GetLastError();
      result.phase = "create-job";
      TerminateProcess(targetProcess.get(), 1);
      result.targetProcessExited = WaitForSingleObject(targetProcess.get(), kExitTimeoutMs) == WAIT_OBJECT_0;
      goto cleanup;
    }
    result.jobCreated = true;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits)) == FALSE ||
        AssignProcessToJobObject(job.get(), targetProcess.get()) == FALSE) {
      result.error = GetLastError();
      result.phase = "assign-job";
      TerminateProcess(targetProcess.get(), 1);
      result.targetProcessExited = WaitForSingleObject(targetProcess.get(), kExitTimeoutMs) == WAIT_OBJECT_0;
      goto cleanup;
    }
    result.targetAssignedToJob = true;
    if (!writeAll(fd3.parent.get(), "fd3-in\n", &error) ||
        !writeAll(carrierParent[0].get(), "fd4-in\n", &error) ||
        !writeAll(carrierParent[1].get(), "fd5-in\n", &error) ||
        !writeAll(carrierParent[2].get(), "fd6-in\n", &error)) {
      result.error = error;
      result.phase = "seed-worker-carriers";
      TerminateJobObject(job.get(), 1);
      result.targetProcessExited = WaitForSingleObject(targetProcess.get(), kExitTimeoutMs) == WAIT_OBJECT_0;
      bool settledAfterTermination = false;
      if (queryJobSettled(job.get(), &settledAfterTermination, &error)) result.jobSettled = settledAfterTermination;
      goto cleanup;
    }
    if (ResumeThread(targetThread.get()) == static_cast<DWORD>(-1)) {
      result.error = GetLastError();
      result.phase = "resume-target";
      TerminateJobObject(job.get(), 1);
      result.targetProcessExited = WaitForSingleObject(targetProcess.get(), kExitTimeoutMs) == WAIT_OBJECT_0;
      bool settledAfterTermination = false;
      if (queryJobSettled(job.get(), &settledAfterTermination, &error)) result.jobSettled = settledAfterTermination;
      goto cleanup;
    }
    result.targetResumed = true;
    targetThread.reset();

    DrainState stdoutDrain;
    DrainState stderrDrain;
    stdoutDrain.handle = std::move(stdoutRead);
    stderrDrain.handle = std::move(stderrRead);
    stdoutDrain.start();
    stderrDrain.start();

    bool omittedSentinel = false;
    DWORD sentinelError = ERROR_SUCCESS;
    const bool sentinelCheckSucceeded = omittedHandleAbsent(targetProcess.get(), sentinel.get(), &omittedSentinel, &sentinelError);
    result.handleAllowlist = sentinelCheckSucceeded && omittedSentinel;
    if (!sentinelCheckSucceeded) {
      result.error = sentinelError;
      result.phase = "inspect-handle-allowlist";
      TerminateJobObject(job.get(), 1);
    }

    std::string readyLine;
    DWORD lineError = ERROR_SUCCESS;
    const std::string hello = "{\"type\":\"hello\",\"version\":1,\"requestId\":\"tier20-hello\"}\n";
    if (sentinelCheckSucceeded && writeAll(fd7.parent.get(), hello, &lineError) && readLine(fd7.parent.get(), &readyLine, kReadyTimeoutMs, &lineError)) {
      result.targetReady = readyLine.find("\"type\":\"ready\"") != std::string::npos;
      result.targetReportPass = readyLine.find("\"status\":\"PASS\"") != std::string::npos;
      result.crtDescriptorTable = readyLine.find("\"fd\":3,\"valid\":true") != std::string::npos &&
          readyLine.find("\"fd\":4,\"valid\":true") != std::string::npos &&
          readyLine.find("\"fd\":5,\"valid\":true") != std::string::npos &&
          readyLine.find("\"fd\":6,\"valid\":true") != std::string::npos &&
          readyLine.find("\"fd\":7,\"valid\":true") != std::string::npos;
      result.carrierReads = readyLine.find("\"carriersRead\":true") != std::string::npos;
      result.targetReadyLine = readyLine;
      std::string fd3Reply;
      if (readLine(fd3.parent.get(), &fd3Reply, kReadyTimeoutMs, &lineError)) {
        result.fd3RoundTrip = fd3Reply == "fd3-out";
      } else {
        result.error = lineError;
        result.phase = "fd3-round-trip";
        TerminateJobObject(job.get(), 1);
      }
      const std::string close = "{\"type\":\"close\",\"requestId\":\"tier20-close\"}\n";
      if (!writeAll(fd7.parent.get(), close, &lineError)) {
        result.error = lineError;
        result.phase = "send-close";
        TerminateJobObject(job.get(), 1);
      } else {
        std::string closingLine;
        if (!readLine(fd7.parent.get(), &closingLine, kReadyTimeoutMs, &lineError) ||
            closingLine.find("\"type\":\"closing\"") == std::string::npos ||
            closingLine.find("\"status\":\"PASS\"") == std::string::npos) {
          result.error = lineError == ERROR_SUCCESS ? ERROR_INVALID_DATA : lineError;
          result.phase = "read-close";
          TerminateJobObject(job.get(), 1);
        }
      }
      // Close the host endpoint after the acknowledged closing frame; this
      // keeps the final pipe lifetime explicit for Job settlement.
      fd7.parent.reset();
    } else {
      result.error = lineError;
      result.phase = "ready-handshake";
      TerminateJobObject(job.get(), 1);
    }

    const DWORD wait = WaitForSingleObject(targetProcess.get(), kExitTimeoutMs);
    result.targetProcessExited = wait == WAIT_OBJECT_0;
    if (wait != WAIT_OBJECT_0) {
      result.error = wait == WAIT_FAILED ? GetLastError() : WAIT_TIMEOUT;
      result.phase = "target-exit";
      TerminateJobObject(job.get(), 1);
      result.targetProcessExited = WaitForSingleObject(targetProcess.get(), kExitTimeoutMs) == WAIT_OBJECT_0;
    }
    if (GetExitCodeProcess(targetProcess.get(), &result.targetExitCode) == FALSE) {
      result.error = GetLastError();
      result.phase = "inspect-target-exit-code";
    } else {
      result.targetExitSuccess = result.targetExitCode == 0;
    }
    result.jobSettled = queryJobSettled(job.get(), &result.jobSettled, &error) && result.jobSettled;
    if (!result.jobSettled && result.error == ERROR_SUCCESS) {
      result.error = error;
      result.phase = "job-settlement";
    }
    stdoutDrain.join();
    stderrDrain.join();
    result.childStdout = stdoutDrain.output;
    result.childStderr = stderrDrain.output;
    stdoutDrain.handle.reset();
    stderrDrain.handle.reset();
    result.cleanup = false;
    targetProcess.reset();
    job.reset();
  }

cleanup:
  {
    DWORD cleanupError = ERROR_SUCCESS;
    const bool quiescent = (!result.targetProcessCreated || result.targetProcessExited) &&
        (!result.targetAssignedToJob || result.jobSettled);
    if (quiescent) {
      auto restoreIfPresent = [&](const std::wstring& path) {
        if (GetFileAttributesW(path.c_str()) == INVALID_FILE_ATTRIBUTES) return true;
        return restoreAclForCleanup(path, &cleanupError);
      };
      bool cleanedSeedAcl = restoreIfPresent(seedPath);
      bool cleanedNodeAcl = restoreIfPresent(targetNodePath);
      bool cleanedWorkerAcl = restoreIfPresent(targetWorkerPath);
      bool cleanedWorkspace = restoreIfPresent(options.workspace);
      bool cleanedTemp = restoreIfPresent(options.privateTemp);
      DeleteFileW(seedPath.c_str());
      DeleteFileW(targetNodePath.c_str());
      DeleteFileW(targetWorkerPath.c_str());
      bool removedSeed = GetFileAttributesW(seedPath.c_str()) == INVALID_FILE_ATTRIBUTES;
      bool removedNode = GetFileAttributesW(targetNodePath.c_str()) == INVALID_FILE_ATTRIBUTES;
      bool removedWorker = GetFileAttributesW(targetWorkerPath.c_str()) == INVALID_FILE_ATTRIBUTES;
      bool removedWorkspace = RemoveDirectoryW(options.workspace.c_str()) != FALSE;
      bool removedTemp = RemoveDirectoryW(options.privateTemp.c_str()) != FALSE;
      result.cleanup = cleanedSeedAcl && cleanedNodeAcl && cleanedWorkerAcl && cleanedWorkspace && cleanedTemp &&
          removedSeed && removedNode && removedWorker && removedWorkspace && removedTemp;
    }
    result.grantsRevokedAfterQuiescence = result.cleanup && quiescent;
    if (!result.cleanup && result.error == ERROR_SUCCESS) {
      result.error = cleanupError == ERROR_SUCCESS ? GetLastError() : cleanupError;
      result.phase = quiescent ? "cleanup" : "cleanup-before-quiescence";
    }
  }
  result.pass = result.daclApplied && result.lowLabelApplied && result.defaultDaclGrant && result.defaultDaclWorldGrant && result.tokenRestricted && result.tokenLow && result.explicitEnvironmentBlock && result.handleAllowlist &&
      result.crtDescriptorTable && result.fd3RoundTrip && result.carrierReads && result.jobCreated && result.targetProcessCreated && result.targetProcessExited && result.targetAssignedToJob && result.targetResumed && result.jobSettled &&
      result.grantsRevokedAfterQuiescence && result.cleanup && result.targetReady && result.targetReportPass && result.targetExitSuccess;
  if (result.pass) result.phase = "complete";
  return printResult(options, result);
}
