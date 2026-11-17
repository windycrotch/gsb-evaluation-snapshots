/*
 * trax_common.h - small shared primitives for the TRAX core.
 *
 * Everything here is plain C11 with no libc beyond stdlib/string, so the same
 * code compiles for the PSP, the Vita and the desktop host used by the tests.
 * The core never opens audio files: an index is built from directory
 * listings, names and sizes alone.
 */
#ifndef TRAX_COMMON_H
#define TRAX_COMMON_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* One folder shows and plays up to 1024 tracks, and a cue sheet up to the
 * same (MANUAL.html: "One folder shows and plays up to 1024 tracks, and a cue
 * sheet up to the same").  The scanner enforces both limits. */
#define TRAX_TRACKS_PER_FOLDER_LIMIT 1024u

/* Guard against pathological / cyclic cards without refusing real libraries. */
#define TRAX_SCAN_MAX_DEPTH 64u
#define TRAX_SCAN_MAX_PATH 4096u

typedef enum {
    TRAX_OK = 0,
    TRAX_ERR = -1,
    TRAX_CANCELLED = -2,
    TRAX_CACHE_MISS = -3
} trax_status;

/*
 * Allocation helpers.  Every allocation the core hands out - including the
 * strings returned by trax_library_track_path() and trax_gallery_cover_path()
 * - is made here and must be released with trax_free().
 *
 * The helpers keep a live block/byte count.  That is what lets the acceptance
 * suite prove that a cancelled scan leaves nothing behind: it compares the
 * counter before and after.  The bookkeeping is cheap (a few arithmetic
 * operations per allocation) and is compiled in on every build on purpose.
 */
void *trax_malloc(size_t size);
void *trax_calloc(size_t count, size_t elem_size);
void *trax_realloc(void *ptr, size_t size);
void trax_free(void *ptr);

/* Live allocations made through the helpers above.  Used by the tests. */
size_t trax_alloc_live_blocks(void);
size_t trax_alloc_live_bytes(void);

/* Allocation helpers. These return NULL on failure; callers must handle it. */
void *trax_reallocarray(void *ptr, size_t count, size_t elem_size);
char *trax_strdup(const char *s);
char *trax_strndup(const char *s, size_t n);
size_t trax_strnlen(const char *s, size_t max);

/* ASCII-only case folding; card names are bytes, not locale. */
char trax_ascii_tolower(char c);
bool trax_str_ieq(const char *a, const char *b);
/* Case-insensitive comparison of the first `n` bytes of both strings. */
bool trax_str_ieq_n(const char *a, const char *b, size_t n);
bool trax_str_ends_with_ci(const char *s, const char *suffix);
void trax_str_lower_ascii(char *s);

/* Deterministic name order: ASCII case-insensitive first, then bytewise. */
int trax_name_compare(const char *a, const char *b);

uint64_t trax_hash_fnv1a(const void *data, size_t len);
uint64_t trax_hash_fnv1a_update(uint64_t hash, const void *data, size_t len);

/*
 * Paths are '/'-separated inside the core, independent of the host.
 * trax_path_normalize() converts backslashes, collapses repeated separators,
 * keeps at most one leading separator, drops a trailing separator and returns
 * a freshly allocated string, or NULL when the input is empty.  A device
 * prefix such as "ux0:" or "grw0:" is not a separator and is preserved.  It
 * does not resolve "." / ".." components.
 */
char *trax_path_normalize(const char *path);
char *trax_path_join(const char *base, const char *name);
const char *trax_path_basename(const char *path);
/* Last extension including the dot, or a pointer to the terminating NUL. */
const char *trax_path_extension(const char *name);
/* File name without its directory and its last extension, freshly allocated. */
char *trax_path_stem(const char *name);
/* True for a name a directory listing may legitimately return as a child. */
bool trax_path_is_plain_name(const char *name);

/*
 * Grow *items so it can hold at least `need` elements.  On failure the old
 * block is untouched and false is returned.
 */
bool trax_vec_reserve(void **items, size_t *cap, size_t need, size_t elem_size);

/*
 * A cancellation flag that may be raised from another thread (the UI thread)
 * while the scanner runs.  The implementation uses C11 atomics where they are
 * available and a volatile int otherwise; either way trax_cancel_requested()
 * is the only reader the scanner uses.
 */
#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L && \
    !defined(__STDC_NO_ATOMICS__)
#include <stdatomic.h>
typedef struct {
    atomic_int value;
} trax_cancel_flag;
#else
typedef struct {
    volatile int value;
} trax_cancel_flag;
#endif

void trax_cancel_init(trax_cancel_flag *flag);
void trax_cancel_reset(trax_cancel_flag *flag);
void trax_cancel_request(trax_cancel_flag *flag);
bool trax_cancel_requested(const trax_cancel_flag *flag);

#ifdef __cplusplus
}
#endif

#endif /* TRAX_COMMON_H */
