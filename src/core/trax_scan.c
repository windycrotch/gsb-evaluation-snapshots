#include "trax_scan.h"

#include <stdlib.h>
#include <string.h>

#include "trax_cue.h"
#include "trax_index_cache.h"

typedef struct {
    char *file_name;      /* audio file name (owned) */
    char *title;          /* display title (owned) */
    char *album_title;    /* album this track belongs to (owned) */
    char *cue_file;       /* sheet name when from a cue (owned) */
    uint32_t cue_track;
    uint32_t cue_index;
    bool from_cue;
} scan_candidate;

typedef struct {
    scan_candidate *items;
    size_t count;
    size_t cap;
} scan_candidates;

typedef struct {
    const trax_scan_options *opt;
    trax_library *work;
    uint32_t folders_total;
    uint32_t folders_done;
    uint32_t tracks_found;
    uint32_t albums_found;
    uint32_t folders_skipped;
    uint32_t folders_capped;
    bool aborted;             /* callback asked to stop */
} scan_ctx;

static void candidates_free(scan_candidates *list) {
    for (size_t i = 0; i < list->count; ++i) {
        trax_free(list->items[i].file_name);
        trax_free(list->items[i].title);
        trax_free(list->items[i].album_title);
        trax_free(list->items[i].cue_file);
    }
    trax_free(list->items);
    memset(list, 0, sizeof(*list));
}

static bool candidates_add(scan_candidates *list, const char *file_name,
                           const char *title, const char *album_title,
                           const char *cue_file, uint32_t cue_track,
                           uint32_t cue_index, bool from_cue) {
    if (!trax_vec_reserve((void **)&list->items, &list->cap, list->count + 1,
                          sizeof(scan_candidate))) {
        return false;
    }
    scan_candidate *c = &list->items[list->count];
    memset(c, 0, sizeof(*c));
    c->file_name = trax_strdup(file_name);
    c->title = title ? trax_strdup(title) : NULL;
    c->album_title = album_title ? trax_strdup(album_title) : NULL;
    c->cue_file = cue_file ? trax_strdup(cue_file) : NULL;
    c->cue_track = cue_track;
    c->cue_index = cue_index;
    c->from_cue = from_cue;
    if (!c->file_name || (title && !c->title) ||
        (album_title && !c->album_title) || (cue_file && !c->cue_file)) {
        candidates_free(list);
        return false;
    }
    ++list->count;
    return true;
}

/* The index cache lives beside the music folder, so writing it must not make
 * the folder look changed on the next launch.  Anything the cache itself
 * created is excluded from the fingerprint and from the walk. */
static bool is_cache_artifact(const char *name) {
    if (!name) return false;
    if (strcmp(name, TRAX_INDEX_CACHE_NAME) == 0) return true;
    size_t n = strlen(TRAX_INDEX_CACHE_NAME);
    if (strncmp(name, TRAX_INDEX_CACHE_NAME, n) == 0 &&
        strcmp(name + n, ".tmp") == 0) {
        return true;
    }
    return false;
}

static int entry_name_cmp(const void *a, const void *b) {
    const trax_dir_entry *ea = (const trax_dir_entry *)a;
    const trax_dir_entry *eb = (const trax_dir_entry *)b;
    return trax_name_compare(ea->name, eb->name);
}

static bool cancelled(const scan_ctx *ctx) {
    if (ctx->aborted) return true;
    if (ctx->opt->cancel && trax_cancel_requested(ctx->opt->cancel)) return true;
    return false;
}

static void emit_progress(scan_ctx *ctx, const char *current) {
    if (!ctx->opt->on_progress) return;
    trax_scan_progress progress;
    progress.folders_total = ctx->folders_total;
    progress.folders_done = ctx->folders_done;
    progress.tracks_found = ctx->tracks_found;
    progress.albums_found = ctx->albums_found;
    progress.current = current;
    if (!ctx->opt->on_progress(ctx->opt->progress_user, &progress)) {
        ctx->aborted = true;
    }
}

