#include "trax_index_cache.h"

#include <string.h>

#define TRAX_CACHE_MAGIC "TRAXCIDX"
#define TRAX_CACHE_MAGIC_LEN 8u
#define TRAX_CACHE_VERSION 2u
/* A card could hold a very large library, but a file past this size is not
 * one of ours; reading it would only waste memory. */
#define TRAX_CACHE_MAX_BYTES (64u * 1024u * 1024u)
#define TRAX_CACHE_NULL_STRING 0xFFFFFFFFu

char *trax_index_cache_default_path(const char *music_folder) {
    if (!music_folder) return NULL;
    return trax_path_join(music_folder, TRAX_INDEX_CACHE_NAME);
}

/* ------------------------------------------------------------------ */
/* writer                                                              */
/* ------------------------------------------------------------------ */

typedef struct {
    unsigned char *data;
    size_t len;
    size_t cap;
    bool failed;
} cache_writer;

static void writer_free(cache_writer *w) {
    trax_free(w->data);
    memset(w, 0, sizeof(*w));
}

static bool writer_reserve(cache_writer *w, size_t extra) {
    if (w->failed) return false;
    if (w->len + extra <= w->cap) return true;
    size_t need = w->len + extra;
    size_t next = w->cap ? w->cap : 256;
    while (next < need) next *= 2;
    unsigned char *grown = (unsigned char *)trax_realloc(w->data, next);
    if (!grown) {
        w->failed = true;
        return false;
    }
    w->data = grown;
    w->cap = next;
    return true;
}

static void w_bytes(cache_writer *w, const void *data, size_t len) {
    if (!writer_reserve(w, len)) return;
    memcpy(w->data + w->len, data, len);
    w->len += len;
}

static void w_u8(cache_writer *w, uint8_t v) { w_bytes(w, &v, 1); }

static void w_u32(cache_writer *w, uint32_t v) {
    unsigned char b[4];
    b[0] = (unsigned char)(v & 0xFFu);
    b[1] = (unsigned char)((v >> 8) & 0xFFu);
    b[2] = (unsigned char)((v >> 16) & 0xFFu);
    b[3] = (unsigned char)((v >> 24) & 0xFFu);
    w_bytes(w, b, sizeof(b));
}

static void w_u64(cache_writer *w, uint64_t v) {
    unsigned char b[8];
    for (int i = 0; i < 8; ++i) b[i] = (unsigned char)((v >> (8 * i)) & 0xFFu);
    w_bytes(w, b, sizeof(b));
}

static void w_string(cache_writer *w, const char *s) {
    if (!s) {
        w_u32(w, TRAX_CACHE_NULL_STRING);
        return;
    }
    size_t n = strlen(s);
    if (n >= TRAX_CACHE_NULL_STRING) {
        w->failed = true;
        return;
    }
    w_u32(w, (uint32_t)n);
    w_bytes(w, s, n);
}

/* ------------------------------------------------------------------ */
/* reader                                                              */
/* ------------------------------------------------------------------ */

typedef struct {
    const unsigned char *data;
    size_t len;
    size_t pos;
    bool failed;
} cache_reader;

static bool r_need(cache_reader *r, size_t n) {
    if (r->failed || r->len - r->pos < n) {
        r->failed = true;
        return false;
    }
    return true;
}

static uint8_t r_u8(cache_reader *r) {
    if (!r_need(r, 1)) return 0;
    return r->data[r->pos++];
}

static uint32_t r_u32(cache_reader *r) {
    if (!r_need(r, 4)) return 0;
    uint32_t v = (uint32_t)r->data[r->pos] |
                 ((uint32_t)r->data[r->pos + 1] << 8) |
                 ((uint32_t)r->data[r->pos + 2] << 16) |
                 ((uint32_t)r->data[r->pos + 3] << 24);
    r->pos += 4;
    return v;
}

static uint64_t r_u64(cache_reader *r) {
    if (!r_need(r, 8)) return 0;
    uint64_t v = 0;
    for (int i = 0; i < 8; ++i) {
        v |= (uint64_t)r->data[r->pos + (size_t)i] << (8 * i);
    }
    r->pos += 8;
    return v;
}

/* Reads a string the writer wrote; NULL when the marker said so.  A read
 * failure leaves *out NULL and sets r->failed. */
static char *r_string(cache_reader *r) {
    uint32_t n = r_u32(r);
    if (r->failed) return NULL;
    if (n == TRAX_CACHE_NULL_STRING) return NULL;
    if (!r_need(r, n)) return NULL;
    char *s = trax_strndup((const char *)r->data + r->pos, n);
    if (!s) {
        r->failed = true;
        return NULL;
    }
    r->pos += n;
    return s;
}

/* A string that must be present. */
static bool r_required_string(cache_reader *r, char **out) {
    uint32_t n = r_u32(r);
    if (r->failed) return false;
    if (n == TRAX_CACHE_NULL_STRING) {
        /* Required field missing: an index without a folder name or a track
         * file name is not usable. */
        r->failed = true;
        return false;
    }
    if (!r_need(r, n)) return false;
    char *s = trax_strndup((const char *)r->data + r->pos, n);
    if (!s) {
        r->failed = true;
        return false;
    }
    r->pos += n;
    *out = s;
    return true;
}

