/*
 * tools/trax_index_cli.c - walk a folder and print what the index found.
 *
 * A small manual check that needs no device:
 *
 *     trax_index_cli <music folder> [--no-cache] [--shuffle]
 *                                   [--cancel-after N] [--verbose]
 *
 * It prints the progress the two entry points would draw, then the album
 * list, then whether a second entry was answered from the cache.  The
 * acceptance suite covers the same ground automatically; this exists so a
 * person can point it at a real copy of a card.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "trax_gallery.h"
#include "trax_host_posix.h"
#include "trax_index.h"
#include "trax_log.h"
#include "trax_shuffle.h"

typedef struct {
    unsigned cancel_after;
    unsigned last_done;
    unsigned last_total;
    unsigned last_tracks;
} cli_progress;

static bool on_progress(void *user, const trax_scan_progress *p) {
    cli_progress *state = (cli_progress *)user;
    if (p->folders_done != state->last_done ||
        p->tracks_found != state->last_tracks || p->folders_done == 0) {
        printf("  reading card: %u of %u folders, %u tracks found\n",
               (unsigned)p->folders_done, (unsigned)p->folders_total,
               (unsigned)p->tracks_found);
        state->last_done = p->folders_done;
        state->last_total = p->folders_total;
        state->last_tracks = p->tracks_found;
    }
    if (state->cancel_after && p->folders_done >= state->cancel_after) {
        printf("  (cancelling, as asked)\n");
        return false;
    }
    return true;
}

static void print_log(trax_log *log) {
    size_t n = trax_log_retained_count(log);
    if (n == 0) return;
    printf("  log (%zu line(s)):\n", n);
    for (size_t i = 0; i < n; ++i) {
        printf("    %s\n", trax_log_line_at(log, i));
    }
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr,
                "usage: %s <music folder> [--no-cache] [--shuffle] "
                "[--cancel-after N] [--verbose]\n",
                argv[0]);
        return 2;
    }
    /* Card paths reach the core in one shape whatever the caller typed. */
    char *normalized = trax_path_normalize(argv[1]);
    if (!normalized) {
        fprintf(stderr, "not a usable folder: %s\n", argv[1]);
        return 2;
    }
    const char *folder = normalized;
    bool use_cache = true;
    bool run_shuffle = false;
    bool verbose = false;
    cli_progress progress;
    memset(&progress, 0, sizeof(progress));

    for (int i = 2; i < argc; ++i) {
        if (strcmp(argv[i], "--no-cache") == 0) use_cache = false;
        else if (strcmp(argv[i], "--shuffle") == 0) run_shuffle = true;
        else if (strcmp(argv[i], "--verbose") == 0) verbose = true;
        else if (strcmp(argv[i], "--cancel-after") == 0 && i + 1 < argc) {
            progress.cancel_after = (unsigned)strtoul(argv[++i], NULL, 10);
        } else {
            fprintf(stderr, "unknown option %s\n", argv[i]);
            return 2;
        }
    }

    trax_log *log = trax_log_create();
    trax_host_posix hp;
    trax_host_posix_init(&hp);
    if (verbose) trax_log_set_min_level(log, TRAX_LOG_DEBUG);

    trax_index_options io;
    memset(&io, 0, sizeof(io));
    io.host = &hp.host;
    io.log = log;
    io.cache_path = use_cache ? NULL : "";
    io.on_progress = on_progress;
    io.progress_user = &progress;

    trax_gallery_options go;
    memset(&go, 0, sizeof(go));
    trax_index *index = trax_index_create(&io);
    go.index = index;
    trax_gallery *gallery = trax_gallery_create(&go);

    printf("First entry into %s\n", folder);
    trax_index_report report;
    trax_status st = trax_gallery_open(gallery, folder, &report);
    if (st != TRAX_OK) {
        printf("  did not open: %s\n",
               st == TRAX_CANCELLED ? "cancelled, nothing kept"
                                    : "the folder could not be read");
        print_log(log);
        trax_gallery_destroy(gallery);
        trax_index_destroy(index);
        trax_log_destroy(log);
        trax_host_posix_free(&hp);
        return st == TRAX_CANCELLED ? 0 : 1;
    }
    printf("  %u album(s), %u track(s), %u skipped folder(s), %u capped\n",
           report.albums, report.tracks, report.folders_skipped,
           report.folders_capped);
    printf("  source: %s, %llu ms\n",
           report.hit_cache ? "cache" : "scan",
           (unsigned long long)report.elapsed_ms);

    size_t albums = trax_gallery_album_count(gallery);
    for (size_t i = 0; i < albums; ++i) {
        const trax_album *album = trax_gallery_album_at(gallery, i);
        if (!album) continue;
        printf("  %2zu. %s  (%u track%s%s)%s\n", i + 1,
               album->title ? album->title : "(untitled)",
               (unsigned)album->track_count,
               album->track_count == 1 ? "" : "s",
               album->from_cue ? ", cue" : "",
               album->cover_name ? "" : "  [orb]");
    }
    print_log(log);

    if (progress.cancel_after) {
        /* The cancelled run already proves "nothing kept"; a second entry is
         * what shows the next visit reads in full. */
        printf("A second entry after the cancellation\n");
        trax_log_clear(log);
        st = trax_gallery_open(gallery, folder, &report);
        printf("  %s: %u track(s) (%s)\n",
               st == TRAX_OK ? "opened" : "did not open", report.tracks,
               report.hit_cache ? "from the cache" : "walked again");
        print_log(log);
    } else {
        printf("Second entry (fresh index, as a new launch would make)\n");
        trax_gallery_close(gallery);
        trax_index_destroy(index);
        trax_log_clear(log);
        index = trax_index_create(&io);
        go.index = index;
        trax_gallery *second_gallery = trax_gallery_create(&go);
        st = trax_gallery_open(second_gallery, folder, &report);
        printf("  %s: %u track(s), %s, %llu ms\n",
               st == TRAX_OK ? "opened" : "did not open", report.tracks,
               report.hit_cache ? "from the cache" : "walked again",
               (unsigned long long)report.elapsed_ms);
        print_log(log);
        trax_gallery_destroy(second_gallery);
    }
    trax_gallery_destroy(gallery);
    trax_index_destroy(index);

    if (run_shuffle) {
        printf("Global shuffle\n");
        trax_log_clear(log);
        trax_shuffle_options so;
        memset(&so, 0, sizeof(so));
        so.host = &hp.host;
        so.log = log;
        trax_shuffle *shuffle = trax_shuffle_create(&so);
        st = trax_shuffle_start(shuffle, folder, &report);
        if (st == TRAX_OK) {
            size_t total = trax_shuffle_length(shuffle);
            printf("  built a %zu-track order\n", total);
            size_t played = 0;
            while (trax_shuffle_current_track(shuffle) >= 0) {
                ++played;
                trax_shuffle_advance(shuffle);
            }
            printf("  played %zu of %zu, then stopped\n", played, total);
            printf("  remembered between launches: %s\n",
                   trax_shuffle_remembers_between_launches() ? "yes" : "no");
        } else {
            printf("  did not start: %s\n",
                   st == TRAX_CANCELLED ? "cancelled" : "could not read");
        }
        print_log(log);
        trax_shuffle_destroy(shuffle);
    }

    trax_host_posix_free(&hp);
    trax_log_destroy(log);
    trax_free(normalized);
    return 0;
}