/*
 * What a folder holds, resolved from one listing.  Consolidating the decision
 * here keeps the recursive walk simple and makes the cue rule - a sheet's
 * audio is not also a plain track - a single, testable step.
 */
typedef struct {
    scan_candidates tracks;   /* in play order: cue albums first, then files */
    bool capped;              /* a cue sheet was cut at the 1024-track limit */
    char *cover_name;         /* preferred cover picture, or NULL */
    char *album_title;        /* folder-derived album name, or NULL */
    size_t playable_seen;     /* before the per-folder limit was applied */
} scan_folder_plan;

static void plan_free(scan_folder_plan *plan) {
    candidates_free(&plan->tracks);
    trax_free(plan->cover_name);
    trax_free(plan->album_title);
    memset(plan, 0, sizeof(*plan));
}

/* Choose a cover: a picture named cover/folder/front/album wins over the
 * alphabetically first picture. */
static char *pick_cover(const trax_dir_entry *entries, size_t count) {
    char *hint = NULL;
    char *any = NULL;
    for (size_t i = 0; i < count; ++i) {
        if (entries[i].kind != TRAX_ENTRY_FILE) continue;
        if (is_cache_artifact(entries[i].name)) continue;
        if (!trax_name_is_picture(entries[i].name)) continue;
        if (trax_name_is_cover_hint(entries[i].name)) {
            if (!hint || trax_name_compare(entries[i].name, hint) < 0) {
                char *copy = trax_strdup(entries[i].name);
                if (copy) {
                    trax_free(hint);
                    hint = copy;
                }
            }
        } else if (!any || trax_name_compare(entries[i].name, any) < 0) {
            char *copy = trax_strdup(entries[i].name);
            if (copy) {
                trax_free(any);
                any = copy;
            }
        }
    }
    if (hint) {
        trax_free(any);
        return hint;
    }
    return any;
}

/* Read and parse one cue sheet.  Returns false when it is unreadable or names
 * no audio that exists in the folder; the caller then treats its audio files
 * as ordinary tracks. */
static bool read_cue_sheet(scan_ctx *ctx, const char *folder, const char *cue_name,
                           const char *const *audio_names, size_t audio_count,
                           trax_cue_sheet *out) {
    char *path = trax_path_join(folder, cue_name);
    if (!path) return false;
    char *data = NULL;
    size_t len = 0;
    trax_status st = ctx->opt->host->read_file(ctx->opt->host->user, path, &data, &len);
    trax_free(path);
    if (st != TRAX_OK || !data) {
        trax_free(data);
        trax_log_printf(ctx->opt->log, TRAX_LOG_WARN,
                        "cue sheet %s in %s could not be read; its audio files "
                        "will be indexed as plain tracks", cue_name, folder);
        return false;
    }
    trax_status parsed = trax_cue_parse(data, len, audio_names, audio_count,
                                        cue_name, out);
    trax_free(data);
    if (parsed != TRAX_OK) {
        trax_log_printf(ctx->opt->log, TRAX_LOG_WARN,
                        "cue sheet %s in %s names no audio in the folder; "
                        "ignored", cue_name, folder);
        return false;
    }
    return true;
}

/*
 * Build the plan for one folder.  `entries` must be sorted by name.
 *
 * Order of the resulting tracks matters: cue albums come first in sheet-name
 * order, and each album's tracks are contiguous, because an album is stored
 * as a run of the track array.  Plain files follow, in name order, and are
 * one album.
 */
