/*
 * trax_library.h - the one index the gallery and global shuffle share.
 *
 * Both entry points need the same thing: every album and every track under
 * the music folder, found by walking it once.  Once found, the result is kept
 * on the card so the second visit is a read rather than a walk, and both users
 * read the same copy (README: "Global shuffle that walks the whole card").
 *
 * The model is deliberately small, because a PSP has little memory and a card
 * can hold thousands of tracks (RELEASE_NOTES: a queue entry holding two
 * strings per track cost 1524 bytes; folders are stored once instead).
 *
 *   - A folder path is stored once in `folders`.
 *   - A track names its folder by index, its file name, and its display title.
 *   - An album records the contiguous run of tracks that belongs to it.
 *   - A cue album's tracks all point at the same audio file and differ by
 *     track number - that is what makes such an album count as its tracks
 *     rather than as one file.
 */
#ifndef TRAX_LIBRARY_H
#define TRAX_LIBRARY_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "trax_common.h"

#ifdef __cplusplus
extern "C" {
#endif

/* How a track came to exist. */
typedef enum {
    TRAX_TRACK_FILE = 0,  /* one playable file */
    TRAX_TRACK_CUE         /* a split of a cue album's single audio file */
} trax_track_kind;

typedef struct {
    uint32_t folder;       /* index into trax_library.folders */
    char *file_name;       /* audio file name, relative to the folder */
    char *title;           /* what the list and player show (owned) */
    uint32_t cue_track;    /* 0 for a whole file; 1..n for a cue split */
    uint32_t cue_index;    /* the sheet's INDEX 01 frame, 0 when absent */
    trax_track_kind kind;
} trax_track;

typedef struct {
    uint32_t folder;       /* index into trax_library.folders */
    char *title;           /* album name (owned) */
    char *cover_name;      /* a picture in the folder, or NULL (owned) */
    char *cue_file;        /* sheet name when from_cue, else NULL (owned) */
    uint32_t first_track;  /* run of tracks belonging to the album */
    uint32_t track_count;
    bool from_cue;
} trax_album;

typedef struct {
    bool valid;
    /* The music folder this index describes.  A cached index whose folder no
     * longer matches the current setting must not be used. */
    char *music_folder;
    /* Identity of the top-level contents: names, kinds, sizes, mtimes.  A
     * cache is only trusted while this still matches the card. */
    uint64_t fingerprint;
    /* When the walk happened (host clock, ms), for the log. */
    uint64_t built_ms;
    /* Top-level progress units the walk had: each top-level folder, plus one
     * for loose files at the root.  Cached so a cache hit can report "12 of
     * 12 folders" without touching the card. */
    uint32_t folders_total;

    char **folders;        /* shared folder paths (owned) */
    size_t folder_count;
    size_t folder_cap;

    trax_track *tracks;    /* owned */
    size_t track_count;
    size_t track_cap;

    trax_album *albums;    /* owned */
    size_t album_count;
    size_t album_cap;

    /* Diagnostics carried with the index so the gallery can say why a card
     * is short: folders skipped because they would not read, and folders
     * capped at the 1024-track limit. */
    uint32_t folders_skipped;
    uint32_t folders_capped;
} trax_library;

trax_library *trax_library_create(void);
void trax_library_destroy(trax_library *lib);
/* Empty the library but keep the allocation; used before a rescan. */
void trax_library_clear(trax_library *lib);

/* Intern a folder path; returns its index, or UINT32_MAX on failure. */
uint32_t trax_library_intern_folder(trax_library *lib, const char *path);
const char *trax_library_folder_path(const trax_library *lib, uint32_t index);

/* Append a track; on success the library owns all of its strings. */
bool trax_library_add_track(trax_library *lib, const trax_track *track);
/* Append an album; on success the library owns all of its strings. */
bool trax_library_add_album(trax_library *lib, const trax_album *album);

/* Mark a run of tracks as an album in one step.  `title`, `cover_name` and
 * `cue_file` are copied.  Returns false on allocation failure. */
bool trax_library_add_album_run(trax_library *lib, uint32_t folder,
                               const char *title, const char *cover_name,
                               const char *cue_file, bool from_cue,
                               uint32_t first_track, uint32_t track_count);

/* A track's absolute path, freshly allocated, or NULL. */
char *trax_library_track_path(const trax_library *lib, const trax_track *track);

/* The tracks belonging to an album (contiguous in the track array). */
bool trax_library_album_tracks(const trax_library *lib, const trax_album *album,
                               const trax_track **tracks, size_t *count);

size_t trax_library_total_tracks(const trax_library *lib);
size_t trax_library_total_albums(const trax_library *lib);

#ifdef __cplusplus
}
#endif

#endif /* TRAX_LIBRARY_H */
