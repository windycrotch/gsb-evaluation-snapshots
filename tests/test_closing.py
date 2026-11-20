# ruff: noqa: N806
"""
Test the closing flow of the canvas: once closed, a canvas is final.

This covers the interplay between BaseRenderCanvas, EventEmitter, Scheduler and
SizeInfo. We use local canvas classes, so no real GUI window is needed.
"""

import time

from testutils import run_tests

from rendercanvas.base import BaseCanvasGroup, BaseRenderCanvas
from rendercanvas.offscreen import StubLoop


class MyCanvasGroup(BaseCanvasGroup):
    pass


class MyLoop(StubLoop):
    """A non-blocking loop: ``run()`` does one iteration of pending tasks."""

    def __init__(self):
        super().__init__()
        self.init_count = 0

    def _rc_init(self):
        self.init_count += 1


class MyContext:
    """A minimal canvas context that can be told to fail."""

    def __init__(self):
        self.closed = False
        self.close_count = 0
        self.present_count = 0
        self.present_after_close = 0
        self.present_error = None
        self.present_callback = None

    def _rc_present(self, force_sync=False):
        if self.closed:
            self.present_after_close += 1
        self.present_count += 1
        if self.present_callback is not None:
            self.present_callback()
        if self.present_error is not None:
            raise self.present_error
        return {"method": "skip"}

    def _rc_close(self):
        self.close_count += 1
        self.closed = True

    def _rc_set_size_dict(self, size_info):
        self.size_dict = size_info


def make_canvas_class(loop=None):
    """Create a fresh canvas class, with its own group and loop."""

    if loop is None:
        loop = MyLoop()

    class MyCanvas(BaseRenderCanvas):
        _rc_canvas_group = MyCanvasGroup(loop)

        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.draw_count = 0
            self.draw_requests = 0
            self.paint_requests = 0
            self.force_paints = 0
            self.gui_polls = 0
            self.rc_close_count = 0
            self._present_to_screen = False
            self.context = MyContext()
            self._canvas_context = self.context
            self._size_info.set_physical_size(100, 100, 1)

        def _rc_gui_poll(self):
            self.gui_polls += 1

        def _rc_request_draw(self):
            self.draw_requests += 1
            self._time_to_draw()

        def _rc_request_paint(self):
            self.paint_requests += 1

        def _rc_force_paint(self):
            self.force_paints += 1
            self._time_to_paint()

        def _rc_close(self):
            self.rc_close_count += 1
            if self.on_rc_close is not None:
                self.on_rc_close()

        on_rc_close = None

        def _draw_frame(self):
            self.draw_count += 1

        def active_sleep(self, delay):
            loop = self._rc_canvas_group.get_loop()
            etime = time.perf_counter() + delay
            while time.perf_counter() < etime:
                time.sleep(0.001)
                loop.run()

    return MyCanvas, loop


def get_scheduler(canvas):
    return canvas._BaseRenderCanvas__scheduler


def get_is_drawing(canvas):
    return canvas._BaseRenderCanvas__is_drawing


# ==================== Normal close


def test_close_after_normal_draw():
    MyCanvas, loop = make_canvas_class()
    canvas = MyCanvas()

    canvas.request_draw(lambda: setattr(canvas, "draw_count", canvas.draw_count + 1))
    canvas.force_draw()
    assert canvas.draw_count == 1
    assert canvas.context.present_count == 1
    assert not canvas.get_closed()

    canvas.close()

    # Closed is immediately visible
    assert canvas.get_closed()
    # Cleanup is complete
    assert canvas.rc_close_count == 1
    assert canvas.context.closed
    assert canvas.context.close_count == 1
    assert canvas._canvas_context is None
    assert canvas._draw_frame is None
    assert canvas._events._closed
    assert not canvas._events._pending_events
    assert not canvas._events._event_handlers
    assert loop.get_canvases() == []
    assert loop._BaseLoop__state == "off"

    # Closing again is a no-op, and does not raise or close twice
    canvas.close()
    canvas.close()
    assert canvas.rc_close_count == 1
    assert canvas.context.close_count == 1