static bool plan_folder(scan_ctx *ctx, const char *folder,
                        const trax_dir_entry *entries, size_t count,
                        const char *folder_title, scan_folder_plan *plan) {
    memset(plan, 0, sizeof(*plan));
    plan->album_title = folder_title ? trax_strdup(folder_title) : NULL;
    plan->cover_name = pick_cover(entries, count);

    /* Names of audio files present, needed to resolve sheets. */
    char **audio_names = NULL;
    size_t audio_count = 0, audio_cap = 0;
    for (size_t i = 0; i < count; ++i) {
        if (cancelled(ctx)) break;
        if (entries[i].kind != TRAX_ENTRY_FILE) continue;
        if (is_cache_artifact(entries[i].name)) continue;
        if (!trax_name_is_audio(entries[i].name)) continue;
        if (!trax_vec_reserve((void **)&audio_names, &audio_cap, audio_count + 1,
                              sizeof(char *))) {
            for (size_t k = 0; k < audio_count; ++k) trax_free(audio_names[k]);
            trax_free(audio_names);
            trax_free(plan->cover_name);
            trax_free(plan->album_title);
            memset(plan, 0, sizeof(*plan));
            return false;
        }
        char *copy = trax_strdup(entries[i].name);
        if (!copy) {
            /* Missing one name would make a sheet resolve wrongly; refuse the
             * folder instead of guessing. */
            for (size_t k = 0; k < audio_count; ++k) trax_free(audio_names[k]);
            trax_free(audio_names);
            trax_free(plan->cover_name);
            trax_free(plan->album_title);
            memset(plan, 0, sizeof(*plan));
            return false;
        }
        audio_names[audio_count++] = copy;
    }

    /* Ownership of an audio file is claimed by the first valid cue sheet that
     * names it, in sheet-name order.  A claimed file is not a plain track. */
    char **claimed = (char **)trax_calloc(audio_count ? audio_count : 1,
                                          sizeof(char *));
    if (!claimed && audio_count) {
        for (size_t i = 0; i < audio_count; ++i) trax_free(audio_names[i]);
        trax_free(audio_names);
        return false;
    }

    for (size_t i = 0; i < count; ++i) {
        if (cancelled(ctx)) break;
        if (entries[i].kind != TRAX_ENTRY_FILE) continue;
        if (is_cache_artifact(entries[i].name)) continue;
        if (!trax_name_is_cue(entries[i].name)) continue;

        trax_cue_sheet sheet;
        memset(&sheet, 0, sizeof(sheet));
        if (!read_cue_sheet(ctx, folder, entries[i].name,
                            (const char *const *)audio_names, audio_count,
                            &sheet)) {
            continue;
        }
        /* A sheet that names audio already claimed by an earlier sheet would
         * double-count it; refuse it and say so. */
        bool clash = false;
        for (size_t t = 0; t < sheet.track_count && !clash; ++t) {
            for (size_t a = 0; a < audio_count; ++a) {
                if (trax_str_ieq(sheet.tracks[t].file_name, audio_names[a]) &&
                    claimed[a]) {
                    clash = true;
                    break;
                }
            }
        }
        if (clash) {
            trax_log_printf(ctx->opt->log, TRAX_LOG_WARN,
                            "cue sheet %s in %s names audio already indexed by "
                            "another sheet; ignored", entries[i].name, folder);
            trax_cue_sheet_free(&sheet);
            continue;
        }
        if (sheet.truncated) {
            trax_log_printf(ctx->opt->log, TRAX_LOG_WARN,
                            "cue sheet %s in %s lists more than %u tracks; "
                            "keeping the first %u", entries[i].name, folder,
                            (unsigned)TRAX_TRACKS_PER_FOLDER_LIMIT,
                            (unsigned)TRAX_TRACKS_PER_FOLDER_LIMIT);
            plan->capped = true;
        }

        char *stem = trax_path_stem(entries[i].name);
        const char *album_title =
            (sheet.album_title && *sheet.album_title) ? sheet.album_title : stem;
        for (size_t t = 0; t < sheet.track_count; ++t) {
            for (size_t a = 0; a < audio_count; ++a) {
                if (trax_str_ieq(sheet.tracks[t].file_name, audio_names[a])) {
                    claimed[a] = (char *)1;
                }
            }
            if (!candidates_add(&plan->tracks, sheet.tracks[t].file_name,
                                sheet.tracks[t].track_title, album_title,
                                entries[i].name, sheet.tracks[t].number,
                                sheet.tracks[t].first_index, true)) {
                trax_free(stem);
                trax_cue_sheet_free(&sheet);
                for (size_t a = 0; a < audio_count; ++a) trax_free(audio_names[a]);
                trax_free(audio_names);
                trax_free(claimed);
                return false;
            }
        }
        trax_free(stem);
        trax_cue_sheet_free(&sheet);
    }

    /* Remaining audio files are one album, in name order (audio_names is
     * built from a sorted listing, so it already is). */
    for (size_t a = 0; a < audio_count; ++a) {
        if (cancelled(ctx)) break;
        if (claimed[a]) continue;
        char *title = trax_path_stem(audio_names[a]);
        if (!candidates_add(&plan->tracks, audio_names[a], title,
                            plan->album_title, NULL, 0, 0, false)) {
            trax_free(title);
            for (size_t k = 0; k < audio_count; ++k) trax_free(audio_names[k]);
            trax_free(audio_names);
            trax_free(claimed);
            return false;
        }
        trax_free(title);
    }

    for (size_t a = 0; a < audio_count; ++a) trax_free(audio_names[a]);
    trax_free(audio_names);
    trax_free(claimed);

    plan->playable_seen = plan->tracks.count;
    if (plan->tracks.count > TRAX_TRACKS_PER_FOLDER_LIMIT) {
        plan->capped = true;
        /* Keep the first 1024 in the album-preserving order above.  Drop the
         * tail's strings now so nothing leaks. */
        for (size_t i = TRAX_TRACKS_PER_FOLDER_LIMIT; i < plan->tracks.count; ++i) {
            trax_free(plan->tracks.items[i].file_name);
            trax_free(plan->tracks.items[i].title);
            trax_free(plan->tracks.items[i].album_title);
            trax_free(plan->tracks.items[i].cue_file);
            memset(&plan->tracks.items[i], 0, sizeof(plan->tracks.items[i]));
        }
        plan->tracks.count = TRAX_TRACKS_PER_FOLDER_LIMIT;
    }
    return true;
}

