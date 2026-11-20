/*
 * Acceptance tests for the global shuffle scan session.
 *
 * Every scenario is driven deterministically: the fake card is an
 * in-memory tree with scripted faults (unreadable folder, card pulled
 * mid-scan), the RNG is seeded, and "late callbacks" are delivered by
 * calling gs_deliver_*() with a captured stale session id — exactly how a
 * belated async platform completion would arrive. No sleeps, no swallowed
 * errors: every test asserts on the event log the callbacks recorded.
 */
#include "global_shuffle.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ------------------------------------------------------------------ */
/* fake memory card                                                    */

typedef struct FakeNode {
    const char *name;
    int is_dir;
    struct FakeNode *kids;
    int nkids;
} FakeNode;

#define DIR(n, k) { n, 1, k, (int)(sizeof(k) / sizeof((k)[0])) }
#define LEAF(n)   { n, 0, NULL, 0 }

static FakeNode live_kids[] = { LEAF("c.flac") };
static FakeNode rock_kids[] = {
    LEAF("a.mp3"), LEAF("b.mp3"), DIR("Live", live_kids)
};
static FakeNode jazz_kids[] = {
    LEAF("d.m4a"), LEAF("e.opus"), LEAF("notes.txt"), LEAF("cover.jpg")
};
static FakeNode cue_kids[] = { LEAF("h.mp3") };
static FakeNode elec_kids[] = {
    LEAF("f.wav"), LEAF("g.mp3"), DIR("cuealbum", cue_kids)
};
static FakeNode music_kids[] = {
    DIR("Rock", rock_kids),
    DIR("Jazz", jazz_kids),
    DIR("Electronic", elec_kids),
    LEAF("loose.mp3"),
    LEAF("readme.txt")
};
static FakeNode music_root = DIR("MUSIC", music_kids);

/* 9 audio tracks across 3 top-level folders plus one loose file. */
#define EXPECT_TRACKS 9
#define EXPECT_FOLDERS 3
/* Root + Rock + Rock/Live + Jazz + Electronic + Electronic/cuealbum. */
#define EXPECT_DIR_OPENS 6

typedef struct {
    FakeNode *root;
    int card_present;        /* 0 simulates the card being pulled */
    const char *fail_open;   /* paths containing this refuse to open */
    int fail_read_after;     /* after this many reads, reads error; -1 off */
    int reads;
    int open_calls;
} FakeFS;

typedef struct {
    FakeNode *node;
    size_t next;
} FakeDir;

static FakeNode *find_node(FakeFS *fs, const char *path)
{
    char buf[GS_PATH_MAX];
    char *tok;
    FakeNode *cur;

    if (strlen(path) >= sizeof(buf))
        return NULL;
    strcpy(buf, path);
    tok = strtok(buf, "/");
    if (!tok || strcmp(tok, fs->root->name))
        return NULL;
    cur = fs->root;
    while ((tok = strtok(NULL, "/")) != NULL) {
        int i;
        if (!cur->is_dir)
            return NULL;
        for (i = 0; i < cur->nkids; i++)
            if (!strcmp(cur->kids[i].name, tok))
                break;
        if (i == cur->nkids)
            return NULL;
        cur = &cur->kids[i];
    }
    return cur;
}

static void *fs_dir_open(void *user, const char *path)
{
    FakeFS *fs = user;
    FakeNode *node;
    FakeDir *dir;

    fs->open_calls++;
    if (!fs->card_present)
        return NULL;
    if (fs->fail_open && strstr(path, fs->fail_open))
        return NULL;
    node = find_node(fs, path);
    if (!node || !node->is_dir)
        return NULL;
    dir = malloc(sizeof(*dir));
    dir->node = node;
    dir->next = 0;
    return dir;
}

