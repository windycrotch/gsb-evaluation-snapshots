/*
 * trax_log.h - the log TRAX keeps beside itself.
 *
 * The scanner records what it had to skip (an unreadable folder, a folder over
 * the 1024-track limit, a cue sheet that named no audio) here rather than
 * aborting, so a real card with one bad directory still yields a usable index.
 * Lines are also retained in memory, which is what the acceptance suite
 * inspects; the file sink is what a user attaches to a bug report.
 */
#ifndef TRAX_LOG_H
#define TRAX_LOG_H

#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>

#include "trax_common.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    TRAX_LOG_DEBUG = 0,
    TRAX_LOG_INFO,
    TRAX_LOG_WARN,
    TRAX_LOG_ERROR
} trax_log_level;

typedef void (*trax_log_sink)(void *user, trax_log_level level, const char *line);

typedef struct trax_log trax_log;

trax_log *trax_log_create(void);
void trax_log_destroy(trax_log *log);

/* A sink sees every line after the prefix; used by tests and by the UI. */
void trax_log_set_sink(trax_log *log, trax_log_sink sink, void *user);
/* A sink may also be set to filter out debug chatter. */
void trax_log_set_min_level(trax_log *log, trax_log_level level);

/* Append to a file.  Returns false when the file cannot be opened; the log
 * still works in memory. */
bool trax_log_open_file(trax_log *log, const char *path);
void trax_log_close_file(trax_log *log);

void trax_log_printf(trax_log *log, trax_log_level level, const char *fmt, ...);
void trax_log_vprintf(trax_log *log, trax_log_level level, const char *fmt, va_list ap);

/* In-memory copy of the lines, newest last.  `line_count` is the number ever
 * written, which may exceed `retained_count` if old lines were dropped. */
size_t trax_log_retained_count(const trax_log *log);
size_t trax_log_line_count(const trax_log *log);
const char *trax_log_line_at(const trax_log *log, size_t index);
/* Case-insensitive substring search over the retained lines. */
bool trax_log_contains(const trax_log *log, const char *needle);
void trax_log_clear(trax_log *log);

#ifdef __cplusplus
}
#endif

#endif /* TRAX_LOG_H */