/* ------------------------------------------------------------------ */
/* save                                                                */
/* ------------------------------------------------------------------ */

trax_status trax_index_cache_save(const trax_host *host, trax_log *log,
                                 const char *path, const trax_library *lib) {
    if (!host || !host->write_file || !path || !lib) return TRAX_ERR;
    if (!lib->valid) {
        /* The rule that matters: a half-built index is never written. */
        trax_log_printf(log, TRAX_LOG_WARN,
                        "index for %s is incomplete; not cached",
                        lib->music_folder ? lib->music_folder : "(unknown)");
        return TRAX_ERR;
    }

    cache_writer w;
    memset(&w, 0, sizeof(w));
    w_u64(&w, lib->fingerprint);
    w_u64(&w, lib->built_ms);
    w_u32(&w, lib->folders_total);
    w_u32(&w, lib->folders_skipped);
    w_u32(&w, lib->folders_capped);
    w_string(&w, lib->music_folder);

    if (lib->folder_count > UINT32_MAX || lib->track_count > UINT32_MAX ||
        lib->album_count > UINT32_MAX) {
        writer_free(&w);
        return TRAX_ERR;
    }
    w_u32(&w, (uint32_t)lib->folder_count);
    for (size_t i = 0; i < lib->folder_count; ++i) {
        w_string(&w, lib->folders[i]);
    }

    w_u32(&w, (uint32_t)lib->track_count);
    for (size_t i = 0; i < lib->track_count; ++i) {
        const trax_track *t = &lib->tracks[i];
        w_u32(&w, t->folder);
        w_u32(&w, t->cue_track);
        w_u32(&w, t->cue_index);
        w_u8(&w, (uint8_t)t->kind);
        w_string(&w, t->file_name);
        w_string(&w, t->title);
    }

    w_u32(&w, (uint32_t)lib->album_count);
    for (size_t i = 0; i < lib->album_count; ++i) {
        const trax_album *a = &lib->albums[i];
        w_u32(&w, a->folder);
        w_u32(&w, a->first_track);
        w_u32(&w, a->track_count);
        w_u8(&w, a->from_cue ? 1u : 0u);
        w_string(&w, a->title);
        w_string(&w, a->cover_name);
        w_string(&w, a->cue_file);
    }

    if (w.failed) {
        writer_free(&w);
        trax_log_printf(log, TRAX_LOG_ERROR,
                        "could not build the index file for %s", path);
        return TRAX_ERR;
    }

    uint64_t checksum = trax_hash_fnv1a(w.data, w.len);

    cache_writer file;
    memset(&file, 0, sizeof(file));
    w_bytes(&file, TRAX_CACHE_MAGIC, TRAX_CACHE_MAGIC_LEN);
    w_u32(&file, TRAX_CACHE_VERSION);
    w_u32(&file, (uint32_t)w.len);
    w_u64(&file, checksum);
    w_bytes(&file, w.data, w.len);
    writer_free(&w);
    if (file.failed) {
        writer_free(&file);
        return TRAX_ERR;
    }

    trax_status st = host->write_file(host->user, path, file.data, file.len);
    writer_free(&file);
    if (st != TRAX_OK) {
        trax_log_printf(log, TRAX_LOG_WARN,
                        "index for %s could not be written to %s; the next "
                        "entry will read the card again",
                        lib->music_folder ? lib->music_folder : "(unknown)", path);
        return TRAX_ERR;
    }
    trax_log_printf(log, TRAX_LOG_INFO,
                    "indexed %s: %u tracks in %u albums across %u folders "
                    "(cache written)",
                    lib->music_folder ? lib->music_folder : "(unknown)",
                    (unsigned)lib->track_count, (unsigned)lib->album_count,
                    (unsigned)lib->folder_count);
    return TRAX_OK;
}

/* ------------------------------------------------------------------ */
/* load                                                                */
/* ------------------------------------------------------------------ */

static void discard(trax_library *out) { trax_library_clear(out); }

