/*
 * trax_platform.h - the seam between the portable core and a machine.
 *
 * The scanner never calls opendir()/sceIo() directly; it asks this interface.
 * A PSP build answers with sceIo, a Vita build with sceIo as well, and the
 * desktop host answers with dirent/stat so the entire scan can be exercised on
 * a developer machine with an ordinary folder.
 *
 * Two behaviours matter for the index:
 *  - A listing that cannot be opened must report TRAX_ERR, not an empty list.
 *    The scanner distinguishes "empty folder" from "unreadable folder", and
 *    skipping a bad folder is what keeps one corrupt directory on a real card
 *    from losing the whole index.
 *  - Entries come back with a kind and a size.  The scanner needs no file
 *    contents, which is what makes a full card readable in seconds.
 */
#ifndef TRAX_PLATFORM_H
#define TRAX_PLATFORM_H

#include <stdbool.h>
#include <stdint.h>

#include "trax_common.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    TRAX_ENTRY_FILE = 0,
    TRAX_ENTRY_DIR,
    TRAX_ENTRY_OTHER
} trax_entry_kind;

typedef struct {
    char *name;      /* UTF-8, owned by the listing */
    uint64_t size;   /* bytes, 0 for directories */
    uint64_t mtime;  /* seconds since the epoch, 0 when unknown */
    trax_entry_kind kind;
} trax_dir_entry;

typedef struct {
    trax_dir_entry *entries;
    size_t count;
    size_t cap;
    /* Set when the first readdir failed partway: callers must treat the
     * listing as incomplete. */
    bool truncated;
} trax_dir_listing;

/*
 * A host is the set of storage operations the core needs.  `user` is passed
 * back untouched so a host can keep per-instance state (a mount prefix, an
 * emulated card root, and so on).
 */
typedef struct trax_host {
    void *user;
    /* Read a directory.  Returns TRAX_OK on success, TRAX_ERR when the folder
     * cannot be opened or read. */
    trax_status (*list_dir)(void *user, const char *path, trax_dir_listing *out);
    /* Whether a path exists and is a directory.  Used to validate the music
     * folder before a scan starts. */
    bool (*is_dir)(void *user, const char *path);
    /* Read a whole file into memory.  Used for .cue sheets (small text). */
    trax_status (*read_file)(void *user, const char *path, char **data, size_t *len);
    /* Write a whole file atomically where possible.  Used for the index cache. */
    trax_status (*write_file)(void *user, const char *path, const void *data, size_t len);
    /* Remove a file; missing files are success. */
    trax_status (*remove_file)(void *user, const char *path);
    /* A monotonic millisecond clock, for the "second entry is faster" check
     * and for log lines.  0 is acceptable if the host has no clock. */
    uint64_t (*now_ms)(void *user);
} trax_host;

/* Frees every name and the entry array; safe on a zeroed listing. */
void trax_dir_listing_free(trax_dir_listing *listing);
/* Appends a copy of `name`; takes ownership of nothing.  Used by hosts and by
 * tests that build listings by hand. */
bool trax_dir_listing_add(trax_dir_listing *listing, const char *name,
                          trax_entry_kind kind, uint64_t size, uint64_t mtime);

/* Convenience: does `name` look like a playable audio file?  The extension
 * list is the one the manual advertises. */
bool trax_name_is_audio(const char *name);
/* Is this a .cue sheet? */
bool trax_name_is_cue(const char *name);
/* Is this a picture TRAX would treat as cover art? */
bool trax_name_is_picture(const char *name);
/* Is this an image whose name marks it as a cover (cover/folder/front)? */
bool trax_name_is_cover_hint(const char *name);

#ifdef __cplusplus
}
#endif

#endif /* TRAX_PLATFORM_H */
