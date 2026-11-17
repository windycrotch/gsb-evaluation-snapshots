/*
 * trax_index.h - the shared library index, as both entry points see it.
 *
 * Opening the gallery and starting a global shuffle used to be two separate
 * walks with two separate caches.  This is the one place both go through:
 *
 *   trax_index_acquire()    - use the in-memory copy or the cache if either
 *                             fits, else walk the card, reporting top-level
 *                             folder progress meanwhile;
 *   trax_index_release()    - drop a user's claim; the last claim frees the
 *                             in-memory index (the cache file remains);
 *   trax_index_invalidate() - a music-folder change makes the old index unfit:
 *                             the in-memory copy is dropped and the cache file
 *                             deleted, so the next entry cannot use it.
 *
 * The index is scoped to a music folder.  A cached index for folder A is
 * never handed out while folder B is the setting, even if both are readable -
 * that is the rule the acceptance suite checks.
 *
 * Cancellation: on TRAX_CANCELLED nothing is retained and no cache is
 * written; the next acquire walks the card from the start.
 */
#ifndef TRAX_INDEX_H
#define TRAX_INDEX_H

#include <stdbool.h>
#include <stdint.h>

#include "trax_common.h"
#include "trax_library.h"
#include "trax_log.h"
#include "trax_platform.h"
#include "trax_scan.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    /* Every call was answered from the cache (or the in-memory copy). */
    TRAX_INDEX_SOURCE_CACHE = 0,
    /* The card was walked. */
    TRAX_INDEX_SOURCE_SCAN
} trax_index_source;

typedef struct {
    bool hit_cache;          /* no walk happened at all */
    trax_index_source source;
    uint32_t folders_total;
    uint32_t folders_done;
    uint32_t tracks;
    uint32_t albums;
    uint32_t folders_skipped; /* unreadable top-level folders, logged */
    uint32_t folders_capped;  /* folders cut at the 1024-track limit, logged */
    uint64_t scan_ms;         /* 0 when answered from the cache */
    uint64_t elapsed_ms;      /* the acquire call, whichever source */
} trax_index_report;

typedef struct {
    const trax_host *host;
    trax_log *log;
    trax_cancel_flag *cancel;
    trax_scan_progress_fn on_progress;
    void *progress_user;
    /* Where to keep the cache; NULL uses <music_folder>/.trax_index.
     * An empty string disables the cache entirely (used by tests that want
     * the walk measured on its own, and by a read-only card). */
    const char *cache_path;
} trax_index_options;

typedef struct trax_index trax_index;

trax_index *trax_index_create(const trax_index_options *options);
void trax_index_destroy(trax_index *index);

/*
 * Get the index for `music_folder`, scanning if neither the held copy nor the
 * cache fits.  Progress is delivered through the options' callback while a
 * walk runs.  On TRAX_CANCELLED nothing is retained, no cache is written, and
 * `out` is untouched.
 *
 * Every successful call takes one claim on the returned library; release it
 * with trax_index_release(index, library).  Both the gallery and the shuffle
 * may hold a claim on the same library, and the pointer stays valid until it
 * is released - even across a music-folder change.
 */
trax_status trax_index_acquire(trax_index *index, const char *music_folder,
                               const trax_library **out, trax_index_report *report);

/* Drop one claim, on the library acquire() returned.  When the index no
 * longer owns it (a folder change dropped it), the last claim frees it. */
void trax_index_release(trax_index *index, const trax_library *library);

/* The currently held library, or NULL when nothing is held. */
const trax_library *trax_index_peek(trax_index *index);
const char *trax_index_music_folder(trax_index *index);
/* Claims currently outstanding on the held library. */
unsigned trax_index_claim_count(trax_index *index);

/* Forget the held index and its cache, as a music-folder change must.  Safe
 * when nothing is held.  Outstanding borrowers keep the old copy alive until
 * they release it, but no new acquire can see it. */
void trax_index_invalidate(trax_index *index);
/* Forget only the in-memory copy; the cache file remains. */
void trax_index_drop_memory(trax_index *index);

#ifdef __cplusplus
}
#endif

#endif /* TRAX_INDEX_H */
