#include "trax_platform.h"

#include <string.h>

void trax_dir_listing_free(trax_dir_listing *listing) {
    if (!listing) return;
    for (size_t i = 0; i < listing->count; ++i) trax_free(listing->entries[i].name);
    trax_free(listing->entries);
    listing->entries = NULL;
    listing->count = 0;
    listing->cap = 0;
    listing->truncated = false;
}

bool trax_dir_listing_add(trax_dir_listing *listing, const char *name,
                          trax_entry_kind kind, uint64_t size, uint64_t mtime) {
    if (!listing || !name) return false;
    if (!trax_vec_reserve((void **)&listing->entries, &listing->cap,
                          listing->count + 1, sizeof(trax_dir_entry))) {
        return false;
    }
    char *copy = trax_strdup(name);
    if (!copy) return false;
    listing->entries[listing->count].name = copy;
    listing->entries[listing->count].size = size;
    listing->entries[listing->count].mtime = mtime;
    listing->entries[listing->count].kind = kind;
    ++listing->count;
    return true;
}

static bool extension_in(const char *name, const char *const *exts, size_t count) {
    const char *ext = trax_path_extension(name);
    if (*ext != '.') return false;
    for (size_t i = 0; i < count; ++i) {
        if (trax_str_ieq(ext, exts[i])) return true;
    }
    return false;
}

bool trax_name_is_audio(const char *name) {
    static const char *const exts[] = {".mp3", ".wav", ".flac", ".m4a",
                                       ".opus", ".at3", ".aac", ".ogg",
                                       ".mka", ".aif", ".aiff"};
    return name && extension_in(name, exts, sizeof(exts) / sizeof(exts[0]));
}

bool trax_name_is_cue(const char *name) {
    return name && trax_str_ends_with_ci(name, ".cue");
}

bool trax_name_is_picture(const char *name) {
    static const char *const exts[] = {".jpg", ".jpeg", ".png", ".bmp"};
    return name && extension_in(name, exts, sizeof(exts) / sizeof(exts[0]));
}

bool trax_name_is_cover_hint(const char *name) {
    if (!trax_name_is_picture(name)) return false;
    char *stem = trax_path_stem(name);
    if (!stem) return false;
    static const char *const hints[] = {"cover", "folder", "front", "album"};
    bool hit = false;
    for (size_t i = 0; i < sizeof(hints) / sizeof(hints[0]) && !hit; ++i) {
        hit = trax_str_ieq(stem, hints[i]);
    }
    trax_free(stem);
    return hit;
}