def test_after_close_calls_are_noops():
    MyCanvas, loop = make_canvas_class()
    canvas = MyCanvas()
    canvas.request_draw(lambda: setattr(canvas, "draw_count", canvas.draw_count + 1))
    canvas.force_draw()
    canvas.close()

    draw_count = canvas.draw_count
    present_count = canvas.context.present_count
    paint_requests = canvas.paint_requests
    force_paints = canvas.force_paints
    gui_polls = canvas.gui_polls
    init_count = loop.init_count

    # All of these must be safe no-ops (i.e. not raise)
    canvas.request_draw(lambda: setattr(canvas, "draw_count", canvas.draw_count + 1))
    canvas.force_draw()
    canvas.submit_event({"event_type": "key_down", "key": "a", "modifiers": ()})
    canvas.add_event_handler(lambda e: None, "key_down")
    canvas._time_to_draw()
    canvas._time_to_paint()
    canvas._process_events()
    canvas._final_canvas_init()

    # And must not have done anything
    assert canvas.draw_count == draw_count
    assert canvas.context.present_count == present_count
    assert canvas.paint_requests == paint_requests
    assert canvas.force_paints == force_paints
    assert canvas.gui_polls == gui_polls
    assert not canvas._events._pending_events
    assert not canvas._events._event_handlers

    # Crucially, the loop must not have been re-initialized (i.e. pulled up again)
    assert loop.init_count == init_count
    assert loop._BaseLoop__state == "off"


# ==================== Pending events


def test_pending_events_are_dropped_not_replayed():
    MyCanvas, _loop = make_canvas_class()
    canvas = MyCanvas()

    received = []
    canvas.add_event_handler(lambda e: received.append(e), "*")

    # Submitted but not yet flushed. Consecutive pointer_move and wheel
    # events get merged while pending.
    canvas.submit_event({"event_type": "pointer_move", "x": 1, "y": 1, "modifiers": ()})
    canvas.submit_event({"event_type": "pointer_move", "x": 2, "y": 2, "modifiers": ()})
    canvas.submit_event({"event_type": "wheel", "dx": 1, "dy": 0, "modifiers": ()})
    canvas.submit_event({"event_type": "wheel", "dx": 1, "dy": 0, "modifiers": ()})
    assert len(canvas._events._pending_events) == 2

    canvas.close()

    # The merged events are cleared on close; only the close event itself is
    # dispatched (once).
    assert len(canvas._events._pending_events) == 0
    assert [e["event_type"] for e in received] == ["close"]

    # Neither a manual flush, nor an event-loop tick dispatches them.
    canvas._events.flush()
    canvas._process_events()
    assert [e["event_type"] for e in received] == ["close"]

    # Events submitted after closing are ignored (not queued, not replayed).
    canvas.submit_event({"event_type": "key_down", "key": "a", "modifiers": ()})
    assert len(canvas._events._pending_events) == 0
    canvas._events.flush()
    canvas._process_events()
    assert [e["event_type"] for e in received] == ["close"]


def test_close_event_is_emitted_and_handlers_cleared():
    MyCanvas, _loop = make_canvas_class()
    canvas = MyCanvas()

    received = []
    canvas.add_event_handler(lambda e: received.append(e["event_type"]), "*")

    canvas.close()

    # The close event itself is still dispatched (once), after which the
    # handlers are gone.
    assert received == ["close"]
    assert not canvas._events._event_handlers


def test_close_twice_from_close_handler_does_not_recurse():
    MyCanvas, _loop = make_canvas_class()
    canvas = MyCanvas()

    calls = []

    def handler(event):
        calls.append(event["event_type"])
        # Closing again from within the close event must be a safe no-op.
        canvas.close()

    canvas.add_event_handler(handler, "*")
    canvas.close()

    assert calls == ["close"]
    assert canvas.get_closed()
    assert canvas.rc_close_count == 1
    assert canvas.context.close_count == 1


# ==================== The 'screen' present path


def test_closed_canvas_ignores_paint_requests():
    MyCanvas, _loop = make_canvas_class()

    class ScreenCanvas(MyCanvas):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._present_to_screen = True
            self.paint_calls = 0

        def _rc_force_paint(self):
            self.paint_calls += 1
            self._time_to_paint()  # -> _draw_and_present

    canvas = ScreenCanvas()
    canvas.request_draw(lambda: setattr(canvas, "draw_count", canvas.draw_count + 1))

    canvas.force_draw()
    assert canvas.draw_count == 1
    assert canvas.context.present_count == 1

    canvas.close()
    draw_count = canvas.draw_count
    present_count = canvas.context.present_count

    # A paint that the backend had already scheduled, arrives after closing.
    canvas._time_to_paint()
    assert canvas.draw_count == draw_count
    assert canvas.context.present_count == present_count
    assert canvas.context.present_after_close == 0

    # And a new force_draw does not reach the backend either.
    canvas.force_draw()
    canvas._time_to_draw()
    assert canvas.draw_count == draw_count
    assert canvas.context.present_count == present_count
    assert canvas.context.present_after_close == 0


# ==================== Closing from within a draw


