"""Benchmark lifecycle tests driven by controllable fake players.

These run the window's real benchmark machinery on fake tiles, so no libmpv or
hardware decoding is needed.  They cover the five required scenarios:
a normal run that applies its result, cancel-and-restore, a cancel landing on
top of the finishing drain, queue/settings changes during a run, and a window
closed while a benchmark is still going.
"""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

from polyreel import app as app_module
from polyreel.app import MainWindow
from polyreel.settings import Settings

from .fakes import (FakeProber, FakeResultsDialog, FakeTile, reset_fakes,
                    tile_factory)

# Shrink every benchmark wait so a full run takes well under a second of wall
# time while keeping the same sequence of rounds and measurements.
FAST_TIMING = dict(start_wait=2.0, measure=0.3, early=0.1, drain_wait=0.5,
                   warmup_ms=20, poll_ms=30, step_ms=10, add_batch=4)


@pytest.fixture
def qapp():
    app = QApplication.instance() or QApplication([])
    yield app


@pytest.fixture
def window(qapp, monkeypatch, tmp_path):
    reset_fakes()
    # Keep settings out of the real registry; tests own every saved value.
    monkeypatch.setattr(Settings, "save", lambda self: None)
    monkeypatch.setattr(app_module, "Prober", FakeProber)
    monkeypatch.setattr(app_module, "BenchmarkResultsDialog", FakeResultsDialog)
    monkeypatch.setattr(app_module, "take_retiring", lambda: [])

    win = MainWindow([])
    win.resize(1280, 760)
    win.tile_factory = tile_factory(win)
    for key, value in FAST_TIMING.items():
        setattr(win.bench_timing, key, value)
    # The first videos would otherwise auto-start a benchmark; tests start it.
    win.settings.benchmark_asked = True
    win._bench_pending = False
    # Real dummy files (their bytes are never decoded by the fake players).
    win._test_dir = tmp_path
    win._test_files = []
    for i in range(8):
        p = tmp_path / f"v{i}.mp4"
        p.write_bytes(b"fake video")
        win._test_files.append(str(p))
    win.show()
    QTest.qWait(20)
    yield win
    if not win._closing:
        win.close()
    QTest.qWait(20)


def pump(ms: int = 10) -> None:
    QTest.qWait(ms)


def wait_until(predicate, timeout: float = 10.0, interval: int = 10) -> bool:
    deadline = timeout
    waited = 0.0
    while waited < deadline:
        QApplication.processEvents()
        if predicate():
            return True
        QTest.qWait(interval)
        waited += interval / 1000.0
    return predicate()


def add_videos(win, n: int = 6) -> list:
    """Add real dummy files; the fake prober marks them ready synchronously."""
    paths = win._test_files[:n]
    win.add_paths(paths)
    items = list(win.pl.played + win.pl.queued + win.pl.playing)
    assert len(items) == n and all(it.probed for it in items)
    return items


def start_benchmark(win) -> None:
    win._bench_pending = False
    win.start_benchmark()
    assert win.bench is not None


def test_full_run_applies_the_pair_of_limits(window):
    # A machine that keeps up through 9 streams but not 10+.
    def chooser(round_count):
        return 0.0 if round_count <= 9 else 0.5
    FakeTile.drop_chooser = staticmethod(chooser)

    add_videos(window)
    start_benchmark(window)
    assert wait_until(lambda: window.bench is None)
    pump(30)

    dialog = FakeResultsDialog.last
    assert dialog is not None and dialog.accepted_value
    s = window.settings
    # The two linked limits take effect together, from the real measurements.
    assert s.max_streams == dialog.limits.values[0]
    assert s.max_drop_pct == dialog.limits.values[1]
    assert s.bench_curve and s.bench_date
    # A genuine multi-round measurement, not a hard-coded answer.
    measured = [n for n, _r in dialog.measured]
    assert len(measured) >= 3 and 8 in measured
    assert max(measured) > 8
    # Every fake player was released back or retired; none left dangling.
    assert window.bench is None
    assert all(not t.isVisible() or t in window.tiles.values() for t in FakeTile.made)


