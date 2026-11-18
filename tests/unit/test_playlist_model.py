"""Tests for the Qt-free playlist rules: reordering, cleanup and step semantics.

All paths point at files created inside pytest's tmp_path; no media decoding and
no Qt widgets are involved.
"""

import os

import pytest

from samovar_lite.playlist_model import PlaylistModel


class FakeRng:
    """Deterministic stand-in for the random module (only what the model uses)."""

    def __init__(self, picks=()):
        self._picks = list(picks)
        self._i = 0
        self.shuffled = None

    def shuffle(self, items):
        self.shuffled = list(items)
        items.reverse()

    def choice(self, items):
        value = self._picks[min(self._i, len(self._picks) - 1)]
        self._i += 1
        return items[value]


def make_files(tmp_path, names):
    paths = []
    for name in names:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"")
        paths.append(str(path))
    return paths


# -- reordering keeps the current entry on the same file -----------------------------------------
def test_sort_by_name_moves_current_anchor_to_the_new_row(tmp_path):
    paths = make_files(tmp_path, ["ep10.mkv", "ep2.mkv", "ep1.mkv"])
    model = PlaylistModel()
    model.set_items(paths)
    model.set_current(0)
    current = model.current_path()

    model.sort("name")

    assert model.paths() == [paths[2], paths[1], paths[0]]
    assert model.current_path() == current
    assert model.current_row() == 2


def test_sort_by_path_and_duration_keep_anchor(tmp_path):
    paths = make_files(tmp_path, ["z/ep.mkv", "a/ep.mkv", "m/ep.mkv"])
    model = PlaylistModel()
    model.set_items(paths)
    model.set_current(2)
    anchored = model.current_path()
    model.sort("path")
    assert model.paths() == [paths[1], paths[2], paths[0]]
    assert model.current_path() == anchored
    assert model.current_row() == 1

    model.set_duration(paths[1], 30)
    model.set_duration(paths[2], 10)
    model.set_duration(paths[0], 20)
    model.sort("duration")
    assert model.paths() == [paths[2], paths[0], paths[1]]
    assert model.current_path() == anchored
    assert model.current_row() == 0


def test_reverse_keeps_anchor(tmp_path):
    paths = make_files(tmp_path, ["a.mkv", "b.mkv", "c.mkv"])
    model = PlaylistModel()
    model.set_items(paths)
    model.set_current(0)
    anchored = model.current_path()
    model.sort("reverse")
    assert model.paths() == list(reversed(paths))
    assert model.current_path() == anchored
    assert model.current_row() == 2


def test_randomize_keeps_anchor_and_uses_injected_rng(tmp_path):
    paths = make_files(tmp_path, ["a.mkv", "b.mkv", "c.mkv", "d.mkv"])
    model = PlaylistModel(FakeRng())
    model.set_items(paths)
    model.set_current(1)
    anchored = model.current_path()
    model.sort("random")
    assert sorted(model.paths()) == sorted(paths)
    assert model.current_path() == anchored
    assert model.paths()[model.current_row()] == anchored


def test_reordering_without_current_stays_without_current(tmp_path):
    paths = make_files(tmp_path, ["b.mkv", "a.mkv"])
    model = PlaylistModel()
    model.set_items(paths)
    assert model.current_row() == -1
    model.sort("name")
    assert model.current_row() == -1
    assert model.current_path() is None
    model.sort("reverse")
    assert model.current_row() == -1


def test_set_order_from_drag_and_drop_keeps_anchor(tmp_path):
    paths = make_files(tmp_path, ["a.mkv", "b.mkv", "c.mkv"])
    model = PlaylistModel()
    model.set_items(paths)
    model.set_current(0)
    model.set_order([paths[2], paths[0], paths[1]])
    assert model.paths() == [paths[2], paths[0], paths[1]]
    assert model.current_path() == paths[0]
    assert model.current_row() == 1


# -- remove missing files ------------------------------------------------------------------------
def test_remove_missing_deletes_only_gone_local_files_and_keeps_urls(tmp_path):
    existing = make_files(tmp_path, ["keep1.mkv", "keep2.mkv"])
    gone = [str(tmp_path / "gone1.mkv"), str(tmp_path / "gone2.mkv")]
    url = "https://example.org/stream.mp4"
    model = PlaylistModel()
    model.set_items([existing[0], gone[0], url, gone[1], existing[1]])
    model.set_current(3)  # playing gone2.mkv

    removed = model.remove_missing()

    assert removed == 2
    assert model.paths() == [existing[0], url, existing[1]]
    # nearest survivor after the old position is keep2.mkv (old index 4 -> new index 2)
    assert model.current_path() == existing[1]
    assert model.current_row() == 2


def test_remove_missing_falls_back_to_survivor_before_when_none_after(tmp_path):
    keep = make_files(tmp_path, ["a.mkv", "b.mkv"])
    gone = str(tmp_path / "gone.mkv")
    model = PlaylistModel()
    model.set_items([keep[0], keep[1], gone])
    model.set_current(2)

    model.remove_missing()

    assert model.paths() == keep
    assert model.current_path() == keep[1]
    assert model.current_row() == 1


