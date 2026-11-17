# Building and testing the library index

The repository carries TRAX's documentation. The shared library index that
stands behind the album gallery and global shuffle is implemented here as
portable C11, with a desktop host so the whole walk can be exercised without a
device.

```sh
make            # build the test runner and the manual check
make test       # run the acceptance suite
```

The suite builds sample cards under the system temporary folder. It covers:

- the progress counts of a first scan;
- cancellation leaving nothing behind, and the next entry reading the card again;
- a second entry answered from the cache;
- the gallery and global shuffle sharing one walk;
- unreadable folders, and cue sheets, skipped and logged rather than aborting;
- folders and cue sheets over 1024 tracks capped and logged;
- cue albums counting their splits rather than their long audio file;
- a music-folder change making the old index unusable;
- global shuffle playing the card once, stopping, and releasing its list.

A manual check against any folder of music:

```sh
build/trax_index_cli path/to/MUSIC --shuffle
build/trax_index_cli path/to/MUSIC --cancel-after 3
```

The rules the walk holds to, and the file map, are in
[docs/library-index.md](docs/library-index.md).