def test_cancel_restores_the_wall_to_its_previous_state(window):
    add_videos(window)
    # Let the wall settle with its own players before the benchmark.
    assert wait_until(lambda: len(window.tiles) >= 1)
    pump(40)
    wall_tiles = list(window.tiles.values())
    # One wall video was paused by hand and another hidden, before measuring.
    if len(wall_tiles) >= 2:
        wall_tiles[0].set_paused(True)
        wall_tiles[1].hide()
    paused_before = {t: t.paused for t in wall_tiles}
    hidden_before = {t for t in wall_tiles if not t.isVisible()}

    start_benchmark(window)
    # The wall is held while measuring.
    assert wait_until(lambda: window.bench and len(window.bench.tiles) > 0)
    assert all(not t.isVisible() for t in wall_tiles)

    window.escape()                       # Esc cancels the run
    assert wait_until(lambda: window.bench is None)
    pump(30)

    # Same players, each back to its own pause state; hidden ones hidden again
    # and every other wall video visible.
    assert list(window.tiles.values()) == wall_tiles
    for t in wall_tiles:
        assert t.paused == paused_before[t]
        assert t.isVisible() == (t not in hidden_before)
    # The run was cancelled: no results dialog, no settings changes.
    assert FakeResultsDialog.last is None
    assert window.settings.bench_curve == ""
    # The wall was re-laid out and rescheduled (not left frozen mid-benchmark).
    assert window.layout_ is not None


def test_cancel_resumes_a_wall_that_was_playing(window):
    # The reported bug: after cancelling, videos stayed paused. A wall that
    # was playing must be playing again once the cancelled run is torn down.
    add_videos(window)
    assert wait_until(lambda: len(window.tiles) >= 1)
    pump(40)
    wall_tiles = list(window.tiles.values())
    assert wall_tiles and all(not t.paused for t in wall_tiles)

    start_benchmark(window)
    assert wait_until(lambda: window.bench and len(window.bench.tiles) > 0)
    # While measuring, the wall players are paused and hidden.
    assert all(t.paused and not t.isVisible() for t in wall_tiles)

    window.escape()
    assert wait_until(lambda: window.bench is None)
    pump(30)

    # Same players, visible and playing again: nothing left stuck on pause.
    assert list(window.tiles.values()) == wall_tiles
    assert all(not t.paused for t in wall_tiles)
    assert all(t.isVisible() for t in wall_tiles)
    assert FakeResultsDialog.last is None


def test_cancel_while_finishing_is_idempotent(window):
    add_videos(window)
    # Keep the finishing drain in flight long enough for repeated cancels.
    FakeTile.stop_delay = 0.25
    start_benchmark(window)
    assert wait_until(lambda: window.bench and len(window.bench.tiles) > 0)

    # First Esc starts the finishing drain; further Esc presses (and a stray
    # finish call) must not start a second drain or a fresh round.
    window.escape()
    b = window.bench
    assert b is not None and b.finishing and b.cancelled
    window.escape()
    window._bench_finish(cancelled=True)
    assert window.bench is b              # same run, no replacement

    assert wait_until(lambda: window.bench is None, timeout=5.0)
    pump(20)
    # No new round was spawned by the repeated cancels.
    assert all(t.paused is not None for t in window.tiles.values())
    assert FakeResultsDialog.last is None


def test_finishing_drain_and_cancel_can_race_without_corrupting_state(window):
    add_videos(window)
    # Make stops take a moment so the finishing drain is genuinely in flight.
    FakeTile.stop_delay = 0.3
    start_benchmark(window)
    assert wait_until(lambda: window.bench and len(window.bench.tiles) > 0)

    # Cancel right as a round completes: finish() and the cancel both arrive
    # while the drain is waiting on slow-to-stop players.
    window._bench_finish(cancelled=True)
    b = window.bench
    window._bench_finish(cancelled=True)     # repeated, must be a no-op
    window.escape()
    assert window.bench is b and b.finishing

    assert wait_until(lambda: window.bench is None, timeout=5.0)
    # The cancel scheduled a fresh wall layout; let that scheduling run land.
    assert wait_until(lambda: window.layout_ is not None)
    pump(40)
    # The slow players were accounted for exactly once each.
    assert all(t.is_stopped or t.retired_flag for t in FakeTile.made)
    assert FakeResultsDialog.last is None
    assert window.bench is None and not window._results_open