def test_remove_missing_keeps_current_when_another_file_is_removed(tmp_path):
    keep = make_files(tmp_path, ["a.mkv", "b.mkv"])
    gone = str(tmp_path / "gone.mkv")
    model = PlaylistModel()
    model.set_items([gone, keep[0], keep[1]])
    model.set_current(2)
    model.remove_missing()
    assert model.paths() == keep
    assert model.current_path() == keep[1]
    assert model.current_row() == 1


def test_remove_missing_all_local_files_gone_reanchors_to_surviving_url(tmp_path):
    gone = [str(tmp_path / "g1.mkv"), str(tmp_path / "g2.mkv")]
    url = "https://example.org/stream.mp4"
    model = PlaylistModel()
    model.set_items([gone[0], gone[1], url])
    model.set_current(1)
    model.remove_missing()
    assert model.paths() == [url]
    # the URL is the nearest survivor after the old current position
    assert model.current_path() == url
    assert model.current_row() == 0


def test_remove_missing_everything_goes_clears_current(tmp_path):
    gone = [str(tmp_path / "g1.mkv"), str(tmp_path / "g2.mkv")]
    model = PlaylistModel()
    model.set_items(gone)
    model.set_current(0)
    model.remove_missing()
    assert model.count() == 0
    assert model.current_row() == -1
    assert model.current_path() is None


def test_remove_missing_on_empty_list_is_a_noop():
    model = PlaylistModel()
    assert model.remove_missing() == 0
    assert model.count() == 0
    assert model.current_row() == -1


# -- remove duplicates ---------------------------------------------------------------------------
def test_remove_duplicates_keeps_first_occurrence(tmp_path):
    paths = make_files(tmp_path, ["a.mkv", "b.mkv", "c.mkv"])
    model = PlaylistModel()
    model.set_items([paths[0], paths[1], paths[0], paths[2], paths[1]])
    model.set_current(2)  # the duplicate a.mkv, which gets deleted

    removed = model.remove_duplicates()

    assert removed == 2
    assert model.paths() == [paths[0], paths[1], paths[2]]
    # nearest survivor after old index 2 is c.mkv (old index 3 -> new index 2)
    assert model.current_path() == paths[2]
    assert model.current_row() == 2


def test_all_duplicates_collapse_to_one_and_current_survives(tmp_path):
    path = str(tmp_path / "same.mkv")
    tmp_path.joinpath("same.mkv").write_bytes(b"")
    model = PlaylistModel()
    model.set_items([path, path, path, path])
    model.set_current(3)
    removed = model.remove_duplicates()
    assert removed == 3
    assert model.paths() == [path]
    # the kept first occurrence is before the old position, so it becomes the current entry
    assert model.current_path() == path
    assert model.current_row() == 0


def test_all_duplicates_without_current_ends_empty_of_dupes(tmp_path):
    path = str(tmp_path / "x.mkv")
    tmp_path.joinpath("x.mkv").write_bytes(b"")
    model = PlaylistModel()
    model.set_items([path, path])
    model.remove_duplicates()
    assert model.paths() == [path]
    assert model.current_row() == -1


def test_remove_duplicates_is_path_based_not_title_based(tmp_path):
    p1 = str(tmp_path / "dir1" / "name.mkv")
    p2 = str(tmp_path / "dir2" / "name.mkv")
    os.makedirs(os.path.dirname(p1), exist_ok=True)
    os.makedirs(os.path.dirname(p2), exist_ok=True)
    open(p1, "wb").close()
    open(p2, "wb").close()
    model = PlaylistModel()
    model.set_items([p1, p2])
    assert model.remove_duplicates() == 0
    assert model.paths() == [p1, p2]


# -- generic removal edge cases ------------------------------------------------------------------
def test_remove_rows_reanchors_before_when_current_was_last(tmp_path):
    paths = make_files(tmp_path, ["a.mkv", "b.mkv", "c.mkv", "d.mkv"])
    model = PlaylistModel()
    model.set_items(paths)
    model.set_current(3)
    model.remove_rows([3])
    assert model.current_path() == paths[2]
    assert model.current_row() == 2


def test_remove_rows_prefers_nearest_after_even_if_closer_before(tmp_path):
    paths = make_files(tmp_path, ["a.mkv", "b.mkv", "c.mkv", "d.mkv", "e.mkv"])
    model = PlaylistModel()
    model.set_items(paths)
    model.set_current(2)  # c.mkv removed; b is one before, d is one after
    model.remove_rows([2])
    assert model.current_path() == paths[3]


def test_remove_current_when_everything_goes_clears_current(tmp_path):
    paths = make_files(tmp_path, ["a.mkv", "b.mkv"])
    model = PlaylistModel()
    model.set_items(paths)
    model.set_current(1)
    model.remove_rows([0, 1])
    assert model.count() == 0
    assert model.current_row() == -1
    assert model.current_path() is None


