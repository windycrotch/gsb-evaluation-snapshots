/*
 * trax_scan.h - walking the music folder once, with progress and cancellation.
 *
 * The walk advances one top-level folder at a time.  That is the only total
 * TRAX can know without reading the card twice (MANUAL.html: "the bar counts
 * the folders at the top level of your music folder - the only total that can
 * be known without reading the card twice"), so it is what the progress
 * reports:
 *
 *     "Reading card: 4 of 12 folders, 137 tracks found"
 *
 * Rules the scan holds to on a real card:
 *   - A folder that will not open is skipped and named in the log; the walk
 *     continues.  A card with one bad directory still yields an index.
 *   - A folder holding more than 1024 playable tracks contributes the first
 *     1024, in name order, and the log says once that the rest were left out.
 *   - A .cue album contributes its tracks, not the one long audio file.  Its
 *     audio file is not also counted as a track of its own.
 *   - Cancelling returns TRAX_CANCELLED and leaves nothing behind: the
 *     partially built library is emptied, and the scanner never asks anyone to
 *     cache an incomplete walk.  The next entry therefore scans in full.
 */
#ifndef TRAX_SCAN_H
#define TRAX_SCAN_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "trax_common.h"
#include "trax_library.h"
#include "trax_log.h"
#include "trax_platform.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint32_t folders_total;   /* top-level folders found under the music root */
    uint32_t folders_done;    /* top-level folders finished */
    uint32_t tracks_found;    /* playable tracks found so far */
    uint32_t albums_found;    /* albums found so far */
    const char *current;      /* the folder being read, or NULL */
} trax_scan_progress;

/*
 * Called after each step so the UI can redraw.  Returning false cancels, as
 * does raising the cancel flag; the scanner also checks the flag between
 * folders and between files, so a UI that never redraws still stops promptly.
 */
typedef bool (*trax_scan_progress_fn)(void *user, const trax_scan_progress *progress);

typedef struct {
    const trax_host *host;
    trax_log *log;
    /* The music folder to walk, in host terms. */
    const char *music_folder;
    trax_cancel_flag *cancel;
    trax_scan_progress_fn on_progress;
    void *progress_user;
} trax_scan_options;

/*
 * Build a library.  On TRAX_OK the library is complete and its `valid` flag
 * set.  On TRAX_CANCELLED or TRAX_ERR, `out` is left empty and must still be
 * destroyed; nothing half-built is kept.
 *
 * `out` is not required to be empty on entry; it is cleared first.
 */
trax_status trax_scan_run(const trax_scan_options *options, trax_library *out);

/*
 * The identity of a music folder's contents, for cache validation: the
 * folder's top-level listing, hashed from each child's name, kind, size and
 * mtime.  Adding, removing or renaming anything at the top level changes it
 * on every filesystem TRAX runs on.  Returns TRAX_ERR when the folder cannot
 * be listed.
 */
trax_status trax_scan_fingerprint(const trax_host *host, const char *music_folder,
                                  uint64_t *out);

#ifdef __cplusplus
}
#endif

#endif /* TRAX_SCAN_H */
