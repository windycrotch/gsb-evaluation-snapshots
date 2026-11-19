"""
Test the close() mechanics of BaseRenderCanvas, and how closing cooperates
with the drawing paths, event dispatch, and the scheduler.

These tests use a minimal locally-defined canvas and loop, so they do not
depend on any real GUI backend.
"""

# ruff: noqa: N806

from testutils import run_tests

import time

from rendercanvas.base import BaseCanvasGroup, BaseRenderCanvas
from rendercanvas.offscreen import StubLoop
from rendercanvas.utils.asyncadapter import Event


class DrawCancelled(Exception):  # noqa: N818 - name matches the base class's check
    pass


class TrackingLoop(StubLoop):
    """Stub loop that tracks init/stop, to detect unwanted restarts."""

    def __init__(self):
        super().__init__()
        self.init_count = 0
        self.stop_count = 0

    def _rc_init(self):
        self.init_count += 1

    def _rc_stop(self):
        self.stop_count += 1
        super()._rc_stop()


class StubContext:
    """Minimal context, counting present calls."""

    def __init__(self, result=None):
        self.present_calls = 0
        self.closed = False
        self._result = result

    def _rc_present(self, force_sync=False):
        self.present_calls += 1
        return dict(self._result or {"method": "skip"})

    def _rc_set_size_dict(self, size_info):
        pass

    def _rc_close(self):
        self.closed = True


def make_canvas_class(*, present_to_screen=False):
    """Create a fresh minimal canvas class with its own loop and group."""

    loop = TrackingLoop()
    group = BaseCanvasGroup(loop)

    class MinimalCanvas(BaseRenderCanvas):
        _rc_canvas_group = group

        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            self.close_calls = 0
            self.draw_calls = 0
            self.paint_requests = 0
            self.context = StubContext()
            self._present_to_screen = present_to_screen
            self._canvas_context = self.context
            self._size_info.set_physical_size(100, 100, 1)
            self._final_canvas_init()

        def _rc_close(self):
            self.close_calls += 1

        def _rc_request_draw(self):
            self._time_to_draw()

        def _rc_request_paint(self):
            self.paint_requests += 1

        def _rc_force_paint(self):
            self._time_to_paint()

        def _rc_gui_poll(self):
            pass

        def count_draw(self, draw_func):
            def wrapped():
                self.draw_calls += 1
                draw_func()

            return wrapped

    return MinimalCanvas, loop


def get_scheduler(canvas):
    return canvas._BaseRenderCanvas__scheduler


# ==================== idempotent close


def test_close_is_idempotent():
    CanvasCls, loop = make_canvas_class()
    canvas = CanvasCls()

    canvas.close()
    assert canvas.get_closed()
    assert canvas.close_calls == 1
    assert canvas.context.closed

    # Closing again (and again) must not touch the backend or the context.
    canvas.close()
    canvas.close()
    assert canvas.close_calls == 1
    assert canvas.context.closed
    assert loop.stop_count == 1


def test_close_from_close_event_handler_is_reentrant():
    CanvasCls, loop = make_canvas_class()
    canvas = CanvasCls()

    seen = []

    def on_close(event):
        seen.append("close")
        canvas.close()  # re-entrant

    canvas.add_event_handler(on_close, "close")
    canvas.close()

    assert seen == ["close"]
    assert canvas.close_calls == 1
    assert loop.stop_count == 1


# ==================== drawing while/after closing


def test_close_during_draw_does_not_present_or_draw_again():
    CanvasCls, _loop = make_canvas_class()
    canvas = CanvasCls()

    def draw():
        canvas.close()

    canvas._draw_frame = canvas.count_draw(draw)
    canvas.force_draw()

    assert canvas.get_closed()
    assert canvas.draw_calls == 1
    assert canvas.close_calls == 1
    assert canvas.context.present_calls == 0
    assert canvas.paint_requests == 0


def test_close_from_before_draw_handler_skips_draw():
    CanvasCls, _loop = make_canvas_class()
    canvas = CanvasCls()
    canvas._draw_frame = canvas.count_draw(lambda: None)

    canvas.add_event_handler(lambda event: canvas.close(), "before_draw")
    canvas.force_draw()

    assert canvas.get_closed()
    assert canvas.draw_calls == 0
    assert canvas.context.present_calls == 0
    assert canvas.close_calls == 1