/* Move a folder's plan into the working library as albums and tracks. */
static bool commit_plan(scan_ctx *ctx, const char *folder,
                        scan_folder_plan *plan) {
    if (plan->tracks.count == 0) return true;
    uint32_t folder_index = trax_library_intern_folder(ctx->work, folder);
    if (folder_index == UINT32_MAX) return false;

    size_t i = 0;
    while (i < plan->tracks.count) {
        const char *album_title = plan->tracks.items[i].album_title;
        const char *cue_file = plan->tracks.items[i].cue_file;
        bool from_cue = plan->tracks.items[i].from_cue;
        size_t run = 0;
        while (i + run < plan->tracks.count) {
            const scan_candidate *c = &plan->tracks.items[i + run];
            if (c->from_cue != from_cue) break;
            if (from_cue) {
                if (!c->cue_file || !cue_file ||
                    !trax_str_ieq(c->cue_file, cue_file)) {
                    break;
                }
            } else if (run > 0) {
                /* Plain files always form a single album run. */
            }
            ++run;
        }
        if (run == 0) run = 1;

        uint32_t first = (uint32_t)ctx->work->track_count;
        for (size_t t = 0; t < run; ++t) {
            scan_candidate *c = &plan->tracks.items[i + t];
            trax_track track;
            memset(&track, 0, sizeof(track));
            track.folder = folder_index;
            track.file_name = c->file_name;
            if (c->title) {
                track.title = c->title;
            } else {
                /* A cue split with no TITLE line still needs a row label. */
                track.title = trax_strdup(c->file_name);
                if (!track.title) return false;
            }
            track.cue_track = c->cue_track;
            track.cue_index = c->cue_index;
            track.kind = c->from_cue ? TRAX_TRACK_CUE : TRAX_TRACK_FILE;
            if (!trax_library_add_track(ctx->work, &track)) {
                if (!c->title) trax_free(track.title);
                return false;
            }
            /* The library took ownership by value; the candidate must not
             * free them. */
            c->file_name = NULL;
            c->title = NULL;
        }
        const char *title = album_title ? album_title : plan->album_title;
        if (!trax_library_add_album_run(ctx->work, folder_index, title,
                                        plan->cover_name, cue_file, from_cue,
                                        first, (uint32_t)run)) {
            return false;
        }
        ++ctx->albums_found;
        ctx->tracks_found += (uint32_t)run;
        i += run;
        emit_progress(ctx, folder);
        if (cancelled(ctx)) return true;
    }
    return true;
}

