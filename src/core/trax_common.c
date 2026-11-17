#include "trax_common.h"

#include <stdlib.h>
#include <string.h>

/* ------------------------------------------------------------------ */
/* tracked allocation                                                  */
/* ------------------------------------------------------------------ */
/*
 * Each block carries a small header with its size.  The payload is aligned
 * past the header with a union of the strongest scalar types and long double,
 * which is at least as strict as any object the core allocates.  A single
 * free path keeps the live counter honest even though several subsystems own
 * strings that cross module boundaries.
 */
typedef union {
    struct {
        size_t size;
    } h;
    long double align_ld;
    void *align_ptr;
    uint64_t align_u64;
} trax_alloc_header;

#define TRAX_HEADER_SIZE (sizeof(trax_alloc_header))

static size_t g_live_blocks;
static size_t g_live_bytes;

size_t trax_alloc_live_blocks(void) { return g_live_blocks; }
size_t trax_alloc_live_bytes(void) { return g_live_bytes; }

void *trax_malloc(size_t size) {
    if (size == 0) size = 1;
    if (size > (size_t)-1 - TRAX_HEADER_SIZE) return NULL;
    trax_alloc_header *block =
        (trax_alloc_header *)malloc(TRAX_HEADER_SIZE + size);
    if (!block) return NULL;
    block->h.size = size;
    ++g_live_blocks;
    g_live_bytes += size;
    return (void *)((char *)block + TRAX_HEADER_SIZE);
}

void *trax_calloc(size_t count, size_t elem_size) {
    if (elem_size == 0) return NULL;
    if (count > (size_t)-1 / elem_size) return NULL;
    size_t total = count * elem_size;
    void *p = trax_malloc(total);
    if (p) memset(p, 0, total);
    return p;
}

void *trax_realloc(void *ptr, size_t size) {
    if (!ptr) return trax_malloc(size);
    if (size == 0) {
        trax_free(ptr);
        return NULL;
    }
    if (size > (size_t)-1 - TRAX_HEADER_SIZE) return NULL;
    trax_alloc_header *block =
        (trax_alloc_header *)((char *)ptr - TRAX_HEADER_SIZE);
    size_t old = block->h.size;
    trax_alloc_header *grown =
        (trax_alloc_header *)realloc(block, TRAX_HEADER_SIZE + size);
    if (!grown) return NULL;
    grown->h.size = size;
    g_live_bytes = g_live_bytes - old + size;
    return (void *)((char *)grown + TRAX_HEADER_SIZE);
}

void trax_free(void *ptr) {
    if (!ptr) return;
    trax_alloc_header *block =
        (trax_alloc_header *)((char *)ptr - TRAX_HEADER_SIZE);
    g_live_bytes -= block->h.size;
    --g_live_blocks;
    free(block);
}

void *trax_reallocarray(void *ptr, size_t count, size_t elem_size) {
    if (elem_size == 0) return NULL;
    if (count > (size_t)-1 / elem_size) return NULL;
    return trax_realloc(ptr, count * elem_size);
}

/* ------------------------------------------------------------------ */
/* strings                                                             */
/* ------------------------------------------------------------------ */

size_t trax_strnlen(const char *s, size_t max) {
    size_t n = 0;
    if (!s) return 0;
    while (n < max && s[n]) ++n;
    return n;
}

char *trax_strdup(const char *s) {
    if (!s) return NULL;
    size_t n = strlen(s);
    char *out = (char *)trax_malloc(n + 1);
    if (!out) return NULL;
    memcpy(out, s, n + 1);
    return out;
}

char *trax_strndup(const char *s, size_t n) {
    if (!s) return NULL;
    size_t len = trax_strnlen(s, n);
    char *out = (char *)trax_malloc(len + 1);
    if (!out) return NULL;
    memcpy(out, s, len);
    out[len] = '\0';
    return out;
}

