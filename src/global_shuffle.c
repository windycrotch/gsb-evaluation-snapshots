#include "global_shuffle.h"

#include <stdlib.h>
#include <string.h>
#include <stdint.h>

struct GSScanner {
    GSPlatform pf;
    GSCallbacks cb;

    GSState state;
    unsigned session;       /* id of the live scan session; 0 = none */
    unsigned next_session;  /* monotonic source of session ids */

    char root[GS_PATH_MAX];

    /* Traversal state (only meaningful while GS_SCANNING). */
    int phase;              /* 0 = list top level, 1 = walk top-level folders */
    char **folders;         /* top-level folders of the music root */
    size_t folder_count, folder_cap;
    size_t folders_done;

    /* Track list: accumulated while scanning, owned by the session while
     * playing, always empty otherwise. */
    char **tracks;
    size_t track_count, track_cap;
};

/* ------------------------------------------------------------------ */
/* small helpers                                                       */

static void *default_alloc(void *user, size_t size)
{
    (void)user;
    return malloc(size);
}

static void default_free(void *user, void *ptr)
{
    (void)user;
    free(ptr);
}

static void *gs_alloc(const GSScanner *gs, size_t size)
{
    return (gs->pf.alloc ? gs->pf.alloc : default_alloc)(gs->pf.user, size);
}

static void gs_freep(const GSScanner *gs, void *ptr)
{
    if (ptr)
        (gs->pf.free ? gs->pf.free : default_free)(gs->pf.user, ptr);
}

static unsigned gs_rand(GSScanner *gs)
{
    /* Fallback xorshift; real builds inject the platform RNG. */
    static uint32_t s = 0x9E3779B9u;
    if (gs->pf.rand)
        return gs->pf.rand(gs->pf.user);
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return s;
}

static void copy_str(char *dst, size_t cap, const char *src)
{
    size_t i = 0;
    if (!cap)
        return;
    while (src[i] && i + 1 < cap) {
        dst[i] = src[i];
        i++;
    }
    dst[i] = '\0';
}

static void join_path(char *out, size_t cap, const char *dir, const char *name)
{
    size_t i = 0;
    while (dir[i] && i + 1 < cap) {
        out[i] = dir[i];
        i++;
    }
    if (i > 0 && out[i - 1] != '/' && i + 1 < cap)
        out[i++] = '/';
    out[i] = '\0';
    while (*name && i + 1 < cap)
        out[i++] = *name++;
    out[i] = '\0';
}

static char *dup_str(GSScanner *gs, const char *src)
{
    size_t n = strlen(src) + 1;
    char *copy = gs_alloc(gs, n);
    if (copy)
        memcpy(copy, src, n);
    return copy;
}

