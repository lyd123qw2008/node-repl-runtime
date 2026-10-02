// SPDX-License-Identifier: MIT
//
// Non-production Windows ABI / handle-list / Job-accounting audit helper.
// This executable is an evidence oracle only. It is not a sandbox launcher and
// does not create a restricted token, change ACLs, or implement a runtime path.

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
#include <jobapi2.h>
#include <processthreadsapi.h>

#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <limits>
#include <string>
#include <vector>

static_assert(sizeof(void*) == 8, "The Windows audit helper is x64-only.");
static_assert(sizeof(STARTUPINFOW) == 104, "Unexpected STARTUPINFOW layout.");
static_assert(offsetof(STARTUPINFOW, hStdInput) == 80, "Unexpected STARTUPINFOW hStdInput offset.");
static_assert(offsetof(STARTUPINFOW, hStdOutput) == 88, "Unexpected STARTUPINFOW hStdOutput offset.");
static_assert(offsetof(STARTUPINFOW, hStdError) == 96, "Unexpected STARTUPINFOW hStdError offset.");
static_assert(sizeof(PROCESS_INFORMATION) == 24, "Unexpected PROCESS_INFORMATION layout.");
static_assert(sizeof(SECURITY_ATTRIBUTES) == 24, "Unexpected SECURITY_ATTRIBUTES layout.");
static_assert(sizeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION) == 48, "Unexpected Job accounting layout.");
static_assert(offsetof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, ActiveProcesses) == 40, "Unexpected Job ActiveProcesses offset.");

namespace {

constexpr wchar_t kToolName[] = L"node-repl-win32-audit";
constexpr DWORD kChildTimeoutMs = 10'000;

class ScopedHandle {
 public:
  explicit ScopedHandle(HANDLE handle = nullptr) : handle_(handle) {}
  ~ScopedHandle() { reset(); }

  ScopedHandle(const ScopedHandle&) = delete;
  ScopedHandle& operator=(const ScopedHandle&) = delete;

  HANDLE get() const { return handle_; }
  bool valid() const { return handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE; }

  void reset(HANDLE replacement = nullptr) {
    if (valid()) {
      (void)CloseHandle(handle_);
    }
    handle_ = replacement;
  }

 private:
  HANDLE handle_;
};

class ScopedAttributeList {
 public:
  ScopedAttributeList() = default;
  ~ScopedAttributeList() { reset(); }

  ScopedAttributeList(const ScopedAttributeList&) = delete;
  ScopedAttributeList& operator=(const ScopedAttributeList&) = delete;

  bool initialize(DWORD attributeCount, DWORD* error) {
    SIZE_T size = 0;
    SetLastError(ERROR_SUCCESS);
    const BOOL initialResult = InitializeProcThreadAttributeList(nullptr, attributeCount, 0, &size);
    if (initialResult != FALSE || GetLastError() != ERROR_INSUFFICIENT_BUFFER || size == 0) {
      *error = GetLastError();
      return false;
    }

    list_ = static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, size));
    if (list_ == nullptr) {
      *error = ERROR_NOT_ENOUGH_MEMORY;
      return false;
    }

    if (InitializeProcThreadAttributeList(list_, attributeCount, 0, &size) == FALSE) {
      *error = GetLastError();
      return false;
    }
    initialized_ = true;
    return true;
  }

  LPPROC_THREAD_ATTRIBUTE_LIST get() const { return list_; }

 private:
  void reset() {
    if (initialized_) {
      DeleteProcThreadAttributeList(list_);
      initialized_ = false;
    }
    if (list_ != nullptr) {
      (void)HeapFree(GetProcessHeap(), 0, list_);
      list_ = nullptr;
    }
  }

  LPPROC_THREAD_ATTRIBUTE_LIST list_ = nullptr;
  bool initialized_ = false;
};

int failJson(const char* mode, const char* phase, DWORD error) {
  std::printf(
      "{\"schemaVersion\":1,\"tool\":\"node-repl-win32-audit\",\"mode\":\"%s\",\"status\":\"FAIL\",\"phase\":\"%s\",\"win32Error\":%lu}\n",
      mode,
      phase,
      static_cast<unsigned long>(error));
  return 1;
}

void terminateAndSettle(HANDLE process) {
  if (process != nullptr && process != INVALID_HANDLE_VALUE) {
    (void)TerminateProcess(process, 1);
    (void)WaitForSingleObject(process, kChildTimeoutMs);
  }
}