def test_time_to_draw_after_close_does_not_request_paint():
    # Use the screen present-method, because that path requests a paint.
    CanvasCls, _loop = make_canvas_class(present_to_screen=True)
    canvas = CanvasCls()
    canvas.close()

    canvas._time_to_draw()
    canvas._time_to_paint()
    canvas.force_draw()

    assert canvas.paint_requests == 0
    assert canvas.draw_calls == 0
    assert canvas.context.present_calls == 0


def test_request_draw_and_submit_event_after_close_have_no_effect():
    CanvasCls, loop = make_canvas_class(present_to_screen=True)
    canvas = CanvasCls()
    scheduler = get_scheduler(canvas)
    canvas.close()

    # The scheduler starts out with a draw requested; clear it so we can tell
    # whether a post-close request_draw() would set it again.
    scheduler._draw_requested = False

    init_count = loop.init_count
    seen = []
    canvas.add_event_handler(seen.append, "key_down")

    def new_draw():
        canvas.draw_calls += 1

    canvas.request_draw(new_draw)
    canvas.submit_event({"event_type": "key_down", "key": "a", "modifiers": ()})
    canvas.force_draw()
    canvas._time_to_draw()

    assert canvas.draw_calls == 0
    assert canvas.paint_requests == 0
    assert seen == []
    # The draw function must not be stored again, and the loop must not be
    # woken up or re-initialized.
    assert canvas._draw_frame is None
    assert not scheduler._draw_requested
    assert loop.init_count == init_count

    canvas._events.flush()
    assert seen == []


# ==================== events during close


def test_close_event_is_dispatched_after_pending_events_are_dropped():
    CanvasCls, _loop = make_canvas_class()
    canvas = CanvasCls()

    seen = []

    @canvas.add_event_handler("*")
    def handler(event):
        seen.append(event["event_type"])

    canvas.submit_event({"event_type": "resize", "width": 10, "height": 10})
    canvas.submit_event({"event_type": "key_down", "key": "a", "modifiers": ()})
    canvas.close()

    assert seen == ["close"]
    assert canvas._events._closed
    assert len(canvas._events._pending_events) == 0
    assert len(canvas._events._event_handlers) == 0


def test_event_merging_before_close():
    CanvasCls, _loop = make_canvas_class()
    canvas = CanvasCls()

    seen = []

    @canvas.add_event_handler("*")
    def handler(event):
        seen.append(event["event_type"])

    # Flush a merged pair, then close while more events are pending.
    canvas.submit_event({"event_type": "wheel", "dx": 1, "dy": 0, "modifiers": ()})
    canvas.submit_event({"event_type": "wheel", "dx": 2, "dy": 0, "modifiers": ()})
    canvas._events.flush()
    assert seen == ["wheel"]

    canvas.submit_event({"event_type": "wheel", "dx": 3, "dy": 0, "modifiers": ()})
    canvas.close()
    assert seen == ["wheel", "close"]


# ==================== loop lifetime


def test_closing_last_canvas_stops_loop_and_prevents_restart():
    CanvasCls, loop = make_canvas_class()
    canvas = CanvasCls()
    assert loop.init_count == 1
    assert loop._BaseLoop__state != "off"

    canvas.close()

    assert loop._BaseLoop__state == "off"
    assert loop.stop_count == 1
    assert loop.get_canvases() == []

    # Subsequent requests from the closed canvas must not restart the loop.
    canvas.request_draw(lambda: None)
    canvas.force_draw()
    canvas.submit_event({"event_type": "key_down", "key": "a", "modifiers": ()})

    assert loop._BaseLoop__state == "off"
    assert loop.init_count == 1
    assert canvas.draw_calls == 0


def test_closing_one_of_two_canvases_keeps_loop_running():
    CanvasCls, loop = make_canvas_class()
    canvas1 = CanvasCls()
    canvas2 = CanvasCls()

    canvas1.close()
    assert loop._BaseLoop__state != "off"
    assert loop.stop_count == 0
    assert loop.get_canvases() == [canvas2]

    canvas2.close()
    assert loop._BaseLoop__state == "off"
    assert loop.stop_count == 1


# ==================== scheduler consistency on cancelled/errored draws


def _prepare_waiting_scheduler(canvas):
    scheduler = get_scheduler(canvas)
    wait_event = Event()
    scheduler._ready_for_present = wait_event
    return scheduler, wait_event