def test_close_inside_draw_callback():
    MyCanvas, loop = make_canvas_class()
    canvas = MyCanvas()

    def draw():
        canvas.draw_count += 1
        canvas.close()

    canvas.request_draw(draw)
    canvas.force_draw()

    # The draw ran once, but nothing was presented afterwards.
    assert canvas.draw_count == 1
    assert canvas.context.present_count == 0
    assert canvas.context.present_after_close == 0
    assert canvas.get_closed()

    # Cleanup is complete.
    assert canvas.context.closed
    assert canvas._canvas_context is None
    assert canvas._draw_frame is None
    assert canvas._events._closed

    # The drawing flag is reset, and the scheduler is not left waiting.
    assert not get_is_drawing(canvas)
    scheduler = get_scheduler(canvas)
    assert scheduler._ready_for_present is None

    # Drawing again is a no-op.
    canvas.force_draw()
    canvas._time_to_draw()
    canvas._time_to_paint()
    assert canvas.draw_count == 1
    assert canvas.context.present_count == 0
    assert loop._BaseLoop__state == "off"


def test_close_inside_draw_callback_via_scheduler():
    MyCanvas, loop = make_canvas_class()
    canvas = MyCanvas(min_fps=0.000001, max_fps=100, update_mode="ondemand")

    def draw():
        canvas.draw_count += 1
        canvas.close()

    canvas.request_draw(draw)

    # Drive the loop until the canvas closes (but do not keep driving it after).
    etime = time.perf_counter() + 1.0
    while not canvas.get_closed() and time.perf_counter() < etime:
        loop.run()
        time.sleep(0.005)

    assert canvas.draw_count == 1
    assert canvas.get_closed()
    assert canvas.context.present_count == 0
    assert loop.get_canvases() == []
    # The loop is stopped, i.e. not left spinning on a closed canvas.
    assert loop._BaseLoop__state == "off"

    # Running the loop some more does not make the closed canvas draw again.
    draw_count = canvas.draw_count
    polls = canvas.gui_polls
    for _ in range(10):
        loop.run()
        time.sleep(0.005)
    assert canvas.draw_count == draw_count
    assert canvas.gui_polls == polls
    assert loop.get_canvases() == []


def test_close_inside_event_handler():
    MyCanvas, _loop = make_canvas_class()
    canvas = MyCanvas()

    received = []

    def handler(event):
        received.append(event["event_type"])
        if event["event_type"] == "key_down":
            canvas.close()

    canvas.add_event_handler(handler, "*")
    canvas.submit_event({"event_type": "key_down", "key": "a", "modifiers": ()})
    canvas.submit_event({"event_type": "key_up", "key": "a", "modifiers": ()})

    # Process the pending events without also emitting a resize event.
    canvas._events.flush()

    # Only the event that triggered the close was handled; the queued key_up is
    # dropped, and (in particular) the close event is dispatched exactly once.
    assert received == ["key_down", "close"]
    assert canvas.get_closed()
    assert canvas._events._closed


# ==================== Errors during close / present


def test_present_error_does_not_wedge_the_scheduler(caplog):
    MyCanvas, loop = make_canvas_class()
    canvas = MyCanvas(update_mode="ondemand", max_fps=100)

    canvas.context.present_error = RuntimeError("mock-present-failure-xyz")

    def draw():
        canvas.draw_count += 1

    canvas.request_draw(draw)
    canvas.force_draw()

    # The error is logged, not raised out of force_draw.
    assert "mock-present-failure-xyz" in caplog.text
    assert canvas.draw_count == 1
    # The draw is not stuck: the flag is reset and the scheduler is released.
    assert not get_is_drawing(canvas)
    scheduler = get_scheduler(canvas)
    assert scheduler._ready_for_present is None

    # And we can still draw and close normally.
    canvas.context.present_error = None
    canvas.force_draw()
    assert canvas.draw_count == 2
    assert canvas.context.present_count == 2

    canvas.close()
    assert canvas.get_closed()
    assert loop._BaseLoop__state == "off"


def test_close_with_failing_present_still_cleans_up(caplog):
    MyCanvas, loop = make_canvas_class()
    canvas = MyCanvas()

    # Present fails, and closing happens from within the failure handling.
    def present_callback():
        canvas.close()

    canvas.context.present_error = RuntimeError("mock-present-close-failure-abc")
    canvas.context.present_callback = present_callback

    canvas.request_draw(lambda: setattr(canvas, "draw_count", 1))
    canvas.force_draw()

    assert "mock-present-close-failure-abc" in caplog.text
    # Despite the error, the canvas closed cleanly and completely.
    assert canvas.get_closed()
    assert canvas.context.closed
    assert canvas._canvas_context is None
    assert canvas._draw_frame is None
    assert canvas._events._closed
    assert not get_is_drawing(canvas)
    assert loop._BaseLoop__state == "off"


