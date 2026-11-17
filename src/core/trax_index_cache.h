/*
 * trax_index_cache.h - keeping the shared index on the card between launches.
 *
 * A walk of a real card takes seconds (README: 1,663 tracks in 2.43 s on a
 * PSP; 1,615 in 1.66 s on a Vita), which is too much to pay every time the
 * gallery is the screen TRAX opens on.  The index is therefore written beside
 * the music folder and read back on the next entry.
 *
 * The cache is only ever a shortcut, never a source of truth:
 *   - It records the music folder it describes.  A cache for another folder
 *     is a miss, which is the "switch the music folder -> old index invalid"
 *     rule (MANUAL.html: Settings has a Music folder row to change it later).
 *   - It records a fingerprint of the top-level listing.  A card whose top
 *     level has changed is a miss, so adding or removing an album re-walks.
 *   - It carries a length and a checksum.  A card pulled mid-write, or a
 *     half-written file, is a miss rather than a corrupt index.
 *   - It is written only after a complete walk.  A cancelled scan has nothing
 *     to write, and `trax_index_acquire()` does not call this after one.
 *
 * Values are serialised explicitly little-endian so the file is the same on
 * every host, including the desktop used by the acceptance suite.
 */
#ifndef TRAX_INDEX_CACHE_H
#define TRAX_INDEX_CACHE_H

#include <stdbool.h>
#include <stdint.h>

#include "trax_common.h"
#include "trax_library.h"
#include "trax_log.h"
#include "trax_platform.h"

#ifdef __cplusplus
extern "C" {
#endif

/* The file name used beside a music folder when no other path is given. */
#define TRAX_INDEX_CACHE_NAME ".trax_index"

/* Default cache path for a music folder: <folder>/.trax_index.  The caller
 * frees the result with trax_free(). */
char *trax_index_cache_default_path(const char *music_folder);

/*
 * Write `lib` to `path`.  TRAX_OK on success.  A failure is logged but is not
 * fatal to the caller: the walk already succeeded and the next entry simply
 * walks again.
 */
trax_status trax_index_cache_save(const trax_host *host, trax_log *log,
                                 const char *path, const trax_library *lib);

/*
 * Read `path` into `out` when it describes `music_folder` at `fingerprint`.
 *
 *   TRAX_OK         - `out` holds a complete copy of the cached index
 *   TRAX_CACHE_MISS - no usable entry (missing, corrupt, another folder or a
 *                     stale fingerprint); `out` is empty
 *   TRAX_ERR        - the host could not be asked at all
 */
trax_status trax_index_cache_load(const trax_host *host, trax_log *log,
                                 const char *path, const char *music_folder,
                                 uint64_t fingerprint, trax_library *out);

#ifdef __cplusplus
}
#endif

#endif /* TRAX_INDEX_CACHE_H */
