"""Coordination between the background planner, the playlists and the wall.

These tests never load libmpv: the prober and the video tiles are replaced by
lightweight Qt fakes, and the planner is either the real pure-Python
``scheduler.plan`` or a scripted stub that blocks until the test releases it.

Run them (no libmpv required) with::

    QT_QPA_PLATFORM=offscreen python -m pytest tests/test_scheduling.py
"""

from __future__ import annotations

import os
import threading
import time

import pytest
from PySide6.QtCore import QObject, QRect, QTimer, Signal
from PySide6.QtWidgets import QApplication

from polyreel import app as appmod
from polyreel.playlist import Item, Playlists
from polyreel.probe import NOT_VIDEO
from polyreel.scheduler import Plan
from polyreel.settings import Settings


# --------------------------------------------------------------------- fakes
class FakeTile(QObject):
    """Stands in for VideoTile: no native window and no libmpv player."""

    double_clicked = Signal(object)
    right_clicked = Signal(object)
    finished = Signal(object, object)
    failed = Signal(object, object, str)
    shape_changed = Signal(object, float)

    def __init__(self, stage, hwdec=None) -> None:
        super().__init__()
        self.item: Item | None = None
        self.num = id(self) & 0xFFFF
        self.user_muted = False
        self.keep_sound = False
        self.zoom = 1.0
        self.paused = False
        self._muted = True
        self._rect = QRect(0, 0, 1, 1)
        self.load_started = 0.0
        self.stops = 0
        self.loads = 0

    # -- the surface MainWindow uses ------------------------------------
    def load(self, item, start: float = 0.0, loop: bool = False, hwdec=None) -> None:
        self.item = item
        self.loads += 1
        self.load_started = time.monotonic()

    def stop(self) -> None:
        self.item = None
        self.stops += 1

    def set_muted(self, muted: bool) -> None:
        self._muted = muted

    def set_paused(self, paused: bool) -> None:
        self.paused = paused

    def set_volume(self, volume: int) -> None:
        pass

    def set_zoom(self, zoom: float) -> None:
        self.zoom = zoom

    def move_to(self, rect, animate: bool) -> None:
        self._rect = QRect(rect)

    def geometry(self) -> QRect:
        return self._rect

    def isVisible(self) -> bool:
        return False

    def show(self) -> None:
        pass

    def hide(self) -> None:
        pass

    def raise_(self) -> None:
        pass

    def poll(self) -> None:
        pass

    def sample(self):
        return None

    def position(self) -> float:
        return 0.0

    def duration(self) -> float:
        return 0.0

    def volume(self) -> int:
        return 100

    def is_stopped(self) -> bool:
        return True

    def retire(self) -> None:
        pass

    def shutdown(self, wait: float = 2.0) -> None:
        pass

    @property
    def is_playing(self) -> bool:
        # A fake file "loads" immediately; keeps the _loading pruning honest.
        return self.item is not None

    @property
    def is_ready(self) -> bool:
        return True


class FakeProber(QObject):
    probed = Signal(int, object, object, object)

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.submitted: list[tuple] = []

    def submit(self, item_id: int, path: str) -> None:
        self.submitted.append((item_id, path))

    def close(self) -> None:
        pass


class BlockPlanner:
    """Planner stand-in that blocks on a gate, so a plan can be held
    in-flight while the test changes the world underneath it.

    Once the gate opens it delegates to the real pure-Python planner, so the
    follow-up computation is genuine; every call (and worker thread) is
    recorded for the single-flight assertions."""

    def __init__(self, real_plan) -> None:
        self.gate = threading.Event()
        self.calls: list[tuple] = []
        self.threads: set[int] = set()
        self._real = real_plan
        self._lock = threading.Lock()

    def __call__(self, *args, **kwargs):
        with self._lock:
            self.calls.append(args)
            self.threads.add(threading.get_ident())
        if not self.gate.wait(5.0):
            return Plan()
        return self._real(*args, **kwargs)


# ------------------------------------------------------------------ fixtures
@pytest.fixture(scope="session")
def qapp():
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])
    yield app
    app.processEvents()


@pytest.fixture
def win(qapp, monkeypatch):
    # Default settings without touching QSettings / the registry.
    monkeypatch.setattr(Settings, "load", classmethod(lambda cls: Settings()))
    monkeypatch.setattr(appmod, "VideoTile", FakeTile)
    monkeypatch.setattr(appmod, "Prober", FakeProber)
    w = appmod.MainWindow([])
    w.stage.resize(1600, 900)
    # Drop the resize-triggered schedule so each test owns its scheduling.
    w._schedule_timer.stop()
    w._replan = False
    yield w
    # Tear timers down so a window from one test can't tick into the next.
    w._closed = True
    w._schedule_timer.stop()
    if w.bench is not None and w.bench.timer is not None:
        w.bench.timer.stop()
    w.bench = None
    for t in list(w.all_tiles):
        t.shutdown()


