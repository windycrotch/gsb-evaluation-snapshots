#include "trax_shuffle.h"

#include <stdlib.h>
#include <string.h>

struct trax_shuffle {
    trax_index_options index_options;
    trax_index *index;
    bool owns_index;

    const trax_library *held;      /* claim while active */
    uint32_t *order;               /* indices into held->tracks */
    size_t order_count;
    size_t order_cap;
    size_t position;               /* next index in `order` */
    size_t played;

    uint32_t (*rand)(void *user);
    void *rand_user;
    uint32_t fallback_state;
    bool active;

    trax_log *log;
};

/* xorshift32: a real build substitutes a generator seeded from the clock, but
 * the plan says nothing about the sequence, only that the card is shuffled. */
static uint32_t fallback_rand(void *user) {
    uint32_t *state = (uint32_t *)user;
    if (*state == 0) *state = 0x9E3779B9u;
    *state ^= *state << 13;
    *state ^= *state >> 17;
    *state ^= *state << 5;
    return *state;
}

trax_shuffle *trax_shuffle_create(const trax_shuffle_options *options) {
    if (!options) return NULL;
    trax_shuffle *shuffle = (trax_shuffle *)trax_calloc(1, sizeof(*shuffle));
    if (!shuffle) return NULL;

    shuffle->log = options->log;
    if (options->index) {
        shuffle->index = options->index;
    } else {
        trax_index_options io;
        memset(&io, 0, sizeof(io));
        io.host = options->host;
        io.log = options->log;
        io.cancel = options->cancel;
        io.cache_path = options->cache_path;
        io.on_progress = options->on_progress;
        io.progress_user = options->progress_user;
        shuffle->index = trax_index_create(&io);
        if (!shuffle->index) {
            trax_free(shuffle);
            return NULL;
        }
        shuffle->owns_index = true;
    }
    shuffle->rand = options->rand;
    shuffle->rand_user = options->rand_user;
    shuffle->fallback_state = 0x2545F491u;
    return shuffle;
}

void trax_shuffle_destroy(trax_shuffle *shuffle) {
    if (!shuffle) return;
    trax_shuffle_stop(shuffle);
    if (shuffle->owns_index) trax_index_destroy(shuffle->index);
    trax_free(shuffle);
}

static uint32_t next_random(trax_shuffle *shuffle) {
    if (shuffle->rand) return shuffle->rand(shuffle->rand_user);
    return fallback_rand(&shuffle->fallback_state);
}

/* Fisher-Yates over the order array.  An unbiased shuffle needs the whole
 * array in memory, which is a uint32 per track - forty kilobytes for ten
 * thousand tracks, where the track list itself is already held by the index. */
static void shuffle_order(trax_shuffle *shuffle) {
    if (shuffle->order_count < 2) return;
    for (size_t i = shuffle->order_count - 1; i > 0; --i) {
        uint32_t r = next_random(shuffle);
        size_t j = (size_t)(r % (uint32_t)(i + 1));
        uint32_t tmp = shuffle->order[i];
        shuffle->order[i] = shuffle->order[j];
        shuffle->order[j] = tmp;
    }
}

trax_status trax_shuffle_start(trax_shuffle *shuffle, const char *music_folder,
                               trax_index_report *report) {
    if (!shuffle || !music_folder) return TRAX_ERR;
    trax_shuffle_stop(shuffle);

    const trax_library *lib = NULL;
    trax_status st = trax_index_acquire(shuffle->index, music_folder, &lib,
                                        report);
    if (st != TRAX_OK) {
        if (shuffle->log) {
            trax_log_printf(shuffle->log, TRAX_LOG_INFO,
                            "global shuffle over %s did not start; nothing kept",
                            music_folder);
        }
        return st;
    }

    size_t count = trax_library_total_tracks(lib);
    if (count > 0) {
        if (!trax_vec_reserve((void **)&shuffle->order, &shuffle->order_cap,
                              count, sizeof(uint32_t))) {
            trax_index_release(shuffle->index, lib);
            return TRAX_ERR;
        }
        for (size_t i = 0; i < count; ++i) shuffle->order[i] = (uint32_t)i;
        shuffle->order_count = count;
        shuffle_order(shuffle);
    } else {
        shuffle->order_count = 0;
    }
    shuffle->held = lib;
    shuffle->position = 0;
    shuffle->played = 0;
    shuffle->active = true;

    if (shuffle->log) {
        trax_log_printf(shuffle->log, TRAX_LOG_INFO,
                        "global shuffle built %u tracks from %s",
                        (unsigned)shuffle->order_count, music_folder);
    }
    return TRAX_OK;
}

/*
 * Let go of the list this session built and the claim on the shared index.
 * The played counter is left alone: "played once then stopped" can be
 * inspected after the fact.  stop() resets it; a session that runs out
 * naturally keeps it.
 */
static void release_list(trax_shuffle *shuffle, bool say_stopped) {
    size_t released = shuffle->order_count;
    trax_free(shuffle->order);
    shuffle->order = NULL;
    shuffle->order_count = 0;
    shuffle->order_cap = 0;
    shuffle->position = 0;
    if (shuffle->held) {
        trax_index_release(shuffle->index, shuffle->held);
        shuffle->held = NULL;
    }
    shuffle->active = false;
    if (shuffle->log && released > 0) {
        trax_log_printf(shuffle->log, TRAX_LOG_INFO,
                        "global shuffle %s; released the %u-track list",
                        say_stopped ? "stopped" : "finished the card",
                        (unsigned)released);
    }
}

void trax_shuffle_stop(trax_shuffle *shuffle) {
    if (!shuffle) return;
    release_list(shuffle, true);
    shuffle->played = 0;
}

bool trax_shuffle_is_active(const trax_shuffle *shuffle) {
    return shuffle && shuffle->active;
}

size_t trax_shuffle_length(const trax_shuffle *shuffle) {
    return shuffle ? shuffle->order_count : 0;
}

size_t trax_shuffle_played_count(const trax_shuffle *shuffle) {
    return shuffle ? shuffle->played : 0;
}

int32_t trax_shuffle_current_track(const trax_shuffle *shuffle) {
    if (!shuffle || !shuffle->active || shuffle->position >= shuffle->order_count) {
        return -1;
    }
    return (int32_t)shuffle->order[shuffle->position];
}

bool trax_shuffle_advance(trax_shuffle *shuffle) {
    if (!shuffle || !shuffle->active) return false;
    if (shuffle->position >= shuffle->order_count) {
        release_list(shuffle, false);
        return false;
    }
    ++shuffle->played;
    ++shuffle->position;
    if (shuffle->position >= shuffle->order_count) {
        /* The last track has been handed out.  Global shuffle stops rather
         * than going round again, and stopping is what releases the list, so
         * do it now rather than waiting to be asked for a seventh track. */
        release_list(shuffle, false);
        return false;
    }
    return true;
}

const trax_library *trax_shuffle_library(const trax_shuffle *shuffle) {
    return shuffle ? shuffle->held : NULL;
}

bool trax_shuffle_remembers_between_launches(void) { return false; }