static int fs_dir_read(void *user, void *vdir, char *name, size_t cap,
                       int *is_dir)
{
    FakeFS *fs = user;
    FakeDir *dir = vdir;
    FakeNode *kid;

    if (!fs->card_present)
        return -1; /* card pulled mid-listing */
    if (fs->fail_read_after >= 0 && fs->reads >= fs->fail_read_after)
        return -1;
    fs->reads++;
    if (dir->next >= (size_t)dir->node->nkids)
        return 0;
    kid = &dir->node->kids[dir->next++];
    if (strlen(kid->name) >= cap)
        return -1;
    strcpy(name, kid->name);
    *is_dir = kid->is_dir;
    return 1;
}

static void fs_dir_close(void *user, void *dir)
{
    (void)user;
    free(dir);
}

/* ------------------------------------------------------------------ */
/* deterministic RNG and counting allocator                            */

static unsigned rng_state;
static unsigned rand_calls;

static unsigned test_rand(void *user)
{
    (void)user;
    rand_calls++;
    rng_state = rng_state * 1664525u + 1013904223u;
    return rng_state >> 8;
}

static int alloc_balance;
static int alloc_baseline; /* balance with just the scanner struct alive */

static void *test_alloc(void *user, size_t size)
{
    (void)user;
    alloc_balance++;
    return malloc(size);
}

static void test_free(void *user, void *ptr)
{
    (void)user;
    if (ptr)
        alloc_balance--;
    free(ptr);
}

/* ------------------------------------------------------------------ */
/* UI event log                                                        */

typedef struct {
    char type[8]; /* cshow chide popen prog pclose err play rel */
    unsigned session;
    unsigned a, b, c;
    char msg[160];
} Ev;

static Ev evs[512];
static int nev;

static void log_ev(const char *type, unsigned session,
                   unsigned a, unsigned b, unsigned c, const char *msg)
{
    Ev *e;
    if (nev >= (int)(sizeof(evs) / sizeof(evs[0]))) {
        fprintf(stderr, "event log overflow\n");
        exit(2);
    }
    e = &evs[nev++];
    strcpy(e->type, type);
    e->session = session;
    e->a = a;
    e->b = b;
    e->c = c;
    if (msg) {
        strncpy(e->msg, msg, sizeof(e->msg) - 1);
        e->msg[sizeof(e->msg) - 1] = '\0';
    } else {
        e->msg[0] = '\0';
    }
}

static void ui_confirm_show(void *u) { (void)u; log_ev("cshow", 0, 0, 0, 0, NULL); }
static void ui_confirm_hide(void *u) { (void)u; log_ev("chide", 0, 0, 0, 0, NULL); }
static void ui_progress_open(void *u, unsigned s)
{ (void)u; log_ev("popen", s, 0, 0, 0, NULL); }
static void ui_progress_update(void *u, unsigned s, unsigned done,
                               unsigned total, unsigned found)
{ (void)u; log_ev("prog", s, done, total, found, NULL); }
static void ui_progress_close(void *u, unsigned s)
{ (void)u; log_ev("pclose", s, 0, 0, 0, NULL); }
static void ui_error(void *u, unsigned s, const char *msg)
{ (void)u; log_ev("err", s, 0, 0, 0, msg); }
static void ui_play(void *u, unsigned s, const char *const *tracks, size_t n)
{ (void)u; (void)tracks; log_ev("play", s, (unsigned)n, 0, 0, NULL); }
static void ui_released(void *u) { (void)u; log_ev("rel", 0, 0, 0, 0, NULL); }

static int count_ev(const char *type)
{
    int n = 0;
    int i;
    for (i = 0; i < nev; i++)
        if (!strcmp(evs[i].type, type))
            n++;
    return n;
}

static const Ev *find_ev(const char *type, int from)
{
    int i;
    for (i = from; i < nev; i++)
        if (!strcmp(evs[i].type, type))
            return &evs[i];
    return NULL;
}

/* ------------------------------------------------------------------ */
/* harness                                                             */

static int failures;
static const char *current_test;

#define CHECK(cond) do {                                            \
        if (!(cond)) {                                              \
            fprintf(stderr, "FAIL %s: %s:%d: %s\n",                 \
                    current_test, __FILE__, __LINE__, #cond);       \
            failures++;                                             \
        }                                                           \
    } while (0)

