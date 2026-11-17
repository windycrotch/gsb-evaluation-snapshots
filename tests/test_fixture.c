#include "test_fixture.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#if defined(_WIN32)
#include <direct.h>
#define fixture_mkdir(path) _mkdir(path)
#define fixture_rmdir(path) _rmdir(path)
#else
#include <unistd.h>
#define fixture_mkdir(path) mkdir(path, 0777)
#define fixture_rmdir(path) rmdir(path)
#endif

bool fixture_join(const char *base, const char *relative, char *out, size_t cap) {
    int n;
    if (relative && *relative) {
        n = snprintf(out, cap, "%s/%s", base, relative);
    } else {
        n = snprintf(out, cap, "%s", base);
    }
    return n > 0 && (size_t)n < cap;
}

/* Recursive removal, so a fixture never outlives its test. */
static void remove_tree(const char *path) {
    char command[1400];
#if defined(_WIN32)
    int n = snprintf(command, sizeof(command), "rmdir /s /q \"%s\" >NUL 2>NUL", path);
#else
    int n = snprintf(command, sizeof(command), "rm -rf \"%s\"", path);
#endif
    if (n > 0 && (size_t)n < sizeof(command)) {
        /* Housekeeping must never fail a test; a leftover temporary folder is
         * the machine's business, not the assertion's. */
        (void)!system(command);
    }
}

bool fixture_create(fixture *fx, const char *tag) {
    if (!fx || !tag) return false;
    memset(fx, 0, sizeof(*fx));
#if defined(_WIN32)
    const char *tmp = getenv("TEMP");
    if (!tmp || !*tmp) tmp = ".";
#else
    const char *tmp = getenv("TMPDIR");
    if (!tmp || !*tmp) tmp = "/tmp";
#endif
    int n = snprintf(fx->root, sizeof(fx->root), "%s/trax_test_%s_%lu", tmp, tag,
                     (unsigned long)(size_t)fx);
    if (n <= 0 || (size_t)n >= sizeof(fx->root)) return false;
    fixture_mkdir(fx->root);
    if (!fixture_join(fx->root, "MUSIC", fx->music, sizeof(fx->music))) return false;
    fixture_mkdir(fx->music);
    struct stat st;
    return stat(fx->music, &st) == 0;
}

void fixture_destroy(fixture *fx) {
    if (!fx || !fx->root[0]) return;
    remove_tree(fx->root);
    fx->root[0] = '\0';
    fx->music[0] = '\0';
}

static bool make_dir(const char *path) {
#if defined(_WIN32)
    return _mkdir(path) == 0;
#else
    return mkdir(path, 0777) == 0;
#endif
}

bool fixture_write_file(fixture *fx, const char *relative, const void *data,
                        size_t len) {
    char path[1400];
    if (!fixture_join(fx->root, relative, path, sizeof(path))) return false;
    FILE *f = fopen(path, "wb");
    if (!f) return false;
    bool ok = len == 0 || fwrite(data, 1, len, f) == len;
    if (fclose(f) != 0) ok = false;
    return ok;
}

bool fixture_write_text(fixture *fx, const char *relative, const char *text) {
    return fixture_write_file(fx, relative, text, strlen(text));
}

static bool touch(const char *path) {
    FILE *f = fopen(path, "wb");
    if (!f) return false;
    fputc('x', f);
    return fclose(f) == 0;
}

bool fixture_make_folder(fixture *fx, const char *name) {
    char path[1400];
    if (!fixture_join(fx->music, name, path, sizeof(path))) return false;
    return make_dir(path);
}

bool fixture_make_big_album(fixture *fx, const char *name, unsigned tracks) {
    char dir[1400];
    if (!fixture_join(fx->music, name, dir, sizeof(dir))) return false;
    if (!make_dir(dir)) return false;
    for (unsigned i = 0; i < tracks; ++i) {
        char rel[1400];
        int n = snprintf(rel, sizeof(rel), "MUSIC/%s/%04u - track.mp3", name, i);
        if (n <= 0 || (size_t)n >= sizeof(rel)) return false;
        char path[1400];
        if (!fixture_join(fx->root, rel, path, sizeof(path))) return false;
        if (!touch(path)) return false;
    }
    return true;
}

bool fixture_make_albums(fixture *fx, unsigned count, unsigned per_album) {
    for (unsigned a = 0; a < count; ++a) {
        char album[64];
        snprintf(album, sizeof(album), "Album %02u", a);
        if (!fixture_make_big_album(fx, album, per_album)) return false;
        if (a == 0) {
            char cover[1400];
            if (!fixture_join(fx->music, "Album 00/cover.jpg", cover,
                              sizeof(cover))) {
                return false;
            }
            if (!touch(cover)) return false;
        }
    }
    return true;
}

bool fixture_make_cue_album(fixture *fx, const char *folder, const char *audio,
                            const char *sheet_name, const char *sheet_text) {
    char dir[1400];
    if (!fixture_join(fx->music, folder, dir, sizeof(dir))) return false;
    if (!make_dir(dir)) return false;
    char rel[1400];
    int n = snprintf(rel, sizeof(rel), "MUSIC/%s/%s", folder, audio);
    if (n <= 0 || (size_t)n >= sizeof(rel)) return false;
    char path[1400];
    if (!fixture_join(fx->root, rel, path, sizeof(path))) return false;
    if (!touch(path)) return false;

    n = snprintf(rel, sizeof(rel), "MUSIC/%s/%s", folder, sheet_name);
    if (n <= 0 || (size_t)n >= sizeof(rel)) return false;
    if (!fixture_write_text(fx, rel, sheet_text)) return false;

    n = snprintf(rel, sizeof(rel), "MUSIC/%s/cover.jpg", folder);
    if (n <= 0 || (size_t)n >= sizeof(rel)) return false;
    if (!fixture_join(fx->root, rel, path, sizeof(path))) return false;
    return touch(path);
}

bool fixture_create_other_music(fixture *fx, const char *tag, char *out,
                                size_t cap) {
    if (!fx || !tag || !out) return false;
    char prefix[256];
    snprintf(prefix, sizeof(prefix), "OTHER_%s", tag);
    char dir[1400];
    if (!fixture_join(fx->root, prefix, dir, sizeof(dir))) return false;
    if (!make_dir(dir)) return false;
    if (!fixture_join(dir, "MUSIC", out, cap)) return false;
    return make_dir(out);
}
