#include "trax_cue.h"
#include "trax_platform.h"

#include <string.h>

typedef struct {
    char *keyword;
    const char *rest;
    size_t rest_len;
} cue_line;

static bool cue_line_parse(const char *line, size_t len, cue_line *out) {
    size_t i = 0;
    while (i < len && (line[i] == ' ' || line[i] == '\t')) ++i;
    size_t kw_start = i;
    while (i < len && line[i] != ' ' && line[i] != '\t') ++i;
    size_t kw_len = i - kw_start;
    if (kw_len == 0) return false;
    while (i < len && (line[i] == ' ' || line[i] == '\t')) ++i;
    out->keyword = trax_strndup(line + kw_start, kw_len);
    if (!out->keyword) return false;
    size_t end = len;
    while (end > i && (line[end - 1] == ' ' || line[end - 1] == '\t' ||
                       line[end - 1] == '\r')) {
        --end;
    }
    out->rest = line + i;
    out->rest_len = end - i;
    return true;
}

/* Trimmed copy of a value, with one pair of surrounding double quotes
 * removed. */
static char *cue_value(const char *start, size_t len) {
    while (len > 0 && (*start == ' ' || *start == '\t')) {
        ++start;
        --len;
    }
    while (len > 0 && (start[len - 1] == ' ' || start[len - 1] == '\t' ||
                       start[len - 1] == '\r' || start[len - 1] == '\n')) {
        --len;
    }
    if (len >= 2 && start[0] == '"' && start[len - 1] == '"') {
        ++start;
        len -= 2;
    }
    return len ? trax_strndup(start, len) : NULL;
}

/* A FILE line's name, which may be quoted (and may itself contain spaces). */
static char *cue_file_value(const char *start, size_t len) {
    while (len > 0 && (*start == ' ' || *start == '\t')) {
        ++start;
        --len;
    }
    if (len == 0) return NULL;
    if (*start == '"') {
        ++start;
        --len;
        size_t n = 0;
        while (n < len && start[n] != '"') ++n;
        return trax_strndup(start, n);
    }
    /* Unquoted: the name ends at the last space-separated token, which the
     * sheet format reserves for the file type (WAVE, BINARY, MP3). */
    size_t end = len;
    while (end > 0 && start[end - 1] != ' ' && start[end - 1] != '\t') --end;
    size_t n = end;
    while (n > 0 && (start[n - 1] == ' ' || start[n - 1] == '\t')) --n;
    return n ? trax_strndup(start, n) : trax_strndup(start, len);
}

/* Does `pathish` end with `file` as a whole path component, ignoring case?
 * Cue sheets frequently carry a directory prefix ("C:\rips\album.flac"). */
static bool path_suffix_matches(const char *pathish, const char *file) {
    if (!pathish || !file) return false;
    size_t pn = strlen(pathish), fn = strlen(file);
    if (fn == 0 || pn < fn) return false;
    const char *tail = pathish + (pn - fn);
    if (!trax_str_ieq(tail, file)) return false;
    if (pn == fn) return true;
    char sep = tail[-1];
    return sep == '/' || sep == '\\';
}

static const char *resolve_audio(const char *sheet_name,
                                 const char *const *audio_names,
                                 size_t audio_count) {
    if (!audio_names || audio_count == 0) return NULL;
    if (sheet_name && *sheet_name) {
        for (size_t i = 0; i < audio_count; ++i) {
            if (strcmp(sheet_name, audio_names[i]) == 0) return audio_names[i];
        }
        for (size_t i = 0; i < audio_count; ++i) {
            if (path_suffix_matches(sheet_name, audio_names[i])) {
                return audio_names[i];
            }
        }
        char *stem = trax_path_stem(sheet_name);
        if (stem) {
            for (size_t i = 0; i < audio_count; ++i) {
                char *other = trax_path_stem(audio_names[i]);
                bool same = other && *stem && trax_str_ieq(stem, other);
                trax_free(other);
                if (same) {
                    trax_free(stem);
                    return audio_names[i];
                }
            }
            trax_free(stem);
        }
    }
    if (audio_count == 1) return audio_names[0];
    return NULL;
}

void trax_cue_sheet_free(trax_cue_sheet *sheet) {
    if (!sheet) return;
    trax_free(sheet->album_title);
    for (size_t i = 0; i < sheet->track_count; ++i) {
        trax_free(sheet->tracks[i].file_name);
        trax_free(sheet->tracks[i].track_title);
    }
    trax_free(sheet->tracks);
    sheet->album_title = NULL;
    sheet->tracks = NULL;
    sheet->track_count = 0;
    sheet->truncated = false;
    sheet->valid = false;
}

