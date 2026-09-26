#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/*
 * Starts an agent CLI inside a job object, so that the CLI and every process it starts end together.
 *
 *   asist-agent-launcher --version
 *   asist-agent-launcher <program.exe> [arguments...]
 *
 * The program starts suspended and is resumed only once it is in the job, so no child it creates can
 * escape. The job kills whatever is left in it when its last handle closes, which is when the launcher
 * exits for any reason, killed included. The launcher exits with the exit code of the program.
 *
 * Only an .exe is started. CreateProcess runs a .cmd or .bat through cmd.exe, which reads the quotes and
 * parentheses in the arguments ASIST passes as its own syntax.
 */

#define LAUNCHER_VERSION "1"

static int fail(const char *what)
{
    DWORD error = GetLastError();
    fprintf(stderr, "asist-agent-launcher: %s failed with error %lu\n", what, error);
    return 1;
}

static int is_exe(const wchar_t *program)
{
    size_t length = wcslen(program);
    return length > 4 && _wcsicmp(program + length - 4, L".exe") == 0;
}

/**
 * Appends arg to out quoted so that CommandLineToArgvW and the C runtime read it back unchanged, and
 * returns the end. A run of backslashes is doubled only before a quote, where the parser halves it.
 */
static wchar_t *append_quoted(wchar_t *out, const wchar_t *arg)
{
    if (*arg != L'\0' && wcspbrk(arg, L" \t\n\v\"") == NULL) {
        size_t length = wcslen(arg);
        wmemcpy(out, arg, length);
        return out + length;
    }
    *out++ = L'"';
    for (const wchar_t *p = arg;; p++) {
        size_t backslashes = 0;
        while (*p == L'\\') {
            p++;
            backslashes++;
        }
        if (*p == L'\0') {
            for (size_t i = 0; i < backslashes * 2; i++) *out++ = L'\\';
            break;
        }
        if (*p == L'"') {
            for (size_t i = 0; i < backslashes * 2 + 1; i++) *out++ = L'\\';
        } else {
            for (size_t i = 0; i < backslashes; i++) *out++ = L'\\';
        }
        *out++ = *p;
    }
    *out++ = L'"';
    return out;
}

/** The command line of argv[first..argc-1]. Quoting at most doubles an argument, plus its quotes and a space. */
static wchar_t *command_line(int argc, wchar_t **argv, int first)
{
    size_t capacity = 1;
    for (int i = first; i < argc; i++) capacity += wcslen(argv[i]) * 2 + 3;
    wchar_t *line = malloc(capacity * sizeof(wchar_t));
    if (line == NULL) return NULL;
    wchar_t *end = line;
    for (int i = first; i < argc; i++) {
        if (i > first) *end++ = L' ';
        end = append_quoted(end, argv[i]);
    }
    *end = L'\0';
    return line;
}

int wmain(int argc, wchar_t **argv)
{
    if (argc == 2 && wcscmp(argv[1], L"--version") == 0) {
        printf("asist-agent-launcher %s\n", LAUNCHER_VERSION);
        return 0;
    }
    if (argc < 2) {
        fprintf(stderr, "usage: asist-agent-launcher --version | <program.exe> [arguments...]\n");
        return 1;
    }
    if (!is_exe(argv[1])) {
        fprintf(stderr, "asist-agent-launcher: %ls is not an .exe\n", argv[1]);
        return 1;
    }

    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (job == NULL) return fail("CreateJobObject");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    ZeroMemory(&limits, sizeof limits);
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits)) {
        return fail("SetInformationJobObject");
    }

    wchar_t *line = command_line(argc, argv, 1);
    if (line == NULL) {
        fprintf(stderr, "asist-agent-launcher: out of memory\n");
        return 1;
    }

    // The standard handles came from ASIST as inheritable pipes, so the program writes straight into them.
    STARTUPINFOW startup;
    ZeroMemory(&startup, sizeof startup);
    startup.cb = sizeof startup;
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);

    // With the program as the application name, CreateProcess neither searches for it nor appends .exe.
    PROCESS_INFORMATION child;
    if (!CreateProcessW(argv[1], line, NULL, NULL, TRUE, CREATE_SUSPENDED, NULL, NULL, &startup, &child)) {
        return fail("CreateProcess");
    }
    free(line);
    if (!AssignProcessToJobObject(job, child.hProcess)) {
        int code = fail("AssignProcessToJobObject");
        TerminateProcess(child.hProcess, 1);
        return code;
    }
    if (ResumeThread(child.hThread) == (DWORD)-1) {
        int code = fail("ResumeThread");
        TerminateProcess(child.hProcess, 1);
        return code;
    }
    CloseHandle(child.hThread);

    if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0) return fail("WaitForSingleObject");
    DWORD exit_code;
    if (!GetExitCodeProcess(child.hProcess, &exit_code)) return fail("GetExitCodeProcess");
    CloseHandle(child.hProcess);
    // Closing the job kills what the program left running.
    CloseHandle(job);
    return (int)exit_code;
}
