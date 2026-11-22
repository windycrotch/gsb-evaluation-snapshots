"""
Test the coordination between the scheduler, the canvas base class and the
event emitter when a canvas is closed, redrawn after closing, and when the
loop is stopped and restarted.

These tests use the offscreen canvas together with a StubLoop, so the timing
is fully deterministic (a manual pump drives the loop instead of a wall-clock
event loop). They cover:

* normal continuous drawing for a few frames and then closing;
* closing the canvas from inside the draw callback;
* request_draw()/force_draw() after closing;
* events going silent after closing;
* stopping the loop and restarting it with a fresh canvas (no double fps,
  no zombie tasks);
* calling loop.stop() from outside while a draw is in flight.
"""

# ruff: noqa: N803, N806

import time

from testutils import run_tests

from rendercanvas.base import BaseCanvasGroup
from rendercanvas.offscreen import OffscreenRenderCanvas, StubLoop


class StubContext:
    """A minimal canvas context that counts present attempts."""

    def __init__(self):
        self.closed = False
        self.present_count = 0

    def _rc_present(self, force_sync=False):
        self.present_count += 1
        if self.closed:
            raise RuntimeError("Cannot present on a closed context")
        return {"method": "skip"}

    def _rc_set_size_dict(self, size_info):
        pass

    def _rc_close(self):
        self.closed = True


def make_canvas_factory():
    """Return (loop, CanvasClass) sharing one fresh StubLoop/canvas group."""
    loop = StubLoop()

    class CanvasGroup(BaseCanvasGroup):
        pass

    class Canvas(OffscreenRenderCanvas):
        _rc_canvas_group = CanvasGroup(loop)

    return loop, Canvas


def pump(loop, duration=0.2):
    """Drive the stub loop for ``duration`` seconds, like an event loop would."""
    etime = time.perf_counter() + duration
    while time.perf_counter() < etime:
        time.sleep(0.001)
        loop.run()


def pump_until(loop, condition, timeout=2.0):
    """Drive the stub loop until ``condition()`` is true or the timeout passes.

    Using a condition instead of a fixed wall-clock window keeps the test
    deterministic regardless of machine/CI speed.
    """
    etime = time.perf_counter() + timeout
    while time.perf_counter() < etime:
        time.sleep(0.001)
        loop.run()
        if condition():
            return True
    return condition()


def live_scheduler_tasks(loop):
    return [t for t in loop._BaseLoop__tasks if t.coro is not None]


def make_canvas(CanvasClass, **kwargs):
    kwargs.setdefault("update_mode", "continuous")
    kwargs.setdefault("max_fps", 100)
    canvas = CanvasClass(**kwargs)
    canvas._canvas_context = StubContext()
    return canvas


# ==================== normal continuous drawing, then close ====================


def test_continuous_draw_then_close():
    loop, Canvas = make_canvas_factory()
    canvas = make_canvas(Canvas)

    draws = []

    @canvas.request_draw
    def draw():
        draws.append(1)

    # Three (or more) frames are produced (wait conditionally to stay robust
    # against slow/loaded CI machines).
    assert pump_until(loop, lambda: len(draws) >= 3)

    # Closing stops the scheduler without leaving a dangling task or wait.
    canvas.close()
    assert canvas.get_closed()
    pump(loop, 0.05)
    assert live_scheduler_tasks(loop) == []
    assert loop._BaseLoop__state == "off"


# ==================== close from inside the draw callback ====================


def test_close_inside_draw_skips_present_and_cancels_scheduler():
    loop, Canvas = make_canvas_factory()
    canvas = make_canvas(Canvas)
    context = canvas._canvas_context

    def draw():
        canvas.close()

    canvas.request_draw(draw)
    pump(loop, 0.2)

    assert canvas.get_closed()
    # The frame is terminated before the presentation stage is entered.
    assert context.present_count == 0
    # The scheduler received a cancellation, not a completion.
    assert canvas._BaseRenderCanvas__scheduler._ready_for_present is None
    # No task is left waiting.
    assert live_scheduler_tasks(loop) == []
    assert loop._BaseLoop__state == "off"


def test_close_inside_draw_with_second_canvas_keeps_other_canvas_alive():
    # With two canvases the loop does not stop when one closes. The closed
    # canvas' scheduler task must still terminate instead of hanging.
    loop, Canvas = make_canvas_factory()
    canvas_a = make_canvas(Canvas)
    canvas_b = make_canvas(Canvas)

    def draw_a():
        canvas_a.close()

    canvas_a.request_draw(draw_a)
    canvas_b.request_draw(lambda: None)

    pump(loop, 0.2)

    assert canvas_a.get_closed()
    assert not canvas_b.get_closed()
    assert canvas_a._BaseRenderCanvas__scheduler._ready_for_present is None

    # Exactly one scheduler task remains: the one for the still-open canvas.
    assert len(live_scheduler_tasks(loop)) == 1

    canvas_b.close()
    pump(loop, 0.1)
    assert live_scheduler_tasks(loop) == []


# ==================== redraw requests after closing ====================