bool currentExecutablePath(std::wstring* path, DWORD* error) {
  std::vector<wchar_t> buffer(32'768, L'\0');
  SetLastError(ERROR_SUCCESS);
  const DWORD length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
  if (length == 0 || length >= static_cast<DWORD>(buffer.size() - 1U)) {
    *error = GetLastError();
    if (*error == ERROR_SUCCESS) {
      *error = ERROR_INSUFFICIENT_BUFFER;
    }
    return false;
  }
  path->assign(buffer.data(), length);
  return true;
}

std::vector<wchar_t> mutableCommandLine(const std::wstring& commandLine) {
  std::vector<wchar_t> result(commandLine.begin(), commandLine.end());
  result.push_back(L'\0');
  return result;
}

std::wstring decimalHandle(HANDLE handle) {
  return std::to_wstring(static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(handle)));
}

bool parseDecimalHandle(const wchar_t* input, HANDLE* output) {
  if (input == nullptr || *input == L'\0') return false;
  errno = 0;
  wchar_t* end = nullptr;
  const unsigned long long parsed = std::wcstoull(input, &end, 10);
  if (errno == ERANGE || end == input || *end != L'\0' ||
      parsed > static_cast<unsigned long long>(std::numeric_limits<uintptr_t>::max())) {
    return false;
  }
  *output = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(parsed));
  return true;
}

int runAbi() {
  std::printf(
      "{\"schemaVersion\":1,\"tool\":\"node-repl-win32-audit\",\"mode\":\"abi\",\"status\":\"PASS\","
      "\"pointerSize\":%zu,\"layouts\":{\"STARTUPINFOW\":%zu,\"PROCESS_INFORMATION\":%zu,"
      "\"SECURITY_ATTRIBUTES\":%zu,\"JOBOBJECT_BASIC_ACCOUNTING_INFORMATION\":%zu},"
      "\"offsets\":{\"STARTUPINFOW.hStdInput\":%zu,\"STARTUPINFOW.hStdOutput\":%zu,"
      "\"STARTUPINFOW.hStdError\":%zu,\"JOBOBJECT_BASIC_ACCOUNTING_INFORMATION.ActiveProcesses\":%zu}}\n",
      sizeof(void*),
      sizeof(STARTUPINFOW),
      sizeof(PROCESS_INFORMATION),
      sizeof(SECURITY_ATTRIBUTES),
      sizeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION),
      offsetof(STARTUPINFOW, hStdInput),
      offsetof(STARTUPINFOW, hStdOutput),
      offsetof(STARTUPINFOW, hStdError),
      offsetof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, ActiveProcesses));
  return 0;
}

int runHandleChild(int argc, wchar_t** argv) {
  HANDLE allowed = nullptr;
  HANDLE sentinel = nullptr;
  if (argc != 4 || !parseDecimalHandle(argv[2], &allowed) || !parseDecimalHandle(argv[3], &sentinel)) {
    return failJson("handle-child", "invalid-argument", ERROR_INVALID_PARAMETER);
  }

  DWORD allowedFlags = 0;
  SetLastError(ERROR_SUCCESS);
  const bool allowedVisible = GetHandleInformation(allowed, &allowedFlags) != FALSE;
  const DWORD allowedVisibleError = allowedVisible ? ERROR_SUCCESS : GetLastError();

  SetLastError(ERROR_SUCCESS);
  const bool allowedSignaled = SetEvent(allowed) != FALSE;
  const DWORD allowedSignalError = allowedSignaled ? ERROR_SUCCESS : GetLastError();

  DWORD sentinelFlags = 0;
  SetLastError(ERROR_SUCCESS);
  const bool sentinelVisible = GetHandleInformation(sentinel, &sentinelFlags) != FALSE;
  const DWORD sentinelVisibleError = sentinelVisible ? ERROR_SUCCESS : GetLastError();

  SetLastError(ERROR_SUCCESS);
  const bool sentinelSignaled = SetEvent(sentinel) != FALSE;
  const DWORD sentinelSignalError = sentinelSignaled ? ERROR_SUCCESS : GetLastError();

  const bool passed = allowedVisible && allowedSignaled && !sentinelVisible &&
      sentinelVisibleError == ERROR_INVALID_HANDLE && !sentinelSignaled &&
      sentinelSignalError == ERROR_INVALID_HANDLE;

  std::printf(
      "{\"schemaVersion\":1,\"tool\":\"node-repl-win32-audit\",\"mode\":\"handle-child\",\"status\":\"%s\","
      "\"allowedVisible\":%s,\"allowedSignaled\":%s,\"allowedVisibleError\":%lu,"
      "\"allowedSignalError\":%lu,\"sentinelVisible\":%s,\"sentinelSignaled\":%s,"
      "\"sentinelVisibleError\":%lu,\"sentinelSignalError\":%lu}\n",
      passed ? "PASS" : "FAIL",
      allowedVisible ? "true" : "false",
      allowedSignaled ? "true" : "false",
      static_cast<unsigned long>(allowedVisibleError),
      static_cast<unsigned long>(allowedSignalError),
      sentinelVisible ? "true" : "false",
      sentinelSignaled ? "true" : "false",
      static_cast<unsigned long>(sentinelVisibleError),
      static_cast<unsigned long>(sentinelSignalError));
  return passed ? 0 : 1;
}