/* Walk a directory that is an album candidate.  `is_top` asks for progress to
 * advance when the directory itself is finished. */
static bool walk_folder(scan_ctx *ctx, const char *path, const char *title,
                        unsigned depth, bool is_top) {
    if (depth > TRAX_SCAN_MAX_DEPTH) {
        trax_log_printf(ctx->opt->log, TRAX_LOG_WARN,
                        "folder %s is nested too deeply; skipped", path);
        ++ctx->work->folders_skipped;
        if (is_top) {
            /* A skipped folder is still a finished unit: the bar must reach
             * its total even on a card with a bad directory. */
            ++ctx->folders_done;
            emit_progress(ctx, NULL);
        }
        return true;
    }
    trax_dir_listing listing;
    memset(&listing, 0, sizeof(listing));
    trax_status st = ctx->opt->host->list_dir(ctx->opt->host->user, path, &listing);
    if (st != TRAX_OK) {
        /* The rule that keeps one bad directory from costing the whole card:
         * name it, count it, carry on. */
        trax_log_printf(ctx->opt->log, TRAX_LOG_WARN,
                        "folder %s could not be read; skipped", path);
        ++ctx->work->folders_skipped;
        trax_dir_listing_free(&listing);
        if (is_top) {
            ++ctx->folders_done;
            emit_progress(ctx, NULL);
        }
        return true;
    }
    if (listing.truncated) {
        trax_log_printf(ctx->opt->log, TRAX_LOG_WARN,
                        "folder %s gave an incomplete listing; indexing what "
                        "was read", path);
        if (is_top) ++ctx->work->folders_skipped;
    }
    if (listing.count > 1) {
        qsort(listing.entries, listing.count, sizeof(trax_dir_entry),
              entry_name_cmp);
    }

    scan_folder_plan plan;
    if (!plan_folder(ctx, path, listing.entries, listing.count, title, &plan)) {
        trax_dir_listing_free(&listing);
        return false;
    }
    if (cancelled(ctx)) {
        /* The UI asked to stop while this folder was being read; nothing is
         * committed and the caller will discard the whole walk. */
        plan_free(&plan);
        trax_dir_listing_free(&listing);
        return true;
    }
    if (plan.tracks.count > 0) {
        if (plan.playable_seen > TRAX_TRACKS_PER_FOLDER_LIMIT) {
            /* One line, naming the folder and both numbers, as the manual
             * promises. */
            trax_log_printf(ctx->opt->log, TRAX_LOG_WARN,
                            "folder %s holds %u playable tracks; only the first "
                            "%u were indexed", path,
                            (unsigned)plan.playable_seen,
                            (unsigned)TRAX_TRACKS_PER_FOLDER_LIMIT);
        }
        if (plan.capped) ++ctx->work->folders_capped;
        bool ok = commit_plan(ctx, path, &plan);
        plan_free(&plan);
        if (!ok) {
            trax_dir_listing_free(&listing);
            return false;
        }
        if (cancelled(ctx)) {
            trax_dir_listing_free(&listing);
            return true;
        }
    } else {
        plan_free(&plan);
    }

    /* Sub-directories are album candidates of their own; recurse in name
     * order for a deterministic index. */
    for (size_t i = 0; i < listing.count; ++i) {
        if (listing.entries[i].kind != TRAX_ENTRY_DIR) continue;
        if (!trax_path_is_plain_name(listing.entries[i].name)) continue;
        if (is_cache_artifact(listing.entries[i].name)) continue;
        char *child = trax_path_join(path, listing.entries[i].name);
        if (!child) {
            trax_dir_listing_free(&listing);
            return false;
        }
        bool ok = walk_folder(ctx, child, listing.entries[i].name, depth + 1,
                              false);
        trax_free(child);
        if (!ok) {
            trax_dir_listing_free(&listing);
            return false;
        }
        if (cancelled(ctx)) {
            trax_dir_listing_free(&listing);
            return true;
        }
    }

    trax_dir_listing_free(&listing);
    if (is_top) {
        ++ctx->folders_done;
        emit_progress(ctx, NULL);
    }
    return true;
}

