/*
 * TRAX — global shuffle scan session.
 *
 * Implements the behaviour described in MANUAL.html, "Global shuffle":
 *
 *  - Pressing Cross on a track in global-shuffle mode only ASKS. Nothing is
 *    read from the card until the dialog is confirmed, so a habitual press
 *    never starts a whole-card traversal.
 *  - Once confirmed, a progress bar advances per top-level folder of the
 *    music folder and reports how many tracks have been found so far.
 *  - Circle cancels the scan; cancelling keeps nothing — part of a card is
 *    not a shuffle of it. The same is true of a scan that fails midway
 *    (unreadable folder, card removed): an understandable message is shown,
 *    the progress dialog is closed, and every partial result is discarded.
 *  - When the scan completes, the whole card plays once through in random
 *    order. Stopping playback lets the built track list go there and then.
 *  - Only one scan session exists at a time. Confirming while a scan is
 *    running does not stack a second traversal, and results that arrive
 *    late from a dead session (cancelled, superseded, or invalidated by
 *    stopping playback or switching the music folder) are dropped instead
 *    of being written back to the UI.
 *
 * The scanner is cooperative: gs_pump() performs one bounded slice of work
 * (the top-level folder listing, or one top-level folder's subtree) per
 * call, so the UI stays responsive and cancellation takes effect between
 * slices. Platform I/O goes through GSPlatform; UI notification goes
 * through GSCallbacks. Asynchronous platform layers deliver their results
 * through gs_deliver_*(), which validate the session id — that is the
 * single choke point that keeps stale sessions from touching the UI.
 */
#ifndef TRAX_GLOBAL_SHUFFLE_H
#define TRAX_GLOBAL_SHUFFLE_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GS_PATH_MAX 512
#define GS_NAME_MAX 256

/* Shown when the card cannot be read (folder unreadable, card removed). */
#define GS_ERR_UNREADABLE \
    "The music folder could not be read. The card may have been removed."

typedef struct GSPlatform {
    void *user;

    /* Open a directory for listing. Returns NULL if it cannot be opened. */
    void *(*dir_open)(void *user, const char *path);
    /* Fetch the next entry. Returns 1 and fills name_out/is_dir, 0 when the
     * listing is finished, -1 on error (e.g. the card was pulled mid-read). */
    int (*dir_read)(void *user, void *dir, char *name_out, size_t name_cap,
                    int *is_dir);
    void (*dir_close)(void *user, void *dir);

    /* Random source for the shuffle. May be NULL (a built-in source is
     * used); tests inject a deterministic one. */
    unsigned (*rand)(void *user);

    /* Memory for track lists. Both NULL selects malloc/free. */
    void *(*alloc)(void *user, size_t size);
    void (*free)(void *user, void *ptr);
} GSPlatform;

typedef struct GSCallbacks {
    void *user;

    /* The confirmation dialog ("reading your entire music folder may take
     * time") opens and closes. */
    void (*confirm_show)(void *user);
    void (*confirm_hide)(void *user);

    /* The progress dialog. session identifies the owning scan; a callback
     * carrying a session that is no longer current must not reach the UI,
     * and never does — the scanner filters before calling. */
    void (*progress_open)(void *user, unsigned session);
    void (*progress_update)(void *user, unsigned session,
                            unsigned folders_done, unsigned folders_total,
                            unsigned tracks_found);
    void (*progress_close)(void *user, unsigned session);

    /* The scan failed. The progress dialog is already closed; message is a
     * user-readable explanation. */
    void (*error)(void *user, unsigned session, const char *message);

    /* The scan completed. tracks/count borrow the scanner's list; it stays
     * valid until gs_stop() (or anything that ends the session). */
    void (*play)(void *user, unsigned session,
                 const char *const *tracks, size_t count);

    /* The built track list was let go of (playback stopped, music folder
     * switched, or a new shuffle requested over the old one). */
    void (*list_released)(void *user);
} GSCallbacks;

typedef enum {
    GS_IDLE,      /* nothing happening */
    GS_CONFIRM,   /* confirmation dialog is up; the card has NOT been read */
    GS_SCANNING,  /* a scan session owns the card until it finishes,
                     is cancelled, or fails */
    GS_PLAYING    /* the shuffled list is built and owned by the session */
} GSState;

typedef struct GSScanner GSScanner;

GSScanner *gs_create(const GSPlatform *platform, const GSCallbacks *callbacks);
void gs_destroy(GSScanner *gs);

/* Sets the music folder root (e.g. "ms0:/PSP/MUSIC"). Switching folders
 * invalidates any live session: a running scan is torn down, a built list
 * is released, and nothing from the old folder writes back afterwards. */
void gs_set_music_folder(GSScanner *gs, const char *path);

/* Cross was pressed on a track while global shuffle is the mode. From
 * GS_IDLE or GS_PLAYING this opens the confirmation dialog (releasing any
 * previously built list first). While a scan is running it is ignored:
 * one session at a time, never a stacked second traversal. */
void gs_request_play(GSScanner *gs);

/* Cross on the confirmation dialog: start the scan. Ignored unless the
 * dialog is actually up — confirming into a running scan is a no-op. */
void gs_confirm(GSScanner *gs);

/* Circle. On the dialog: close it and nothing happens. During a scan:
 * discard everything collected and close the progress dialog. */
void gs_cancel(GSScanner *gs);

/* One slice of scan work. Returns 1 while the scan is still going, 0 when
 * idle, finished, cancelled, or failed. Does nothing unless a scan was
 * confirmed — playing tracks directly never traverses the card. */
int gs_pump(GSScanner *gs);

/* Playback stopped. A built track list is released immediately; a scan in
 * flight is invalidated so its progress and results never write back. */
void gs_stop(GSScanner *gs);

GSState gs_state(const GSScanner *gs);
unsigned gs_session(const GSScanner *gs);       /* 0 = no live session */
size_t gs_track_count(const GSScanner *gs);     /* valid while GS_PLAYING */
const char *gs_track(const GSScanner *gs, size_t index);

/* Delivery points for platform operations that complete asynchronously.
 * Every one of them validates the session id first; a stale session's late
 * result is dropped here and never reaches the callbacks. The synchronous
 * pump delivers through these same functions, so there is exactly one
 * validation path. */
void gs_deliver_progress(GSScanner *gs, unsigned session,
                         unsigned folders_done, unsigned folders_total,
                         unsigned tracks_found);
/* Takes ownership of tracks (an array of count heap strings) only by
 * returning 1. On 0 the caller still owns — and must free — the list. */
int gs_deliver_done(GSScanner *gs, unsigned session,
                    char **tracks, size_t count);
void gs_deliver_error(GSScanner *gs, unsigned session, const char *message);

#ifdef __cplusplus
}
#endif

#endif /* TRAX_GLOBAL_SHUFFLE_H */