def enqueue(w: appmod.MainWindow, n: int, aspect: float = 16 / 9) -> list[Item]:
    items = w.pl.add([f"/v/{i}.mp4" for i in range(n)])
    for it in items:
        it.aspect, it.probed = aspect, True
    return items


def pump(w: appmod.MainWindow, ms: int = 220) -> None:
    """Let queued Qt work (worker-thread signals, single-shot timers) run."""
    deadline = time.monotonic() + ms / 1000
    while time.monotonic() < deadline:
        QApplication.processEvents()
        time.sleep(0.005)


def assert_disjoint(pl: Playlists) -> None:
    ids = [it.id for lst in (pl.played, pl.playing, pl.queued) for it in lst]
    assert len(ids) == len(set(ids)), "an item is in more than one list"


# ----------------------------------------------------------- normal operation
def test_schedule_starts_queued_videos_and_lays_them_out(win):
    items = enqueue(win, 3)
    win.schedule()
    pump(win)

    assert win.pl.playing == items
    assert win.pl.queued == []
    assert set(win.tiles) == {it.id for it in items}
    assert all(t.item is not None for t in win.tiles.values())
    assert win.layout_ is not None and len(win.layout_.rects) == 3
    assert not win._planning
    assert_disjoint(win.pl)


# ------------------------------------------------------- stale result discard
def test_stale_plan_is_discarded_and_replanned_once(win, monkeypatch):
    items = enqueue(win, 3)
    block = BlockPlanner(appmod.plan)
    monkeypatch.setattr(appmod, "plan", block)

    win.schedule()
    pump(win, 40)
    assert win._planning and len(block.calls) == 1

    # The world changes while the planner thread is stuck.
    win.pl.remove(items[0])
    win.schedule()                       # merged into the in-flight run
    assert win._planning and win._replan
    assert len(block.calls) == 1        # ...so no second thread yet

    block.gate.set()
    pump(win, 320)

    # The stale result was dropped; exactly one recompute followed, on a
    # different thread, and it applied to the two items that remain.
    assert len(block.calls) == 2
    assert len(block.threads) == 2
    assert win.pl.playing == items[1:]
    assert set(win.tiles) == {items[1].id, items[2].id}
    assert win.pl.find(items[0].id) is None
    assert_disjoint(win.pl)


def test_input_revision_change_also_invalidates_a_plan(win, monkeypatch):
    # Same ids in the same lists, but an aspect ratio (hence the revision)
    # changes while a plan is in flight: the plan must still be discarded.
    items = enqueue(win, 2)
    block = BlockPlanner(appmod.plan)
    monkeypatch.setattr(appmod, "plan", block)
    win.schedule()
    pump(win, 40)

    items[0].aspect = 9 / 16
    win.pl.touch()                       # revision bump, lists unchanged
    block.gate.set()
    pump(win, 320)

    assert len(block.calls) == 2        # recomputed after the revision change
    assert set(win.pl.playing) == set(items)   # lookahead may reorder by fit
    assert set(win.tiles) == {it.id for it in items}


# ------------------------------------------------------- single-flight merging
def test_repeated_schedules_coalesce_into_one_worker(win, monkeypatch):
    enqueue(win, 4)
    block = BlockPlanner(appmod.plan)
    monkeypatch.setattr(appmod, "plan", block)

    win.schedule()
    pump(win, 40)
    for _ in range(5):
        win.schedule()                   # every one just sets the dirty flag
    assert len(block.calls) == 1
    assert win._replan

    block.gate.set()
    pump(win, 320)

    # One in-flight plan plus at most one merged follow-up: never a pile.
    assert len(block.calls) <= 2
    assert len(block.threads) <= 2


# ------------------------------------------------------ failure / skip cleanup
def test_failed_tile_returns_to_pool_and_item_goes_to_played(win):
    items = enqueue(win, 3)
    win.schedule()
    pump(win)
    tile = win.tiles[items[0].id]

    tile.failed.emit(tile, items[0], "could not be played")
    pump(win)

    assert items[0] in win.pl.played
    assert items[0].error == "could not be played"
    assert items[0] not in win.pl.playing
    assert items[0].id not in win.tiles
    assert tile in win.pool and tile.item is None
    assert win.pl.playing == items[1:]
    assert_disjoint(win.pl)


def test_skip_releases_tile_and_finishes_item_without_error(win):
    items = enqueue(win, 3)
    win.schedule()
    pump(win)
    tile = win.tiles[items[1].id]

    win._skip_id(items[1].id)
    pump(win)

    assert items[1] in win.pl.played and items[1].error is None
    assert items[1].id not in win.tiles
    assert tile in win.pool
    assert win.pl.playing == [items[0], items[2]]
    assert_disjoint(win.pl)