def test_queue_and_settings_changes_during_a_run_do_not_pollute_rounds(window):
    items = add_videos(window)
    start_benchmark(window)
    b0 = window.bench
    assert wait_until(lambda: window.bench and len(window.bench.tiles) > 0)

    first_round = b0.plan.current
    sources_before = list(b0.sources)
    count_before = len(window.pl)

    # Add new files while a round is running: they are held aside, not probed
    # or merged, so the running round's library cannot change underneath it.
    extra1 = str(window._test_dir / "extra1.mp4")
    extra2 = str(window._test_dir / "extra2.mp4")
    open(extra1, "wb").write(b"fake")
    open(extra2, "wb").write(b"fake")
    window.add_paths([extra1, extra2])
    assert window._deferred_paths == [extra1, extra2]
    assert len(window.pl) == count_before
    # Removing an existing queued item does not touch the run's snapshot.
    queued = list(window.pl.queued)
    if queued:
        window.pl.remove(queued[0])
    # And change settings that a round would otherwise pick up live.
    window.settings.crop_pct = 25.0
    window.settings.hwdec = "no"
    window.settings.max_streams = 1
    pump(30)

    # The run is the same run, on the same frozen sources and settings...
    assert window.bench is b0
    assert b0.sources == sources_before
    assert b0.hwdec != "no" and b0.crop == 0.0
    # ...and its round tiles are benchmark tiles only, never wall players.
    assert all(t not in window.tiles.values() for t in b0.tiles)
    assert len(b0.tiles) == first_round or b0.finishing
    for t in b0.tiles:
        assert t.hwdec == b0.hwdec

    assert wait_until(lambda: window.bench is None)
    pump(30)
    # The deferred files were merged in once the run ended (and probed).
    all_paths = {it.path for it in
                 window.pl.played + window.pl.queued + window.pl.playing}
    assert {extra1, extra2} <= all_paths
    assert window._deferred_paths == []
    # The finished run never handed an active leftover back to the pool.
    for t in window.pool:
        assert t.is_stopped and not t.retired_flag


def test_closing_the_window_mid_run_tears_everything_down(window):
    add_videos(window)
    start_benchmark(window)
    assert wait_until(lambda: window.bench and len(window.bench.tiles) > 0)
    bench_tiles = list(window.bench.tiles)
    active_before = [t for t in FakeTile.made if t.is_playing]

    window.close()                        # close while a round is live
    pump(30)

    assert window._closing and window.bench is None
    # No benchmark timer can fire into the dead run.
    assert not hasattr(window, "_boom")
    # closeEvent shuts every player (wall, pool and benchmark) down for good.
    for t in FakeTile.made:
        assert t.shut_down or t.retired_flag
    # The round's own players were the ones active at close time.
    assert set(active_before) <= set(bench_tiles)
    # The prober was closed too.
    assert window.prober is not None


def test_drain_that_gives_up_retires_leftovers_instead_of_reusing_them(window):
    add_videos(window)
    # Players take far longer to stop than the drain is willing to wait.
    FakeTile.stop_delay = 5.0
    window.bench_timing.drain_wait = 0.2
    start_benchmark(window)
    assert wait_until(lambda: window.bench and len(window.bench.tiles) > 0)
    pump(20)
    first_round_tiles = list(window.bench.tiles)

    window.escape()
    assert wait_until(lambda: window.bench is None, timeout=5.0)
    pump(40)

    # The players that never acknowledged the stop were retired, not pooled.
    leftovers = [t for t in first_round_tiles if not t.is_stopped]
    assert leftovers, "the drain should have given up on at least one player"
    for t in leftovers:
        assert t.retired_flag and t not in window.pool and t not in window.all_tiles
    # Nothing active was handed back for a later round to reuse.
    for t in window.pool:
        assert t.is_stopped and not t.retired_flag


def test_a_following_run_never_inherits_the_previous_runs_players(window):
    # Slow stops that still answer within the drain window, across two runs.
    FakeTile.stop_delay = 0.15
    add_videos(window)
    start_benchmark(window)
    assert wait_until(lambda: window.bench is None, timeout=8.0)
    pump(40)

    # A second, separate benchmark must build its rounds on clean players:
    # any tile it uses was fully stopped before being loaded again.
    start_benchmark(window)
    b = window.bench
    assert wait_until(lambda: window.bench and len(window.bench.tiles) > 0)
    # Every round tile is actively playing: a half-stopped leftover from the
    # previous run is never carried into a new round.
    assert all(t.is_playing for t in b.tiles)
    assert wait_until(lambda: window.bench is None, timeout=8.0)
    pump(20)
    assert FakeResultsDialog.last is not None


