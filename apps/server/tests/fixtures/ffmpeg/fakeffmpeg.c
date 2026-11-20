/*
 * A stand-in for ffmpeg in the radio tests. The real thing can't be assumed in CI,
 * but the server only needs a child process that reads what it's given, emits a byte
 * once it's "producing audio", and dies when killed.
 *
 * Modes, chosen from its arguments exactly like stream.ts's transcode():
 *   - piped (`-i pipe:0`): drains stdin (the upstream stream) and echoes a byte per read
 *   - address (anything else): emits a byte on a timer
 *
 * Test knobs via the environment:
 *   FAKE_FFMPEG_LOG       a file every spawn appends "<pid> start <mode>\n" to
 *   FAKE_FFMPEG_DELAY_MS  wait this long before the first output byte (slow startup)
 *   FAKE_FFMPEG_FAIL      exit non-zero at once (an encoder that never starts)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <io.h>
#include <process.h>
#include <windows.h>
#define getpid _getpid
#else
#include <unistd.h>
#endif

static void emit(void) {
  char one = 0x4f; /* 'O' */
#ifdef _WIN32
  _write(1, &one, 1);
#else
  write(1, &one, 1);
#endif
}

static void nap(unsigned ms) {
#ifdef _WIN32
  Sleep(ms);
#else
  usleep((useconds_t)ms * 1000);
#endif
}

int main(int argc, char **argv) {
  int piped = 0;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "-i") == 0 && i + 1 < argc && strcmp(argv[i + 1], "pipe:0") == 0) piped = 1;
  }

  const char *logpath = getenv("FAKE_FFMPEG_LOG");
  if (logpath) {
    FILE *f = fopen(logpath, "a");
    if (f) {
      fprintf(f, "%ld start %s\n", (long)getpid(), piped ? "piped" : "url");
      fflush(f);
      fclose(f);
    }
  }

  const char *delay = getenv("FAKE_FFMPEG_DELAY_MS");
  if (delay && atoi(delay) > 0) nap((unsigned)atoi(delay));
  if (getenv("FAKE_FFMPEG_FAIL")) return 1;

  /* One buffered byte is what transcode() waits on before resolving. */
  emit();

  if (piped) {
    char buf[4096];
    for (;;) {
#ifdef _WIN32
      int n = _read(0, buf, (unsigned int)sizeof buf);
#else
      ssize_t n = read(0, buf, sizeof buf);
#endif
      if (n <= 0) break;
      emit();
    }
  } else {
    for (;;) {
      nap(50);
      emit();
    }
  }
  return 0;
}