def test_close_with_failing_rc_close_still_cleans_up():
    MyCanvas, loop = make_canvas_class()
    canvas = MyCanvas()

    def fail():
        raise RuntimeError("mock-rc-close-failure")

    canvas.on_rc_close = fail

    try:
        canvas.close()
    except RuntimeError as err:
        assert "mock-rc-close-failure" in str(err)
    else:  # pragma: no cover
        raise AssertionError("close() should have raised the backend error")

    # get_closed() was true all along, and the rest of the cleanup still ran.
    assert canvas.get_closed()
    assert canvas.context.closed
    assert canvas._canvas_context is None
    assert canvas._draw_frame is None
    assert canvas._events._closed
    assert loop.get_canvases() == []

    # Closing again is a silent no-op (no repeated error).
    canvas.close()
    canvas.close()
    assert canvas.rc_close_count == 1
    assert canvas.context.close_count == 1


def test_close_while_drawing_flag_reset():
    # A close that happens while the draw-flag is set must not leave the canvas
    # permanently "drawing" (which would block future force_draw calls).
    MyCanvas, _loop = make_canvas_class()
    canvas = MyCanvas()

    def draw():
        canvas.close()

    canvas.request_draw(draw)
    canvas.force_draw()

    assert not get_is_drawing(canvas)
    # force_draw on a closed canvas is a no-op instead of raising.
    canvas.force_draw()


# ==================== Async present finishing after close


def test_async_present_finishes_after_close():
    MyCanvas, _loop = make_canvas_class()
    canvas = MyCanvas()

    canvas.request_draw(lambda: setattr(canvas, "draw_count", 1))
    canvas.force_draw()
    present_count = canvas.context.present_count

    canvas.close()

    # Simulate an async present that completes after closing.
    canvas._finish_present({"method": "skip"})

    assert canvas.context.present_count == present_count
    assert canvas.context.present_after_close == 0
    assert canvas.paint_requests == 0  # the late 'skip' would have triggered one
    scheduler = get_scheduler(canvas)
    assert scheduler._ready_for_present is None


# ==================== Multiple canvases on one loop


def test_closing_one_canvas_does_not_affect_the_others():
    MyCanvas, loop = make_canvas_class()
    canvas1 = MyCanvas()
    canvas2 = MyCanvas()

    for c in (canvas1, canvas2):
        c.request_draw(lambda c=c: setattr(c, "draw_count", c.draw_count + 1))

    canvas1.force_draw()
    canvas2.force_draw()
    assert canvas1.draw_count == 1
    assert canvas2.draw_count == 1
    assert len(loop.get_canvases()) == 2

    canvas1.close()

    # The loop keeps running for the other canvas.
    assert canvas1.get_closed()
    assert not canvas2.get_closed()
    assert loop.get_canvases() == [canvas2]
    assert loop._BaseLoop__state != "off"

    # The other canvas still draws and presents normally.
    canvas2.force_draw()
    assert canvas2.draw_count == 2
    assert canvas2.context.present_count == 2
    assert canvas2.context.present_after_close == 0

    # Events still work for the other canvas.
    received = []
    canvas2.add_event_handler(lambda e: received.append(e["event_type"]), "*")
    canvas2.submit_event({"event_type": "key_down", "key": "a", "modifiers": ()})
    canvas2._events.flush()
    assert received == ["key_down"]

    # Closing the second one does stop the loop.
    canvas2.close()
    assert loop.get_canvases() == []
    assert loop._BaseLoop__state == "off"


def test_closing_one_canvas_leaves_scheduler_of_other_working():
    MyCanvas, loop = make_canvas_class()
    canvas1 = MyCanvas(min_fps=0.000001, max_fps=100, update_mode="continuous")
    canvas2 = MyCanvas(min_fps=0.000001, max_fps=100, update_mode="continuous")

    canvas1.active_sleep(0.25)
    assert canvas1.draw_count > 0
    assert canvas2.draw_count > 0

    canvas1.close()
    count1 = canvas1.draw_count
    canvas2.draw_count = 0

    canvas2.active_sleep(0.15)

    # canvas1 no longer draws, canvas2 still does.
    assert canvas1.draw_count == count1
    assert canvas2.draw_count > 0
    assert loop._BaseLoop__state != "off"

    canvas2.close()
    assert loop._BaseLoop__state == "off"


# ==================== Size info


def test_pending_resize_is_cancelled_on_close():
    MyCanvas, _loop = make_canvas_class()
    canvas = MyCanvas()

    received = []
    canvas.add_event_handler(lambda e: received.append(e["event_type"]), "*")

    # A size change that has not been processed yet.
    canvas._size_info.set_physical_size(200, 200, 1)
    assert canvas._size_info["changed"] is True

    canvas.close()

    # The pending resize is cancelled, and not emitted later.
    assert canvas._size_info["changed"] is False
    canvas._process_events()
    assert "resize" not in received
    # The size values themselves remain readable.
    assert canvas.get_physical_size() == (200, 200)


if __name__ == "__main__":
    run_tests(globals())