static uint64_t hash_listing(const char *folder, const trax_dir_entry *entries,
                             size_t count) {
    uint64_t h = trax_hash_fnv1a(folder, strlen(folder));
    for (size_t i = 0; i < count; ++i) {
        if (is_cache_artifact(entries[i].name)) continue;
        h = trax_hash_fnv1a_update(h, entries[i].name, strlen(entries[i].name) + 1);
        uint64_t kind = (uint64_t)entries[i].kind;
        h = trax_hash_fnv1a_update(h, &kind, sizeof(kind));
        h = trax_hash_fnv1a_update(h, &entries[i].size, sizeof(entries[i].size));
        h = trax_hash_fnv1a_update(h, &entries[i].mtime, sizeof(entries[i].mtime));
    }
    return h;
}

trax_status trax_scan_fingerprint(const trax_host *host, const char *music_folder,
                                  uint64_t *out) {
    if (!host || !host->list_dir || !music_folder || !out) return TRAX_ERR;
    trax_dir_listing listing;
    memset(&listing, 0, sizeof(listing));
    if (host->list_dir(host->user, music_folder, &listing) != TRAX_OK) {
        trax_dir_listing_free(&listing);
        return TRAX_ERR;
    }
    if (listing.count > 1) {
        qsort(listing.entries, listing.count, sizeof(trax_dir_entry),
              entry_name_cmp);
    }
    *out = hash_listing(music_folder, listing.entries, listing.count);
    trax_dir_listing_free(&listing);
    return TRAX_OK;
}

/* Count the top-level progress units: each directory is one, and loose
 * playable files at the root are one more (they form the root's own album). */
static uint32_t count_top_units(const trax_dir_entry *entries, size_t count) {
    uint32_t units = 0;
    bool loose = false;
    for (size_t i = 0; i < count; ++i) {
        if (is_cache_artifact(entries[i].name)) continue;
        if (entries[i].kind == TRAX_ENTRY_DIR) {
            ++units;
        } else if (entries[i].kind == TRAX_ENTRY_FILE &&
                   (trax_name_is_audio(entries[i].name) ||
                    trax_name_is_cue(entries[i].name))) {
            loose = true;
        }
    }
    if (loose) ++units;
    return units;
}