int runHandleSentinel() {
  SECURITY_ATTRIBUTES inheritable{};
  inheritable.nLength = static_cast<DWORD>(sizeof(inheritable));
  inheritable.bInheritHandle = TRUE;

  ScopedHandle allowed(CreateEventW(&inheritable, TRUE, FALSE, nullptr));
  if (!allowed.valid()) return failJson("handle-sentinel", "CreateEventW-allowed", GetLastError());

  ScopedHandle sentinel(CreateEventW(&inheritable, TRUE, FALSE, nullptr));
  if (!sentinel.valid()) return failJson("handle-sentinel", "CreateEventW-sentinel", GetLastError());

  DWORD error = ERROR_SUCCESS;
  ScopedAttributeList attributes;
  if (!attributes.initialize(1, &error)) return failJson("handle-sentinel", "InitializeProcThreadAttributeList", error);

  HANDLE allowlist[] = {allowed.get()};
  if (UpdateProcThreadAttribute(
          attributes.get(),
          0,
          PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
          allowlist,
          sizeof(allowlist),
          nullptr,
          nullptr) == FALSE) {
    return failJson("handle-sentinel", "UpdateProcThreadAttribute-handle-list", GetLastError());
  }

  std::wstring executable;
  if (!currentExecutablePath(&executable, &error)) return failJson("handle-sentinel", "GetModuleFileNameW", error);

  std::wstring commandLine = L"\"" + executable + L"\" --handle-child " +
      decimalHandle(allowed.get()) + L" " + decimalHandle(sentinel.get());
  std::vector<wchar_t> mutableCommand = mutableCommandLine(commandLine);

  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = static_cast<DWORD>(sizeof(startup));
  startup.lpAttributeList = attributes.get();
  PROCESS_INFORMATION processInformation{};

  if (CreateProcessW(
          executable.c_str(),
          mutableCommand.data(),
          nullptr,
          nullptr,
          TRUE,
          EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
          nullptr,
          nullptr,
          &startup.StartupInfo,
          &processInformation) == FALSE) {
    return failJson("handle-sentinel", "CreateProcessW", GetLastError());
  }

  ScopedHandle childProcess(processInformation.hProcess);
  ScopedHandle childThread(processInformation.hThread);
  const DWORD wait = WaitForSingleObject(childProcess.get(), kChildTimeoutMs);
  if (wait != WAIT_OBJECT_0) {
    terminateAndSettle(childProcess.get());
    return failJson("handle-sentinel", wait == WAIT_FAILED ? "WaitForSingleObject" : "child-timeout", wait == WAIT_FAILED ? GetLastError() : ERROR_TIMEOUT);
  }

  DWORD childExitCode = STILL_ACTIVE;
  if (GetExitCodeProcess(childProcess.get(), &childExitCode) == FALSE) {
    return failJson("handle-sentinel", "GetExitCodeProcess", GetLastError());
  }
  const DWORD allowedWait = WaitForSingleObject(allowed.get(), 0);
  const bool passed = childExitCode == 0 && allowedWait == WAIT_OBJECT_0;

  std::printf(
      "{\"schemaVersion\":1,\"tool\":\"node-repl-win32-audit\",\"mode\":\"handle-sentinel\",\"status\":\"%s\","
      "\"childExitCode\":%lu,\"allowedEventObserved\":%s,\"handleListCount\":1}\n",
      passed ? "PASS" : "FAIL",
      static_cast<unsigned long>(childExitCode),
      allowedWait == WAIT_OBJECT_0 ? "true" : "false");
  return passed ? 0 : 1;
}