static int is_audio(const char *name)
{
    static const char *const exts[] = {
        ".mp3", ".wav", ".flac", ".m4a", ".opus"
    };
    size_t len = strlen(name);
    size_t e;
    for (e = 0; e < sizeof(exts) / sizeof(exts[0]); e++) {
        size_t el = strlen(exts[e]);
        size_t i;
        int match;
        if (el > len)
            continue;
        match = 1;
        for (i = 0; i < el; i++) {
            char a = name[len - el + i];
            char b = exts[e][i];
            if (a >= 'A' && a <= 'Z')
                a = (char)(a - 'A' + 'a');
            if (a != b) {
                match = 0;
                break;
            }
        }
        if (match)
            return 1;
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/* list management                                                     */

static int list_push(GSScanner *gs, char ***items, size_t *count, size_t *cap,
                     const char *path)
{
    if (*count == *cap) {
        size_t new_cap = *cap ? *cap * 2 : 16;
        char **grown = gs_alloc(gs, new_cap * sizeof(*grown));
        if (!grown)
            return -1;
        if (*items)
            memcpy(grown, *items, *count * sizeof(*grown));
        gs_freep(gs, *items);
        *items = grown;
        *cap = new_cap;
    }
    (*items)[*count] = dup_str(gs, path);
    if (!(*items)[*count])
        return -1;
    (*count)++;
    return 0;
}

static void list_free(GSScanner *gs, char ***items, size_t *count, size_t *cap)
{
    size_t i;
    for (i = 0; i < *count; i++)
        gs_freep(gs, (*items)[i]);
    gs_freep(gs, *items);
    *items = NULL;
    *count = 0;
    *cap = 0;
}

/* Throw away everything a scan collected. After this the scanner is back
 * to a clean slate: no half-built queue survives to be played by mistake. */
static void discard_scan(GSScanner *gs)
{
    list_free(gs, &gs->folders, &gs->folder_count, &gs->folder_cap);
    list_free(gs, &gs->tracks, &gs->track_count, &gs->track_cap);
    gs->folders_done = 0;
    gs->phase = 0;
}

/* ------------------------------------------------------------------ */
/* session lifecycle                                                   */

static void end_scan_with_error(GSScanner *gs, const char *message)
{
    unsigned session = gs->session;
    gs->session = 0;
    gs->state = GS_IDLE;
    discard_scan(gs);
    if (gs->cb.progress_close)
        gs->cb.progress_close(gs->cb.user, session);
    if (gs->cb.error)
        gs->cb.error(gs->cb.user, session, message);
}

static void end_scan_cancelled(GSScanner *gs)
{
    unsigned session = gs->session;
    gs->session = 0;
    gs->state = GS_IDLE;
    discard_scan(gs);
    if (gs->cb.progress_close)
        gs->cb.progress_close(gs->cb.user, session);
}

static void release_playlist(GSScanner *gs)
{
    list_free(gs, &gs->tracks, &gs->track_count, &gs->track_cap);
    gs->session = 0;
    gs->state = GS_IDLE;
    if (gs->cb.list_released)
        gs->cb.list_released(gs->cb.user);
}

/* ------------------------------------------------------------------ */
/* public lifecycle                                                    */

GSScanner *gs_create(const GSPlatform *platform, const GSCallbacks *callbacks)
{
    GSScanner *gs;
    GSPlatform pf = *platform;
    if (!pf.alloc)
        pf.alloc = default_alloc;
    if (!pf.free)
        pf.free = default_free;

    gs = pf.alloc(pf.user, sizeof(*gs));
    if (!gs)
        return NULL;
    memset(gs, 0, sizeof(*gs));
    gs->pf = pf;
    if (callbacks)
        gs->cb = *callbacks;
    gs->state = GS_IDLE;
    return gs;
}

void gs_destroy(GSScanner *gs)
{
    GSPlatform pf;
    if (!gs)
        return;
    discard_scan(gs);
    pf = gs->pf;
    pf.free(pf.user, gs);
}

void gs_set_music_folder(GSScanner *gs, const char *path)
{
    /* The new folder owns the UI now: nothing from the old one may write
     * back, so any live session ends here. */
    if (gs->state == GS_SCANNING)
        end_scan_cancelled(gs);
    else if (gs->state == GS_PLAYING)
        release_playlist(gs);
    else if (gs->state == GS_CONFIRM) {
        gs->state = GS_IDLE;
        if (gs->cb.confirm_hide)
            gs->cb.confirm_hide(gs->cb.user);
    }
    copy_str(gs->root, sizeof(gs->root), path);
}

void gs_request_play(GSScanner *gs)
{
    if (gs->state == GS_PLAYING)
        release_playlist(gs);
    if (gs->state != GS_IDLE)
        return; /* dialog already up, or a scan owns the card */
    gs->state = GS_CONFIRM;
    if (gs->cb.confirm_show)
        gs->cb.confirm_show(gs->cb.user);
}

void gs_confirm(GSScanner *gs)
{
    if (gs->state != GS_CONFIRM)
        return; /* never stacks a second traversal onto a running scan */
    if (gs->cb.confirm_hide)
        gs->cb.confirm_hide(gs->cb.user);
    gs->session = ++gs->next_session;
    if (!gs->session) /* skip 0, the "no session" value, on wrap */
        gs->session = ++gs->next_session;
    gs->state = GS_SCANNING;
    gs->phase = 0;
    gs->folders_done = 0;
    if (gs->cb.progress_open)
        gs->cb.progress_open(gs->cb.user, gs->session);
}

void gs_cancel(GSScanner *gs)
{
    if (gs->state == GS_CONFIRM) {
        gs->state = GS_IDLE;
        if (gs->cb.confirm_hide)
            gs->cb.confirm_hide(gs->cb.user);
    } else if (gs->state == GS_SCANNING) {
        end_scan_cancelled(gs);
    }
}

void gs_stop(GSScanner *gs)
{
    if (gs->state == GS_PLAYING)
        release_playlist(gs);
    else if (gs->state == GS_SCANNING)
        end_scan_cancelled(gs);
}

GSState gs_state(const GSScanner *gs)
{
    return gs->state;
}

unsigned gs_session(const GSScanner *gs)
{
    return gs->session;
}

size_t gs_track_count(const GSScanner *gs)
{
    return gs->state == GS_PLAYING ? gs->track_count : 0;
}

const char *gs_track(const GSScanner *gs, size_t index)
{
    if (gs->state != GS_PLAYING || index >= gs->track_count)
        return NULL;
    return gs->tracks[index];
}

/* ------------------------------------------------------------------ */
/* delivery — the single validation choke point                        */

static int session_live(const GSScanner *gs, unsigned session)
{
    return session && session == gs->session && gs->state == GS_SCANNING;
}

void gs_deliver_progress(GSScanner *gs, unsigned session,
                         unsigned folders_done, unsigned folders_total,
                         unsigned tracks_found)
{
    if (!session_live(gs, session))
        return;
    if (gs->cb.progress_update)
        gs->cb.progress_update(gs->cb.user, session,
                               folders_done, folders_total, tracks_found);
}

int gs_deliver_done(GSScanner *gs, unsigned session,
                    char **tracks, size_t count)
{
    if (!session_live(gs, session))
        return 0;
    gs->tracks = tracks;
    gs->track_count = count;
    gs->track_cap = count;
    gs->state = GS_PLAYING;
    if (gs->cb.progress_close)
        gs->cb.progress_close(gs->cb.user, session);
    if (gs->cb.play)
        gs->cb.play(gs->cb.user, session,
                    (const char *const *)tracks, count);
    return 1;
}

void gs_deliver_error(GSScanner *gs, unsigned session, const char *message)
{
    if (!session_live(gs, session))
        return;
    end_scan_with_error(gs, message);
}

/* ------------------------------------------------------------------ */
/* the scan itself                                                     */

/* Collect every audio track under path, recursively. Returns 0 on
 * success, -1 if anything could not be read. */
static int collect_tracks(GSScanner *gs, const char *path)
{
    void *dir = gs->pf.dir_open(gs->pf.user, path);
    char name[GS_NAME_MAX];
    int is_dir;
    int r;
    int rc = 0;

    if (!dir)
        return -1;
    while ((r = gs->pf.dir_read(gs->pf.user, dir, name, sizeof(name),
                                &is_dir)) == 1) {
        char child[GS_PATH_MAX];
        if (!strcmp(name, ".") || !strcmp(name, ".."))
            continue;
        join_path(child, sizeof(child), path, name);
        if (is_dir) {
            if (collect_tracks(gs, child) != 0) {
                rc = -1;
                break;
            }
        } else if (is_audio(name)) {
            if (list_push(gs, &gs->tracks, &gs->track_count,
                          &gs->track_cap, child) != 0) {
                rc = -1;
                break;
            }
        }
    }
    if (r < 0)
        rc = -1;
    gs->pf.dir_close(gs->pf.user, dir);
    return rc;
}

static void shuffle(GSScanner *gs)
{
    size_t i;
    for (i = gs->track_count; i > 1; i--) {
        size_t j = gs_rand(gs) % i;
        char *tmp = gs->tracks[i - 1];
        gs->tracks[i - 1] = gs->tracks[j];
        gs->tracks[j] = tmp;
    }
}

int gs_pump(GSScanner *gs)
{
    if (gs->state != GS_SCANNING)
        return 0;

    if (gs->phase == 0) {
        /* First slice: list the top level of the music folder. That gives
         * the progress bar its total — the only total knowable without
         * reading the card twice. Loose files at the root count too. */
        void *dir = gs->pf.dir_open(gs->pf.user, gs->root);
        char name[GS_NAME_MAX];
        int is_dir;
        int r;
        int failed = 0;

        if (!dir) {
            gs_deliver_error(gs, gs->session, GS_ERR_UNREADABLE);
            return 0;
        }
        while ((r = gs->pf.dir_read(gs->pf.user, dir, name, sizeof(name),
                                    &is_dir)) == 1) {
            char child[GS_PATH_MAX];
            if (!strcmp(name, ".") || !strcmp(name, ".."))
                continue;
            join_path(child, sizeof(child), gs->root, name);
            if (is_dir) {
                if (list_push(gs, &gs->folders, &gs->folder_count,
                              &gs->folder_cap, child) != 0) {
                    failed = 1;
                    break;
                }
            } else if (is_audio(name)) {
                if (list_push(gs, &gs->tracks, &gs->track_count,
                              &gs->track_cap, child) != 0) {
                    failed = 1;
                    break;
                }
            }
        }
        if (r < 0)
            failed = 1;
        gs->pf.dir_close(gs->pf.user, dir);
        if (failed) {
            gs_deliver_error(gs, gs->session, GS_ERR_UNREADABLE);
            return 0;
        }
        gs->phase = 1;
        gs_deliver_progress(gs, gs->session, 0,
                            (unsigned)gs->folder_count,
                            (unsigned)gs->track_count);
        return 1;
    }

    if (gs->folders_done < gs->folder_count) {
        /* One top-level folder per slice: the bar advances per folder. */
        if (collect_tracks(gs, gs->folders[gs->folders_done]) != 0) {
            gs_deliver_error(gs, gs->session, GS_ERR_UNREADABLE);
            return 0;
        }
        gs->folders_done++;
        gs_deliver_progress(gs, gs->session, (unsigned)gs->folders_done,
                            (unsigned)gs->folder_count,
                            (unsigned)gs->track_count);
        return 1;
    }

    /* Whole card read: shuffle and hand the list to the player, through
     * the same validated delivery point an async backend would use. */
    shuffle(gs);
    {
        char **list = gs->tracks;
        size_t count = gs->track_count;
        gs->tracks = NULL;
        gs->track_count = 0;
        gs->track_cap = 0;
        list_free(gs, &gs->folders, &gs->folder_count, &gs->folder_cap);
        gs_deliver_done(gs, gs->session, list, count);
    }
    return 0;
}
