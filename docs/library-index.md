# The shared library index

Both screens the player is opened for — the album wall and global shuffle —
begin by reading the whole card. This document describes the one index they
share, the rules the walk holds to, and how each rule is checked without a
device.

The implementation is portable C11. Nothing here opens an audio file: an
index is built from directory listings, names, sizes and times alone, which
is what makes a card of two thousand tracks readable in tens of milliseconds
on a desktop and in a couple of seconds on a PSP.

```
                    ┌──────────────────────────┐
   album wall ─────▶│  trax_index_acquire()    │
                    │  (one walk, one cache)   │◀───── global shuffle
                    └────────────┬─────────────┘
                                 │
                   ┌─────────────┴─────────────┐
                   ▼                           ▼
          trax_scan_run()            trax_index_cache_load()
          walk the card,             read <music>/.trax_index
          progress + cancel          checks folder + fingerprint
```

## Files

| File | Role |
|---|---|
| `src/core/trax_common.{h,c}` | allocation (with a live-block counter), paths, vectors, the cancel flag |
| `src/core/trax_platform.{h,c}` | the storage seam: list a folder, read/write a file, clock; extension rules |
| `src/core/trax_log.{h,c}` | the log TRAX keeps beside itself; retained in memory so failures are observable |
| `src/core/trax_cue.{h,c}` | `.cue` parsing: split counting, titles, data-track rejection, audio resolution |
| `src/core/trax_library.{h,c}` | the index model: folders, tracks, albums |
| `src/core/trax_scan.{h,c}` | the walk: per-folder plans, limits, cancellation, fingerprint |
| `src/core/trax_index_cache.{h,c}` | the on-card cache file, versioned and checksummed |
| `src/core/trax_index.{h,c}` | the shared entry point: cache hit, walk, claims, invalidation |
| `src/core/trax_gallery.{h,c}` | the album wall as a consumer of the index |
| `src/core/trax_shuffle.{h,c}` | global shuffle as a consumer of the index |
| `src/host/trax_host_posix.c` | desktop host (dirent/stat/stdio) plus fault injection for tests |
| `tests/` | the acceptance suite; `tools/trax_index_cli.c` is a manual check |

## What the walk guarantees