static FakeFS fs;
static GSScanner *gs;

static void setup(void)
{
    static const GSCallbacks cb = {
        NULL,
        ui_confirm_show, ui_confirm_hide,
        ui_progress_open, ui_progress_update, ui_progress_close,
        ui_error, ui_play, ui_released
    };
    GSPlatform pf = {
        &fs, fs_dir_open, fs_dir_read, fs_dir_close,
        test_rand, test_alloc, test_free
    };
    memset(&fs, 0, sizeof(fs));
    fs.root = &music_root;
    fs.card_present = 1;
    fs.fail_read_after = -1;
    nev = 0;
    alloc_balance = 0;
    rng_state = 12345;
    rand_calls = 0;
    gs = gs_create(&pf, &cb);
    gs_set_music_folder(gs, "MUSIC");
    alloc_baseline = alloc_balance;
}

static void teardown(void)
{
    gs_destroy(gs);
    CHECK(alloc_balance == 0); /* teardown: after destroy, everything freed */
    gs = NULL;
}

static void run_test(const char *name, void (*fn)(void))
{
    current_test = name;
    setup();
    fn();
    teardown();
    printf("ok - %s\n", name);
}

/* Confirm and pump until the scan settles. */
static void confirm_and_run(void)
{
    gs_request_play(gs);
    gs_confirm(gs);
    while (gs_pump(gs))
        ;
}

static int sorted_contains_expected(void)
{
    static const char *const expected[EXPECT_TRACKS] = {
        "MUSIC/Electronic/cuealbum/h.mp3",
        "MUSIC/Electronic/f.wav",
        "MUSIC/Electronic/g.mp3",
        "MUSIC/Jazz/d.m4a",
        "MUSIC/Jazz/e.opus",
        "MUSIC/Rock/Live/c.flac",
        "MUSIC/Rock/a.mp3",
        "MUSIC/Rock/b.mp3",
        "MUSIC/loose.mp3"
    };
    int used[EXPECT_TRACKS] = { 0 };
    size_t i;
    int j;

    if (gs_track_count(gs) != EXPECT_TRACKS)
        return 0;
    for (i = 0; i < EXPECT_TRACKS; i++) {
        const char *got = gs_track(gs, i);
        for (j = 0; j < EXPECT_TRACKS; j++)
            if (!used[j] && got && !strcmp(got, expected[j]))
                break;
        if (j == EXPECT_TRACKS)
            return 0;
        used[j] = 1;
    }
    return 1;
}

/* ------------------------------------------------------------------ */
/* scenarios                                                           */

/* Normal run: confirm, progress per top-level folder with a running
 * track count, then the whole card plays in shuffled order. */
static void test_scan_completes(void)
{
    const Ev *play;
    int i;
    unsigned last_done = 0, last_found = 0;

    gs_request_play(gs);
    CHECK(gs_state(gs) == GS_CONFIRM);
    CHECK(count_ev("cshow") == 1);
    CHECK(fs.open_calls == 0); /* asking must not read the card */

    gs_confirm(gs);
    CHECK(gs_state(gs) == GS_SCANNING);
    CHECK(count_ev("chide") == 1);
    CHECK(count_ev("popen") == 1);

    while (gs_pump(gs))
        ;

    CHECK(gs_state(gs) == GS_PLAYING);
    play = find_ev("play", 0);
    CHECK(play != NULL);
    CHECK(play && play->a == EXPECT_TRACKS);
    CHECK(play && play->session == gs_session(gs));
    CHECK(sorted_contains_expected());
    CHECK(rand_calls > 0); /* the order really was shuffled */

    /* Progress advanced per top-level folder, track count monotonic. */
    for (i = 0; i < nev; i++) {
        if (strcmp(evs[i].type, "prog"))
            continue;
        CHECK(evs[i].b == EXPECT_FOLDERS);
        CHECK(evs[i].a >= last_done);
        CHECK(evs[i].c >= last_found);
        last_done = evs[i].a;
        last_found = evs[i].c;
    }
    CHECK(last_done == EXPECT_FOLDERS);
    CHECK(last_found == EXPECT_TRACKS);
    CHECK(count_ev("pclose") == 1);
    CHECK(count_ev("err") == 0);
    CHECK(fs.open_calls == EXPECT_DIR_OPENS);

    /* Stopping playback lets the built list go there and then. */
    gs_stop(gs);
    CHECK(gs_state(gs) == GS_IDLE);
    CHECK(gs_track_count(gs) == 0);
    CHECK(count_ev("rel") == 1);
    CHECK(alloc_balance == alloc_baseline);
}

