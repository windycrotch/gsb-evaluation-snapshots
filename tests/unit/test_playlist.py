"""Playlist panel: import -> probe -> sort -> remove -> shutdown stays consistent.

The prober thread is replaced with a synchronous fake, so test callbacks run on the
test thread and `_set_duration` is invoked directly (same-thread signal connection).
"""

import os
import queue
import time

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest
from PySide6.QtWidgets import QApplication

from samovar_lite import playlist as playlist_mod
from samovar_lite.playlist import DURATION_ROLE, PlaylistPanel

PATHS = ["/music/alpha.mp3", "/music/beta.mp3", "/music/gamma.mp3"]


class FakeProber:
    """Stands in for _DurationProber: records jobs, delivers results on demand."""

    def __init__(self, callback):
        self.callback = callback
        self.ffprobe = "ffprobe"  # pretend ffprobe exists so jobs get queued
        self.jobs = queue.Queue()
        self.stopped = False

    def start(self):
        pass

    def is_alive(self):
        return False

    def stop(self, timeout=5.0):
        self.stopped = True

    def take_jobs(self):
        jobs = []
        while True:
            try:
                jobs.append(self.jobs.get_nowait())
            except queue.Empty:
                return jobs

    def deliver(self, token, path, duration):
        self.callback(token, path, duration)


@pytest.fixture(scope="module")
def qapp():
    app = QApplication.instance() or QApplication([])
    yield app


@pytest.fixture()
def panel(qapp, monkeypatch):
    monkeypatch.setattr(playlist_mod, "_DurationProber", FakeProber)
    widget = PlaylistPanel()
    yield widget
    widget.shutdown()
    widget.deleteLater()


def durations(panel):
    return [panel.view.item(i).data(DURATION_ROLE) for i in range(panel.count())]


def test_batch_add_shows_all_items_immediately(panel):
    first = panel.add(PATHS)
    assert first == 0
    assert panel.count() == 3
    assert panel.paths() == PATHS
    assert not any(durations(panel))  # durations only arrive later, row by row
    assert [path for _, path in panel._prober.take_jobs()] == PATHS


def test_probe_results_fill_rows_one_by_one(panel):
    panel.add(PATHS)
    jobs = panel._prober.take_jobs()
    panel._prober.deliver(jobs[1][0], jobs[1][1], 95.0)
    assert durations(panel) == [None, 95.0, None]
    panel._prober.deliver(jobs[0][0], jobs[0][1], 61.0)
    panel._prober.deliver(jobs[2][0], jobs[2][1], 12.0)
    assert durations(panel) == [61.0, 95.0, 12.0]


def test_duplicate_paths_each_row_gets_its_own_duration(panel):
    panel.add(["/music/a.mp3", "/music/b.mp3", "/music/a.mp3"])
    jobs = panel._prober.take_jobs()
    assert len(jobs) == 3
    assert jobs[0][0] != jobs[2][0]  # same path, distinct probe tokens
    panel._prober.deliver(jobs[0][0], jobs[0][1], 30.0)
    assert durations(panel) == [30.0, None, None]  # not splattered onto the other "a.mp3" row
    panel._prober.deliver(jobs[2][0], jobs[2][1], 30.0)
    assert durations(panel) == [30.0, None, 30.0]


@pytest.mark.parametrize("key", ["name", "path", "duration", "reverse", "random"])
def test_sort_keeps_current_item_and_durations(panel, key):
    panel.add(PATHS)
    known = dict(zip(PATHS, [61.0, 95.0, 12.0], strict=True))
    for token, path in panel._prober.take_jobs():
        panel._prober.deliver(token, path, known[path])
    panel.set_current(1)
    panel.sort_by(key)
    assert panel.path(panel.current_row()) == PATHS[1]
    for i in range(panel.count()):
        assert panel.view.item(i).data(DURATION_ROLE) == known[panel.path(i)]


def test_pending_probe_result_survives_a_sort(panel):
    panel.add(PATHS)
    jobs = panel._prober.take_jobs()
    panel.sort_by("name")
    token, path = jobs[0]
    panel._prober.deliver(token, path, 42.0)
    row = panel.paths().index(path)
    assert panel.view.item(row).data(DURATION_ROLE) == 42.0


def test_late_result_after_remove_is_dropped(panel):
    panel.add(PATHS)
    jobs = panel._prober.take_jobs()
    panel.view.item(0).setSelected(True)
    panel.remove_selected()
    assert panel.paths() == PATHS[1:]
    panel._prober.deliver(jobs[0][0], jobs[0][1], 10.0)  # belongs to the removed row
    assert not any(durations(panel))
    panel._prober.deliver(jobs[1][0], jobs[1][1], 20.0)  # survivors still get theirs
    assert durations(panel) == [20.0, None]


def test_late_result_does_not_land_on_a_new_row_with_the_same_path(panel):
    panel.add(["/music/a.mp3"])
    (old_job,) = panel._prober.take_jobs()
    panel.clear()
    panel.add(["/music/a.mp3"])
    (new_job,) = panel._prober.take_jobs()
    assert new_job[0] != old_job[0]
    panel._prober.deliver(old_job[0], old_job[1], 30.0)  # stale: from before the clear
    assert durations(panel) == [None]
    panel._prober.deliver(new_job[0], new_job[1], 30.0)  # the re-import's own probe
    assert durations(panel) == [30.0]