def test_draw_cancelled_restores_scheduler_state():
    CanvasCls, _loop = make_canvas_class()
    canvas = CanvasCls()
    scheduler, wait_event = _prepare_waiting_scheduler(canvas)

    def draw():
        raise DrawCancelled()

    canvas._draw_frame = canvas.count_draw(draw)
    canvas._time_to_draw()

    # The scheduler must not be stuck waiting for a frame that will never come.
    assert scheduler._ready_for_present is None
    assert wait_event._is_set
    assert not canvas._BaseRenderCanvas__is_drawing

    # And the canvas can draw normally again.
    canvas._draw_frame = canvas.count_draw(lambda: None)
    canvas.force_draw()
    assert canvas.draw_calls == 2

    canvas.close()


def test_draw_error_restores_scheduler_state():
    CanvasCls, _loop = make_canvas_class()
    canvas = CanvasCls()
    scheduler, wait_event = _prepare_waiting_scheduler(canvas)

    def draw():
        raise ValueError("boom")

    canvas._draw_frame = canvas.count_draw(draw)
    canvas._time_to_draw()

    assert scheduler._ready_for_present is None
    assert wait_event._is_set
    assert not canvas._BaseRenderCanvas__is_drawing

    # The canvas remains usable after a draw error.
    canvas._draw_frame = canvas.count_draw(lambda: None)
    canvas.force_draw()
    assert canvas.draw_calls == 2

    canvas.close()


def test_close_during_draw_restores_scheduler_state():
    CanvasCls, _loop = make_canvas_class()
    canvas = CanvasCls()
    scheduler, wait_event = _prepare_waiting_scheduler(canvas)

    def draw():
        canvas.close()

    canvas._draw_frame = canvas.count_draw(draw)
    canvas._time_to_draw()

    assert canvas.get_closed()
    assert scheduler._ready_for_present is None
    assert wait_event._is_set
    assert not canvas._BaseRenderCanvas__is_drawing
    assert canvas.context.present_calls == 0


def test_finish_present_after_close_does_not_touch_backend():
    # Async presents may complete after the canvas is closed.
    CanvasCls, _loop = make_canvas_class()
    canvas = CanvasCls()
    canvas.close()

    canvas._finish_present({"method": "bitmap", "data": b"", "format": "rgba-u8"})

    assert canvas.paint_requests == 0


def test_close_releases_scheduler_waiting_for_draw():
    # Two canvases, so the loop keeps running when the first one closes.
    CanvasCls, _loop = make_canvas_class()
    canvas1 = CanvasCls()
    canvas2 = CanvasCls()

    scheduler, wait_event = _prepare_waiting_scheduler(canvas1)
    canvas1.close()

    # The scheduler must be released, otherwise its task hangs on the event.
    assert scheduler._ready_for_present is None
    assert wait_event._is_set

    canvas2.close()


def _run_loop_for(loop, duration, *, stop_when_off=False):
    """Run the (stub) loop for the given duration."""
    etime = time.perf_counter() + duration
    while time.perf_counter() < etime:
        if stop_when_off and loop._BaseLoop__state == "off":
            return
        time.sleep(0.001)
        loop.run()


def test_end_to_end_close_while_drawing():
    # A full run through the real scheduler: the draw function closes the
    # canvas, and we verify that no further draws happen afterwards.
    CanvasCls, loop = make_canvas_class(present_to_screen=False)
    canvas = CanvasCls(max_fps=100, update_mode="ondemand")

    def draw():
        canvas.draw_calls += 1
        if canvas.draw_calls == 1:
            canvas.close()

    canvas._draw_frame = draw
    canvas.request_draw()

    _run_loop_for(loop, 0.2, stop_when_off=True)

    assert canvas.get_closed()
    assert canvas.draw_calls == 1
    assert canvas.close_calls == 1
    assert canvas.context.present_calls == 0
    assert loop._BaseLoop__state == "off"
    assert loop.stop_count == 1
    assert loop.init_count == 1

    # Asking for more draws must not draw again, nor re-initialize the loop.
    canvas.request_draw(lambda: None)
    canvas._time_to_draw()
    assert canvas.draw_calls == 1
    assert canvas.paint_requests == 0
    assert loop.init_count == 1
    assert loop._BaseLoop__state == "off"


if __name__ == "__main__":
    run_tests(globals())