def test_removing_a_playing_item_releases_its_tile(win):
    items = enqueue(win, 2)
    win.schedule()
    pump(win)
    tile = win.tiles[items[0].id]

    win._remove_ids([items[0].id])
    pump(win)

    assert win.pl.find(items[0].id) is None
    assert items[0].id not in win.tiles
    assert tile in win.pool
    assert win.pl.playing == [items[1]]
    assert_disjoint(win.pl)


def test_late_signal_about_a_recycled_tile_is_ignored(win):
    items = enqueue(win, 2)
    win.schedule()
    pump(win)
    tile = win.tiles[items[0].id]

    win._finish_tile(tile, items[0])     # tile goes back to the pool
    assert tile.item is None

    other = Item("/v/other.mp4")
    other.aspect, other.probed = 16 / 9, True
    win.pl.queued.append(other)
    win.pl.touch()
    win.schedule()
    pump(win)
    assert win.tiles[other.id] is tile   # the recycled tile got a new file

    tile.failed.emit(tile, items[0], "late failure about the old file")
    pump(win)

    assert items[0] in win.pl.played
    assert other in win.pl.playing and other.error is None
    assert win.tiles[other.id] is tile


# -------------------------------------------------------------- probe results
def test_probe_result_for_a_removed_item_changes_nothing(win):
    items = enqueue(win, 2)
    items[0].probed = False             # still waiting for its probe result
    win.pl.remove(items[0])
    revision = win.pl.revision

    win._probed(items[0].id, 16 / 9, 5.0, None)

    assert win.pl.revision == revision
    assert win.pl.find(items[0].id) is None
    assert items[0].probed is False      # the late result never touched it


def test_probe_error_moves_a_queued_item_to_played_with_the_message(win):
    items = enqueue(win, 2)
    win._probed(items[0].id, None, None, "could not be opened")

    assert items[0] in win.pl.played
    assert items[0].error == "could not be opened"
    assert items[0] not in win.pl.queued
    assert items[1] in win.pl.queued
    assert_disjoint(win.pl)


def test_not_video_is_removed_quietly_and_counted(win):
    items = enqueue(win, 2)
    win._probed(items[0].id, None, None, NOT_VIDEO)

    assert win.pl.find(items[0].id) is None
    assert items[1] in win.pl.queued
    assert win._skipped == 1


def test_probe_error_for_an_item_already_gone_is_a_noop(win):
    items = enqueue(win, 2)
    win.pl.remove(items[0])
    revision = win.pl.revision
    win._probed(items[0].id, None, None, "could not be opened")
    assert win.pl.revision == revision


# ---------------------------------------------- shutdown / benchmark fencing
def test_plan_delivered_after_close_is_never_applied(win, monkeypatch):
    enqueue(win, 3)
    block = BlockPlanner(appmod.plan)
    monkeypatch.setattr(appmod, "plan", block)
    win.schedule()
    pump(win, 40)

    win.close()
    assert win._closed
    block.gate.set()
    pump(win, 250)

    assert win.tiles == {}
    assert win.pl.playing == []


def test_plan_delivered_after_benchmark_start_is_discarded(win, monkeypatch):
    enqueue(win, 4)
    block = BlockPlanner(appmod.plan)
    monkeypatch.setattr(appmod, "plan", block)
    win.schedule()
    pump(win, 40)

    win.start_benchmark()
    assert win.bench is not None
    block.gate.set()
    pump(win, 250)

    # The wall plan never touched the playlist or the wall's tiles; the
    # benchmark keeps its own tiles separate.
    assert win.pl.playing == []
    assert win.tiles == {}
    assert len(win.bench.tiles) >= 1


# ----------------------------------------------------- playlist-level guards
def test_playlist_transitions_refuse_items_that_left_their_list():
    pl = Playlists()
    a, b = pl.add(["/a.mp4", "/b.mp4"])
    ghost = Item("/ghost.mp4")

    assert pl.start(ghost) is False and pl.queued == [a, b]
    assert pl.demote(a) is False          # not playing yet
    assert pl.finish(ghost) is False
    assert pl.remove(ghost) is False

    pl.start(a)
    assert pl.demote(a) is True and pl.queued[0] is a
    pl.start(a)
    assert pl.finish(a, error="boom") is True
    assert pl.finish(a) is True           # idempotent: keeps the error
    assert a.error == "boom" and pl.played == [a]
    assert pl.start(a) is False           # a played item cannot be revived
    assert_disjoint(pl)


def test_playlist_revision_bumps_on_structural_and_metadata_changes():
    pl = Playlists()
    a, = pl.add(["/a.mp4"])
    before = pl.revision

    pl.touch()
    assert pl.revision == before + 1
    pl.start(a)
    after_start = pl.revision
    pl.finish(a)
    assert pl.revision == after_start + 1
    pl.remove(a)
    assert pl.revision > after_start + 1
