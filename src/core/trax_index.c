#include "trax_index.h"

#include <string.h>

#include "trax_index_cache.h"

/*
 * The held library is reference counted.  The count includes the index's own
 * reference, so it starts at 2 when a walk or a cache load produces the
 * library (the index's own plus the caller's).  Each acquire() adds one; each
 * release() removes one; the index's own reference goes when destroy(),
 * invalidate() or drop_memory() runs.  The block is freed with the last
 * reference, so a borrower that is mid-use still holds a valid pointer across
 * a music-folder change.
 */
typedef struct held_index {
    trax_library lib;
    unsigned refs;
    uint64_t scan_ms;
    /* Every block this index has handed out, including ones a folder change
     * has already let go of but a borrower still holds.  release() checks the
     * block is ours before touching it, so a stray pointer cannot free
     * something else. */
    struct held_index *next_live;
} held_index;

struct trax_index {
    trax_index_options opt;
    held_index *held;
    held_index *live;
    /* The folder this index last served.  Kept after the in-memory copy is
     * let go, so a music-folder change can still find and delete that
     * folder's cache - "the old index must not be used again" is about the
     * card, not just about RAM. */
    char *last_folder;
};

/* Drop one reference; frees the library with the last one and unlinks it
 * from the index's list of blocks still in someone's hands. */
static void held_unref(trax_index *index, held_index *held) {
    if (!held || held->refs == 0) return;
    --held->refs;
    if (held->refs > 0) return;
    if (index) {
        for (held_index **link = &index->live; *link; link = &(*link)->next_live) {
            if (*link == held) {
                *link = held->next_live;
                break;
            }
        }
    }
    trax_library_clear(&held->lib);
    trax_free(held);
}

trax_index *trax_index_create(const trax_index_options *options) {
    if (!options || !options->host) return NULL;
    trax_index *index = (trax_index *)trax_calloc(1, sizeof(*index));
    if (!index) return NULL;
    index->opt = *options;
    return index;
}

void trax_index_destroy(trax_index *index) {
    if (!index) return;
    if (index->held) {
        held_index *old = index->held;
        index->held = NULL;
        held_unref(index, old);
    }
    /* Destroying the index is the end of the screen that owned it, so any
     * block still listed here goes too.  Borrowing across a *folder change*
     * is supported (invalidate keeps the block alive for its borrower); a
     * borrower outliving the index itself is a teardown order bug, and
     * freeing here is preferable to leaking the card's worth of tracks. */
    for (held_index *block = index->live; block;) {
        held_index *next = block->next_live;
        trax_library_clear(&block->lib);
        trax_free(block);
        block = next;
    }
    trax_free(index->last_folder);
    trax_free(index);
}

static const char *cache_path_for(const trax_index *index,
                                  const char *music_folder,
                                  char **owned) {
    *owned = NULL;
    if (index->opt.cache_path) {
        if (!*index->opt.cache_path) return NULL; /* caching disabled */
        return index->opt.cache_path;
    }
    *owned = trax_index_cache_default_path(music_folder);
    return *owned;
}

const trax_library *trax_index_peek(trax_index *index) {
    if (!index || !index->held || !index->held->lib.valid) return NULL;
    return &index->held->lib;
}

const char *trax_index_music_folder(trax_index *index) {
    if (!index || !index->held) return NULL;
    return index->held->lib.music_folder;
}

unsigned trax_index_claim_count(trax_index *index) {
    if (!index || !index->held) return 0;
    /* Borrowers only: the index's own reference is not a claim. */
    return index->held->refs > 0 ? index->held->refs - 1 : 0;
}

void trax_index_drop_memory(trax_index *index) {
    if (!index || !index->held) return;
    held_index *old = index->held;
    index->held = NULL;
    held_unref(index, old);
}

/* Forget `folder` entirely: drop the cache file and the in-memory copy.
 * Borrowers keep their pointer alive through the reference count. */
