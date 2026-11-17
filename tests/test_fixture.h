/*
 * tests/test_fixture.h - a sample card under the system temporary directory.
 *
 * Every test builds its own tree so cases never interfere, and so the
 * acceptance suite needs no device and no real memory stick.  Paths handed
 * back are host paths, which the POSIX host understands directly.
 */
#ifndef TRAX_TEST_FIXTURE_H
#define TRAX_TEST_FIXTURE_H

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    char root[1024];     /* the sample card */
    char music[1024];    /* <root>/MUSIC */
} fixture;

bool fixture_create(fixture *fx, const char *tag);
void fixture_destroy(fixture *fx);

/* Build `count` albums of `per_album` tracks under the music folder, plus one
 * cover in the first album.  Names are deterministic. */
bool fixture_make_albums(fixture *fx, unsigned count, unsigned per_album);

/* One album whose folder holds `tracks` playable files. */
bool fixture_make_big_album(fixture *fx, const char *name, unsigned tracks);

/* Add a folder that the fault-injecting host will refuse to list. */
bool fixture_make_folder(fixture *fx, const char *name);

/* Write a file with the given contents; parent folders are assumed to exist. */
bool fixture_write_file(fixture *fx, const char *relative, const void *data,
                        size_t len);
bool fixture_write_text(fixture *fx, const char *relative, const char *text);

/* Make a cue album: one long audio file, one sheet, one cover. */
bool fixture_make_cue_album(fixture *fx, const char *folder, const char *audio,
                            const char *sheet_name, const char *sheet_text);

/* A second music tree, for "the user switched the music folder".  Creates it
 * and writes its path into `out`. */
bool fixture_create_other_music(fixture *fx, const char *tag, char *out,
                                size_t cap);

/* Join `relative` onto `base` into `out`; returns false when it will not fit. */
bool fixture_join(const char *base, const char *relative, char *out, size_t cap);

#endif /* TRAX_TEST_FIXTURE_H */
