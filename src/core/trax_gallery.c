#include "trax_gallery.h"

#include <string.h>

struct trax_gallery {
    trax_index_options index_options;
    trax_index *index;
    bool owns_index;
    const trax_library *held;
    trax_status last_status;
    const char *empty_message;
};

trax_gallery *trax_gallery_create(const trax_gallery_options *options) {
    if (!options) return NULL;
    trax_gallery *gallery = (trax_gallery *)trax_calloc(1, sizeof(*gallery));
    if (!gallery) return NULL;
    if (options->index) {
        gallery->index = options->index;
    } else {
        /* A gallery with no shared index makes its own, so a caller that only
         * wants a wall need not know the index exists. */
        trax_index_options io;
        memset(&io, 0, sizeof(io));
        io.host = options->host;
        io.log = options->log;
        io.cancel = options->cancel;
        io.cache_path = options->cache_path;
        io.on_progress = options->on_progress;
        io.progress_user = options->progress_user;
        gallery->index = trax_index_create(&io);
        if (!gallery->index) {
            trax_free(gallery);
            return NULL;
        }
        gallery->owns_index = true;
    }
    gallery->empty_message = "No albums found";
    return gallery;
}

void trax_gallery_destroy(trax_gallery *gallery) {
    if (!gallery) return;
    trax_gallery_close(gallery);
    if (gallery->owns_index) trax_index_destroy(gallery->index);
    trax_free(gallery);
}

trax_status trax_gallery_open(trax_gallery *gallery, const char *music_folder,
                              trax_index_report *report) {
    if (!gallery || !music_folder) return TRAX_ERR;
    trax_gallery_close(gallery);
    const trax_library *lib = NULL;
    trax_status st = trax_index_acquire(gallery->index, music_folder, &lib,
                                        report);
    gallery->last_status = st;
    if (st != TRAX_OK) {
        gallery->held = NULL;
        gallery->empty_message =
            st == TRAX_CANCELLED ? "Reading stopped" : "Could not read that folder";
        return st;
    }
    gallery->held = lib;
    gallery->empty_message =
        trax_library_total_albums(lib) == 0 ? "No albums found" : "";
    return TRAX_OK;
}

void trax_gallery_close(trax_gallery *gallery) {
    if (!gallery) return;
    if (gallery->held) {
        trax_index_release(gallery->index, gallery->held);
        gallery->held = NULL;
    }
}

bool trax_gallery_is_open(const trax_gallery *gallery) {
    return gallery && gallery->held != NULL;
}

size_t trax_gallery_album_count(const trax_gallery *gallery) {
    if (!gallery || !gallery->held) return 0;
    return trax_library_total_albums(gallery->held);
}

const trax_album *trax_gallery_album_at(const trax_gallery *gallery, size_t i) {
    if (!gallery || !gallery->held || i >= gallery->held->album_count) return NULL;
    return &gallery->held->albums[i];
}

const char *trax_gallery_empty_message(const trax_gallery *gallery) {
    if (!gallery) return "No albums found";
    return gallery->empty_message;
}

char *trax_gallery_cover_path(const trax_gallery *gallery,
                              const trax_album *album) {
    if (!gallery || !gallery->held || !album || !album->cover_name) return NULL;
    const char *folder = trax_library_folder_path(gallery->held, album->folder);
    if (!folder) return NULL;
    return trax_path_join(folder, album->cover_name);
}

bool trax_gallery_album_tracks(const trax_gallery *gallery,
                               const trax_album *album,
                               const trax_track **tracks, size_t *count) {
    if (!gallery || !gallery->held) return false;
    return trax_library_album_tracks(gallery->held, album, tracks, count);
}
