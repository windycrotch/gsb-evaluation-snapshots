"""Qt-level tests for PlaylistPanel: view/model consistency and change notifications.

These exercise the real widget with the offscreen platform but never decode media.
Skipped automatically when PySide6 is unavailable (CI installs only pytest).
"""

import pytest

pytest.importorskip("PySide6")

from PySide6.QtWidgets import QApplication  # noqa: E402

from samovar_lite.playlist import DURATION_ROLE, PATH_ROLE, PlaylistPanel  # noqa: E402

app = QApplication.instance() or QApplication([])


@pytest.fixture
def panel():
    panel = PlaylistPanel()
    yield panel
    panel.shutdown()


def view_paths(panel):
    return [panel.view.item(i).data(PATH_ROLE) for i in range(panel.view.count())]


def make_files(tmp_path, names):
    return [str(tmp_path.joinpath(name).write_bytes(b"") or tmp_path / name) for name in names]


def test_set_items_builds_the_view_and_emits_once(panel, tmp_path, signal_spy):
    paths = make_files(tmp_path, ["a.mkv", "b.mkv"])
    with signal_spy(panel.changed) as spy:
        panel.set_items(paths)
    assert spy.count == 1
    assert view_paths(panel) == paths
    assert panel.paths() == paths
    assert panel.count() == 2
    assert panel.current_row() == -1


def test_sort_keeps_highlight_on_the_same_file_path(panel, tmp_path, signal_spy):
    paths = make_files(tmp_path, ["ep10.mkv", "ep2.mkv", "ep1.mkv"])
    panel.set_items(paths)
    panel.set_current(0)
    anchored = panel.path(0)
    with signal_spy(panel.changed) as spy:
        panel.sort_by("name")
    assert spy.count == 1
    assert panel.paths() == [paths[2], paths[1], paths[0]]
    assert panel.current_path() == anchored
    assert panel.current_row() == 2
    # the visible highlight item is the row the model considers current
    assert panel.current_item is panel.view.item(2)
    assert panel.current_item.data(PATH_ROLE) == anchored


def test_set_current_emits_one_notification_and_highlights(panel, tmp_path, signal_spy):
    paths = make_files(tmp_path, ["a.mkv", "b.mkv"])
    panel.set_items(paths)
    with signal_spy(panel.changed) as spy:
        panel.set_current(1)
    assert spy.count == 1
    assert panel.current_row() == 1
    assert panel.current_item is panel.view.item(1)
    # re-setting the same row is a no-op: no extra notification
    with signal_spy(panel.changed) as spy2:
        panel.set_current(1)
    assert spy2.count == 0


def test_remove_missing_reanchors_highlight_to_next_survivor(panel, tmp_path):
    keep = make_files(tmp_path, ["keep1.mkv", "keep2.mkv"])
    gone = [str(tmp_path / "gone1.mkv"), str(tmp_path / "gone2.mkv")]
    url = "https://example.org/stream.mp4"
    panel.set_items([keep[0], gone[0], url, gone[1], keep[1]])
    panel.set_current(3)
    panel._remove_missing()
    assert panel.paths() == [keep[0], url, keep[1]]
    assert view_paths(panel) == panel.paths()
    assert panel.current_path() == keep[1]
    assert panel.current_row() == 2
    assert panel.current_item is panel.view.item(2)


def test_remove_missing_urls_are_never_touched(panel, tmp_path):
    url = "https://example.org/a.mp4"
    panel.set_items([url])
    panel._remove_missing()
    assert panel.paths() == [url]
    assert panel.count() == 1


def test_remove_duplicates_keeps_first_position(panel, tmp_path):
    paths = make_files(tmp_path, ["a.mkv", "b.mkv", "c.mkv"])
    panel.set_items([paths[0], paths[1], paths[0], paths[2]])
    panel.set_current(2)
    panel._remove_duplicates()
    assert panel.paths() == [paths[0], paths[1], paths[2]]
    assert panel.current_path() == paths[2]
    assert panel.current_row() == 2


