#include "trax_library.h"

#include <string.h>

trax_library *trax_library_create(void) {
    return (trax_library *)trax_calloc(1, sizeof(trax_library));
}

static void free_album(trax_album *album) {
    trax_free(album->title);
    trax_free(album->cover_name);
    trax_free(album->cue_file);
    memset(album, 0, sizeof(*album));
}

static void free_track(trax_track *track) {
    trax_free(track->file_name);
    trax_free(track->title);
    memset(track, 0, sizeof(*track));
}

void trax_library_clear(trax_library *lib) {
    if (!lib) return;
    for (size_t i = 0; i < lib->folder_count; ++i) trax_free(lib->folders[i]);
    trax_free(lib->folders);
    lib->folders = NULL;
    lib->folder_count = 0;
    lib->folder_cap = 0;

    for (size_t i = 0; i < lib->track_count; ++i) free_track(&lib->tracks[i]);
    trax_free(lib->tracks);
    lib->tracks = NULL;
    lib->track_count = 0;
    lib->track_cap = 0;

    for (size_t i = 0; i < lib->album_count; ++i) free_album(&lib->albums[i]);
    trax_free(lib->albums);
    lib->albums = NULL;
    lib->album_count = 0;
    lib->album_cap = 0;

    trax_free(lib->music_folder);
    lib->music_folder = NULL;
    lib->fingerprint = 0;
    lib->built_ms = 0;
    lib->folders_total = 0;
    lib->folders_skipped = 0;
    lib->folders_capped = 0;
    lib->valid = false;
}

void trax_library_destroy(trax_library *lib) {
    if (!lib) return;
    trax_library_clear(lib);
    trax_free(lib);
}

uint32_t trax_library_intern_folder(trax_library *lib, const char *path) {
    if (!lib || !path) return UINT32_MAX;
    for (size_t i = 0; i < lib->folder_count; ++i) {
        if (strcmp(lib->folders[i], path) == 0) return (uint32_t)i;
    }
    if (!trax_vec_reserve((void **)&lib->folders, &lib->folder_cap,
                          lib->folder_count + 1, sizeof(char *))) {
        return UINT32_MAX;
    }
    char *copy = trax_strdup(path);
    if (!copy) return UINT32_MAX;
    lib->folders[lib->folder_count] = copy;
    return (uint32_t)lib->folder_count++;
}

const char *trax_library_folder_path(const trax_library *lib, uint32_t index) {
    if (!lib || index >= lib->folder_count) return NULL;
    return lib->folders[index];
}

bool trax_library_add_track(trax_library *lib, const trax_track *track) {
    if (!lib || !track) return false;
    if (lib->track_count >= UINT32_MAX) return false;
    if (!trax_vec_reserve((void **)&lib->tracks, &lib->track_cap,
                          lib->track_count + 1, sizeof(trax_track))) {
        return false;
    }
    lib->tracks[lib->track_count++] = *track;
    return true;
}

bool trax_library_add_album(trax_library *lib, const trax_album *album) {
    if (!lib || !album) return false;
    if (!trax_vec_reserve((void **)&lib->albums, &lib->album_cap,
                          lib->album_count + 1, sizeof(trax_album))) {
        return false;
    }
    lib->albums[lib->album_count++] = *album;
    return true;
}

bool trax_library_add_album_run(trax_library *lib, uint32_t folder,
                               const char *title, const char *cover_name,
                               const char *cue_file, bool from_cue,
                               uint32_t first_track, uint32_t track_count) {
    if (!lib) return false;
    trax_album album;
    memset(&album, 0, sizeof(album));
    album.folder = folder;
    album.title = title ? trax_strdup(title) : NULL;
    album.cover_name = cover_name ? trax_strdup(cover_name) : NULL;
    album.cue_file = cue_file ? trax_strdup(cue_file) : NULL;
    album.from_cue = from_cue;
    album.first_track = first_track;
    album.track_count = track_count;
    if ((title && !album.title) || (cover_name && !album.cover_name) ||
        (cue_file && !album.cue_file)) {
        free_album(&album);
        return false;
    }
    if (!trax_library_add_album(lib, &album)) {
        free_album(&album);
        return false;
    }
    return true;
}

char *trax_library_track_path(const trax_library *lib, const trax_track *track) {
    if (!lib || !track) return NULL;
    const char *folder = trax_library_folder_path(lib, track->folder);
    if (!folder) return NULL;
    return trax_path_join(folder, track->file_name);
}

bool trax_library_album_tracks(const trax_library *lib, const trax_album *album,
                               const trax_track **tracks, size_t *count) {
    if (!lib || !album || !tracks || !count) return false;
    size_t first = album->first_track;
    if (first > lib->track_count) return false;
    size_t n = album->track_count;
    if (n > lib->track_count - first) n = lib->track_count - first;
    *tracks = lib->tracks + first;
    *count = n;
    return true;
}

size_t trax_library_total_tracks(const trax_library *lib) {
    return lib ? lib->track_count : 0;
}

size_t trax_library_total_albums(const trax_library *lib) {
    return lib ? lib->album_count : 0;
}
