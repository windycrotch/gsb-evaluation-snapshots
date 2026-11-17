#include "trax_log.h"

#include <stdio.h>
#include <string.h>

#define TRAX_LOG_RETAIN 4096

struct trax_log {
    trax_log_sink sink;
    void *sink_user;
    trax_log_level min_level;
    FILE *file;

    char **lines;
    size_t retained;
    size_t cap;
    size_t total;
};

static const char *level_name(trax_log_level level) {
    switch (level) {
    case TRAX_LOG_DEBUG: return "debug";
    case TRAX_LOG_INFO: return "info";
    case TRAX_LOG_WARN: return "warn";
    case TRAX_LOG_ERROR: return "error";
    }
    return "info";
}

trax_log *trax_log_create(void) {
    trax_log *log = (trax_log *)trax_calloc(1, sizeof(*log));
    if (!log) return NULL;
    log->min_level = TRAX_LOG_INFO;
    return log;
}

void trax_log_destroy(trax_log *log) {
    if (!log) return;
    trax_log_close_file(log);
    for (size_t i = 0; i < log->retained; ++i) trax_free(log->lines[i]);
    trax_free(log->lines);
    trax_free(log);
}

void trax_log_set_sink(trax_log *log, trax_log_sink sink, void *user) {
    if (!log) return;
    log->sink = sink;
    log->sink_user = user;
}

void trax_log_set_min_level(trax_log *log, trax_log_level level) {
    if (log) log->min_level = level;
}

bool trax_log_open_file(trax_log *log, const char *path) {
    if (!log || !path) return false;
    trax_log_close_file(log);
    log->file = fopen(path, "ab");
    return log->file != NULL;
}

void trax_log_close_file(trax_log *log) {
    if (log && log->file) {
        fclose(log->file);
        log->file = NULL;
    }
}

static void retain_line(trax_log *log, const char *line) {
    if (log->retained == TRAX_LOG_RETAIN) {
        trax_free(log->lines[0]);
        memmove(log->lines, log->lines + 1, (log->retained - 1) * sizeof(char *));
        --log->retained;
    }
    if (!trax_vec_reserve((void **)&log->lines, &log->cap, log->retained + 1,
                          sizeof(char *))) {
        return;
    }
    char *copy = trax_strdup(line);
    if (copy) log->lines[log->retained++] = copy;
}

void trax_log_vprintf(trax_log *log, trax_log_level level, const char *fmt, va_list ap) {
    if (!log || !fmt) return;
    ++log->total;
    /* Errors are always kept: a bad folder is exactly what a user's log is
     * attached to diagnose. */
    if (level < log->min_level && level != TRAX_LOG_ERROR) return;

    va_list measure;
    va_copy(measure, ap);
    int body_len = vsnprintf(NULL, 0, fmt, measure);
    va_end(measure);
    if (body_len < 0) return;

    const char *name = level_name(level);
    size_t prefix_len = strlen(name) + 3;
    char *line = (char *)trax_malloc(prefix_len + (size_t)body_len + 1);
    if (!line) return;
    line[0] = '[';
    memcpy(line + 1, name, strlen(name));
    memcpy(line + 1 + strlen(name), "] ", 2);
    vsnprintf(line + prefix_len, (size_t)body_len + 1, fmt, ap);

    if (log->file) {
        fputs(line, log->file);
        fputc('\n', log->file);
        fflush(log->file);
    }
    retain_line(log, line);
    if (log->sink) log->sink(log->sink_user, level, line);
    trax_free(line);
}

void trax_log_printf(trax_log *log, trax_log_level level, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    trax_log_vprintf(log, level, fmt, ap);
    va_end(ap);
}

size_t trax_log_retained_count(const trax_log *log) {
    return log ? log->retained : 0;
}

size_t trax_log_line_count(const trax_log *log) {
    return log ? log->total : 0;
}

const char *trax_log_line_at(const trax_log *log, size_t index) {
    if (!log || index >= log->retained) return NULL;
    return log->lines[index];
}

bool trax_log_contains(const trax_log *log, const char *needle) {
    if (!log || !needle) return false;
    size_t n = strlen(needle);
    for (size_t i = 0; i < log->retained; ++i) {
        const char *hay = log->lines[i];
        size_t h = strlen(hay);
        if (n > h) continue;
        for (size_t k = 0; k + n <= h; ++k) {
            if (trax_str_ieq_n(hay + k, needle, n)) return true;
        }
    }
    return false;
}

void trax_log_clear(trax_log *log) {
    if (!log) return;
    for (size_t i = 0; i < log->retained; ++i) trax_free(log->lines[i]);
    log->retained = 0;
    log->total = 0;
}
