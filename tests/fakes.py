"""Controllable, hardware-free test doubles for the benchmark lifecycle.

No libmpv is involved: ``FakeTile`` mimics the slice of the ``VideoTile``
interface the window drives (load / stop / poll / sample / pause / layout) and
simulates frame counters whose drop rate the test decides per round.  The
benchmark's real logic - rounds, draining, cancellation, restore, settings -
runs unchanged on top of them.
"""

from __future__ import annotations

import itertools
import time

from PySide6.QtCore import QObject, QRect, QTimer, Signal
from PySide6.QtWidgets import QWidget

from polyreel.perf import Sample

_numbers = itertools.count(1)


class FakeTile(QWidget):
    """A fake libmpv player rendered into an ordinary (offscreen) QWidget."""

    double_clicked = Signal(object)
    right_clicked = Signal(object)
    finished = Signal(object)
    failed = Signal(object, str)
    shape_changed = Signal(object, float)
    ready = Signal(object)
    retired = Signal(object)

    # Every tile built in the current test, so a test can inspect lifecycle.
    made: list["FakeTile"] = []
    # Tests set this to choose a round's simulated drop ratio.  It is called
    # with the stream count currently being tried (the live round).
    drop_chooser = staticmethod(lambda round_count: 0.0)
    # A stop that takes this long to "carry out" (0 = immediate).
    stop_delay = 0.0

    def __init__(self, parent=None, hwdec: str = "auto-safe", window=None) -> None:
        super().__init__(parent)
        self.setGeometry(0, 0, 1, 1)
        self.num = next(_numbers)
        self.hwdec = hwdec
        self.window = window
        self.item = None
        self.zoom = 1.0
        self.user_muted = False
        self.keep_sound = False
        self._muted = True
        self._paused = False
        self._active = False
        self._file = 0
        self._dropped = 0
        self._sim_at = 0.0          # simulated playback clock
        self._real_at = 0.0         # wall clock the simulation last advanced
        self._polled_at = 0.0
        self.load_started = 0.0
        self._stops_sent = 0
        self._stops_done = 0
        self.shut_down = False
        self.retired_flag = False
        self.show()
        FakeTile.made.append(self)

    def _current_round(self) -> int:
        b = self.window.bench if self.window is not None else None
        return b.plan.current if b is not None else 0

    # -- the VideoTile surface the window uses --------------------------------
    def load(self, item, start: float = 0.0, loop: bool = False, hwdec: str | None = None) -> None:
        if hwdec:
            self.hwdec = hwdec
        self.item = item
        self._active = True
        self._paused = False
        self._file += 1
        self._dropped = 0
        self._sim_at = 0.0
        self._real_at = time.monotonic()
        self._polled_at = self._real_at
        self.load_started = self._real_at
        self.show()

    def stop(self) -> None:
        self.item = None
        self._active = False
        self._file += 1
        self._polled_at = 0.0
        self.load_started = 0.0
        self._stops_sent += 1
        if self.stop_delay <= 0.0:
            self._stops_done = self._stops_sent
        else:
            # Finish "stopping" after the configured delay, like a busy player.
            n = self._stops_sent

            def done() -> None:
                self._stops_done = max(self._stops_done, n)

            QTimer.singleShot(int(self.stop_delay * 1000), done)
        self.hide()

    def retire(self) -> None:
        """Shut down for good (the real one does it on a background thread)."""
        self.hide()
        self.retired_flag = True
        self.shutdown()
        self.retired.emit(self)

    def shutdown(self, wait: float = 2.0) -> None:
        self.item = None
        self._active = False
        self.shut_down = True

    def poll(self) -> None:
        """Advance the simulated playback clock and frame counters."""
        if not self._active or self._paused:
            return
        now = time.monotonic()
        dt = now - self._real_at
        self._real_at = now
        if dt <= 0:
            return
        fps = 30.0
        expected = fps * dt
        ratio = float(self.drop_chooser(self._current_round()))
        self._dropped += int(round(expected * ratio))
        self._sim_at += dt
        self._polled_at = now

    def sample(self) -> Sample | None:
        if not self._active or not self._polled_at:
            return None
        return Sample(self._dropped, 30.0, self._polled_at, self._sim_at)

    @property
    def is_ready(self) -> bool:
        return True

    @property
    def is_playing(self) -> bool:
        return self._active

    @property
    def is_stopped(self) -> bool:
        return self._stops_done >= self._stops_sent

    def set_paused(self, paused: bool) -> None:
        if paused != self._paused:
            self._paused = paused
            if not paused and self._active:
                self._real_at = time.monotonic()

    @property
    def paused(self) -> bool:
        return self._paused

    def set_muted(self, muted: bool) -> None:
        self._muted = muted

    def set_zoom(self, zoom: float) -> None:
        self.zoom = zoom

    def move_to(self, rect: QRect, animate: bool) -> None:
        self.setGeometry(QRect(rect))
        self.show()

    def position(self) -> float:
        return self._sim_at

    def duration(self) -> float:
        return float(self.item.duration or 0.0) if self.item else 0.0

    def volume(self) -> int:
        return 100

    def set_volume(self, volume: int) -> None:
        pass

    def seek(self, seconds: float, exact: bool = True) -> None:
        self._sim_at = seconds


class FakeProber(QObject):
    """No subprocess/mpv probing: marks every item as a ready 16:9 video."""

    probed = Signal(int, object, object, object)

    def __init__(self, parent=None) -> None:
        super().__init__(parent)

    def submit(self, item_id: int, path: str) -> None:
        # Emitted synchronously, so the item is probed by the time add_paths
        # returns; the window's slot runs as a direct call.
        self.probed.emit(item_id, 16 / 9, 10.0, None)

    def close(self) -> None:
        pass


class FakeResultsDialog:
    """Stands in for the modal results dialog without blocking the event loop."""

    last: "FakeResultsDialog | None" = None
    # Tests flip this to simulate dismissing the dialog without accepting.
    accept_default = True

    def __init__(self, curve, measured, max_drop_pct, bench_date, parent=None) -> None:
        recommended = curve.max_streams_for(max_drop_pct / 100) if curve else 1
        self.limits = type("Limits", (), {"values": (recommended, max_drop_pct)})()
        self.measured = measured
        self.accepted_value = FakeResultsDialog.accept_default
        FakeResultsDialog.last = self

    def exec(self) -> bool:
        return self.accepted_value


def reset_fakes() -> None:
    """Reset the class-wide fake state between tests."""
    FakeTile.made = []
    FakeTile.drop_chooser = staticmethod(lambda round_count: 0.0)
    FakeTile.stop_delay = 0.0
    FakeResultsDialog.last = None
    FakeResultsDialog.accept_default = True


def tile_factory(window):
    """A window's tile factory: fakes that read their round from the window."""
    def factory(parent, hwdec="auto-safe"):
        return FakeTile(parent, hwdec, window=window)
    return factory