trax_status trax_cue_parse(const char *text, size_t len,
                           const char *const *audio_names, size_t audio_count,
                           const char *cue_name,
                           trax_cue_sheet *out) {
    if (!text || !out) return TRAX_ERR;
    memset(out, 0, sizeof(*out));
    (void)cue_name;

    if (len >= 3 && (unsigned char)text[0] == 0xEF &&
        (unsigned char)text[1] == 0xBB && (unsigned char)text[2] == 0xBF) {
        text += 3;
        len -= 3;
    }

    char *pending_file = NULL;   /* most recent FILE line */
    char *album_title = NULL;    /* TITLE before any AUDIO track */
    size_t raw_audio_tracks = 0;

    trax_cue_track *tracks = NULL;
    size_t track_cap = 0;

    size_t pos = 0;
    while (pos < len) {
        size_t end = pos;
        while (end < len && text[end] != '\n') ++end;
        cue_line cl;
        bool parsed = cue_line_parse(text + pos, end - pos, &cl);
        pos = end + 1;
        if (!parsed) continue;

        if (trax_str_ieq(cl.keyword, "TRACK")) {
            const char *p = cl.rest;
            const char *limit = cl.rest + cl.rest_len;
            while (p < limit && (*p == ' ' || *p == '\t')) ++p;
            unsigned long number = 0;
            while (p < limit && *p >= '0' && *p <= '9') {
                number = number * 10 + (unsigned long)(*p - '0');
                ++p;
            }
            while (p < limit && (*p == ' ' || *p == '\t')) ++p;
            const char *type = p;
            while (p < limit && *p != ' ' && *p != '\t') ++p;
            size_t type_len = (size_t)(p - type);

            bool is_audio = type_len == 0;
            if (!is_audio) {
                char *type_copy = trax_strndup(type, type_len);
                is_audio = type_copy && trax_str_ieq(type_copy, "AUDIO");
                trax_free(type_copy);
            }
            if (is_audio) {
                ++raw_audio_tracks;
                if (raw_audio_tracks <= TRAX_TRACKS_PER_FOLDER_LIMIT) {
                    if (!trax_vec_reserve((void **)&tracks, &track_cap,
                                          raw_audio_tracks,
                                          sizeof(trax_cue_track))) {
                        trax_free(cl.keyword);
                        trax_free(pending_file);
                        trax_free(album_title);
                        for (size_t i = 0; i + 1 < raw_audio_tracks; ++i) {
                            trax_free(tracks[i].file_name);
                            trax_free(tracks[i].track_title);
                        }
                        trax_free(tracks);
                        return TRAX_ERR;
                    }
                    trax_cue_track *t = &tracks[raw_audio_tracks - 1];
                    memset(t, 0, sizeof(*t));
                    t->number = (uint32_t)number;
                    t->file_name = pending_file ? trax_strdup(pending_file)
                                                : NULL;
                } else {
                    out->truncated = true;
                }
            }
        } else if (trax_str_ieq(cl.keyword, "FILE")) {
            char *value = cue_file_value(cl.rest, cl.rest_len);
            if (value && *value) {
                trax_free(pending_file);
                pending_file = value;
                value = NULL;
            }
            trax_free(value);
        } else if (trax_str_ieq(cl.keyword, "TITLE")) {
            char *value = cue_value(cl.rest, cl.rest_len);
            if (value && *value) {
                if (raw_audio_tracks > 0 &&
                    raw_audio_tracks <= TRAX_TRACKS_PER_FOLDER_LIMIT) {
                    trax_cue_track *t = &tracks[raw_audio_tracks - 1];
                    if (!t->track_title) {
                        t->track_title = value;
                        value = NULL;
                    }
                }
                if (value && !album_title) {
                    album_title = value;
                    value = NULL;
                }
            }
            trax_free(value);
        } else if (trax_str_ieq(cl.keyword, "INDEX")) {
            if (raw_audio_tracks > 0 &&
                raw_audio_tracks <= TRAX_TRACKS_PER_FOLDER_LIMIT) {
                const char *p = cl.rest;
                const char *limit = cl.rest + cl.rest_len;
                unsigned long idx = 0;
                while (p < limit && *p >= '0' && *p <= '9') {
                    idx = idx * 10 + (unsigned long)(*p - '0');
                    ++p;
                }
                while (p < limit && (*p == ' ' || *p == '\t')) ++p;
                if (idx == 1) {
                    unsigned long m = 0, s = 0, f = 0;
                    while (p < limit && *p >= '0' && *p <= '9') {
                        m = m * 10 + (unsigned long)(*p - '0');
                        ++p;
                    }
                    if (p < limit && *p == ':') ++p;
                    while (p < limit && *p >= '0' && *p <= '9') {
                        s = s * 10 + (unsigned long)(*p - '0');
                        ++p;
                    }
                    if (p < limit && *p == ':') ++p;
                    while (p < limit && *p >= '0' && *p <= '9') {
                        f = f * 10 + (unsigned long)(*p - '0');
                        ++p;
                    }
                    tracks[raw_audio_tracks - 1].first_index =
                        (uint32_t)(m * 60u * 75u + s * 75u + f);
                }
            }
        }
        if (cl.keyword) trax_free(cl.keyword);
    }

    trax_free(pending_file);

    out->album_title = album_title;
    out->tracks = tracks;
    out->truncated = out->truncated ||
                     raw_audio_tracks > TRAX_TRACKS_PER_FOLDER_LIMIT;
    out->track_count =
        raw_audio_tracks > TRAX_TRACKS_PER_FOLDER_LIMIT
            ? TRAX_TRACKS_PER_FOLDER_LIMIT
            : raw_audio_tracks;

    if (out->track_count == 0) {
        trax_cue_sheet_free(out);
        return TRAX_ERR;
    }

    /* Resolve each track's audio against what the folder holds.  A track
     * whose FILE did not resolve is dropped; a sheet that resolves nothing is
     * invalid, and the caller then counts the folder as plain audio instead. */
    size_t kept = 0;
    for (size_t i = 0; i < out->track_count; ++i) {
        const char *resolved = resolve_audio(out->tracks[i].file_name,
                                             audio_names, audio_count);
        if (!resolved) {
            trax_free(out->tracks[i].file_name);
            trax_free(out->tracks[i].track_title);
            memset(&out->tracks[i], 0, sizeof(out->tracks[i]));
            continue;
        }
        if (kept != i) {
            out->tracks[kept] = out->tracks[i];
            memset(&out->tracks[i], 0, sizeof(out->tracks[i]));
        }
        trax_free(out->tracks[kept].file_name);
        out->tracks[kept].file_name = trax_strdup(resolved);
        ++kept;
    }
    out->track_count = kept;
    out->valid = kept > 0;
    if (!out->valid) {
        trax_cue_sheet_free(out);
        return TRAX_ERR;
    }
    return TRAX_OK;
}
