/*
 * tests/test_main.c - the acceptance suite for the shared library index.
 *
 * Each test builds a sample card under the system temporary directory and
 * drives the real scanner, cache, gallery and shuffle through the POSIX host.
 * No device is required.  The cases named in the task are covered as:
 *
 *   progress counts on a first scan        test_scan_progress_counts
 *   cancel leaves nothing, rescan          test_cancel_leaves_nothing
 *   second visit hits the cache            test_second_visit_uses_cache
 *   gallery and shuffle share one index    test_gallery_and_shuffle_share
 *   bad folder skipped and logged          test_unreadable_folder_is_skipped
 *   over-limit folder capped and logged    test_over_limit_folder_is_capped
 *   cue album counts its tracks            test_cue_album_counts_tracks
 *   folder change invalidates the index    test_folder_change_invalidates
 *   shuffle plays once then stops          test_shuffle_plays_once
 *   shuffle list released on stop          test_shuffle_release_drops_list
 *   shuffle mode is not remembered         test_shuffle_is_not_remembered
 *   a corrupt cache is a miss, not a crash test_corrupt_cache_is_a_miss
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#if defined(_WIN32)
#include <direct.h>
#else
#include <sys/stat.h>
#endif

#include "test_fixture.h"
#include "trax_common.h"
#include "trax_cue.h"
#include "trax_gallery.h"
#include "trax_host_posix.h"
#include "trax_index.h"
#include "trax_index_cache.h"
#include "trax_library.h"
#include "trax_log.h"
#include "trax_scan.h"
#include "trax_shuffle.h"

static int g_failures;
static int g_checks;
static const char *g_current_test;
static trax_log *g_log;

#define CHECK(cond)                                                          \
    do {                                                                     \
        ++g_checks;                                                          \
        if (!(cond)) {                                                       \
            ++g_failures;                                                    \
            printf("  FAIL %s:%d [%s] %s\n", __FILE__, __LINE__,             \
                   g_current_test, #cond);                                   \
        }                                                                    \
    } while (0)

#define CHECK_EQ_INT(actual, expected)                                       \
    do {                                                                     \
        long long a_ = (long long)(actual);                                  \
        long long e_ = (long long)(expected);                                \
        ++g_checks;                                                          \
        if (a_ != e_) {                                                      \
            ++g_failures;                                                    \
            printf("  FAIL %s:%d [%s] %s == %lld, expected %lld\n",          \
                   __FILE__, __LINE__, g_current_test, #actual, a_, e_);     \
        }                                                                    \
    } while (0)

#define CHECK_NOT_NULL(ptr) CHECK((ptr) != NULL)
#define CHECK_NULL(ptr) CHECK((ptr) == NULL)

/* ------------------------------------------------------------------ */
/* shared plumbing                                                     */
/* ------------------------------------------------------------------ */

typedef struct {
    unsigned calls;
    trax_scan_progress last;
    unsigned first_done;
    unsigned total_seen;
    unsigned tracks_seen;
    unsigned max_done;
    /* Cancel once folders_done reaches this value; 0 disables. */
    unsigned cancel_after_folders;
    /* Raise this flag instead of returning false, as the UI thread would. */
    trax_cancel_flag *flag;
} progress_capture;

static bool capture_progress(void *user, const trax_scan_progress *progress) {
    progress_capture *cap = (progress_capture *)user;
    ++cap->calls;
    cap->last = *progress;
    if (cap->calls == 1) cap->first_done = progress->folders_done;
    cap->total_seen = progress->folders_total;
    cap->tracks_seen = progress->tracks_found;
    if (progress->folders_done > cap->max_done) cap->max_done = progress->folders_done;
    if (cap->cancel_after_folders &&
        progress->folders_done >= cap->cancel_after_folders) {
        if (cap->flag) {
            trax_cancel_request(cap->flag);
            return true;
        }
        return false;
    }
    return true;
}

static void begin(const char *name) {
    g_current_test = name;
    if (g_log) trax_log_clear(g_log);
    printf("- %s\n", name);
}

static char *cache_path_for(fixture *fx, char *out, size_t cap) {
    if (!fixture_join(fx->music, TRAX_INDEX_CACHE_NAME, out, cap)) return NULL;
    return out;
}

/* ------------------------------------------------------------------ */
/* 1. progress on a first scan                                          */
/* ------------------------------------------------------------------ */