def test_redraw_requests_after_close_are_silent():
    loop, Canvas = make_canvas_factory()
    canvas = make_canvas(Canvas, update_mode="ondemand")
    draws = []
    canvas.request_draw(lambda: draws.append(1))
    assert pump_until(loop, lambda: draws == [1])

    canvas.close()
    draws.clear()

    # Neither request_draw nor force_draw may invoke the draw callback or raise.
    canvas.request_draw(lambda: draws.append(2))
    canvas.force_draw()
    pump(loop, 0.1)
    assert draws == []

    # The freshly supplied draw function must not be retained on a closed canvas.
    assert canvas._draw_frame is None


def test_repeated_close_is_idempotent():
    _loop, Canvas = make_canvas_factory()
    canvas = make_canvas(Canvas)
    canvas.close()
    # Repeated closes must be a silent no-op (and not raise).
    canvas.close()
    canvas.close()
    assert canvas.get_closed()


def test_offscreen_draw_after_close_returns_last_image_without_drawing():
    _loop, Canvas = make_canvas_factory()
    canvas = make_canvas(Canvas)
    canvas._last_image = sentinel = object()
    canvas.close()
    assert canvas.draw() is sentinel


# ==================== events go silent after closing ====================


def test_events_are_silent_after_close():
    _loop, Canvas = make_canvas_factory()
    canvas = make_canvas(Canvas)

    received = []
    canvas.add_event_handler(
        lambda event: received.append(event["event_type"]), "key_down"
    )
    canvas.close()

    # A handler registered after closing is silently ignored.
    canvas.add_event_handler(lambda event: received.append("late"), "key_down")
    # Submitted events are dropped, none reach any handler.
    canvas.submit_event({"event_type": "key_down"})
    canvas._events.flush()
    assert received == []
    assert canvas._events._closed


def test_close_event_is_emitted_before_going_silent():
    _loop, Canvas = make_canvas_factory()
    canvas = make_canvas(Canvas)

    seen = []
    canvas.add_event_handler(lambda event: seen.append(event["event_type"]), "close")
    canvas.close()
    # The close event itself is still delivered, exactly once.
    assert seen == ["close"]
    # ...after which the emitter is disabled.
    canvas.submit_event({"event_type": "close"})
    canvas._events.flush()
    assert seen == ["close"]


# ==================== stop / restart: no double fps, no zombies ====================


def test_stop_and_restart_does_not_double_framerate():
    loop, Canvas = make_canvas_factory()

    canvas1 = make_canvas(Canvas)
    count1 = []
    canvas1.request_draw(lambda: count1.append(1))
    pump(loop, 0.2)
    first = len(count1)
    assert first > 0, "the canvas should have drawn at least one frame"

    loop.stop()
    assert loop._BaseLoop__state == "off"
    assert live_scheduler_tasks(loop) == []
    assert loop._callbacks == []

    # Recreate a canvas on the same (stopped) loop and run again.
    canvas2 = make_canvas(Canvas)
    count2 = []
    canvas2.request_draw(lambda: count2.append(1))
    pump(loop, 0.2)
    second = len(count2)

    # Only one scheduler task is alive, and the frame rate is not doubled.
    assert len(live_scheduler_tasks(loop)) == 1
    assert 0.6 < second / first < 1.6, (first, second)

    canvas2.close()
    loop.stop()
    assert live_scheduler_tasks(loop) == []


# ==================== external stop while a draw is in flight ====================


def test_external_stop_during_draw_cancels_cleanly():
    loop, Canvas = make_canvas_factory()
    # Two canvases, so the loop would otherwise keep running.
    canvas1 = make_canvas(Canvas)
    canvas2 = make_canvas(Canvas)

    draws = {"n": 0}

    def draw1():
        draws["n"] += 1
        if draws["n"] == 2:
            # Simulate an external stop() arriving during the draw.
            loop.stop()

    canvas1.request_draw(draw1)
    canvas2.request_draw(lambda: None)

    pump(loop, 0.3)

    # Both canvases are closed by the loop stop.
    assert canvas1.get_closed()
    assert canvas2.get_closed()
    # The loop reaches its off-state with nothing left hanging.
    assert loop._BaseLoop__state == "off"
    assert loop._callbacks == []
    assert live_scheduler_tasks(loop) == []


# ==================== existing behaviors are preserved ====================


def test_continuous_draw_and_event_merging_preserved():
    # Guard against regressions in the behaviors this refactor must keep:
    # continuous drawing keeps ticking, and pointer_move events merge.
    loop, Canvas = make_canvas_factory()
    canvas = make_canvas(Canvas)

    draws = []
    canvas.request_draw(lambda: draws.append(1))
    assert pump_until(loop, lambda: len(draws) >= 3)

    moves = []
    canvas.add_event_handler(
        lambda event: moves.append((event["x"], event["y"])), "pointer_move"
    )
    canvas.submit_event(
        {"event_type": "pointer_move", "x": 1, "y": 1, "buttons": [], "modifiers": []}
    )
    canvas.submit_event(
        {"event_type": "pointer_move", "x": 2, "y": 2, "buttons": [], "modifiers": []}
    )
    canvas._process_events()
    # The two pointer_move events merge into a single dispatch with the latest data.
    assert moves == [(2, 2)]

    canvas.close()


if __name__ == "__main__":
    run_tests(globals())