def test_remove_rows_without_current_just_shrinks(tmp_path):
    paths = make_files(tmp_path, ["a.mkv", "b.mkv", "c.mkv"])
    model = PlaylistModel()
    model.set_items(paths)
    assert model.remove_rows([0, 2]) is True
    assert model.paths() == [paths[1]]
    assert model.current_row() == -1


# -- step semantics ------------------------------------------------------------------------------
def test_step_empty_list_returns_empty():
    model = PlaylistModel()
    for direction in (-1, 1):
        for repeat in ("off", "one", "all"):
            assert model.step(direction, repeat, False) == -1
            assert model.step(direction, repeat, True) == -1


def test_step_next_and_prev_inside_the_list(tmp_path):
    paths = make_files(tmp_path, ["a.mkv", "b.mkv", "c.mkv"])
    model = PlaylistModel()
    model.set_items(paths)
    model.set_current(1)
    assert model.step(1, "off", False) == 2
    assert model.step(-1, "off", False) == 0


def test_step_boundaries_off_and_one_stop(tmp_path):
    paths = make_files(tmp_path, ["a.mkv", "b.mkv"])
    model = PlaylistModel()
    model.set_items(paths)
    model.set_current(0)
    for repeat in ("off", "one"):
        assert model.step(-1, repeat, False) == -1
    model.set_current(1)
    for repeat in ("off", "one"):
        assert model.step(1, repeat, False) == -1


def test_step_boundary_repeat_all_wraps_both_directions(tmp_path):
    paths = make_files(tmp_path, ["a.mkv", "b.mkv", "c.mkv"])
    model = PlaylistModel()
    model.set_items(paths)
    model.set_current(0)
    assert model.step(-1, "all", False) == 2
    model.set_current(2)
    assert model.step(1, "all", False) == 0


def test_step_without_current_starts_at_ends(tmp_path):
    paths = make_files(tmp_path, ["a.mkv", "b.mkv"])
    model = PlaylistModel()
    model.set_items(paths)
    assert model.step(1, "off", False) == 0
    assert model.step(-1, "off", False) == 1


def test_step_shuffle_picks_another_row_and_never_the_current(tmp_path):
    paths = make_files(tmp_path, ["a.mkv", "b.mkv", "c.mkv", "d.mkv"])
    rng = FakeRng(picks=(0,))  # always the first *eligible* choice
    model = PlaylistModel(rng)
    model.set_items(paths)
    model.set_current(0)
    assert model.step(1, "off", True) == 1
    model.set_current(2)
    for _ in range(10):
        assert model.step(1, "all", True) != 2


def test_step_shuffle_single_item(tmp_path):
    path = make_files(tmp_path, ["only.mkv"])[0]
    model = PlaylistModel()
    model.set_items([path])
    model.set_current(0)
    assert model.step(1, "off", True) == -1
    assert model.step(1, "one", True) == -1
    assert model.step(1, "all", True) == 0


# -- change notifications and mode preservation ---------------------------------------------------
def test_every_content_or_current_change_bumps_revision(tmp_path):
    paths = make_files(tmp_path, ["b.mkv", "a.mkv", "c.mkv"])
    model = PlaylistModel()
    assert model.revision == 0
    model.set_items(paths)
    assert model.revision == 1
    model.set_current(1)
    assert model.revision == 2
    model.sort("name")
    assert model.revision == 3
    model.sort("reverse")
    assert model.revision == 4
    model.add([str(tmp_path / "d.mkv")])
    assert model.revision == 5
    model.remove_rows([0])
    assert model.revision == 6
    model.clear()
    assert model.revision == 7


def test_noop_operations_do_not_bump_revision(tmp_path):
    paths = make_files(tmp_path, ["a.mkv"])
    model = PlaylistModel()
    model.set_items(paths)
    model.set_current(0)
    before = model.revision
    model.set_current(0)  # same row
    model.add([])
    model.remove_rows([99])  # nothing matches
    model.remove_missing()  # the file exists
    model.remove_duplicates()  # no duplicates
    assert model.revision == before


def test_tidy_operations_preserve_repeat_and_shuffle(tmp_path):
    paths = make_files(tmp_path, ["b.mkv", "a.mkv"])
    model = PlaylistModel()
    model.set_items(paths)
    model.set_modes("all", True)
    model.set_current(0)
    model.sort("name")
    model.sort("reverse")
    model.sort("random")
    model.remove_duplicates()
    model.remove_missing()
    assert model.repeat == "all"
    assert model.shuffle is True


def test_set_modes_rejects_unknown_repeat():
    model = PlaylistModel()
    with pytest.raises(ValueError):
        model.set_modes("sometimes", False)


def test_set_duration_keeps_first_probe_and_ignores_zero(tmp_path):
    path = make_files(tmp_path, ["a.mkv"])[0]
    model = PlaylistModel()
    model.set_items([path])
    assert model.set_duration(path, 12.5) is True
    assert model.duration(0) == 12.5
    assert model.set_duration(path, 99.0) is False  # first probe wins
    assert model.duration(0) == 12.5
    assert model.set_duration(path, 0) is False