def test_clear_then_reimport_refills_durations(panel):
    panel.add(PATHS)
    old_jobs = panel._prober.take_jobs()
    panel.clear()
    assert panel.count() == 0
    panel.add(PATHS)
    new_jobs = panel._prober.take_jobs()
    assert len(new_jobs) == 3
    for token, path in old_jobs:  # everything queued before the clear is stale now
        panel._prober.deliver(token, path, 99.0)
    assert not any(durations(panel))
    for token, path in new_jobs:
        panel._prober.deliver(token, path, 99.0)
    assert durations(panel) == [99.0, 99.0, 99.0]


def test_remove_duplicates_keeps_the_survivors_probe(panel):
    panel.add(["/music/a.mp3", "/music/a.mp3", "/music/b.mp3"])
    jobs = panel._prober.take_jobs()
    panel._remove_duplicates()
    assert panel.paths() == ["/music/a.mp3", "/music/b.mp3"]
    panel._prober.deliver(jobs[1][0], jobs[1][1], 5.0)  # the removed duplicate's job
    assert durations(panel) == [None, None]
    panel._prober.deliver(jobs[0][0], jobs[0][1], 7.0)  # the surviving row's job
    assert durations(panel) == [7.0, None]


def test_remove_missing_keeps_the_survivors_probe(panel, tmp_path):
    real = tmp_path / "real.mp3"
    real.write_bytes(b"x")
    panel.add([str(real), "/music/gone.mp3"])
    jobs = panel._prober.take_jobs()
    panel._remove_missing()
    assert panel.paths() == [str(real)]
    panel._prober.deliver(jobs[1][0], jobs[1][1], 5.0)  # removed row's job
    assert durations(panel) == [None]
    panel._prober.deliver(jobs[0][0], jobs[0][1], 8.0)
    assert durations(panel) == [8.0]


def test_engine_reported_duration_fills_every_matching_row(panel):
    panel.add(["/music/a.mp3", "/music/a.mp3"])
    panel._prober.take_jobs()
    panel.set_duration("/music/a.mp3", 44.0)
    assert durations(panel) == [44.0, 44.0]


def test_shutdown_stops_the_prober_and_blocks_late_results(panel):
    panel.add(PATHS)
    jobs = panel._prober.take_jobs()
    panel.shutdown()
    assert panel._prober.stopped
    for token, path in jobs:
        panel._prober.deliver(token, path, 10.0)
    assert not any(durations(panel))


class _FakePopen:
    """Instant ffprobe: reports a fixed duration."""

    instances = []

    def __init__(self, cmd, **kwargs):
        self.cmd = cmd
        self.killed = False
        _FakePopen.instances.append(self)

    def communicate(self, timeout=None):
        return ("12.5\n", "")

    def poll(self):
        return 0

    def kill(self):
        self.killed = True


class _SlowPopen:
    """An ffprobe that never answers until it is killed."""

    instances = []

    def __init__(self, cmd, **kwargs):
        self.killed = False
        _SlowPopen.instances.append(self)

    def communicate(self, timeout=None):
        while not self.killed:
            time.sleep(0.01)
        return ("", "")

    def poll(self):
        return None if not self.killed else 1

    def kill(self):
        self.killed = True


def test_prober_thread_delivers_and_stops(monkeypatch):
    monkeypatch.setattr(playlist_mod.shutil, "which", lambda name: "/usr/bin/ffprobe")
    monkeypatch.setattr(playlist_mod.subprocess, "Popen", _FakePopen)
    results = []
    prober = playlist_mod._DurationProber(lambda *args: results.append(args))
    prober.start()
    prober.jobs.put((1, "/music/a.mp3"))
    deadline = time.monotonic() + 5
    while not results and time.monotonic() < deadline:
        time.sleep(0.01)
    prober.stop()
    assert results == [(1, "/music/a.mp3", 12.5)]
    assert not prober.is_alive()


def test_prober_stop_interrupts_a_probe_in_flight(monkeypatch):
    monkeypatch.setattr(playlist_mod.shutil, "which", lambda name: "/usr/bin/ffprobe")
    monkeypatch.setattr(playlist_mod.subprocess, "Popen", _SlowPopen)
    prober = playlist_mod._DurationProber(lambda *args: None)
    prober.start()
    prober.jobs.put((1, "/music/a.mp3"))
    deadline = time.monotonic() + 5
    while not _SlowPopen.instances and time.monotonic() < deadline:
        time.sleep(0.01)
    started = time.monotonic()
    prober.stop()
    assert time.monotonic() - started < 4
    assert not prober.is_alive()


def test_panel_shutdown_joins_the_prober_thread(qapp, monkeypatch):
    monkeypatch.setattr(playlist_mod.shutil, "which", lambda name: "/usr/bin/ffprobe")
    monkeypatch.setattr(playlist_mod.subprocess, "Popen", _SlowPopen)
    widget = PlaylistPanel()
    widget.add(PATHS)
    assert widget._prober.is_alive()
    widget.shutdown()
    assert not widget._prober.is_alive()
    widget.deleteLater()