static void forget_folder(trax_index *index, const char *folder) {
    if (!folder) return;
    char *owned = NULL;
    const char *path = cache_path_for(index, folder, &owned);
    bool removed = false;
    if (path && index->opt.host && index->opt.host->remove_file) {
        removed = index->opt.host->remove_file(index->opt.host->user, path) ==
                  TRAX_OK;
    }
    trax_log_printf(index->opt.log, TRAX_LOG_INFO,
                    "music folder changed; dropped the index for %s%s", folder,
                    removed ? " and its cache" : " (no cache to drop)");
    trax_free(owned);
    if (index->held && index->held->lib.music_folder &&
        strcmp(index->held->lib.music_folder, folder) == 0) {
        held_index *old = index->held;
        index->held = NULL;
        held_unref(index, old);
    }
}

void trax_index_invalidate(trax_index *index) {
    if (!index) return;
    forget_folder(index, index->last_folder);
    trax_free(index->last_folder);
    index->last_folder = NULL;
}

void trax_index_release(trax_index *index, const trax_library *library) {
    if (!index || !library) return;
    /* The library is the first member of its block, so the block's address
     * is the library's - but only the blocks this index handed out may be
     * walked back to.  The list makes a stray pointer a no-op rather than a
     * heap corruption. */
    held_index *held = (held_index *)(uintptr_t)(const void *)library;
    for (held_index *block = index->live; block; block = block->next_live) {
        if (block == held) {
            /* The index keeps its own reference, which is what lets the
             * gallery and the shuffle share one walk: closing the gallery
             * does not force the shuffle to read the card again.  destroy(),
             * invalidate() and drop_memory() take that reference away. */
            held_unref(index, block);
            return;
        }
    }
}

static void fill_report(trax_index_report *report, const held_index *held,
                        bool hit_cache, uint64_t elapsed_ms) {
    if (!report) return;
    memset(report, 0, sizeof(*report));
    const trax_library *lib = &held->lib;
    report->hit_cache = hit_cache;
    report->source = hit_cache ? TRAX_INDEX_SOURCE_CACHE : TRAX_INDEX_SOURCE_SCAN;
    report->folders_total = lib->folders_total;
    report->folders_done = lib->folders_total;
    report->tracks = (uint32_t)lib->track_count;
    report->albums = (uint32_t)lib->album_count;
    report->folders_skipped = lib->folders_skipped;
    report->folders_capped = lib->folders_capped;
    report->scan_ms = hit_cache ? 0 : held->scan_ms;
    report->elapsed_ms = elapsed_ms;
}

static uint64_t host_now(const trax_host *host) {
    return host->now_ms ? host->now_ms(host->user) : 0;
}

