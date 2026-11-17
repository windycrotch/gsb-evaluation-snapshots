/*
 * trax_gallery.h - the album wall, reading the shared index.
 *
 * The gallery is one of the two users of the shared index (the other is
 * global shuffle).  It opens the index once and keeps a claim on it for as
 * long as it is on screen, so walking into the gallery and then starting a
 * global shuffle does not read the card twice.
 *
 * The gallery draws albums, not tracks, and an album with no cover file gets
 * TRAX's orb rather than a gap (MANUAL.html: "An album with no cover file gets
 * the orb ... so the wall stays a wall rather than a row of gaps").
 */
#ifndef TRAX_GALLERY_H
#define TRAX_GALLERY_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "trax_common.h"
#include "trax_index.h"
#include "trax_library.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct trax_gallery trax_gallery;

typedef struct {
    trax_index *index;           /* the shared index; not owned */
    /* Used only when `index` is NULL: the gallery makes its own index. */
    const trax_host *host;
    trax_log *log;
    trax_cancel_flag *cancel;
    const char *cache_path;      /* forwarded to the index; NULL for default */
    trax_scan_progress_fn on_progress;
    void *progress_user;
} trax_gallery_options;

trax_gallery *trax_gallery_create(const trax_gallery_options *options);
void trax_gallery_destroy(trax_gallery *gallery);

/*
 * Open the gallery over `music_folder`.  This is trax_index_acquire() plus a
 * claim held until trax_gallery_close().  On TRAX_CANCELLED nothing is held.
 */
trax_status trax_gallery_open(trax_gallery *gallery, const char *music_folder,
                              trax_index_report *report);

void trax_gallery_close(trax_gallery *gallery);

/* True while an index is held. */
bool trax_gallery_is_open(const trax_gallery *gallery);

/* Albums on the wall, in the index's order. */
size_t trax_gallery_album_count(const trax_gallery *gallery);
const trax_album *trax_gallery_album_at(const trax_gallery *gallery, size_t i);

/* What the gallery would say above an empty wall: the walk is still running,
 * the folder holds no albums, or the card could not be read.  Never NULL. */
const char *trax_gallery_empty_message(const trax_gallery *gallery);

/* An album's cover path, freshly allocated, or NULL when it has none.
 * The caller frees with trax_free(). */
char *trax_gallery_cover_path(const trax_gallery *gallery, const trax_album *album);

/* Open an album as the list would: its tracks, contiguous. */
bool trax_gallery_album_tracks(const trax_gallery *gallery,
                               const trax_album *album,
                               const trax_track **tracks, size_t *count);

#ifdef __cplusplus
}
#endif

#endif /* TRAX_GALLERY_H */
