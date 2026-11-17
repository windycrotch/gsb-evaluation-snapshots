/*
 * trax_shuffle.h - global shuffle: the whole card, once, in a random order.
 *
 * Global shuffle is the second user of the shared index (the gallery is the
 * first).  Its rules come straight from MANUAL.html / RELEASE_NOTES:
 *
 *   - It plays the whole music folder, in a random order, not the folder the
 *     list happens to show.
 *   - An album with a cue sheet contributes its tracks, not the one long file
 *     they live in.
 *   - It plays the card through once and then stops; it does not loop.
 *   - Stopping playback releases the list it built, there and then.
 *   - It is the one mode TRAX does not remember between launches: the mode is
 *     not persisted, so a press of Cross out of habit never starts a read of
 *     the whole card.
 *
 * The session holds a claim on the shared index while it plays, so the
 * gallery and the shuffle share one walk.  The play order is a separate array
 * of indices, which is what is released when playback stops - not the index,
 * which the other entry point may still be using.
 */
#ifndef TRAX_SHUFFLE_H
#define TRAX_SHUFFLE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "trax_common.h"
#include "trax_index.h"
#include "trax_library.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct trax_shuffle trax_shuffle;

typedef struct {
    trax_index *index;            /* the shared index; not owned */
    const trax_host *host;        /* used when `index` is NULL */
    trax_log *log;
    trax_cancel_flag *cancel;
    const char *cache_path;
    trax_scan_progress_fn on_progress;
    void *progress_user;
    /* The random source.  NULL uses a fixed internal sequence so a test run
     * is reproducible; a real build passes its generator. */
    uint32_t (*rand)(void *user);
    void *rand_user;
} trax_shuffle_options;

trax_shuffle *trax_shuffle_create(const trax_shuffle_options *options);
void trax_shuffle_destroy(trax_shuffle *shuffle);

/*
 * Start a global shuffle over `music_folder`: acquire the shared index and
 * build a random order of every track in it.  On TRAX_CANCELLED nothing is
 * held and nothing plays.
 */
trax_status trax_shuffle_start(trax_shuffle *shuffle, const char *music_folder,
                               trax_index_report *report);

/* Stop playback and release the order and the claim on the index.  Logs what
 * was released, since "stopping playback ends it, and the list of tracks it
 * built is let go of there and then" is observable. */
void trax_shuffle_stop(trax_shuffle *shuffle);

bool trax_shuffle_is_active(const trax_shuffle *shuffle);
size_t trax_shuffle_length(const trax_shuffle *shuffle);

/* The library index position of the next track, or -1 when the session has
 * played everything (global shuffle stops rather than looping). */
int32_t trax_shuffle_current_track(const trax_shuffle *shuffle);
/* Advance to the next track.  Returns false - and ends the session - after
 * the last one, which is what "plays once then stops" means. */
bool trax_shuffle_advance(trax_shuffle *shuffle);
/* How many tracks have been handed out; equals the length when the card has
 * been played through. */
size_t trax_shuffle_played_count(const trax_shuffle *shuffle);

/* The index the session is using, while active.  NULL otherwise. */
const trax_library *trax_shuffle_library(const trax_shuffle *shuffle);

/* Whether this mode survives a restart.  Always false, by design; exposed so
 * the settings code cannot accidentally persist it and so the suite can
 * assert the rule. */
bool trax_shuffle_remembers_between_launches(void);

#ifdef __cplusplus
}
#endif

#endif /* TRAX_SHUFFLE_H */