def test_all_duplicates_collapse_and_current_falls_back(panel, tmp_path):
    path = str(tmp_path / "same.mkv")
    tmp_path.joinpath("same.mkv").write_bytes(b"")
    panel.set_items([path, path, path])
    panel.set_current(2)
    panel._remove_duplicates()
    assert panel.paths() == [path]
    assert panel.current_path() == path
    assert panel.current_row() == 0


def test_remove_selected_deletes_current_with_survivor_rule(panel, tmp_path):
    paths = make_files(tmp_path, ["a.mkv", "b.mkv", "c.mkv"])
    panel.set_items(paths)
    panel.set_current(0)
    panel.view.item(0).setSelected(True)
    panel.remove_selected()
    assert panel.paths() == [paths[1], paths[2]]
    assert panel.current_path() == paths[1]
    assert panel.current_row() == 0


def test_clear_empties_view_model_and_current(panel, tmp_path):
    paths = make_files(tmp_path, ["a.mkv"])
    panel.set_items(paths)
    panel.set_current(0)
    panel.clear()
    assert panel.count() == 0
    assert panel.view.count() == 0
    assert panel.current_row() == -1
    assert panel.current_item is None


def test_empty_list_step_returns_minus_one(panel):
    panel.set_items([])
    assert panel.step(1, "all", False) == -1
    assert panel.step(-1, "all", True) == -1


def test_step_delegates_boundary_rules(panel, tmp_path):
    paths = make_files(tmp_path, ["a.mkv", "b.mkv"])
    panel.set_items(paths)
    panel.set_current(1)
    assert panel.step(1, "off", False) == -1
    assert panel.step(1, "one", False) == -1
    assert panel.step(1, "all", False) == 0
    panel.set_current(0)
    assert panel.step(-1, "all", False) == 1


def test_tidy_operations_keep_repeat_and_shuffle(panel, tmp_path):
    paths = make_files(tmp_path, ["b.mkv", "a.mkv"])
    panel.set_items(paths)
    panel.set_modes("all", True)
    panel.set_current(0)
    panel.sort_by("name")
    panel.sort_by("reverse")
    panel.sort_by("random")
    panel._remove_duplicates()
    panel._remove_missing()
    assert panel.model.repeat == "all"
    assert panel.model.shuffle is True


def test_randomize_keeps_current_path_and_permutes_rows(panel, tmp_path):
    paths = make_files(tmp_path, ["a.mkv", "b.mkv", "c.mkv", "d.mkv"])
    panel.set_items(paths)
    panel.set_current(1)
    anchored = panel.current_path()
    panel.sort_by("random")
    assert sorted(panel.paths()) == sorted(paths)
    assert panel.current_path() == anchored
    assert panel.path(panel.current_row()) == anchored


def test_view_drag_reorder_feeds_back_into_model(panel, tmp_path, signal_spy):
    paths = make_files(tmp_path, ["a.mkv", "b.mkv", "c.mkv"])
    panel.set_items(paths)
    panel.set_current(0)
    # simulate the view's internal move: rows reordered to c, a, b
    panel.view.clear()
    for path in [paths[2], paths[0], paths[1]]:
        panel.view.addItem(panel._make_item(path))
    with signal_spy(panel.changed) as spy:
        panel.on_view_reordered()
    assert spy.count == 1
    assert panel.paths() == [paths[2], paths[0], paths[1]]
    assert panel.current_path() == paths[0]
    assert panel.current_row() == 1


def test_duration_updates_model_and_row(panel, tmp_path):
    path = make_files(tmp_path, ["a.mkv"])[0]
    panel.set_items([path])
    panel.set_duration(path, 42.0)
    assert panel.model.duration(0) == 42.0
    assert panel.view.item(0).data(DURATION_ROLE) == 42.0