/* Circle mid-scan: everything collected is thrown away, the dialog
 * closes, and a later scan starts from a clean slate and completes. */
static void test_cancel_discards_partial(void)
{
    unsigned killed;

    gs_request_play(gs);
    gs_confirm(gs);
    CHECK(gs_pump(gs) == 1); /* top level listed */
    CHECK(gs_pump(gs) == 1); /* first folder walked, tracks collected */
    killed = gs_session(gs);

    gs_cancel(gs);
    CHECK(gs_state(gs) == GS_IDLE);
    CHECK(gs_session(gs) == 0);
    CHECK(gs_track_count(gs) == 0);
    CHECK(count_ev("pclose") == 1);
    CHECK(count_ev("play") == 0);
    CHECK(count_ev("err") == 0);
    CHECK(alloc_balance == alloc_baseline); /* no half-built queue kept */

    /* The cancelled session's id must never be reused. */
    confirm_and_run();
    CHECK(gs_state(gs) == GS_PLAYING);
    CHECK(gs_session(gs) != killed);
    CHECK(sorted_contains_expected());
    gs_stop(gs);
}

/* A folder that will not open mid-scan: understandable error, dialog
 * closed, partial results discarded, and a retry completes cleanly. */
static void test_failure_mid_scan_cleans_up(void)
{
    const Ev *err;

    fs.fail_open = "Jazz";
    confirm_and_run();

    CHECK(gs_state(gs) == GS_IDLE);
    CHECK(count_ev("play") == 0);
    CHECK(count_ev("pclose") == 1); /* dialog closed, not stuck */
    err = find_ev("err", 0);
    CHECK(err != NULL);
    CHECK(err && strlen(err->msg) > 0);
    CHECK(alloc_balance == alloc_baseline);

    fs.fail_open = NULL;
    confirm_and_run();
    CHECK(gs_state(gs) == GS_PLAYING);
    CHECK(sorted_contains_expected());
    gs_stop(gs);
}

/* A read that errors mid-listing (card pulled while reading). */
static void test_read_error_mid_scan(void)
{
    const Ev *err;

    fs.fail_read_after = 2; /* root listing dies on its third entry */
    confirm_and_run();

    CHECK(gs_state(gs) == GS_IDLE);
    CHECK(count_ev("play") == 0);
    err = find_ev("err", 0);
    CHECK(err != NULL);
    CHECK(count_ev("pclose") == 1);
    CHECK(alloc_balance == alloc_baseline);
}

/* The card is gone before the scan even starts. */
static void test_card_removed_at_start(void)
{
    const Ev *err;

    fs.card_present = 0;
    confirm_and_run();
    CHECK(gs_state(gs) == GS_IDLE);
    err = find_ev("err", 0);
    CHECK(err != NULL);
    CHECK(count_ev("pclose") == 1);
    CHECK(count_ev("play") == 0);
    CHECK(alloc_balance == alloc_baseline);
}

/* The card is pulled between two slices of a running scan. */
static void test_card_removed_mid_scan(void)
{
    gs_request_play(gs);
    gs_confirm(gs);
    CHECK(gs_pump(gs) == 1);
    fs.card_present = 0;
    while (gs_pump(gs))
        ;
    CHECK(gs_state(gs) == GS_IDLE);
    CHECK(count_ev("err") == 1);
    CHECK(count_ev("play") == 0);
    CHECK(alloc_balance == alloc_baseline);
}