trax_status trax_scan_run(const trax_scan_options *options, trax_library *out) {
    if (!options || !out || !options->host || !options->host->list_dir ||
        !options->music_folder) {
        return TRAX_ERR;
    }
    trax_library_clear(out);

    trax_library work;
    memset(&work, 0, sizeof(work));
    work.valid = false;
    work.music_folder = trax_strdup(options->music_folder);
    if (!work.music_folder) return TRAX_ERR;

    scan_ctx ctx;
    memset(&ctx, 0, sizeof(ctx));
    ctx.opt = options;
    ctx.work = &work;

    uint64_t start_ms = options->host->now_ms ? options->host->now_ms(options->host->user) : 0;

    trax_dir_listing root;
    memset(&root, 0, sizeof(root));
    if (options->host->list_dir(options->host->user, options->music_folder,
                                &root) != TRAX_OK) {
        trax_log_printf(options->log, TRAX_LOG_ERROR,
                        "music folder %s could not be read; nothing indexed",
                        options->music_folder);
        trax_library_clear(&work);
        trax_dir_listing_free(&root);
        return TRAX_ERR;
    }
    if (root.count > 1) {
        qsort(root.entries, root.count, sizeof(trax_dir_entry), entry_name_cmp);
    }
    work.fingerprint = hash_listing(options->music_folder, root.entries, root.count);

    ctx.folders_total = count_top_units(root.entries, root.count);
    work.folders_total = ctx.folders_total;
    emit_progress(&ctx, NULL);
    if (cancelled(&ctx)) goto cancelled;

    /* Process the root's own loose files first (they form the root's album),
     * then each top-level folder in name order. */
    {
        bool has_loose = false;
        for (size_t i = 0; i < root.count; ++i) {
            if (is_cache_artifact(root.entries[i].name)) continue;
            if (root.entries[i].kind == TRAX_ENTRY_FILE &&
                (trax_name_is_audio(root.entries[i].name) ||
                 trax_name_is_cue(root.entries[i].name))) {
                has_loose = true;
                break;
            }
        }
        if (has_loose) {
            const char *root_title = trax_path_basename(options->music_folder);
            /* A root album with no name still needs something to show. */
            if (!root_title || !*root_title) root_title = "Music";
            scan_folder_plan plan;
            if (!plan_folder(&ctx, options->music_folder, root.entries,
                             root.count, root_title, &plan)) {
                goto failed;
            }
            if (cancelled(&ctx)) {
                plan_free(&plan);
                goto cancelled_root;
            }
            if (plan.tracks.count > 0) {
                if (plan.playable_seen > TRAX_TRACKS_PER_FOLDER_LIMIT) {
                    trax_log_printf(options->log, TRAX_LOG_WARN,
                                    "folder %s holds %u playable tracks; only "
                                    "the first %u were indexed",
                                    options->music_folder,
                                    (unsigned)plan.playable_seen,
                                    (unsigned)TRAX_TRACKS_PER_FOLDER_LIMIT);
                }
                if (plan.capped) ++work.folders_capped;
                if (!commit_plan(&ctx, options->music_folder, &plan)) {
                    plan_free(&plan);
                    goto failed;
                }
            }
            plan_free(&plan);
            ++ctx.folders_done;
            emit_progress(&ctx, NULL);
            if (cancelled(&ctx)) goto cancelled;
        }
    }

    for (size_t i = 0; i < root.count; ++i) {
        if (root.entries[i].kind != TRAX_ENTRY_DIR) continue;
        if (!trax_path_is_plain_name(root.entries[i].name)) continue;
        if (is_cache_artifact(root.entries[i].name)) continue;
        char *child = trax_path_join(options->music_folder, root.entries[i].name);
        if (!child) goto failed;
        bool ok = walk_folder(&ctx, child, root.entries[i].name, 1, true);
        trax_free(child);
        if (!ok) goto failed;
        if (cancelled(&ctx)) goto cancelled;
    }
    trax_dir_listing_free(&root);

    if (cancelled(&ctx)) goto cancelled_no_root;

    work.valid = true;
    work.folders_total = ctx.folders_total;
    work.built_ms = options->host->now_ms
                        ? options->host->now_ms(options->host->user) - start_ms
                        : 0;
    /* Hand the finished library to the caller. */
    trax_library_clear(out);
    *out = work;
    emit_progress(&ctx, NULL);
    return TRAX_OK;

cancelled_root:
    trax_dir_listing_free(&root);
    goto cancelled_no_root;
cancelled:
    trax_dir_listing_free(&root);
cancelled_no_root:
    trax_log_printf(options->log, TRAX_LOG_INFO,
                    "scan cancelled; nothing kept - the next entry reads the "
                    "card in full");
    trax_library_clear(&work);
    return TRAX_CANCELLED;

failed:
    trax_log_printf(options->log, TRAX_LOG_ERROR,
                    "scan failed while building the index; nothing kept");
    trax_dir_listing_free(&root);
    trax_library_clear(&work);
    return TRAX_ERR;
}
