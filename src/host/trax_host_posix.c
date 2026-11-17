#include "trax_host_posix.h"

#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>

/* ------------------------------------------------------------------ */
/* the stock operations                                                */
/* ------------------------------------------------------------------ */

trax_status trax_host_posix_list_dir(void *user, const char *path,
                                     trax_dir_listing *out) {
    if (!out) return TRAX_ERR;
    memset(out, 0, sizeof(*out));
    (void)user;
    DIR *dir = opendir(path);
    if (!dir) return TRAX_ERR;

    /* Build each child's full path once for the stat call.  errno is cleared
     * immediately before each readdir so a stat() or a failed allocation on
     * the previous iteration cannot be mistaken for a read error. */
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(dir);
        if (!entry) {
            if (errno != 0) out->truncated = true;
            break;
        }
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) {
            continue;
        }
        trax_entry_kind kind = TRAX_ENTRY_OTHER;
        uint64_t size = 0;
        uint64_t mtime = 0;
#if defined(DT_DIR)
        if (entry->d_type == DT_DIR) {
            kind = TRAX_ENTRY_DIR;
        } else if (entry->d_type == DT_REG) {
            kind = TRAX_ENTRY_FILE;
        } else if (entry->d_type == DT_UNKNOWN) {
            kind = TRAX_ENTRY_OTHER;
        } else {
            kind = TRAX_ENTRY_OTHER;
        }
#endif
        char *full = trax_path_join(path, entry->d_name);
        struct stat st;
        if (full && stat(full, &st) == 0) {
            if (S_ISDIR(st.st_mode)) {
                kind = TRAX_ENTRY_DIR;
            } else if (S_ISREG(st.st_mode)) {
                kind = TRAX_ENTRY_FILE;
                size = (uint64_t)st.st_size;
            }
            mtime = (uint64_t)st.st_mtime;
        }
        bool added = trax_dir_listing_add(out, entry->d_name, kind, size, mtime);
        trax_free(full);
        if (!added) {
            out->truncated = true;
            trax_dir_listing_free(out);
            closedir(dir);
            return TRAX_ERR;
        }
    }
    closedir(dir);
    return TRAX_OK;
}

bool trax_host_posix_is_dir(void *user, const char *path) {
    (void)user;
    struct stat st;
    if (stat(path, &st) != 0) return false;
    return S_ISDIR(st.st_mode);
}

trax_status trax_host_posix_read_file(void *user, const char *path, char **data,
                                      size_t *len) {
    (void)user;
    if (!data || !len) return TRAX_ERR;
    *data = NULL;
    *len = 0;
    FILE *f = fopen(path, "rb");
    if (!f) return TRAX_ERR;
    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        return TRAX_ERR;
    }
    long size = ftell(f);
    if (size < 0) {
        fclose(f);
        return TRAX_ERR;
    }
    rewind(f);
    char *buffer = (char *)trax_malloc((size_t)size + 1);
    if (!buffer) {
        fclose(f);
        return TRAX_ERR;
    }
    size_t read = fread(buffer, 1, (size_t)size, f);
    fclose(f);
    if (read != (size_t)size) {
        trax_free(buffer);
        return TRAX_ERR;
    }
    buffer[size] = '\0';
    *data = buffer;
    *len = (size_t)size;
    return TRAX_OK;
}

trax_status trax_host_posix_write_file(void *user, const char *path,
                                       const void *data, size_t len) {
    (void)user;
    if (!path || (!data && len)) return TRAX_ERR;
    /* Write beside the target and rename, so a card pulled mid-write leaves
     * the old cache rather than half of a new one. */
    size_t n = strlen(path);
    char *tmp = (char *)trax_malloc(n + 5);
    if (!tmp) return TRAX_ERR;
    memcpy(tmp, path, n);
    memcpy(tmp + n, ".tmp", 5);
    FILE *f = fopen(tmp, "wb");
    if (!f) {
        trax_free(tmp);
        return TRAX_ERR;
    }
    bool ok = len == 0 || fwrite(data, 1, len, f) == len;
    if (fclose(f) != 0) ok = false;
    if (!ok) {
        remove(tmp);
        trax_free(tmp);
        return TRAX_ERR;
    }
    remove(path);
    if (rename(tmp, path) != 0) {
        remove(tmp);
        trax_free(tmp);
        return TRAX_ERR;
    }
    trax_free(tmp);
    return TRAX_OK;
}