/* Confirming while a scan runs must not stack a second traversal. */
static void test_no_concurrent_sessions(void)
{
    unsigned session;

    gs_request_play(gs);
    gs_confirm(gs);
    CHECK(gs_pump(gs) == 1);
    session = gs_session(gs);

    gs_request_play(gs); /* ignored: a scan owns the card */
    gs_confirm(gs);      /* ignored: no dialog is up */
    CHECK(gs_state(gs) == GS_SCANNING);
    CHECK(gs_session(gs) == session);
    CHECK(count_ev("cshow") == 1); /* no second dialog either */
    CHECK(count_ev("popen") == 1);

    while (gs_pump(gs))
        ;
    CHECK(gs_state(gs) == GS_PLAYING);
    CHECK(count_ev("play") == 1);
    /* Exactly one traversal happened: each directory opened once. */
    CHECK(fs.open_calls == EXPECT_DIR_OPENS);
    gs_stop(gs);
}

/* After playback stops, nothing the dead session may still deliver —
 * progress, results, errors — is allowed to reach the UI. */
static void test_late_delivery_after_stop(void)
{
    unsigned dead;
    char **stale;
    int plays_before, progs_before, errs_before;

    confirm_and_run();
    CHECK(gs_state(gs) == GS_PLAYING);
    dead = gs_session(gs);
    gs_stop(gs);
    CHECK(count_ev("rel") == 1);

    plays_before = count_ev("play");
    progs_before = count_ev("prog");
    errs_before = count_ev("err");

    gs_deliver_progress(gs, dead, 2, 3, 7);
    stale = malloc(sizeof(char *));
    stale[0] = malloc(8);
    strcpy(stale[0], "ghost");
    CHECK(gs_deliver_done(gs, dead, stale, 1) == 0); /* rejected */
    free(stale[0]); /* caller keeps ownership of a rejected list */
    free(stale);
    gs_deliver_error(gs, dead, "too late");

    CHECK(count_ev("play") == plays_before);
    CHECK(count_ev("prog") == progs_before);
    CHECK(count_ev("err") == errs_before);
    CHECK(gs_state(gs) == GS_IDLE);
    CHECK(gs_track_count(gs) == 0);
}

/* Cancel, rescan, and the old session's late results must not overwrite
 * the new session's progress or queue. */
static void test_late_delivery_after_restart(void)
{
    unsigned old_session, new_session;
    char **stale;

    gs_request_play(gs);
    gs_confirm(gs);
    CHECK(gs_pump(gs) == 1);
    old_session = gs_session(gs);
    gs_cancel(gs);

    gs_request_play(gs);
    gs_confirm(gs);
    new_session = gs_session(gs);
    CHECK(new_session != old_session);
    CHECK(gs_pump(gs) == 1); /* new scan has its own partial state */

    stale = malloc(sizeof(char *));
    stale[0] = malloc(8);
    strcpy(stale[0], "ghost");
    CHECK(gs_deliver_done(gs, old_session, stale, 1) == 0);
    free(stale[0]);
    free(stale);
    gs_deliver_progress(gs, old_session, 3, 3, 99);
    gs_deliver_error(gs, old_session, "zombie");

    /* The new session is untouched and finishes normally. */
    CHECK(gs_state(gs) == GS_SCANNING);
    CHECK(count_ev("play") == 0);
    CHECK(count_ev("err") == 0);
    while (gs_pump(gs))
        ;
    CHECK(gs_state(gs) == GS_PLAYING);
    {
        const Ev *play = find_ev("play", 0);
        CHECK(play != NULL);
        CHECK(play && play->session == new_session);
    }
    CHECK(sorted_contains_expected());
    gs_stop(gs);
}

