/*
 * trax_host_posix.h - the desktop host, for the acceptance suite.
 *
 * It answers the trax_host interface with dirent/stat and stdio, so a sample
 * card can be an ordinary directory tree under the system temporary folder.
 * No device is required.
 *
 * The host is exercised in two ways:
 *   - The real one, on real fixture directories.
 *   - A wrappable one: a `trax_host_faults` record names paths whose listing
 *     should fail (an unreadable folder on a card) without needing permission
 *     tricks, which are unreliable under Windows.  A listing that fails is
 *     exactly what a real card's bad directory produces through sceIo.
 */
#ifndef TRAX_HOST_POSIX_H
#define TRAX_HOST_POSIX_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "trax_common.h"
#include "trax_platform.h"

#ifdef __cplusplus
extern "C" {
#endif

#define TRAX_HOST_MAX_FAULT_PATHS 32

typedef struct {
    /* Paths whose listing must fail, as if the folder would not open. */
    char *fail_list_paths[TRAX_HOST_MAX_FAULT_PATHS];
    size_t fail_list_count;
    /* Paths whose read must fail, as if a cue sheet were corrupt. */
    char *fail_read_paths[TRAX_HOST_MAX_FAULT_PATHS];
    size_t fail_read_count;
    /* Counters, so a test can prove the cache path avoided a walk. */
    unsigned list_calls;
    unsigned read_calls;
    unsigned write_calls;
} trax_host_faults;

typedef struct {
    trax_host host;
    trax_host_faults faults;
} trax_host_posix;

void trax_host_posix_init(trax_host_posix *h);
void trax_host_posix_free(trax_host_posix *h);
/* Convenience: a bare host with no faults, for tests that only need the
 * interface.  `out` must outlive the scan. */
void trax_host_posix_fill(trax_host *out, trax_host_posix *storage);

/* Register a path that must fail to list / to read.  Copies the string.
 * Returns false when the table is full. */
bool trax_host_posix_fail_list(trax_host_posix *h, const char *path);
bool trax_host_posix_fail_read(trax_host_posix *h, const char *path);

/* The stock host functions, exposed for a host that wants to wrap them. */
trax_status trax_host_posix_list_dir(void *user, const char *path,
                                     trax_dir_listing *out);
bool trax_host_posix_is_dir(void *user, const char *path);
trax_status trax_host_posix_read_file(void *user, const char *path, char **data,
                                      size_t *len);
trax_status trax_host_posix_write_file(void *user, const char *path,
                                       const void *data, size_t len);
trax_status trax_host_posix_remove_file(void *user, const char *path);
uint64_t trax_host_posix_now_ms(void *user);

#ifdef __cplusplus
}
#endif

#endif /* TRAX_HOST_POSIX_H */
