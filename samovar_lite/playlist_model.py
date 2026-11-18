"""Pure playlist model: ordering, cleanup and the previous/next step rules.

Deliberately free of Qt so the rules are unit-testable without a display or the
media engine. Entries are identified by their *path*, never by their row:

* reordering (sort / reverse / shuffle) keeps the current entry anchored to the
  same file, or clears it when that file is no longer in the list;
* deletions re-anchor a removed current entry to the nearest survivor after its
  old position, then the nearest one before it, then no current entry;
* ``revision`` is bumped on every content/current change so views can emit a
  single change notification per operation.

Tidy operations never touch the repeat/shuffle settings.
"""

from __future__ import annotations

import os
import random

from .util import is_url, natural_key, title_of

SORT_KEYS = ("name", "path", "duration", "reverse", "random")
REPEAT_MODES = ("off", "one", "all")


class PlaylistModel:
    def __init__(self, rng=None):
        # Each entry is a (path, duration) tuple; duration is None until probed.
        self._entries: list[tuple[str, float | None]] = []
        self._current = -1
        self.revision = 0
        self.repeat = "off"
        self.shuffle = False
        self._rng = rng or random

    # -- read side -------------------------------------------------------------------------------
    def count(self) -> int:
        return len(self._entries)

    def entries(self) -> list[tuple[str, float | None]]:
        return list(self._entries)

    def paths(self) -> list[str]:
        return [path for path, _ in self._entries]

    def entry(self, row: int) -> tuple[str, float | None] | None:
        if 0 <= row < len(self._entries):
            return self._entries[row]
        return None

    def path(self, row: int) -> str | None:
        entry = self.entry(row)
        return entry[0] if entry is not None else None

    def duration(self, row: int) -> float | None:
        entry = self.entry(row)
        return entry[1] if entry is not None else None

    def current_row(self) -> int:
        return self._current

    def current_path(self) -> str | None:
        return self.path(self._current) if self._current >= 0 else None

    # -- write side ------------------------------------------------------------------------------
    def _bump(self):
        self.revision += 1

    def set_modes(self, repeat: str, shuffle: bool):
        if repeat not in REPEAT_MODES:
            raise ValueError("unknown repeat mode: %r" % (repeat,))
        self.repeat = repeat
        self.shuffle = bool(shuffle)

    def set_items(self, paths: list[str]):
        self._entries = [(path, None) for path in paths]
        self._current = -1
        self._bump()

    def add(self, paths: list[str]) -> int:
        """Append entries; return the row at which the new ones start."""
        first = len(self._entries)
        if paths:
            self._entries.extend((path, None) for path in paths)
            self._bump()
        return first

    def clear(self):
        if not self._entries and self._current < 0:
            return
        self._entries = []
        self._current = -1
        self._bump()

    def set_current(self, row: int):
        target = row if 0 <= row < len(self._entries) else -1
        if target != self._current:
            self._current = target
            self._bump()

    def set_duration(self, path: str, duration: float) -> bool:
        """Fill in a missing duration; the first probe for a path wins."""
        if not duration:
            return False
        changed = False
        for i, (entry_path, entry_duration) in enumerate(self._entries):
            if entry_path == path and not entry_duration:
                self._entries[i] = (entry_path, float(duration))
                changed = True
        if changed:
            self._bump()
        return changed

    def set_order(self, paths: list[str]):
        """Reorder entries to match the given paths (used by drag-and-drop moves)."""
        if len(paths) != len(self._entries):
            raise ValueError("set_order received %d paths for %d entries" % (len(paths), len(self._entries)))
        current_path = self.current_path()
        remaining: dict[str, list[tuple[str, float | None]]] = {}
        for entry in self._entries:
            remaining.setdefault(entry[0], []).append(entry)
        reordered: list[tuple[str, float | None]] = []
        for path in paths:
            bucket = remaining.get(path)
            if not bucket:
                raise ValueError("set_order path is not in the playlist: %r" % path)
            reordered.append(bucket.pop(0))
        self._entries = reordered
        self._current = self._row_of(current_path)
        self._bump()

    def sort(self, key: str, rng=None):
        """Reorder the entries. The current entry stays anchored to its path."""
        if key not in SORT_KEYS:
            raise ValueError("unknown sort key: %r" % (key,))
        anchored = self.current_path()
        rng = rng or self._rng
        if key == "name":
            self._entries.sort(key=lambda e: natural_key(title_of(e[0])))
        elif key == "path":
            self._entries.sort(key=lambda e: natural_key(e[0]))
        elif key == "duration":
            # Stable sort: unprobed entries (duration 0) keep their relative order.
            self._entries.sort(key=lambda e: e[1] or 0)
        elif key == "reverse":
            self._entries.reverse()
        else:  # "random"
            rng.shuffle(self._entries)
        self._current = self._row_of(anchored)
        self._bump()

    def remove_rows(self, rows) -> bool:
        """Delete the given rows, re-anchoring the current entry per the survivor rule."""
        removed = {row for row in rows if 0 <= row < len(self._entries)}
        if not removed:
            return False
        old_current = self._current
        survivors = [(old, entry) for old, entry in enumerate(self._entries) if old not in removed]
        if old_current in removed:
            # Prefer the nearest survivor that was after the old position...
            new_current = next(
                (new for new, (old, _) in enumerate(survivors) if old > old_current),
                None,
            )
            if new_current is None:
                # ...otherwise the nearest one before it, otherwise no current entry.
                before = [new for new, (old, _) in enumerate(survivors) if old < old_current]
                new_current = before[-1] if before else -1
        elif old_current >= 0:
            new_current = old_current - sum(1 for row in removed if row < old_current)
        else:
            new_current = -1
        self._entries = [entry for _, entry in survivors]
        self._current = new_current
        self._bump()
        return True

    def remove_missing(self, exists=os.path.exists) -> int:
        """Drop local files that no longer exist. URLs are never checked or removed."""
        rows = [row for row, (path, _) in enumerate(self._entries) if not is_url(path) and not exists(path)]
        self.remove_rows(rows)
        return len(rows)

    def remove_duplicates(self) -> int:
        """Deduplicate by path, keeping the first occurrence of each path."""
        seen: set[str] = set()
        duplicates = []
        for row, (path, _) in enumerate(self._entries):
            if path in seen:
                duplicates.append(row)
            else:
                seen.add(path)
        self.remove_rows(duplicates)
        return len(duplicates)

    def step(self, direction: int, repeat: str, shuffle: bool, rng=None) -> int:
        """Row to play for a previous/next request, or -1 when nothing should play.

        * empty list always returns -1;
        * with no current entry, next starts at the first row and previous at the last;
        * inside the list, the adjacent row in the requested direction is returned;
        * at a boundary, repeat="all" wraps around while "off"/"one" return -1;
        * shuffle picks any other row at random (the current row is excluded);
          a one-entry shuffled list only replays with repeat="all".
        """
        count = len(self._entries)
        if count == 0:
            return -1
        rng = rng or self._rng
        if shuffle:
            if count == 1:
                return 0 if repeat == "all" else -1
            choices = [row for row in range(count) if row != self._current]
            return rng.choice(choices)
        if self._current < 0:
            target = 0 if direction > 0 else count - 1
        else:
            target = self._current + direction
        if 0 <= target < count:
            return target
        if repeat == "all":
            return target % count
        return -1

    def _row_of(self, path: str | None) -> int:
        if path is None:
            return -1
        for row, (entry_path, _) in enumerate(self._entries):
            if entry_path == path:
                return row
        return -1