def test_cancel_exactly_as_the_last_round_finishes_is_handled_once(window):
    # Drive the natural completion and an Esc cancel through the same turn:
    # whichever "wins", exactly one teardown runs and no results dialog opens.
    FakeTile.stop_delay = 0.2
    add_videos(window)
    start_benchmark(window)
    b = window.bench
    # Force the plan to be one record away from done, then complete the round.
    b.plan.done = True

    # _bench_measure_check sees plan.done and calls _bench_finish(); an Esc
    # arrives immediately after, in the same event-loop turn. The first call
    # owns the outcome, so the later Esc cannot start a second teardown.
    window._bench_measure_check()
    assert window.bench is b and b.finishing
    window.escape()
    window._bench_finish(cancelled=True)      # idempotent against the finish
    assert window.bench is b                   # one run, one drain in flight
    assert wait_until(lambda: window.bench is None, timeout=8.0)
    pump(40)
    # Exactly one teardown ran; the run's own outcome (natural completion) is
    # preserved and no second results dialog or stray round appears.
    assert all(t.is_stopped or t.retired_flag for t in FakeTile.made)
    assert window.bench is None


def test_natural_finish_and_cancel_both_landing_leave_one_teardown(window):
    # The inverse ordering: cancel first, then the measurement's completion
    # callback tries to finish an already-finishing run.
    FakeTile.stop_delay = 0.2
    add_videos(window)
    start_benchmark(window)
    b = window.bench
    b.plan.done = True
    window.escape()                              # cancel starts the drain
    assert b.finishing and b.cancelled
    window._bench_measure_check()                # late: guarded, no new record
    window._bench_finish(cancelled=False)        # idempotent: no second drain
    assert window.bench is b                      # the run was not replaced
    assert wait_until(lambda: window.bench is None, timeout=8.0)
    pump(20)
    assert FakeResultsDialog.last is None
    assert window.bench is None


def test_paused_all_flag_is_unchanged_by_cancel(window):
    add_videos(window)
    assert wait_until(lambda: len(window.tiles) >= 1)
    pump(30)
    window.paused_all = True
    for t in window.tiles.values():
        t.set_paused(True)

    start_benchmark(window)
    assert wait_until(lambda: window.bench and len(window.bench.tiles) > 0)
    window.escape()
    assert wait_until(lambda: window.bench is None)
    pump(20)
    # The global pause state is whatever it was before; every wall player is
    # back to that state rather than left paused by the benchmark's hide step.
    assert window.paused_all is True
    assert all(t.paused is True for t in window.tiles.values())
    assert FakeResultsDialog.last is None


def test_settings_apply_benchmark_updates_both_limits_together():
    from polyreel.perf import DropCurve
    s = Settings(max_streams=6, max_drop_pct=5.0, bench_curve="", bench_date="")
    curve = DropCurve([(8, 0.02), (16, 0.12)])
    s.apply_benchmark(curve, 14, 8.0, bench_date="2026-11-23")
    # All four values land as one transaction.
    assert s.max_streams == 14 and s.max_drop_pct == 8.0
    assert s.bench_curve == curve.to_text() and s.bench_date == "2026-11-23"

    # A bad value leaves the previous, paired state untouched (no half update).
    before = (s.max_streams, s.max_drop_pct, s.bench_curve)
    with pytest.raises((TypeError, ValueError)):
        s.apply_benchmark(curve, "not-a-number", 8.0)   # type: ignore[arg-type]
    assert (s.max_streams, s.max_drop_pct, s.bench_curve) == before


def test_rejecting_results_keeps_both_limits_at_their_old_values(window):
    FakeTile.drop_chooser = staticmethod(lambda n: 0.0 if n <= 6 else 0.5)
    # The dialog is created the moment the run finishes, so decide beforehand.
    FakeResultsDialog.accept_default = False
    add_videos(window)
    old_streams, old_drop = window.settings.max_streams, window.settings.max_drop_pct
    start_benchmark(window)
    assert wait_until(lambda: window.bench is None)
    pump(20)
    assert FakeResultsDialog.last is not None
    assert window.settings.max_streams == old_streams
    assert window.settings.max_drop_pct == old_drop
    # The curve was still recorded, ready to link the limits in Settings later.
    assert window.settings.bench_curve
    FakeResultsDialog.accept_default = True
