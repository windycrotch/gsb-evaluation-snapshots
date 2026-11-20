/*
 * Test-only shim that presents itself as "ffmpeg" on PATH and forwards to
 * fake_ffmpeg.py in the same directory. Built by test/test_video_export_session.py
 * with a C compiler; no production code references it.
 */
#if defined(_WIN32)
#  include <windows.h>
#  include <stdio.h>
#  include <stdlib.h>
#  include <string.h>

int main(int argc, char *argv[]) {
    char dir[MAX_PATH];
    char script[MAX_PATH];
    char cmd[32768];
    int i, n;

    if (!GetModuleFileNameA(NULL, dir, MAX_PATH)) {
        return 90;
    }
    char *slash = strrchr(dir, '\\');
    if (slash) {
        *slash = '\0';
    }
    snprintf(script, sizeof(script), "%s\\fake_ffmpeg.py", dir);

    n = snprintf(cmd, sizeof(cmd), "python \"%s\"", script);
    for (i = 1; i < argc && n < (int)sizeof(cmd) - 4; i++) {
        n += snprintf(cmd + n, sizeof(cmd) - n, " \"%s\"", argv[i]);
    }

    int rc = system(cmd);
    if (rc == -1) {
        return 91;
    }
    return rc;
}

#else  /* POSIX: Linux / macOS */
#  include <stdio.h>
#  include <stdlib.h>
#  include <string.h>
#  include <unistd.h>
#  include <libgen.h>
#  include <sys/types.h>
#  include <sys/stat.h>
#  if defined(__APPLE__)
#    include <mach-o/dyld.h>
#  endif

static void executableDir(char *buf, size_t cap) {
#if defined(__linux__)
    ssize_t n = readlink("/proc/self/exe", buf, cap - 1);
    if (n > 0) {
        buf[n] = '\0';
    } else {
        strncpy(buf, ".", cap);
    }
#elif defined(__APPLE__)
    uint32_t size = (uint32_t)cap;
    if (_NSGetExecutablePath(buf, &size) != 0) {
        strncpy(buf, ".", cap);
    }
#else
    strncpy(buf, ".", cap);
#endif
    char *slash = strrchr(buf, '/');
    if (slash) {
        *slash = '\0';
    }
}

int main(int argc, char *argv[]) {
    char exePath[4096];
    char script[4096];
    executableDir(exePath, sizeof(exePath));
    snprintf(script, sizeof(script), "%s/fake_ffmpeg.py", exePath);

    char *pyArgs[argc + 3];
    pyArgs[0] = (char *)"python";
    pyArgs[1] = script;
    for (int i = 1; i < argc; i++) {
        pyArgs[i + 1] = argv[i];
    }
    pyArgs[argc + 1] = NULL;

    execvp("python", pyArgs);
    return 91;  /* execvp only returns on failure */
}
#endif
