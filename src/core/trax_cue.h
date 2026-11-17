/*
 * trax_cue.h - reading a .cue sheet well enough to index and name it.
 *
 * An album can be one long audio file with a sheet that marks where each track
 * begins.  For the library index such an album contributes its *tracks*, not
 * the one file they live in: a forty-track cue album is forty entries, and the
 * audio file itself must not also be counted (RELEASE_NOTES: "A cue album's
 * audio file was indexed twice by global shuffle").
 *
 * Only the parts that decide that count and name are parsed.  Anything else
 * (PERFORMER, REM, ISRC, PREGAP, FLAGS) is ignored on purpose: the index never
 * needs sample offsets, and the player reads those through its own path.
 *
 * Names in a sheet cannot be trusted to equal the names on the card: a sheet
 * written on a Japanese system spells its file in Shift-JIS while the card
 * hands back UTF-8, so the two can never be equal (RELEASE_NOTES).  The
 * parser therefore resolves each FILE line against the audio names the folder
 * actually contains, never against the sheet's own spelling alone.
 */
#ifndef TRAX_CUE_H
#define TRAX_CUE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "trax_common.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    char *file_name;    /* audio file name in the folder, owned */
    char *track_title;  /* sheet's TRACK TITLE, or NULL, owned */
    uint32_t number;    /* the sheet's track number (TRACK nn) */
    uint32_t first_index; /* INDEX 01 frame count, 0 when absent */
} trax_cue_track;

typedef struct {
    char *album_title;       /* sheet TITLE at album level, or NULL */
    trax_cue_track *tracks;  /* one per playable AUDIO track */
    size_t track_count;
    /* True when the sheet listed more than TRAX_TRACKS_PER_FOLDER_LIMIT
     * audio tracks and the tail was dropped; the scanner logs it. */
    bool truncated;
    bool valid;              /* at least one playable track was resolved */
} trax_cue_sheet;

/*
 * Parse `text` (may carry a UTF-8 BOM and CRLF) as a cue sheet.
 *
 * `audio_names` is the list of audio file names actually present in the
 * folder.  A FILE line is matched byte-for-byte first, then case-insensitively,
 * then by stem ("album.cue" naming "album.flac" when the sheet spells nothing
 * usable), and finally - when the folder holds exactly one audio file - that
 * file is used.  A sheet whose audio cannot be resolved is reported invalid
 * rather than as an album that opens empty; the scanner then falls back to
 * counting the folder's audio files normally.
 *
 * A sheet listing more than TRAX_TRACKS_PER_FOLDER_LIMIT AUDIO tracks keeps
 * the first limit and sets `truncated`.
 *
 * On success the sheet owns its strings; release with trax_cue_sheet_free().
 */
trax_status trax_cue_parse(const char *text, size_t len,
                           const char *const *audio_names, size_t audio_count,
                           const char *cue_name,
                           trax_cue_sheet *out);

void trax_cue_sheet_free(trax_cue_sheet *sheet);

#ifdef __cplusplus
}
#endif

#endif /* TRAX_CUE_H */