static void test_scan_progress_counts(void) {
    begin("scan progress counts folders and tracks");
    fixture fx;
    CHECK(fixture_create(&fx, "progress"));
    CHECK(fixture_make_albums(&fx, 4, 3)); /* 4 folders, 12 tracks */

    trax_host_posix hp;
    trax_host_posix_init(&hp);

    progress_capture cap;
    memset(&cap, 0, sizeof(cap));

    trax_library lib;
    memset(&lib, 0, sizeof(lib));
    trax_scan_options opt;
    memset(&opt, 0, sizeof(opt));
    opt.host = &hp.host;
    opt.log = g_log;
    opt.music_folder = fx.music;
    opt.on_progress = capture_progress;
    opt.progress_user = &cap;

    trax_status st = trax_scan_run(&opt, &lib);
    CHECK_EQ_INT(st, TRAX_OK);
    CHECK_EQ_INT(lib.track_count, 12);
    CHECK_EQ_INT(lib.album_count, 4);
    CHECK(lib.valid);
    CHECK_EQ_INT(lib.folders_total, 4);
    CHECK_EQ_INT(lib.folders_skipped, 0);
    CHECK_EQ_INT(lib.folders_capped, 0);

    /* Progress reported the right total and ended at it. */
    CHECK_EQ_INT(cap.total_seen, 4);
    CHECK_EQ_INT(cap.last.folders_total, 4);
    CHECK_EQ_INT(cap.max_done, 4);
    CHECK_EQ_INT(cap.last.tracks_found, 12);
    CHECK(cap.calls >= 5); /* one before the walk, one per folder at least */

    /* Every track found belongs to a folder whose path reads back. */
    size_t reachable = 0;
    for (size_t i = 0; i < lib.track_count; ++i) {
        char *p = trax_library_track_path(&lib, &lib.tracks[i]);
        if (p) ++reachable;
        trax_free(p);
    }
    CHECK_EQ_INT(reachable, 12);

    /* Every album maps onto its own run of tracks. */
    size_t album_tracks = 0;
    for (size_t i = 0; i < lib.album_count; ++i) {
        const trax_track *tracks = NULL;
        size_t count = 0;
        CHECK(trax_library_album_tracks(&lib, &lib.albums[i], &tracks, &count));
        album_tracks += count;
    }
    CHECK_EQ_INT(album_tracks, 12);

    trax_library_clear(&lib);
    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* A folder that starts with the cache's name must still be walked; only the
 * cache file itself is excluded. */
static void test_cache_name_folder_is_indexed(void) {
    begin("a folder named like the cache is not mistaken for it");
    fixture fx;
    CHECK(fixture_create(&fx, "cachefolder"));
    CHECK(fixture_make_albums(&fx, 1, 2));
    CHECK(fixture_make_big_album(&fx, TRAX_INDEX_CACHE_NAME "-extra", 3));

    trax_host_posix hp;
    trax_host_posix_init(&hp);
    trax_library lib;
    memset(&lib, 0, sizeof(lib));
    trax_scan_options opt;
    memset(&opt, 0, sizeof(opt));
    opt.host = &hp.host;
    opt.log = g_log;
    opt.music_folder = fx.music;
    CHECK_EQ_INT(trax_scan_run(&opt, &lib), TRAX_OK);
    CHECK_EQ_INT(lib.track_count, 5);

    trax_library_clear(&lib);
    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* ------------------------------------------------------------------ */
/* 2. cancel                                                          */
/* ------------------------------------------------------------------ */

static void test_cancel_leaves_nothing(void) {
    begin("cancel leaves nothing and the next entry scans again");
    fixture fx;
    CHECK(fixture_create(&fx, "cancel"));
    CHECK(fixture_make_albums(&fx, 8, 4)); /* 8 folders, 32 tracks */

    trax_host_posix hp;
    trax_host_posix_init(&hp);
    char cache[1400];
    CHECK_NOT_NULL(cache_path_for(&fx, cache, sizeof(cache)));

    /* The host and log are already allocated; the scan must add nothing
     * that outlives its cancellation. */
    progress_capture cap;
    memset(&cap, 0, sizeof(cap));
    cap.cancel_after_folders = 3; /* ask to stop after the third folder */

    trax_library lib;
    memset(&lib, 0, sizeof(lib));
    trax_scan_options opt;
    memset(&opt, 0, sizeof(opt));
    opt.host = &hp.host;
    opt.log = g_log;
    opt.music_folder = fx.music;
    opt.on_progress = capture_progress;
    opt.progress_user = &cap;

    trax_status st = trax_scan_run(&opt, &lib);
    CHECK_EQ_INT(st, TRAX_CANCELLED);
    /* Nothing half-built survives. */
    CHECK_EQ_INT(lib.track_count, 0);
    CHECK_EQ_INT(lib.album_count, 0);
    CHECK_EQ_INT(lib.folder_count, 0);
    CHECK(!lib.valid);
    CHECK_NULL(lib.music_folder);
    CHECK(trax_log_contains(g_log, "cancelled"));
    CHECK(trax_log_contains(g_log, "nothing kept"));
    trax_library_clear(&lib);

    /* No allocation the scan made survives the cancellation.  A log retains
     * its lines on purpose, so this second cancelled walk writes to a log of
     * its own, which is destroyed before the count is compared. */
    {
        size_t baseline_blocks = trax_alloc_live_blocks();
        trax_log *scratch = trax_log_create();
        trax_scan_options opt2 = opt;
        opt2.log = scratch;
        trax_library lib2;
        memset(&lib2, 0, sizeof(lib2));
        CHECK_EQ_INT(trax_scan_run(&opt2, &lib2), TRAX_CANCELLED);
        trax_library_clear(&lib2);
        trax_log_destroy(scratch);
        CHECK_EQ_INT(trax_alloc_live_blocks(), baseline_blocks);
    }

    /* No cache was written, so a fresh acquire must scan in full. */
    FILE *probe = fopen(cache, "rb");
    CHECK_NULL(probe);
    if (probe) fclose(probe);

    trax_index_options io;
    memset(&io, 0, sizeof(io));
    io.host = &hp.host;
    io.log = g_log;

    /* First entry: cancel partway through, via the progress callback. */
    progress_capture cap2;
    memset(&cap2, 0, sizeof(cap2));
    cap2.cancel_after_folders = 2;
    io.on_progress = capture_progress;
    io.progress_user = &cap2;
    trax_index *index = trax_index_create(&io);
    CHECK_NOT_NULL(index);

    const trax_library *lib_ptr = (const trax_library *)0x1;
    trax_index_report report;
    st = trax_index_acquire(index, fx.music, &lib_ptr, &report);
    CHECK_EQ_INT(st, TRAX_CANCELLED);
    CHECK_NULL(lib_ptr);
    CHECK_NULL(trax_index_peek(index));
    CHECK_NULL(trax_index_music_folder(index));
    /* Nothing was written for the partial walk. */
    {
        FILE *partial = fopen(cache, "rb");
        CHECK_NULL(partial);
        if (partial) fclose(partial);
    }
    trax_index_destroy(index);

    /* Second entry: the card is read from the start, in full. */
    progress_capture cap3;
    memset(&cap3, 0, sizeof(cap3));
    trax_index_options io2 = io;
    io2.on_progress = capture_progress;
    io2.progress_user = &cap3;
    index = trax_index_create(&io2);
    st = trax_index_acquire(index, fx.music, &lib_ptr, &report);
    CHECK_EQ_INT(st, TRAX_OK);
    CHECK_NOT_NULL(lib_ptr);
    if (lib_ptr) {
        CHECK_EQ_INT(lib_ptr->track_count, 32);
        CHECK_EQ_INT(cap3.total_seen, 8);
        CHECK_EQ_INT(cap3.max_done, 8);
        CHECK(!report.hit_cache);
        CHECK_EQ_INT(report.source, TRAX_INDEX_SOURCE_SCAN);
        CHECK_EQ_INT(report.folders_total, 8);
        CHECK_EQ_INT(report.folders_done, 8);
        trax_index_release(index, lib_ptr);
    }

    trax_index_destroy(index);
    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* ------------------------------------------------------------------ */
/* 3. second visit uses the cache                                      */
/* ------------------------------------------------------------------ */

static void test_second_visit_uses_cache(void) {
    begin("second visit is answered from the cache");
    fixture fx;
    CHECK(fixture_create(&fx, "cache"));
    CHECK(fixture_make_albums(&fx, 6, 5)); /* 6 folders, 30 tracks */

    trax_host_posix hp;
    trax_host_posix_init(&hp);
    char cache[1400];
    CHECK_NOT_NULL(cache_path_for(&fx, cache, sizeof(cache)));

    trax_index_options io;
    memset(&io, 0, sizeof(io));
    io.host = &hp.host;
    io.log = g_log;

    trax_index *index = trax_index_create(&io);
    const trax_library *first = NULL;
    trax_index_report r1;
    CHECK_EQ_INT(trax_index_acquire(index, fx.music, &first, &r1), TRAX_OK);
    CHECK_NOT_NULL(first);
    CHECK(!r1.hit_cache);
    CHECK_EQ_INT(r1.tracks, 30);
    CHECK_EQ_INT(r1.albums, 6);
    CHECK_EQ_INT(r1.folders_total, 6);
    if (first) trax_index_release(index, first);

    /* The cache exists after a complete walk. */
    FILE *probe = fopen(cache, "rb");
    CHECK_NOT_NULL(probe);
    if (probe) fclose(probe);

    /* A fresh index (as a new launch would make) must not list the card's
     * folders again: that is what "obviously faster" means here. */
    unsigned list_calls_before = hp.faults.list_calls;
    trax_index_destroy(index);
    index = trax_index_create(&io);
    const trax_library *second = NULL;
    trax_index_report r2;
    CHECK_EQ_INT(trax_index_acquire(index, fx.music, &second, &r2), TRAX_OK);
    CHECK_NOT_NULL(second);
    CHECK(r2.hit_cache);
    CHECK_EQ_INT(r2.source, TRAX_INDEX_SOURCE_CACHE);
    CHECK_EQ_INT(r2.scan_ms, 0);
    CHECK_EQ_INT(r2.tracks, 30);
    CHECK_EQ_INT(r2.albums, 6);
    CHECK_EQ_INT(r2.folders_total, 6);
    CHECK_EQ_INT(r2.folders_done, 6);
    /* Only the root listing was needed for the fingerprint. */
    CHECK_EQ_INT(hp.faults.list_calls - list_calls_before, 1);
    CHECK(trax_log_contains(g_log, "used the cache"));

    if (second) trax_index_release(index, second);
    trax_index_destroy(index);
    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* ------------------------------------------------------------------ */
/* 4. gallery and shuffle share one walk                              */
/* ------------------------------------------------------------------ */

static void test_gallery_and_shuffle_share(void) {
    begin("the gallery and global shuffle share one index");
    fixture fx;
    CHECK(fixture_create(&fx, "share"));
    CHECK(fixture_make_albums(&fx, 5, 4)); /* 20 tracks */

    trax_host_posix hp;
    trax_host_posix_init(&hp);

    trax_index_options io;
    memset(&io, 0, sizeof(io));
    io.host = &hp.host;
    io.log = g_log;
    trax_index *index = trax_index_create(&io);

    trax_gallery_options go;
    memset(&go, 0, sizeof(go));
    go.index = index;
    trax_gallery *gallery = trax_gallery_create(&go);
    CHECK_NOT_NULL(gallery);

    trax_index_report gr;
    CHECK_EQ_INT(trax_gallery_open(gallery, fx.music, &gr), TRAX_OK);
    CHECK_EQ_INT(trax_gallery_album_count(gallery), 5);
    CHECK(!gr.hit_cache);

    /* The shuffle starts from the gallery's index, without a second walk. */
    unsigned list_calls_before = hp.faults.list_calls;
    trax_shuffle_options so;
    memset(&so, 0, sizeof(so));
    so.index = index;
    so.log = g_log;
    trax_shuffle *shuffle = trax_shuffle_create(&so);
    CHECK_NOT_NULL(shuffle);
    trax_index_report sr;
    CHECK_EQ_INT(trax_shuffle_start(shuffle, fx.music, &sr), TRAX_OK);
    CHECK(sr.hit_cache);
    CHECK_EQ_INT(sr.tracks, 20);
    CHECK_EQ_INT(hp.faults.list_calls - list_calls_before, 0);

    /* Both hold a claim on the same library, and it is the same object. */
    CHECK_EQ_INT(trax_index_claim_count(index), 2);
    CHECK(trax_shuffle_library(shuffle) == trax_index_peek(index));

    /* The album wall survives the shuffle stopping. */
    trax_shuffle_stop(shuffle);
    CHECK_EQ_INT(trax_index_claim_count(index), 1);
    CHECK_EQ_INT(trax_gallery_album_count(gallery), 5);
    CHECK(trax_gallery_is_open(gallery));

    trax_gallery_close(gallery);
    CHECK_EQ_INT(trax_index_claim_count(index), 0);

    trax_shuffle_destroy(shuffle);
    trax_gallery_destroy(gallery);
    trax_index_destroy(index);
    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* Closing the gallery and then starting a shuffle must not read the card
 * again: the index owns its own reference for exactly this reason. */
static void test_shuffle_reuses_index_after_gallery_closes(void) {
    begin("a shuffle after the gallery closes reuses the shared index");
    fixture fx;
    CHECK(fixture_create(&fx, "reuse"));
    CHECK(fixture_make_albums(&fx, 4, 3));

    trax_host_posix hp;
    trax_host_posix_init(&hp);
    trax_index_options io;
    memset(&io, 0, sizeof(io));
    io.host = &hp.host;
    io.log = g_log;
    trax_index *index = trax_index_create(&io);

    trax_gallery_options go;
    memset(&go, 0, sizeof(go));
    go.index = index;
    trax_gallery *gallery = trax_gallery_create(&go);
    CHECK_EQ_INT(trax_gallery_open(gallery, fx.music, NULL), TRAX_OK);
    trax_gallery_close(gallery);
    CHECK_EQ_INT(trax_index_claim_count(index), 0);

    unsigned list_calls_before = hp.faults.list_calls;
    trax_shuffle_options so;
    memset(&so, 0, sizeof(so));
    so.index = index;
    so.log = g_log;
    trax_shuffle *shuffle = trax_shuffle_create(&so);
    trax_index_report report;
    CHECK_EQ_INT(trax_shuffle_start(shuffle, fx.music, &report), TRAX_OK);
    CHECK(report.hit_cache);
    CHECK_EQ_INT(report.tracks, 12);
    /* Not one directory of the card was listed again. */
    CHECK_EQ_INT(hp.faults.list_calls - list_calls_before, 0);
    trax_shuffle_stop(shuffle);

    trax_shuffle_destroy(shuffle);
    trax_gallery_destroy(gallery);
    trax_index_destroy(index);
    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* The UI thread cancels by raising the shared flag; the scanner must notice
 * between folders even though the callback never returns false. */
static void test_cancel_flag_from_ui_thread(void) {
    begin("the cancel flag stops a walk that is under way");
    fixture fx;
    CHECK(fixture_create(&fx, "flagcancel"));
    CHECK(fixture_make_albums(&fx, 8, 3));

    trax_host_posix hp;
    trax_host_posix_init(&hp);
    char cache[1400];
    CHECK(fixture_join(fx.music, TRAX_INDEX_CACHE_NAME, cache, sizeof(cache)));

    trax_cancel_flag flag;
    trax_cancel_init(&flag);

    progress_capture cap;
    memset(&cap, 0, sizeof(cap));
    cap.cancel_after_folders = 3;
    cap.flag = &flag;

    trax_index_options io;
    memset(&io, 0, sizeof(io));
    io.host = &hp.host;
    io.log = g_log;
    io.cancel = &flag;
    io.on_progress = capture_progress;
    io.progress_user = &cap;
    trax_index *index = trax_index_create(&io);

    const trax_library *lib = (const trax_library *)0x1;
    trax_index_report report;
    CHECK_EQ_INT(trax_index_acquire(index, fx.music, &lib, &report), TRAX_CANCELLED);
    CHECK_NULL(lib);
    CHECK_NULL(trax_index_peek(index));
    FILE *probe = fopen(cache, "rb");
    CHECK_NULL(probe);
    if (probe) fclose(probe);
    trax_index_destroy(index);

    /* A cancelled run does not poison the flag for the next entry: the caller
     * clears it, as the UI's Cancel dialog does, and the card is read fully. */
    trax_cancel_reset(&flag);
    trax_index_options io2 = io;
    io2.on_progress = NULL;
    io2.progress_user = NULL;
    index = trax_index_create(&io2);
    CHECK_EQ_INT(trax_index_acquire(index, fx.music, &lib, &report), TRAX_OK);
    CHECK_EQ_INT(report.tracks, 24);
    CHECK(!report.hit_cache);
    if (lib) trax_index_release(index, lib);
    trax_index_destroy(index);

    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* ------------------------------------------------------------------ */
/* 5. an unreadable folder is skipped, logged, and the walk continues  */
/* ------------------------------------------------------------------ */

static void test_unreadable_folder_is_skipped(void) {
    begin("an unreadable folder is skipped and logged");
    fixture fx;
    CHECK(fixture_create(&fx, "bad"));
    CHECK(fixture_make_albums(&fx, 3, 2)); /* 6 tracks in 3 folders */
    CHECK(fixture_make_folder(&fx, "Broken Album"));

    char broken[1400];
    CHECK(fixture_join(fx.music, "Broken Album", broken, sizeof(broken)));

    trax_host_posix hp;
    trax_host_posix_init(&hp);
    CHECK(trax_host_posix_fail_list(&hp, broken));

    progress_capture cap;
    memset(&cap, 0, sizeof(cap));

    trax_library lib;
    memset(&lib, 0, sizeof(lib));
    trax_scan_options opt;
    memset(&opt, 0, sizeof(opt));
    opt.host = &hp.host;
    opt.log = g_log;
    opt.music_folder = fx.music;
    opt.on_progress = capture_progress;
    opt.progress_user = &cap;

    CHECK_EQ_INT(trax_scan_run(&opt, &lib), TRAX_OK);
    /* The walk finished; the other albums are all there, and the bar still
     * reached its total even though one folder was skipped. */
    CHECK_EQ_INT(cap.total_seen, 4);
    CHECK_EQ_INT(cap.max_done, 4);
    CHECK_EQ_INT(lib.track_count, 6);
    CHECK_EQ_INT(lib.album_count, 3);
    CHECK_EQ_INT(lib.folders_skipped, 1);
    CHECK(lib.valid);
    CHECK(trax_log_contains(g_log, "Broken Album"));
    CHECK(trax_log_contains(g_log, "could not be read"));
    CHECK(trax_log_contains(g_log, "skipped"));

    /* The skipped folder is not silently reported as an empty album. */
    bool saw_broken = false;
    for (size_t i = 0; i < lib.album_count; ++i) {
        if (lib.albums[i].title &&
            strstr(lib.albums[i].title, "Broken Album") != NULL) {
            saw_broken = true;
        }
    }
    CHECK(!saw_broken);

    trax_library_clear(&lib);
    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* A cue sheet that cannot be read must not lose its audio either. */
static void test_unreadable_cue_does_not_lose_audio(void) {
    begin("an unreadable cue sheet falls back to its audio file");
    fixture fx;
    CHECK(fixture_create(&fx, "badcue"));
    const char *sheet =
        "FILE \"album.flac\" WAVE\n"
        "  TRACK 01 AUDIO\n"
        "    TITLE \"One\"\n"
        "    INDEX 01 00:00:00\n";
    CHECK(fixture_make_cue_album(&fx, "Cue", "album.flac", "album.cue", sheet));

    char cue_path[1400];
    CHECK(fixture_join(fx.music, "Cue/album.cue", cue_path, sizeof(cue_path)));

    trax_host_posix hp;
    trax_host_posix_init(&hp);
    CHECK(trax_host_posix_fail_read(&hp, cue_path));

    trax_library lib;
    memset(&lib, 0, sizeof(lib));
    trax_scan_options opt;
    memset(&opt, 0, sizeof(opt));
    opt.host = &hp.host;
    opt.log = g_log;
    opt.music_folder = fx.music;
    CHECK_EQ_INT(trax_scan_run(&opt, &lib), TRAX_OK);
    /* One plain track, not zero. */
    CHECK_EQ_INT(lib.track_count, 1);
    CHECK_EQ_INT(lib.album_count, 1);
    CHECK(trax_log_contains(g_log, "could not be read"));

    trax_library_clear(&lib);
    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* ------------------------------------------------------------------ */
/* 6. an over-limit folder keeps the first 1024 and says so           */
/* ------------------------------------------------------------------ */

static void test_over_limit_folder_is_capped(void) {
    begin("a folder over 1024 tracks is capped and logged");
    fixture fx;
    CHECK(fixture_create(&fx, "cap"));
    CHECK(fixture_make_big_album(&fx, "Huge", 1100));

    trax_host_posix hp;
    trax_host_posix_init(&hp);

    trax_library lib;
    memset(&lib, 0, sizeof(lib));
    trax_scan_options opt;
    memset(&opt, 0, sizeof(opt));
    opt.host = &hp.host;
    opt.log = g_log;
    opt.music_folder = fx.music;

    CHECK_EQ_INT(trax_scan_run(&opt, &lib), TRAX_OK);
    CHECK_EQ_INT(lib.track_count, TRAX_TRACKS_PER_FOLDER_LIMIT);
    CHECK_EQ_INT(lib.album_count, 1);
    CHECK_EQ_INT(lib.folders_capped, 1);
    CHECK_EQ_INT(lib.folders_skipped, 0);
    CHECK(trax_log_contains(g_log, "Huge"));
    CHECK(trax_log_contains(g_log, "1100"));
    CHECK(trax_log_contains(g_log, "1024"));

    /* The retained tracks are the first ones in name order. */
    const trax_track *tracks = NULL;
    size_t count = 0;
    CHECK(trax_library_album_tracks(&lib, &lib.albums[0], &tracks, &count));
    CHECK_EQ_INT(count, TRAX_TRACKS_PER_FOLDER_LIMIT);
    if (count > 0) {
        CHECK_NOT_NULL(strstr(tracks[0].file_name, "000"));
        CHECK_NOT_NULL(strstr(tracks[count - 1].file_name, "1023"));
    }

    trax_library_clear(&lib);
    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* ------------------------------------------------------------------ */
/* 7. a cue album contributes its tracks, not its audio file          */
/* ------------------------------------------------------------------ */

static void test_cue_album_counts_tracks(void) {
    begin("a cue album counts its splits, not its audio file");
    fixture fx;
    CHECK(fixture_create(&fx, "cue"));
    CHECK(fixture_make_albums(&fx, 1, 2)); /* one plain album, 2 tracks */

    const char *sheet =
        "REM GENRE Rock\n"
        "TITLE \"Live at the Hall\"\n"
        "PERFORMER \"Someone\"\n"
        "FILE \"gig.flac\" WAVE\n"
        "  TRACK 01 AUDIO\n"
        "    TITLE \"Opening\"\n"
        "    INDEX 01 00:00:00\n"
        "  TRACK 02 AUDIO\n"
        "    TITLE \"Middle\"\n"
        "    INDEX 01 03:12:40\n"
        "  TRACK 03 AUDIO\n"
        "    TITLE \"Encore\"\n"
        "    INDEX 01 07:44:10\n";
    CHECK(fixture_make_cue_album(&fx, "Gig", "gig.flac", "gig.cue", sheet));

    trax_host_posix hp;
    trax_host_posix_init(&hp);

    trax_library lib;
    memset(&lib, 0, sizeof(lib));
    trax_scan_options opt;
    memset(&opt, 0, sizeof(opt));
    opt.host = &hp.host;
    opt.log = g_log;
    opt.music_folder = fx.music;
    CHECK_EQ_INT(trax_scan_run(&opt, &lib), TRAX_OK);

    /* 2 plain tracks + 3 cue splits; the .flac is not a fourth. */
    CHECK_EQ_INT(lib.track_count, 5);
    CHECK_EQ_INT(lib.album_count, 2);

    const trax_album *cue_album = NULL;
    for (size_t i = 0; i < lib.album_count; ++i) {
        if (lib.albums[i].from_cue) cue_album = &lib.albums[i];
    }
    CHECK_NOT_NULL(cue_album);
    if (cue_album) {
        CHECK_EQ_INT(cue_album->track_count, 3);
        CHECK_NOT_NULL(cue_album->cue_file);
        CHECK_NOT_NULL(cue_album->title);
        if (cue_album->title) {
            CHECK(strcmp(cue_album->title, "Live at the Hall") == 0);
        }
        const trax_track *tracks = NULL;
        size_t count = 0;
        CHECK(trax_library_album_tracks(&lib, cue_album, &tracks, &count));
        CHECK_EQ_INT(count, 3);
        for (size_t i = 0; i < count; ++i) {
            CHECK_EQ_INT(tracks[i].kind, TRAX_TRACK_CUE);
            CHECK_EQ_INT(tracks[i].cue_track, (int)(i + 1));
            CHECK(strcmp(tracks[i].file_name, "gig.flac") == 0);
        }
        if (count == 3) {
            /* Titles come from the sheet's TRACK TITLE lines. */
            CHECK(strcmp(tracks[0].title, "Opening") == 0);
            CHECK(strcmp(tracks[1].title, "Middle") == 0);
            CHECK(strcmp(tracks[2].title, "Encore") == 0);
            /* INDEX 01 03:12:40 = (3*60+12)*75+40 frames. */
            CHECK_EQ_INT(tracks[1].cue_index, ((3 * 60 + 12) * 75 + 40));
        }
    }

    /* The audio file appears exactly once as a track row per split, never as
     * a plain file of its own. */
    size_t gig_rows = 0;
    for (size_t i = 0; i < lib.track_count; ++i) {
        if (strcmp(lib.tracks[i].file_name, "gig.flac") == 0) ++gig_rows;
    }
    CHECK_EQ_INT(gig_rows, 3);

    /* Global shuffle sees the same count. */
    trax_index_options io;
    memset(&io, 0, sizeof(io));
    io.host = &hp.host;
    io.log = g_log;
    trax_index *index = trax_index_create(&io);
    const trax_library *shared = NULL;
    trax_index_report report;
    CHECK_EQ_INT(trax_index_acquire(index, fx.music, &shared, &report), TRAX_OK);
    CHECK_EQ_INT(report.tracks, 5);
    trax_shuffle_options so;
    memset(&so, 0, sizeof(so));
    so.index = index;
    so.log = g_log;
    trax_shuffle *shuffle = trax_shuffle_create(&so);
    CHECK_EQ_INT(trax_shuffle_start(shuffle, fx.music, &report), TRAX_OK);
    CHECK_EQ_INT(trax_shuffle_length(shuffle), 5);
    trax_shuffle_destroy(shuffle);
    if (shared) trax_index_release(index, shared);
    trax_index_destroy(index);

    trax_library_clear(&lib);
    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* A mixed-mode sheet's data track is not a track TRAX can play. */
static void test_cue_data_track_not_counted(void) {
    begin("a cue sheet's data track is not counted");
    fixture fx;
    CHECK(fixture_create(&fx, "cuedata"));
    const char *sheet =
        "FILE \"disc.bin\" BINARY\n"
        "  TRACK 01 MODE1/2352\n"
        "    INDEX 01 00:00:00\n"
        "FILE \"disc.wav\" WAVE\n"
        "  TRACK 02 AUDIO\n"
        "    TITLE \"Song\"\n"
        "    INDEX 01 00:00:00\n"
        "  TRACK 03 AUDIO\n"
        "    TITLE \"Other\"\n"
        "    INDEX 01 04:01:00\n";
    CHECK(fixture_make_cue_album(&fx, "Mixed", "disc.wav", "disc.cue", sheet));
    /* The BINARY track names disc.bin, which does not exist; that is fine. */

    trax_host_posix hp;
    trax_host_posix_init(&hp);
    trax_library lib;
    memset(&lib, 0, sizeof(lib));
    trax_scan_options opt;
    memset(&opt, 0, sizeof(opt));
    opt.host = &hp.host;
    opt.log = g_log;
    opt.music_folder = fx.music;
    CHECK_EQ_INT(trax_scan_run(&opt, &lib), TRAX_OK);
    CHECK_EQ_INT(lib.track_count, 2);
    trax_library_clear(&lib);
    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* A sheet whose FILE line is in another encoding finds its audio by stem. */
static void test_cue_shiftjis_named_audio_resolves(void) {
    begin("a cue sheet naming another encoding still resolves its audio");
    fixture fx;
    CHECK(fixture_create(&fx, "cuesjis"));
    /* The sheet spells a name that can never match the card's UTF-8 name. */
    const char *sheet =
        "\x93\xfa\x96\x7b\x8c\xea.flac WAVE\n"
        "  TRACK 01 AUDIO\n"
        "    TITLE \"A\"\n"
        "    INDEX 01 00:00:00\n"
        "  TRACK 02 AUDIO\n"
        "    TITLE \"B\"\n"
        "    INDEX 01 05:00:00\n";
    CHECK(fixture_make_cue_album(&fx, "Japanese", "Live in Tokyo.flac",
                                 "tokyo.cue", sheet));

    trax_host_posix hp;
    trax_host_posix_init(&hp);
    trax_library lib;
    memset(&lib, 0, sizeof(lib));
    trax_scan_options opt;
    memset(&opt, 0, sizeof(opt));
    opt.host = &hp.host;
    opt.log = g_log;
    opt.music_folder = fx.music;
    CHECK_EQ_INT(trax_scan_run(&opt, &lib), TRAX_OK);
    /* One audio file in the folder, so the sheet's unusable name still
     * resolves to it, and the album contributes two splits. */
    CHECK_EQ_INT(lib.track_count, 2);
    CHECK_EQ_INT(lib.album_count, 1);
    if (lib.track_count == 2) {
        CHECK(strcmp(lib.tracks[0].file_name, "Live in Tokyo.flac") == 0);
    }
    trax_library_clear(&lib);
    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* A cue sheet listing more than 1024 tracks is capped the same way. */
static void test_cue_over_limit_is_capped(void) {
    begin("a cue sheet over 1024 tracks is capped and logged");
    fixture fx;
    CHECK(fixture_create(&fx, "cuebig"));

    /* Build a 1030-track sheet: FILE once, then TRACK lines, which is what a
     * real long-disc sheet looks like. */
    size_t cap = 1030 * 64 + 64;
    char *sheet = (char *)malloc(cap);
    CHECK_NOT_NULL(sheet);
    if (!sheet) {
        fixture_destroy(&fx);
        return;
    }
    size_t used = (size_t)snprintf(sheet, cap, "FILE \"long.wav\" WAVE\n");
    for (unsigned t = 1; t <= 1030; ++t) {
        used += (size_t)snprintf(sheet + used, cap - used,
                                 "  TRACK %02u AUDIO\n    INDEX 01 %02u:%02u:00\n",
                                 t, t / 60, t % 60);
    }
    CHECK(fixture_make_cue_album(&fx, "Long", "long.wav", "long.cue", sheet));
    free(sheet);

    trax_host_posix hp;
    trax_host_posix_init(&hp);
    trax_library lib;
    memset(&lib, 0, sizeof(lib));
    trax_scan_options opt;
    memset(&opt, 0, sizeof(opt));
    opt.host = &hp.host;
    opt.log = g_log;
    opt.music_folder = fx.music;
    CHECK_EQ_INT(trax_scan_run(&opt, &lib), TRAX_OK);
    CHECK_EQ_INT(lib.track_count, TRAX_TRACKS_PER_FOLDER_LIMIT);
    CHECK_EQ_INT(lib.folders_capped, 1);
    CHECK(trax_log_contains(g_log, "more than 1024"));
    trax_library_clear(&lib);
    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* ------------------------------------------------------------------ */
/* 8. switching the music folder makes the old index unusable          */
/* ------------------------------------------------------------------ */

static void test_folder_change_invalidates(void) {
    begin("switching the music folder drops the old index and its cache");
    fixture fx;
    CHECK(fixture_create(&fx, "switch"));
    CHECK(fixture_make_albums(&fx, 3, 2)); /* 6 tracks */

    char other[1400];
    CHECK(fixture_create_other_music(&fx, "two", other, sizeof(other)));
    /* Put something different in the other folder: 2 albums of 7. */
    {
        char rel[1400];
        CHECK(fixture_join(other, "Band", rel, sizeof(rel)));
#if defined(_WIN32)
        _mkdir(rel);
#else
        mkdir(rel, 0777);
#endif
        for (int i = 0; i < 7; ++i) {
            char file[8192];
            snprintf(file, sizeof(file), "%s/%02d.mp3", rel, i);
            FILE *f = fopen(file, "wb");
            CHECK_NOT_NULL(f);
            if (f) {
                fputc('x', f);
                fclose(f);
            }
        }
    }

    trax_host_posix hp;
    trax_host_posix_init(&hp);

    char cache_a[1400];
    CHECK_NOT_NULL(cache_path_for(&fx, cache_a, sizeof(cache_a)));

    trax_index_options io;
    memset(&io, 0, sizeof(io));
    io.host = &hp.host;
    io.log = g_log;
    trax_index *index = trax_index_create(&io);

    const trax_library *lib = NULL;
    trax_index_report report;
    CHECK_EQ_INT(trax_index_acquire(index, fx.music, &lib, &report), TRAX_OK);
    CHECK_EQ_INT(report.tracks, 6);
    CHECK_NOT_NULL(trax_index_peek(index));
    if (lib) trax_index_release(index, lib);

    /* Switch the setting.  A real settings row invalidates; the acquire path
     * also refuses a held index for another folder. */
    trax_index_invalidate(index);
    CHECK_NULL(trax_index_peek(index));
    FILE *probe = fopen(cache_a, "rb");
    CHECK_NULL(probe);
    if (probe) fclose(probe);
    CHECK(trax_log_contains(g_log, "music folder changed"));

    /* Entering with the new folder reads the new card, not the old one. */
    CHECK_EQ_INT(trax_index_acquire(index, other, &lib, &report), TRAX_OK);
    CHECK_EQ_INT(report.tracks, 7);
    CHECK(!report.hit_cache);
    if (lib) {
        CHECK(lib->music_folder && strcmp(lib->music_folder, other) == 0);
        trax_index_release(index, lib);
    }

    /* And switching back does not resurrect A's old index: its cache was
     * removed with the invalidation, so A is walked again. */
    CHECK_EQ_INT(trax_index_acquire(index, fx.music, &lib, &report), TRAX_OK);
    CHECK_EQ_INT(report.tracks, 6);
    CHECK(!report.hit_cache);
    if (lib) trax_index_release(index, lib);

    trax_index_destroy(index);
    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* A cache written for folder A must never be handed out for folder B, even
 * when both cache files exist and both folders are readable. */
static void test_cache_for_other_folder_is_a_miss(void) {
    begin("a cache describing another folder is a miss");
    fixture fx;
    CHECK(fixture_create(&fx, "othermisc"));
    CHECK(fixture_make_albums(&fx, 2, 3));
    char other[1400];
    CHECK(fixture_create_other_music(&fx, "misc", other, sizeof(other)));

    trax_host_posix hp;
    trax_host_posix_init(&hp);

    /* Copy A's cache over B's, as a renamed folder or a stale card might. */
    char a_cache[1400], b_cache[1400];
    CHECK(fixture_join(fx.music, TRAX_INDEX_CACHE_NAME, a_cache,
                       sizeof(a_cache)));
    CHECK(fixture_join(other, TRAX_INDEX_CACHE_NAME, b_cache,
                       sizeof(b_cache)));

    trax_index_options io;
    memset(&io, 0, sizeof(io));
    io.host = &hp.host;
    io.log = g_log;
    trax_index *index = trax_index_create(&io);
    const trax_library *lib = NULL;
    trax_index_report report;
    CHECK_EQ_INT(trax_index_acquire(index, fx.music, &lib, &report), TRAX_OK);
    if (lib) trax_index_release(index, lib);
    trax_index_destroy(index);

    char *bytes = NULL;
    size_t len = 0;
    CHECK_EQ_INT(trax_host_posix_read_file(NULL, a_cache, &bytes, &len), TRAX_OK);
    CHECK(trax_host_posix_write_file(NULL, b_cache, bytes, len) == TRAX_OK);
    trax_free(bytes);

    index = trax_index_create(&io);
    /* B must be walked, not answered with A's two albums. */
    CHECK_EQ_INT(trax_index_acquire(index, other, &lib, &report), TRAX_OK);
    CHECK(!report.hit_cache);
    CHECK_EQ_INT(report.tracks, 0); /* B is empty apart from the cache file */
    if (lib) trax_index_release(index, lib);
    trax_index_destroy(index);

    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* ------------------------------------------------------------------ */
/* 9. global shuffle plays once and stops                             */
/* ------------------------------------------------------------------ */

static uint32_t scripted_rand(void *user) {
    unsigned *n = (unsigned *)user;
    ++*n;
    /* A cheap, deterministic sequence; the test only asserts the order is a
     * permutation, not any particular shuffle. */
    return (uint32_t)((*n * 2654435761u) >> 3);
}

static void test_shuffle_plays_once(void) {
    begin("global shuffle plays the card through once and stops");
    fixture fx;
    CHECK(fixture_create(&fx, "shuffle"));
    CHECK(fixture_make_albums(&fx, 4, 4)); /* 16 tracks */

    trax_host_posix hp;
    trax_host_posix_init(&hp);

    unsigned seed = 1;
    trax_shuffle_options so;
    memset(&so, 0, sizeof(so));
    so.host = &hp.host;
    so.log = g_log;
    so.rand = scripted_rand;
    so.rand_user = &seed;
    trax_shuffle *shuffle = trax_shuffle_create(&so);
    CHECK_NOT_NULL(shuffle);

    trax_index_report report;
    CHECK_EQ_INT(trax_shuffle_start(shuffle, fx.music, &report), TRAX_OK);
    CHECK(trax_shuffle_is_active(shuffle));
    CHECK_EQ_INT(trax_shuffle_length(shuffle), 16);

    /* Every track appears exactly once in the order. */
    unsigned seen[16];
    memset(seen, 0, sizeof(seen));
    size_t steps = 0;
    while (trax_shuffle_current_track(shuffle) >= 0) {
        int32_t idx = trax_shuffle_current_track(shuffle);
        CHECK(idx >= 0 && idx < 16);
        if (idx >= 0 && idx < 16) ++seen[idx];
        ++steps;
        CHECK(steps <= 16); /* never loops */
        trax_shuffle_advance(shuffle);
    }
    CHECK_EQ_INT(steps, 16);
    CHECK_EQ_INT(trax_shuffle_played_count(shuffle), 16);
    for (size_t i = 0; i < 16; ++i) CHECK_EQ_INT(seen[i], 1);

    /* It stops rather than restarting. */
    CHECK(trax_shuffle_current_track(shuffle) < 0);
    CHECK(!trax_shuffle_advance(shuffle));

    /* And it is not a mode that is remembered between launches. */
    CHECK(!trax_shuffle_remembers_between_launches());

    trax_shuffle_destroy(shuffle);
    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* Order must actually vary with the random source, otherwise "shuffled" is a
 * lie; two seeds produce two different orders on a big enough card. */
static void record_order(trax_index *index, const char *folder, unsigned seed,
                         int32_t *out, size_t want) {
    trax_shuffle_options so;
    memset(&so, 0, sizeof(so));
    so.index = index;
    so.log = g_log;
    so.rand = scripted_rand;
    so.rand_user = &seed;
    trax_shuffle *shuffle = trax_shuffle_create(&so);
    CHECK_EQ_INT(trax_shuffle_start(shuffle, folder, NULL), TRAX_OK);
    for (size_t i = 0; i < want; ++i) {
        out[i] = trax_shuffle_current_track(shuffle);
        trax_shuffle_advance(shuffle);
    }
    trax_shuffle_destroy(shuffle);
}

static void test_shuffle_order_is_random(void) {
    begin("global shuffle order depends on the random source");
    fixture fx;
    CHECK(fixture_create(&fx, "shufflerand"));
    CHECK(fixture_make_albums(&fx, 4, 8)); /* 32 tracks */

    trax_host_posix hp;
    trax_host_posix_init(&hp);
    trax_index_options io;
    memset(&io, 0, sizeof(io));
    io.host = &hp.host;
    io.log = g_log;
    trax_index *index = trax_index_create(&io);

    int32_t order_a[32], order_b[32];
    record_order(index, fx.music, 7u, order_a, 32);
    record_order(index, fx.music, 12345u, order_b, 32);
    size_t differences = 0;
    for (size_t i = 0; i < 32; ++i) {
        if (order_a[i] != order_b[i]) ++differences;
        CHECK(order_a[i] >= 0 && order_a[i] < 32);
        CHECK(order_b[i] >= 0 && order_b[i] < 32);
    }
    CHECK(differences > 1);

    /* Same seed, same order: a seeded generator is reproducible. */
    int32_t order_c[32];
    record_order(index, fx.music, 7u, order_c, 32);
    for (size_t i = 0; i < 32; ++i) CHECK(order_a[i] == order_c[i]);

    trax_index_destroy(index);
    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* ------------------------------------------------------------------ */
/* 10. stopping releases what the shuffle built                       */
/* ------------------------------------------------------------------ */

static void test_shuffle_release_drops_list(void) {
    begin("stopping a global shuffle releases its list");
    fixture fx;
    CHECK(fixture_create(&fx, "shufflerelease"));
    CHECK(fixture_make_albums(&fx, 6, 10)); /* 60 tracks */

    trax_host_posix hp;
    trax_host_posix_init(&hp);

    trax_shuffle_options so;
    memset(&so, 0, sizeof(so));
    so.host = &hp.host;
    so.log = g_log;
    trax_shuffle *shuffle = trax_shuffle_create(&so);
    size_t blocks_before_start = trax_alloc_live_blocks();
    CHECK_EQ_INT(trax_shuffle_start(shuffle, fx.music, NULL), TRAX_OK);
    CHECK_EQ_INT(trax_shuffle_length(shuffle), 60);
    size_t blocks_running = trax_alloc_live_blocks();
    CHECK(blocks_running > blocks_before_start);

    trax_shuffle_stop(shuffle);
    CHECK(!trax_shuffle_is_active(shuffle));
    CHECK_EQ_INT(trax_shuffle_length(shuffle), 0);
    CHECK_NULL(trax_shuffle_library(shuffle));
    /* Some memory went away, and the log says what was let go of. */
    /* The log says what was let go of, and the built list is gone.  The
     * shared index survives on purpose: the other entry point may still use
     * it, so compare after the stop's own log line is dropped. */
    CHECK(trax_log_contains(g_log, "released the 60-track list"));
    trax_log_clear(g_log);
    CHECK(trax_alloc_live_blocks() < blocks_running);

    trax_shuffle_destroy(shuffle);
    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* A shuffle that is played to the end must release its list the same way. */
static void test_shuffle_end_releases_list(void) {
    begin("a finished global shuffle releases its list");
    fixture fx;
    CHECK(fixture_create(&fx, "shuffleend"));
    CHECK(fixture_make_albums(&fx, 2, 3)); /* 6 tracks */

    trax_host_posix hp;
    trax_host_posix_init(&hp);
    trax_shuffle_options so;
    memset(&so, 0, sizeof(so));
    so.host = &hp.host;
    so.log = g_log;
    trax_shuffle *shuffle = trax_shuffle_create(&so);
    CHECK_EQ_INT(trax_shuffle_start(shuffle, fx.music, NULL), TRAX_OK);
    for (size_t i = 0; i < 6; ++i) trax_shuffle_advance(shuffle);
    CHECK_EQ_INT(trax_shuffle_played_count(shuffle), 6);
    /* The sixth advance ends the session and lets the list go. */
    CHECK_EQ_INT(trax_shuffle_current_track(shuffle), -1);
    CHECK(trax_log_contains(g_log, "released the 6-track list"));
    CHECK(!trax_shuffle_is_active(shuffle));
    CHECK_NULL(trax_shuffle_library(shuffle));

    trax_shuffle_destroy(shuffle);
    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* Global shuffle writes nothing: no settings row, no resume point.  That is
 * what "it is the one mode TRAX does not remember between launches" means at
 * the storage layer. */
static void test_shuffle_persists_nothing(void) {
    begin("global shuffle writes nothing to carry across a launch");
    fixture fx;
    CHECK(fixture_create(&fx, "shufflepersist"));
    CHECK(fixture_make_albums(&fx, 3, 3));

    trax_host_posix hp;
    trax_host_posix_init(&hp);
    trax_index_options io;
    memset(&io, 0, sizeof(io));
    io.host = &hp.host;
    io.log = g_log;
    trax_index *index = trax_index_create(&io);

    /* Warm the shared index first, so the shuffle itself is the only thing
     * running when writes are counted. */
    const trax_library *lib = NULL;
    CHECK_EQ_INT(trax_index_acquire(index, fx.music, &lib, NULL), TRAX_OK);
    if (lib) trax_index_release(index, lib);

    unsigned writes_before = hp.faults.write_calls;
    trax_shuffle_options so;
    memset(&so, 0, sizeof(so));
    so.index = index;
    so.log = g_log;
    trax_shuffle *shuffle = trax_shuffle_create(&so);
    CHECK_EQ_INT(trax_shuffle_start(shuffle, fx.music, NULL), TRAX_OK);
    for (size_t i = 0; i < trax_shuffle_length(shuffle) + 1; ++i) {
        trax_shuffle_advance(shuffle);
    }
    trax_shuffle_destroy(shuffle);
    CHECK_EQ_INT(hp.faults.write_calls, writes_before);
    CHECK(!trax_shuffle_remembers_between_launches());

    /* A new session (what a launch makes) starts inactive, not resuming. */
    trax_shuffle *fresh = trax_shuffle_create(&so);
    CHECK(!trax_shuffle_is_active(fresh));
    CHECK_EQ_INT(trax_shuffle_length(fresh), 0);
    trax_shuffle_destroy(fresh);

    trax_index_destroy(index);
    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* A bad folder nested inside an otherwise good album must not lose either
 * the album's own tracks or its siblings. */
static void test_nested_bad_folder_is_skipped(void) {
    begin("a bad folder nested in an album is skipped without losing the album");
    fixture fx;
    CHECK(fixture_create(&fx, "nestedbad"));
    CHECK(fixture_make_albums(&fx, 1, 2)); /* Album 00 with 2 tracks */
    /* A subfolder inside it, which the host will refuse to list... */
    char nested[1400];
    CHECK(fixture_join(fx.music, "Album 00/Extras", nested, sizeof(nested)));
#if defined(_WIN32)
    CHECK(_mkdir(nested) == 0);
#else
    CHECK(mkdir(nested, 0777) == 0);
#endif
    CHECK(fixture_make_big_album(&fx, "Album 01", 2));

    trax_host_posix hp;
    trax_host_posix_init(&hp);
    CHECK(trax_host_posix_fail_list(&hp, nested));

    trax_library lib;
    memset(&lib, 0, sizeof(lib));
    trax_scan_options opt;
    memset(&opt, 0, sizeof(opt));
    opt.host = &hp.host;
    opt.log = g_log;
    opt.music_folder = fx.music;
    CHECK_EQ_INT(trax_scan_run(&opt, &lib), TRAX_OK);
    CHECK_EQ_INT(lib.track_count, 4);
    CHECK_EQ_INT(lib.folders_skipped, 1);
    CHECK(trax_log_contains(g_log, "Extras"));
    trax_library_clear(&lib);
    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* ------------------------------------------------------------------ */
/* 11. a corrupt cache is a miss, never a crash                        */
/* ------------------------------------------------------------------ */

static void test_corrupt_cache_is_a_miss(void) {
    begin("a damaged cache is ignored and the card is read");
    fixture fx;
    CHECK(fixture_create(&fx, "corrupt"));
    CHECK(fixture_make_albums(&fx, 3, 3)); /* 9 tracks */

    trax_host_posix hp;
    trax_host_posix_init(&hp);
    char cache[1400];
    CHECK_NOT_NULL(cache_path_for(&fx, cache, sizeof(cache)));

    /* Truncated magic. */
    CHECK(trax_host_posix_write_file(NULL, cache, "TRAXC", 5) == TRAX_OK);

    trax_index_options io;
    memset(&io, 0, sizeof(io));
    io.host = &hp.host;
    io.log = g_log;
    trax_index *index = trax_index_create(&io);
    const trax_library *lib = NULL;
    trax_index_report report;
    CHECK_EQ_INT(trax_index_acquire(index, fx.music, &lib, &report), TRAX_OK);
    CHECK(!report.hit_cache);
    CHECK_EQ_INT(report.tracks, 9);
    if (lib) trax_index_release(index, lib);

    /* Now the file is valid; damage one payload byte and it must miss. */
    char *bytes = NULL;
    size_t len = 0;
    CHECK_EQ_INT(trax_host_posix_read_file(NULL, cache, &bytes, &len), TRAX_OK);
    if (bytes && len > 24) {
        bytes[len - 1] ^= 0xFF;
        CHECK(trax_host_posix_write_file(NULL, cache, bytes, len) == TRAX_OK);
    }
    trax_free(bytes);

    trax_index_destroy(index);
    index = trax_index_create(&io);
    CHECK_EQ_INT(trax_index_acquire(index, fx.music, &lib, &report), TRAX_OK);
    CHECK(!report.hit_cache);
    CHECK_EQ_INT(report.tracks, 9);
    if (lib) trax_index_release(index, lib);

    trax_index_destroy(index);
    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* The cache must not be written when the card's top level changed: a rescan
 * after adding an album has to pick the album up rather than serve the old
 * index forever. */
static void test_new_album_invalidates_cache(void) {
    begin("adding an album makes the cache stale");
    fixture fx;
    CHECK(fixture_create(&fx, "stale"));
    CHECK(fixture_make_albums(&fx, 2, 2)); /* 4 tracks */

    trax_host_posix hp;
    trax_host_posix_init(&hp);
    trax_index_options io;
    memset(&io, 0, sizeof(io));
    io.host = &hp.host;
    io.log = g_log;
    trax_index *index = trax_index_create(&io);
    const trax_library *lib = NULL;
    trax_index_report report;
    CHECK_EQ_INT(trax_index_acquire(index, fx.music, &lib, &report), TRAX_OK);
    CHECK_EQ_INT(report.tracks, 4);
    if (lib) trax_index_release(index, lib);
    trax_index_destroy(index);

    CHECK(fixture_make_big_album(&fx, "Album 99", 3));

    index = trax_index_create(&io);
    CHECK_EQ_INT(trax_index_acquire(index, fx.music, &lib, &report), TRAX_OK);
    CHECK(!report.hit_cache);
    CHECK_EQ_INT(report.tracks, 7);
    if (lib) trax_index_release(index, lib);
    trax_index_destroy(index);

    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* ------------------------------------------------------------------ */
/* 12. cue parsing units                                              */
/* ------------------------------------------------------------------ */

static void test_cue_parser_units(void) {
    begin("cue parser keeps titles, numbers and skips data tracks");
    const char *audio[] = {"one.flac"};
    const char *sheet =
        "TITLE \"Album\"\n"
        "FILE \"one.flac\" WAVE\n"
        "  TRACK 01 AUDIO\n"
        "    TITLE \"First\"\n"
        "    INDEX 01 00:00:00\n"
        "  TRACK 02 AUDIO\n"
        "    TITLE \"Second\"\n"
        "    INDEX 00 03:00:00\n"
        "    INDEX 01 03:02:10\n";
    trax_cue_sheet parsed;
    CHECK_EQ_INT(trax_cue_parse(sheet, strlen(sheet), audio, 1, "x.cue",
                                &parsed), TRAX_OK);
    CHECK(parsed.valid);
    CHECK_EQ_INT(parsed.track_count, 2);
    CHECK_NOT_NULL(parsed.album_title);
    if (parsed.album_title) CHECK(strcmp(parsed.album_title, "Album") == 0);
    if (parsed.track_count == 2) {
        CHECK_EQ_INT(parsed.tracks[1].number, 2);
        CHECK_EQ_INT(parsed.tracks[1].first_index, (3 * 60 + 2) * 75 + 10);
    }
    trax_cue_sheet_free(&parsed);

    /* No audio at all: invalid, not an empty album. */
    CHECK_EQ_INT(trax_cue_parse("TRACK 01 AUDIO\n", 15, NULL, 0, "x.cue",
                                &parsed), TRAX_ERR);
    CHECK(!parsed.valid);

    /* A quote-wrapped FILE name with spaces resolves. */
    const char *audio2[] = {"My Song.mp3"};
    const char *sheet2 =
        "FILE \"C:\\rips\\My Song.mp3\" MP3\n"
        "  TRACK 01 AUDIO\n"
        "    INDEX 01 00:00:00\n";
    CHECK_EQ_INT(trax_cue_parse(sheet2, strlen(sheet2), audio2, 1, "x.cue",
                                &parsed), TRAX_OK);
    CHECK_EQ_INT(parsed.track_count, 1);
    if (parsed.track_count == 1) {
        CHECK(strcmp(parsed.tracks[0].file_name, "My Song.mp3") == 0);
    }
    trax_cue_sheet_free(&parsed);
}

/* ------------------------------------------------------------------ */
/* 13. a folder with a cue sheet plus plain files in the same album   */
/* ------------------------------------------------------------------ */

static void test_cue_plus_plain_files(void) {
    begin("a cue split and a plain file in one folder are both counted");
    fixture fx;
    CHECK(fixture_create(&fx, "mixedfolder"));
    const char *sheet =
        "FILE \"score.flac\" WAVE\n"
        "  TRACK 01 AUDIO\n"
        "    TITLE \"Movement I\"\n"
        "    INDEX 01 00:00:00\n"
        "  TRACK 02 AUDIO\n"
        "    TITLE \"Movement II\"\n"
        "    INDEX 01 12:00:00\n";
    CHECK(fixture_make_cue_album(&fx, "Symphony", "score.flac", "score.cue",
                                 sheet));
    CHECK(fixture_write_text(&fx, "MUSIC/Symphony/bonus.mp3", "x"));

    trax_host_posix hp;
    trax_host_posix_init(&hp);
    trax_library lib;
    memset(&lib, 0, sizeof(lib));
    trax_scan_options opt;
    memset(&opt, 0, sizeof(opt));
    opt.host = &hp.host;
    opt.log = g_log;
    opt.music_folder = fx.music;
    CHECK_EQ_INT(trax_scan_run(&opt, &lib), TRAX_OK);
    /* Two splits plus the bonus file; score.flac itself is not a third. */
    CHECK_EQ_INT(lib.track_count, 3);
    CHECK_EQ_INT(lib.album_count, 2);
    trax_library_clear(&lib);
    trax_host_posix_free(&hp);
    fixture_destroy(&fx);
}

/* ------------------------------------------------------------------ */
/* 14. path handling units                                             */
/* ------------------------------------------------------------------ */

static void test_path_normalize_units(void) {
    begin("path normalization keeps device prefixes and one leading slash");
    char *p = trax_path_normalize("ux0:\\MUSIC\\");
    CHECK_NOT_NULL(p);
    if (p) CHECK(strcmp(p, "ux0:/MUSIC") == 0);
    trax_free(p);

    p = trax_path_normalize("//grw0:/MUSIC//Album A///");
    CHECK_NOT_NULL(p);
    if (p) CHECK(strcmp(p, "/grw0:/MUSIC/Album A") == 0);
    trax_free(p);

    p = trax_path_normalize("/tmp/MUSIC");
    CHECK_NOT_NULL(p);
    if (p) CHECK(strcmp(p, "/tmp/MUSIC") == 0);
    trax_free(p);

    p = trax_path_normalize("C:\\Music");
    CHECK_NOT_NULL(p);
    if (p) CHECK(strcmp(p, "C:/Music") == 0);
    trax_free(p);

    CHECK_NULL(trax_path_normalize(""));
    CHECK_NULL(trax_path_normalize("///"));

    char *joined = trax_path_join("ux0:/MUSIC", "Album A");
    CHECK_NOT_NULL(joined);
    if (joined) CHECK(strcmp(joined, "ux0:/MUSIC/Album A") == 0);
    trax_free(joined);

    CHECK(strcmp(trax_path_basename("ux0:/MUSIC/Album A/01.mp3"), "01.mp3") == 0);
    CHECK(trax_str_ieq(trax_path_extension("a.FLAC"), ".flac"));
    char *stem = trax_path_stem("/x/01 - Song.FLAC");
    CHECK_NOT_NULL(stem);
    if (stem) CHECK(strcmp(stem, "01 - Song") == 0);
    trax_free(stem);
}

/* ------------------------------------------------------------------ */
/* runner                                                              */
/* ------------------------------------------------------------------ */

typedef struct {
    const char *name;
    void (*fn)(void);
} test_case;

static const test_case g_tests[] = {
    {"scan progress counts folders and tracks", test_scan_progress_counts},
    {"a folder named like the cache", test_cache_name_folder_is_indexed},
    {"cancel leaves nothing", test_cancel_leaves_nothing},
    {"second visit uses the cache", test_second_visit_uses_cache},
    {"gallery and shuffle share", test_gallery_and_shuffle_share},
    {"shuffle reuses index after gallery", test_shuffle_reuses_index_after_gallery_closes},
    {"unreadable folder skipped", test_unreadable_folder_is_skipped},
    {"unreadable cue keeps audio", test_unreadable_cue_does_not_lose_audio},
    {"over-limit folder capped", test_over_limit_folder_is_capped},
    {"cue album counts tracks", test_cue_album_counts_tracks},
    {"cue data track not counted", test_cue_data_track_not_counted},
    {"cue shift-jis audio resolves", test_cue_shiftjis_named_audio_resolves},
    {"cue over limit capped", test_cue_over_limit_is_capped},
    {"folder change invalidates", test_folder_change_invalidates},
    {"cache for another folder", test_cache_for_other_folder_is_a_miss},
    {"cancel flag from UI thread", test_cancel_flag_from_ui_thread},
    {"shuffle plays once", test_shuffle_plays_once},
    {"shuffle order is random", test_shuffle_order_is_random},
    {"shuffle release drops list", test_shuffle_release_drops_list},
    {"shuffle end releases list", test_shuffle_end_releases_list},
    {"shuffle persists nothing", test_shuffle_persists_nothing},
    {"nested bad folder", test_nested_bad_folder_is_skipped},
    {"corrupt cache is a miss", test_corrupt_cache_is_a_miss},
    {"new album invalidates cache", test_new_album_invalidates_cache},
    {"cue parser units", test_cue_parser_units},
    {"cue plus plain files", test_cue_plus_plain_files},
    {"path normalization units", test_path_normalize_units},
};

int main(void) {
    g_log = trax_log_create();
    if (!g_log) {
        fprintf(stderr, "could not create the log\n");
        return 2;
    }

    const char *only = getenv("TRAX_TEST");
    size_t run = 0;
    for (size_t i = 0; i < sizeof(g_tests) / sizeof(g_tests[0]); ++i) {
        if (only && *only && strcmp(only, g_tests[i].name) != 0) continue;
        size_t before = (size_t)g_failures;
        printf("[%zu] %s\n", i + 1, g_tests[i].name);
        g_tests[i].fn();
        if ((size_t)g_failures == before) printf("  ok\n");
        ++run;
    }

    /* Every fixture has been destroyed; nothing the suite allocated may be
     * left.  A leak here is a leak in the scanner. */
    trax_log_destroy(g_log);
    g_log = NULL;

    printf("\n%zu test(s), %d check(s), %d failure(s)\n", run, g_checks,
           g_failures);
    if (g_failures == 0) {
        size_t live = trax_alloc_live_blocks();
        printf("live allocations after the suite: %zu\n", live);
        if (live != 0) {
            printf("FAIL: the suite leaked %zu allocation(s)\n", live);
            return 1;
        }
    }
    return g_failures == 0 ? 0 : 1;
}