**Progress is per top-level folder.** `folders_total` is the number of
top-level folders plus one if the music folder itself holds loose audio
files (they form the root's own album). `folders_done` advances when a
top-level folder is finished — including one that had to be skipped, so the
count always reaches its total. `tracks_found` and `albums_found` are live.
Every progress callback is also a cancellation point.

**Cancelling keeps nothing.** A cancel raised from the UI thread (the
`trax_cancel_flag`) or by returning `false` from the progress callback
unwinds the walk, empties the working library, writes no cache entry, and
returns `TRAX_CANCELLED`. The suite compares the allocator's live-block
counter across a cancelled walk to prove it.

**A bad folder does not cost the card.** A folder whose listing fails is
logged by name, counted in `folders_skipped`, and skipped; the walk continues.
A cue sheet that cannot be read, or that names no audio in its folder, is
logged and its audio files are indexed as plain tracks — one bad sheet never
loses the album. A folder whose listing comes back truncated is logged and
indexed as far as it was read.

**A folder is capped at 1024.** `TRAX_TRACKS_PER_FOLDER_LIMIT` tracks are
kept, in name order (cue albums first, since an album is stored as a run of
the track array), and one log line names the folder and both numbers. A cue
sheet listing more than 1024 splits is capped by the same limit and logged
separately.

**A cue album contributes its splits.** A sheet's `AUDIO` tracks become rows;
the audio file named by `FILE` is not also a plain track. Ownership of an
audio file is claimed by the first valid sheet that names it, so two sheets
cannot double-count one file. A track type that is present and is not
`AUDIO` (a data track on a mixed-mode disc) is not counted. The sheet's
`FILE` line is resolved against the names the card actually returned — exact
bytes, then a path component, then the stem, then the folder's single audio
file — because a sheet written in Shift-JIS can never match a UTF-8 name.

**The cache is only a shortcut.** `<music folder>/.trax_index` records the
music folder, a fingerprint of the top-level listing (names, kinds, sizes,
mtimes), a version, a payload length and an FNV-1a checksum. It is read only
when the folder and fingerprint both match; anything else — another folder,
a changed card, a short read, a damaged byte, a future version — is a miss
and the card is walked. The cache file and its `.tmp` sibling are excluded
from the walk and the fingerprint, so writing the index never makes the card
look changed.

**Changing the music folder invalidates the old index.** `trax_index_acquire`
notices that the folder asked for differs from the last one served and calls
`trax_index_invalidate` itself, which deletes that folder's cache file and
drops the in-memory copy. `trax_index_invalidate()` is also exposed for the
Settings row, which knows the change before anyone re-enters. A cached index
for folder A is therefore never handed to folder B, even if the file is
copied across.

**The index is shared, not copied.** `trax_index_acquire` returns a pointer
and takes a reference; the gallery and the shuffle each hold one while they
use it. Closing the gallery does not force the shuffle to read the card
again. The index holds its own reference, so the in-memory copy survives
until `trax_index_destroy`, `trax_index_invalidate` or
`trax_index_drop_memory`.

## Global shuffle

* Builds a Fisher–Yates order of every track in the shared index: one
  `uint32_t` per track (40 KB for ten thousand tracks), which is what is
  released when playback stops.
* Plays the order once. The advance that hands out the last track ends the
  session, and that is where the list and the claim on the index are let go;
  it never wraps.
* `trax_shuffle_stop` logs how many tracks were released — "stopping playback
  ends it, and the list of tracks it built is let go of there and then".
* `trax_shuffle_remembers_between_launches()` always returns `false`, and is
  exposed so the settings code cannot persist the mode by accident.

## Acceptance coverage

`make test` builds and runs the suite; each case below is a test in
`tests/test_main.c`.

| Requirement | Test |
|---|---|
| first scan's progress counts are correct | `scan progress counts folders and tracks` |
| a folder named like the cache is not mistaken for it | `a folder named like the cache` |
| cancel leaves nothing, the next entry scans again | `cancel leaves nothing and the next entry scans again` |
| the UI thread's cancel flag works | `the cancel flag stops a walk that is under way` |
| second entry hits the cache | `second visit is answered from the cache` |
| gallery and shuffle share one walk | `the gallery and global shuffle share one index`; `a shuffle after the gallery closes reuses the shared index` |
| a bad folder is skipped and logged, the walk continues | `an unreadable folder is skipped and logged` |
| a bad folder nested in an album loses neither the album nor its siblings | `a bad folder nested in an album is skipped without losing the album` |
| an unreadable sheet keeps its audio | `an unreadable cue sheet falls back to its audio file` |
| an over-limit folder keeps the first 1024 and logs it | `a folder over 1024 tracks is capped and logged` |
| cue albums count splits, not the long file | `a cue album counts its splits, not its audio file` |
| data tracks are not counted | `a cue sheet's data track is not counted` |
| a Shift-JIS sheet still finds its audio | `a cue sheet naming another encoding still resolves its audio` |
| an over-limit sheet is capped | `a cue sheet over 1024 tracks is capped and logged` |
| a folder change invalidates the old index | `switching the music folder drops the old index and its cache` |
| a cache for another folder is never used | `a cache describing another folder is a miss` |
| shuffle plays once then stops | `global shuffle plays the card through once and stops` |
| the order really is random | `global shuffle order depends on the random source` |
| stopping releases the built list | `stopping a global shuffle releases its list`; `a finished global shuffle releases its list` |
| shuffle is not remembered, and writes nothing across a launch | `global shuffle plays the card through once and stops`; `global shuffle writes nothing to carry across a launch` |
| a damaged cache is a miss | `a damaged cache is ignored and the card is read` |
| adding an album makes the cache stale | `adding an album makes the cache stale` |
| cue parsing units | `cue parser keeps titles, numbers and skips data tracks` |
| cue + plain files in one folder | `a cue split and a plain file in one folder are both counted` |
| path normalization (device prefixes, separators, stems) | `path normalization keeps device prefixes and one leading slash` |

The suite runs the whole thing against real directories under the system
temporary folder and asserts, at the end, that the allocator's live-block
counter is zero: every fixture, every library and every log line is gone.

## Limits worth knowing

* The fingerprint is the *top level* of the music folder. Adding or removing
  an album is always noticed; adding a track inside an existing album folder
  is noticed because the folder's mtime and size are part of that top-level
  entry, but only at the filesystem's timestamp resolution (one second on
  FAT and on the PSP's card filesystem). A file added in the same second the
  index was built can therefore be missed until the next invalidation.
* `TRAX_SCAN_MAX_DEPTH` (64) bounds recursion; a deeper tree is logged and
  skipped rather than allowed to run away on a cyclic card.
* The cache is written beside the music folder. On a read-only card the
  write fails, is logged, and the player simply walks the card again next
  time.