trax_status trax_index_acquire(trax_index *index, const char *music_folder,
                               const trax_library **out, trax_index_report *report) {
    if (!index || !music_folder || !out) return TRAX_ERR;
    *out = NULL;
    if (report) memset(report, 0, sizeof(*report));
    uint64_t started = host_now(index->opt.host);

    /* A held copy for this same folder, with no folder switch since, is the
     * cheapest answer for both the gallery and the shuffle. */
    if (index->held && index->held->lib.music_folder &&
        strcmp(index->held->lib.music_folder, music_folder) == 0) {
        ++index->held->refs;
        fill_report(report, index->held, true,
                    host_now(index->opt.host) - started);
        *out = &index->held->lib;
        return TRAX_OK;
    }
    /* A different music folder means the old index is unfit: its cache is
     * deleted and its memory dropped, whether or not the settings code
     * remembered to call trax_index_invalidate().  This is the rule that a
     * cached grid for one folder is never shown for another. */
    if (index->last_folder && strcmp(index->last_folder, music_folder) != 0) {
        trax_index_invalidate(index);
    }

    if (!index->opt.host->list_dir) return TRAX_ERR;
    if (index->opt.host->is_dir &&
        !index->opt.host->is_dir(index->opt.host->user, music_folder)) {
        trax_log_printf(index->opt.log, TRAX_LOG_ERROR,
                        "music folder %s does not exist; nothing indexed",
                        music_folder);
        return TRAX_ERR;
    }

    uint64_t fingerprint = 0;
    if (trax_scan_fingerprint(index->opt.host, music_folder, &fingerprint) !=
        TRAX_OK) {
        trax_log_printf(index->opt.log, TRAX_LOG_ERROR,
                        "music folder %s could not be listed; nothing indexed",
                        music_folder);
        return TRAX_ERR;
    }

    char *owned_path = NULL;
    const char *cache_path = cache_path_for(index, music_folder, &owned_path);

    if (cache_path) {
        trax_library cached;
        memset(&cached, 0, sizeof(cached));
        trax_status loaded = trax_index_cache_load(
            index->opt.host, index->opt.log, cache_path, music_folder,
            fingerprint, &cached);
        if (loaded == TRAX_OK) {
            held_index *held = (held_index *)trax_calloc(1, sizeof(*held));
            char *remembered = held ? trax_strdup(music_folder) : NULL;
            if (!held || !remembered) {
                trax_free(remembered);
                trax_free(held);
                trax_library_clear(&cached);
                trax_free(owned_path);
                return TRAX_ERR;
            }
            trax_free(index->last_folder);
            index->last_folder = remembered;
            held->lib = cached;
            held->refs = 2; /* the index's own reference plus this borrower */
            held->scan_ms = 0;
            held->next_live = index->live;
            index->live = held;
            index->held = held;
            fill_report(report, held, true,
                        host_now(index->opt.host) - started);
            *out = &held->lib;
            trax_log_printf(index->opt.log, TRAX_LOG_INFO,
                            "index for %s used the cache: %u tracks, %u albums",
                            music_folder, (unsigned)held->lib.track_count,
                            (unsigned)held->lib.album_count);
            trax_free(owned_path);
            return TRAX_OK;
        }
        trax_library_clear(&cached);
    }

    trax_scan_options scan_opt;
    memset(&scan_opt, 0, sizeof(scan_opt));
    scan_opt.host = index->opt.host;
    scan_opt.log = index->opt.log;
    scan_opt.music_folder = music_folder;
    scan_opt.cancel = index->opt.cancel;
    scan_opt.on_progress = index->opt.on_progress;
    scan_opt.progress_user = index->opt.progress_user;

    trax_library scanned;
    memset(&scanned, 0, sizeof(scanned));
    uint64_t scan_started = host_now(index->opt.host);
    trax_status st = trax_scan_run(&scan_opt, &scanned);
    if (st != TRAX_OK) {
        /* Cancelled or failed: nothing retained, nothing cached.  The next
         * entry must walk again, which is exactly what the caller sees. */
        trax_library_clear(&scanned);
        trax_free(owned_path);
        return st;
    }

    held_index *held = (held_index *)trax_calloc(1, sizeof(*held));
    char *remembered = trax_strdup(music_folder);
    if (!held || !remembered) {
        trax_free(remembered);
        trax_free(held);
        trax_library_clear(&scanned);
        trax_free(owned_path);
        return TRAX_ERR;
    }
    trax_free(index->last_folder);
    index->last_folder = remembered;
    held->lib = scanned;
    held->refs = 2; /* the index's own reference plus this borrower */
    held->scan_ms = host_now(index->opt.host) - scan_started;
    held->next_live = index->live;
    index->live = held;
    index->held = held;

    /* Only a complete walk is written.  A failed write costs nothing but a
     * second walk next time. */
    if (cache_path) {
        trax_index_cache_save(index->opt.host, index->opt.log, cache_path,
                             &held->lib);
    }
    trax_free(owned_path);

    fill_report(report, held, false, host_now(index->opt.host) - started);
    *out = &held->lib;
    return TRAX_OK;
}