trax_status trax_host_posix_remove_file(void *user, const char *path) {
    (void)user;
    if (!path) return TRAX_ERR;
    if (remove(path) == 0) return TRAX_OK;
    /* A missing file is success. */
    FILE *probe = fopen(path, "rb");
    if (!probe) return TRAX_OK;
    fclose(probe);
    return TRAX_ERR;
}

uint64_t trax_host_posix_now_ms(void *user) {
    (void)user;
    /* Wall clock, not CPU time: "the second entry is faster" is about how
     * long the user waits, and a walk is dominated by card I/O. */
#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L &&     !defined(__STDC_NO_ATOMICS__)
    struct timespec ts;
    if (timespec_get(&ts, TIME_UTC) == TIME_UTC) {
        return (uint64_t)ts.tv_sec * 1000ull + (uint64_t)(ts.tv_nsec / 1000000);
    }
#endif
    return (uint64_t)((clock() * 1000ull) / CLOCKS_PER_SEC);
}

/* ------------------------------------------------------------------ */
/* fault-injecting wrapper                                             */
/* ------------------------------------------------------------------ */

static bool path_in(const char *path, char *const *list, size_t count) {
    if (!path) return false;
    for (size_t i = 0; i < count; ++i) {
        if (list[i] && strcmp(path, list[i]) == 0) return true;
    }
    return false;
}

static trax_host_posix *as_posix(void *user) {
    return (trax_host_posix *)user;
}

static trax_status wrapper_list(void *user, const char *path,
                                trax_dir_listing *out) {
    trax_host_posix *h = as_posix(user);
    ++h->faults.list_calls;
    if (path_in(path, h->faults.fail_list_paths, h->faults.fail_list_count)) {
        if (out) memset(out, 0, sizeof(*out));
        return TRAX_ERR;
    }
    return trax_host_posix_list_dir(user, path, out);
}

static bool wrapper_is_dir(void *user, const char *path) {
    return trax_host_posix_is_dir(user, path);
}

static trax_status wrapper_read(void *user, const char *path, char **data,
                                size_t *len) {
    trax_host_posix *h = as_posix(user);
    ++h->faults.read_calls;
    if (path_in(path, h->faults.fail_read_paths, h->faults.fail_read_count)) {
        if (data) *data = NULL;
        if (len) *len = 0;
        return TRAX_ERR;
    }
    return trax_host_posix_read_file(user, path, data, len);
}

static trax_status wrapper_write(void *user, const char *path, const void *data,
                                 size_t len) {
    trax_host_posix *h = as_posix(user);
    ++h->faults.write_calls;
    return trax_host_posix_write_file(user, path, data, len);
}

static trax_status wrapper_remove(void *user, const char *path) {
    return trax_host_posix_remove_file(user, path);
}

static uint64_t wrapper_now(void *user) { return trax_host_posix_now_ms(user); }

void trax_host_posix_init(trax_host_posix *h) {
    if (!h) return;
    memset(h, 0, sizeof(*h));
    h->host.user = h;
    h->host.list_dir = wrapper_list;
    h->host.is_dir = wrapper_is_dir;
    h->host.read_file = wrapper_read;
    h->host.write_file = wrapper_write;
    h->host.remove_file = wrapper_remove;
    h->host.now_ms = wrapper_now;
}

void trax_host_posix_free(trax_host_posix *h) {
    if (!h) return;
    for (size_t i = 0; i < h->faults.fail_list_count; ++i) {
        trax_free(h->faults.fail_list_paths[i]);
    }
    for (size_t i = 0; i < h->faults.fail_read_count; ++i) {
        trax_free(h->faults.fail_read_paths[i]);
    }
    memset(h, 0, sizeof(*h));
}

void trax_host_posix_fill(trax_host *out, trax_host_posix *storage) {
    if (!out || !storage) return;
    trax_host_posix_init(storage);
    *out = storage->host;
}

bool trax_host_posix_fail_list(trax_host_posix *h, const char *path) {
    if (!h || !path || h->faults.fail_list_count >= TRAX_HOST_MAX_FAULT_PATHS) {
        return false;
    }
    char *copy = trax_strdup(path);
    if (!copy) return false;
    h->faults.fail_list_paths[h->faults.fail_list_count++] = copy;
    return true;
}

bool trax_host_posix_fail_read(trax_host_posix *h, const char *path) {
    if (!h || !path || h->faults.fail_read_count >= TRAX_HOST_MAX_FAULT_PATHS) {
        return false;
    }
    char *copy = trax_strdup(path);
    if (!copy) return false;
    h->faults.fail_read_paths[h->faults.fail_read_count++] = copy;
    return true;
}