/* Without a confirmed scan, nothing traverses the card: pressing Cross
 * only asks, Circle on the dialog does nothing, and pumping is inert. */
static void test_no_scan_without_confirm(void)
{
    CHECK(gs_pump(gs) == 0); /* idle pump is inert */
    CHECK(fs.open_calls == 0);

    gs_confirm(gs); /* confirm with no dialog up: ignored */
    CHECK(gs_state(gs) == GS_IDLE);
    CHECK(fs.open_calls == 0);

    gs_request_play(gs);
    CHECK(gs_state(gs) == GS_CONFIRM);
    CHECK(gs_pump(gs) == 0); /* dialog up, still no traversal */
    CHECK(fs.open_calls == 0);
    CHECK(count_ev("popen") == 0);

    gs_cancel(gs); /* Circle on the dialog: nothing happens */
    CHECK(gs_state(gs) == GS_IDLE);
    CHECK(count_ev("chide") == 1);
    CHECK(fs.open_calls == 0);
    CHECK(count_ev("play") == 0);
}

/* Switching the music folder kills the session: no write-back from the
 * old folder afterwards, and the next scan starts clean. */
static void test_folder_switch_invalidates(void)
{
    unsigned dead;

    gs_request_play(gs);
    gs_confirm(gs);
    CHECK(gs_pump(gs) == 1);
    dead = gs_session(gs);

    gs_set_music_folder(gs, "OTHER");
    CHECK(gs_state(gs) == GS_IDLE);
    CHECK(count_ev("pclose") == 1);
    CHECK(alloc_balance == alloc_baseline);

    gs_deliver_progress(gs, dead, 1, 3, 4);
    gs_deliver_error(gs, dead, "late");
    CHECK(count_ev("prog") == 1); /* only the pre-switch update */
    CHECK(count_ev("err") == 0);

    /* A built list is released on switch too. */
    gs_set_music_folder(gs, "MUSIC");
    confirm_and_run();
    CHECK(gs_state(gs) == GS_PLAYING);
    gs_set_music_folder(gs, "OTHER");
    CHECK(gs_state(gs) == GS_IDLE);
    CHECK(count_ev("rel") == 1);
    CHECK(gs_track_count(gs) == 0);
    CHECK(alloc_balance == alloc_baseline);
}

/* Asking again while a shuffle plays releases the old list first, then
 * asks — one owned list at a time. */
static void test_request_while_playing(void)
{
    confirm_and_run();
    CHECK(gs_state(gs) == GS_PLAYING);

    gs_request_play(gs);
    CHECK(count_ev("rel") == 1);
    CHECK(gs_state(gs) == GS_CONFIRM);
    CHECK(gs_track_count(gs) == 0);

    gs_confirm(gs);
    while (gs_pump(gs))
        ;
    CHECK(gs_state(gs) == GS_PLAYING);
    CHECK(sorted_contains_expected());
    gs_stop(gs);
    CHECK(count_ev("rel") == 2);
}

int main(void)
{
    run_test("scan completes and plays shuffled card", test_scan_completes);
    run_test("cancel discards partial results", test_cancel_discards_partial);
    run_test("mid-scan failure cleans up", test_failure_mid_scan_cleans_up);
    run_test("read error mid-scan cleans up", test_read_error_mid_scan);
    run_test("card removed before scan starts", test_card_removed_at_start);
    run_test("card removed mid-scan", test_card_removed_mid_scan);
    run_test("no concurrent scan sessions", test_no_concurrent_sessions);
    run_test("late delivery after stop is dropped",
             test_late_delivery_after_stop);
    run_test("late delivery after restart is dropped",
             test_late_delivery_after_restart);
    run_test("no traversal without confirm", test_no_scan_without_confirm);
    run_test("folder switch invalidates session",
             test_folder_switch_invalidates);
    run_test("request while playing releases first",
             test_request_while_playing);

    if (failures) {
        fprintf(stderr, "%d check(s) failed\n", failures);
        return 1;
    }
    printf("all tests passed\n");
    return 0;
}