int runJobSettlement() {
  ScopedHandle job(CreateJobObjectW(nullptr, nullptr));
  if (!job.valid()) return failJson("job-settlement", "CreateJobObjectW", GetLastError());

  DWORD error = ERROR_SUCCESS;
  std::wstring executable;
  if (!currentExecutablePath(&executable, &error)) return failJson("job-settlement", "GetModuleFileNameW", error);

  std::wstring commandLine = L"\"" + executable + L"\" --job-child";
  std::vector<wchar_t> mutableCommand = mutableCommandLine(commandLine);
  STARTUPINFOW startup{};
  startup.cb = static_cast<DWORD>(sizeof(startup));
  PROCESS_INFORMATION processInformation{};

  if (CreateProcessW(
          executable.c_str(),
          mutableCommand.data(),
          nullptr,
          nullptr,
          FALSE,
          CREATE_SUSPENDED | CREATE_NO_WINDOW,
          nullptr,
          nullptr,
          &startup,
          &processInformation) == FALSE) {
    return failJson("job-settlement", "CreateProcessW-suspended", GetLastError());
  }

  ScopedHandle childProcess(processInformation.hProcess);
  ScopedHandle childThread(processInformation.hThread);
  if (AssignProcessToJobObject(job.get(), childProcess.get()) == FALSE) {
    const DWORD assignError = GetLastError();
    terminateAndSettle(childProcess.get());
    return failJson("job-settlement", "AssignProcessToJobObject", assignError);
  }

  if (ResumeThread(childThread.get()) == static_cast<DWORD>(-1)) {
    const DWORD resumeError = GetLastError();
    terminateAndSettle(childProcess.get());
    return failJson("job-settlement", "ResumeThread", resumeError);
  }

  const DWORD wait = WaitForSingleObject(childProcess.get(), kChildTimeoutMs);
  if (wait != WAIT_OBJECT_0) {
    terminateAndSettle(childProcess.get());
    return failJson("job-settlement", wait == WAIT_FAILED ? "WaitForSingleObject" : "child-timeout", wait == WAIT_FAILED ? GetLastError() : ERROR_TIMEOUT);
  }

  DWORD childExitCode = STILL_ACTIVE;
  if (GetExitCodeProcess(childProcess.get(), &childExitCode) == FALSE) {
    return failJson("job-settlement", "GetExitCodeProcess", GetLastError());
  }

  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  if (QueryInformationJobObject(
          job.get(),
          JobObjectBasicAccountingInformation,
          &accounting,
          static_cast<DWORD>(sizeof(accounting)),
          nullptr) == FALSE) {
    return failJson("job-settlement", "QueryInformationJobObject", GetLastError());
  }

  const bool passed = childExitCode == 0 && accounting.ActiveProcesses == 0 &&
      accounting.TotalProcesses >= 1 && accounting.TotalTerminatedProcesses >= 1;
  std::printf(
      "{\"schemaVersion\":1,\"tool\":\"node-repl-win32-audit\",\"mode\":\"job-settlement\",\"status\":\"%s\","
      "\"targetCreatedSuspended\":true,\"targetAssignedToJob\":true,\"targetResumed\":true,"
      "\"childExitCode\":%lu,\"activeProcesses\":%lu,\"totalProcesses\":%lu,\"totalTerminatedProcesses\":%lu}\n",
      passed ? "PASS" : "FAIL",
      static_cast<unsigned long>(childExitCode),
      static_cast<unsigned long>(accounting.ActiveProcesses),
      static_cast<unsigned long>(accounting.TotalProcesses),
      static_cast<unsigned long>(accounting.TotalTerminatedProcesses));
  return passed ? 0 : 1;
}

int usage() {
  std::fwprintf(
      stderr,
      L"Usage: %ls <abi|handle-sentinel|job-settlement>\n",
      kToolName);
  return 64;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc >= 2 && std::wcscmp(argv[1], L"--handle-child") == 0) return runHandleChild(argc, argv);
  if (argc == 2 && std::wcscmp(argv[1], L"--job-child") == 0) return 0;
  if (argc != 2) return usage();
  if (std::wcscmp(argv[1], L"abi") == 0) return runAbi();
  if (std::wcscmp(argv[1], L"handle-sentinel") == 0) return runHandleSentinel();
  if (std::wcscmp(argv[1], L"job-settlement") == 0) return runJobSettlement();
  return usage();
}