trax_status trax_index_cache_load(const trax_host *host, trax_log *log,
                                 const char *path, const char *music_folder,
                                 uint64_t fingerprint, trax_library *out) {
    if (!host || !host->read_file || !path || !music_folder || !out) {
        return TRAX_ERR;
    }
    discard(out);

    char *data = NULL;
    size_t len = 0;
    trax_status st = host->read_file(host->user, path, &data, &len);
    if (st != TRAX_OK || !data) {
        trax_free(data);
        return TRAX_CACHE_MISS;
    }
    if (len < TRAX_CACHE_MAGIC_LEN + 4 + 4 + 8 || len > TRAX_CACHE_MAX_BYTES ||
        memcmp(data, TRAX_CACHE_MAGIC, TRAX_CACHE_MAGIC_LEN) != 0) {
        trax_log_printf(log, TRAX_LOG_DEBUG,
                        "index cache at %s is not readable; ignoring", path);
        trax_free(data);
        return TRAX_CACHE_MISS;
    }

    cache_reader header;
    header.data = (const unsigned char *)data;
    header.len = len;
    header.pos = TRAX_CACHE_MAGIC_LEN;
    header.failed = false;
    uint32_t version = r_u32(&header);
    uint32_t payload_len = r_u32(&header);
    uint64_t checksum = r_u64(&header);
    if (header.failed || version != TRAX_CACHE_VERSION ||
        (size_t)payload_len != len - header.pos ||
        trax_hash_fnv1a(data + header.pos, payload_len) != checksum) {
        trax_log_printf(log, TRAX_LOG_DEBUG,
                        "index cache at %s is damaged or from another version; "
                        "ignoring", path);
        trax_free(data);
        return TRAX_CACHE_MISS;
    }

    cache_reader r;
    r.data = (const unsigned char *)data;
    r.len = len;
    r.pos = header.pos;
    r.failed = false;

    trax_library lib;
    memset(&lib, 0, sizeof(lib));
    lib.fingerprint = r_u64(&r);
    lib.built_ms = r_u64(&r);
    lib.folders_total = r_u32(&r);
    lib.folders_skipped = r_u32(&r);
    lib.folders_capped = r_u32(&r);
    char *cached_folder = NULL;
    if (!r_required_string(&r, &cached_folder)) goto damaged;

    /* The two rules that make a shared cache safe.  The folder must be the
     * one the setting names, and the card's top level must still be what it
     * was. */
    if (strcmp(cached_folder, music_folder) != 0) {
        trax_log_printf(log, TRAX_LOG_INFO,
                        "index cache at %s is for %s, not %s; reading the card",
                        path, cached_folder, music_folder);
        trax_free(cached_folder);
        trax_free(data);
        return TRAX_CACHE_MISS;
    }
    trax_free(cached_folder);
    if (lib.fingerprint != fingerprint) {
        trax_log_printf(log, TRAX_LOG_INFO,
                        "index cache at %s no longer matches the card; reading "
                        "it again", path);
        trax_free(data);
        return TRAX_CACHE_MISS;
    }
    lib.music_folder = trax_strdup(music_folder);
    if (!lib.music_folder) goto damaged;

    uint32_t folder_count = r_u32(&r);
    if (r.failed || folder_count > (len - r.pos)) goto damaged;
    for (uint32_t i = 0; i < folder_count; ++i) {
        char *folder = NULL;
        if (!r_required_string(&r, &folder)) {
            trax_free(folder);
            goto damaged;
        }
        if (trax_library_intern_folder(&lib, folder) == UINT32_MAX) {
            trax_free(folder);
            goto damaged;
        }
        trax_free(folder);
    }

    uint32_t track_count = r_u32(&r);
    if (r.failed || track_count > (len - r.pos)) goto damaged;
    for (uint32_t i = 0; i < track_count; ++i) {
        trax_track t;
        memset(&t, 0, sizeof(t));
        t.folder = r_u32(&r);
        t.cue_track = r_u32(&r);
        t.cue_index = r_u32(&r);
        uint8_t kind = r_u8(&r);
        if (r.failed || t.folder >= lib.folder_count || kind > 1) goto damaged;
        t.kind = (trax_track_kind)kind;
        if (!r_required_string(&r, &t.file_name)) {
            trax_free(t.file_name);
            goto damaged;
        }
        t.title = r_string(&r);
        if (r.failed) {
            trax_free(t.file_name);
            trax_free(t.title);
            goto damaged;
        }
        if (!trax_library_add_track(&lib, &t)) {
            trax_free(t.file_name);
            trax_free(t.title);
            goto damaged;
        }
    }

    uint32_t album_count = r_u32(&r);
    if (r.failed || album_count > (len - r.pos)) goto damaged;
    for (uint32_t i = 0; i < album_count; ++i) {
        trax_album a;
        memset(&a, 0, sizeof(a));
        a.folder = r_u32(&r);
        a.first_track = r_u32(&r);
        a.track_count = r_u32(&r);
        a.from_cue = r_u8(&r) != 0;
        if (r.failed || a.folder >= lib.folder_count ||
            a.first_track > lib.track_count ||
            a.track_count > lib.track_count - a.first_track) {
            goto damaged;
        }
        a.title = r_string(&r);
        a.cover_name = r_string(&r);
        a.cue_file = r_string(&r);
        if (r.failed) {
            trax_free(a.title);
            trax_free(a.cover_name);
            trax_free(a.cue_file);
            goto damaged;
        }
        if (!trax_library_add_album(&lib, &a)) {
            trax_free(a.title);
            trax_free(a.cover_name);
            trax_free(a.cue_file);
            goto damaged;
        }
    }

    if (r.pos != r.len) goto damaged;

    lib.valid = true;
    trax_free(data);
    *out = lib;
    return TRAX_OK;

damaged:
    trax_log_printf(log, TRAX_LOG_WARN,
                    "index cache at %s is damaged; reading the card again", path);
    trax_library_clear(&lib);
    trax_free(data);
    return TRAX_CACHE_MISS;
}