char trax_ascii_tolower(char c) {
    return (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c;
}

void trax_str_lower_ascii(char *s) {
    if (!s) return;
    for (; *s; ++s) *s = trax_ascii_tolower(*s);
}

bool trax_str_ieq(const char *a, const char *b) {
    if (a == b) return true;
    if (!a || !b) return false;
    while (*a && *b) {
        if (trax_ascii_tolower(*a) != trax_ascii_tolower(*b)) return false;
        ++a;
        ++b;
    }
    return *a == '\0' && *b == '\0';
}

bool trax_str_ieq_n(const char *a, const char *b, size_t n) {
    if (a == b) return true;
    if (!a || !b) return false;
    for (size_t i = 0; i < n; ++i) {
        if (trax_ascii_tolower(a[i]) != trax_ascii_tolower(b[i])) return false;
        if (!a[i]) return true;
    }
    return true;
}

bool trax_str_ends_with_ci(const char *s, const char *suffix) {    if (!s || !suffix) return false;
    size_t n = strlen(s), m = strlen(suffix);
    if (m > n) return false;
    return trax_str_ieq(s + (n - m), suffix);
}

int trax_name_compare(const char *a, const char *b) {
    const char *pa = a ? a : "";
    const char *pb = b ? b : "";
    const unsigned char *x = (const unsigned char *)pa;
    const unsigned char *y = (const unsigned char *)pb;
    while (*x && *y) {
        unsigned char cx = (unsigned char)trax_ascii_tolower((char)*x);
        unsigned char cy = (unsigned char)trax_ascii_tolower((char)*y);
        if (cx != cy) return cx < cy ? -1 : 1;
        ++x;
        ++y;
    }
    if (*x != *y) return *x ? 1 : -1;
    /* Case-insensitive equal: fall back to bytes so "A" and "a" keep a
     * stable, total order. */
    return strcmp(pa, pb);
}

uint64_t trax_hash_fnv1a(const void *data, size_t len) {
    return trax_hash_fnv1a_update(1469598103934665603ull, data, len);
}

uint64_t trax_hash_fnv1a_update(uint64_t h, const void *data, size_t len) {
    const unsigned char *p = (const unsigned char *)data;
    for (size_t i = 0; i < len; ++i) {
        h ^= p[i];
        h *= 1099511628211ull;
    }
    return h;
}

/* ------------------------------------------------------------------ */
/* paths                                                               */
/* ------------------------------------------------------------------ */

char *trax_path_normalize(const char *path) {
    if (!path || !*path) return NULL;
    size_t n = strlen(path);
    if (n > TRAX_SCAN_MAX_PATH) return NULL;
    char *out = (char *)trax_malloc(n + 1);
    if (!out) return NULL;

    size_t w = 0;
    bool prev_sep = false;
    for (size_t i = 0; i < n; ++i) {
        char c = path[i];
        if (c == '\\' || c == '/') {
            if (prev_sep) continue;
            /* A single leading separator marks an absolute path and is kept;
             * a device prefix such as "ux0:/MUSIC" carries its colon before
             * the separator, so this cannot swallow it. */
            out[w++] = '/';
            prev_sep = true;
        } else {
            out[w++] = c;
            prev_sep = false;
        }
    }
    while (w > 0 && out[w - 1] == '/') --w;
    out[w] = '\0';
    if (w == 0) {
        trax_free(out);
        return NULL;
    }
    return out;
}

char *trax_path_join(const char *base, const char *name) {
    if (!base || !name) return NULL;
    size_t b = strlen(base), n = strlen(name);
    bool need_sep = b > 0 && base[b - 1] != '/';
    if (b + n + 2 > TRAX_SCAN_MAX_PATH) return NULL;
    char *out = (char *)trax_malloc(b + (need_sep ? 1 : 0) + n + 1);
    if (!out) return NULL;
    memcpy(out, base, b);
    size_t w = b;
    if (need_sep) out[w++] = '/';
    memcpy(out + w, name, n + 1);
    return out;
}

const char *trax_path_basename(const char *path) {
    if (!path) return "";
    const char *last = path;
    for (const char *p = path; *p; ++p) {
        if (*p == '/' || *p == '\\') last = p + 1;
    }
    return last;
}

const char *trax_path_extension(const char *name) {
    if (!name) return "";
    const char *dot = NULL;
    for (const char *p = name; *p; ++p) {
        if (*p == '.') dot = p;
        else if (*p == '/' || *p == '\\') dot = NULL;
    }
    return dot ? dot : name + strlen(name);
}

char *trax_path_stem(const char *name) {
    if (!name) return NULL;
    const char *base = trax_path_basename(name);
    const char *ext = trax_path_extension(base);
    return trax_strndup(base, (size_t)(ext - base));
}

bool trax_path_is_plain_name(const char *name) {
    if (!name || !*name) return false;
    if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) return false;
    for (const char *p = name; *p; ++p) {
        if (*p == '/' || *p == '\\') return false;
    }
    return true;
}

/* ------------------------------------------------------------------ */
/* vectors and cancellation                                            */
/* ------------------------------------------------------------------ */

bool trax_vec_reserve(void **items, size_t *cap, size_t need, size_t elem_size) {
    if (need <= *cap) return true;
    size_t next = *cap ? *cap : 8;
    while (next < need) {
        if (next > (size_t)-1 / 2) {
            next = need;
            break;
        }
        next *= 2;
    }
    void *p = trax_reallocarray(*items, next, elem_size);
    if (!p) return false;
    *items = p;
    *cap = next;
    return true;
}

void trax_cancel_init(trax_cancel_flag *flag) {
#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L && \
    !defined(__STDC_NO_ATOMICS__)
    atomic_init(&flag->value, 0);
#else
    flag->value = 0;
#endif
}

void trax_cancel_reset(trax_cancel_flag *flag) {
#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L && \
    !defined(__STDC_NO_ATOMICS__)
    atomic_store(&flag->value, 0);
#else
    flag->value = 0;
#endif
}

void trax_cancel_request(trax_cancel_flag *flag) {
#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L && \
    !defined(__STDC_NO_ATOMICS__)
    atomic_store(&flag->value, 1);
#else
    flag->value = 1;
#endif
}

bool trax_cancel_requested(const trax_cancel_flag *flag) {
#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L && \
    !defined(__STDC_NO_ATOMICS__)
    return atomic_load(&flag->value) != 0;
#else
    return flag->value != 0;
#endif
}
