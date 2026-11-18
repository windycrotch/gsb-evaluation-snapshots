"""
Test that a size change is consumed once, right before a draw.

The resize event must be emitted before the 'before_draw' event, and must
describe the same size that the draw uses. A cancelled draw must not consume
the size change, and a size change during a draw must result in a new draw.
"""

import time

from testutils import run_tests

from rendercanvas.base import BaseCanvasGroup, BaseRenderCanvas
from rendercanvas.offscreen import StubLoop


class StubContext:
    """A context that records the size info that it is given."""

    def __init__(self):
        self.size_info = None
        # Snapshots of the size at the moment it was passed to the context.
        self.size_history = []

    def _rc_set_size_dict(self, size_info):
        self.size_info = size_info
        self.size_history.append(
            {
                "physical_size": size_info["physical_size"],
                "logical_size": size_info["logical_size"],
                "pixel_ratio": size_info["total_pixel_ratio"],
            }
        )

    def _rc_present(self, force_sync=False):
        return {"method": "skip"}

    def _rc_close(self):
        pass


class ResizeCanvasGroup(BaseCanvasGroup):
    pass


class ResizeLoop(StubLoop):
    pass


class ResizeCanvas(BaseRenderCanvas):
    """A canvas that records the order of resize and before_draw events."""

    def __init__(self, *args, update_mode="manual", **kwargs):
        super().__init__(*args, update_mode=update_mode, **kwargs)
        self.draw_count = 0
        self.events = []
        self._present_to_screen = False
        self._canvas_context = StubContext()
        self.add_event_handler(self._on_event, "resize", "before_draw")

    def _on_event(self, event):
        self.events.append(event)

    def get_resize_events(self):
        return [event for event in self.events if event["event_type"] == "resize"]

    def active_sleep(self, delay):
        loop = self._rc_canvas_group.get_loop()
        etime = time.perf_counter() + delay
        while time.perf_counter() < etime:
            time.sleep(0.001)
            loop.run()


def make_canvas(*, update_mode="manual", use_loop=False):
    """Create a canvas class with its own (fresh) canvas group."""
    loop = ResizeLoop() if use_loop else None
    group = ResizeCanvasGroup(loop)

    class TheCanvas(ResizeCanvas):
        _rc_canvas_group = group

    return TheCanvas(update_mode=update_mode, max_fps=100)


def test_resize_is_emitted_before_first_draw():
    canvas = make_canvas()
    canvas._size_info.set_physical_size(100, 50, 2.0)
    assert canvas._size_info["changed"] is True

    def draw():
        canvas.draw_count += 1

    canvas.request_draw(draw)
    canvas.force_draw()

    assert canvas.draw_count == 1
    # The resize event precedes the draw, with the drawn (logical) size.
    assert [e["event_type"] for e in canvas.events] == ["resize", "before_draw"]
    resize_event = canvas.events[0]
    assert resize_event["width"] == 50.0
    assert resize_event["height"] == 25.0
    assert resize_event["pixel_ratio"] == 2.0

    # The size change is consumed, and the context has the latest size.
    assert canvas._size_info["changed"] is False
    assert canvas._canvas_context.size_info is canvas._size_info
    assert canvas._canvas_context.size_info["physical_size"] == (100, 50)
    assert canvas._canvas_context.size_info["logical_size"] == (50.0, 25.0)
    assert canvas._canvas_context.size_info["total_pixel_ratio"] == 2.0

    # A next draw without a size change does not emit a resize.
    canvas.force_draw()
    assert canvas.draw_count == 2
    assert [e["event_type"] for e in canvas.events] == [
        "resize",
        "before_draw",
        "before_draw",
    ]

    # A new size is applied before the next draw, both in event and context.
    canvas._size_info.set_physical_size(200, 100, 1.0)
    canvas.force_draw()
    assert canvas.draw_count == 3
    assert [e["event_type"] for e in canvas.events][-2:] == ["resize", "before_draw"]
    assert canvas.events[-2]["width"] == 200.0
    assert canvas.events[-2]["height"] == 100.0
    assert canvas.events[-2]["pixel_ratio"] == 1.0
    assert canvas._canvas_context.size_info["logical_size"] == (200.0, 100.0)
    assert canvas._canvas_context.size_info["total_pixel_ratio"] == 1.0
    assert canvas._size_info["changed"] is False

    canvas.close()


def test_resize_during_draw_keeps_changed():
    canvas = make_canvas(update_mode="manual")
    canvas._size_info.set_physical_size(100, 100, 1.0)

    def draw():
        canvas.draw_count += 1
        if canvas.draw_count == 1:
            canvas._size_info.set_physical_size(200, 200, 1.0)

    canvas.request_draw(draw)
    canvas.force_draw()

    # The change made during the draw is not consumed by that draw.
    assert canvas.draw_count == 1
    assert canvas._size_info["changed"] is True
    # The first draw used (and reported) the old size. Note that the context's
    # size dict is the same object, so we check the recorded history.
    assert len(canvas.get_resize_events()) == 1
    assert canvas.get_resize_events()[0]["width"] == 100.0
    assert canvas._canvas_context.size_history[-1]["logical_size"] == (100.0, 100.0)

    # The next draw consumes the new size, so the context is up-to-date again.
    canvas.force_draw()
    assert canvas.draw_count == 2
    assert canvas._size_info["changed"] is False
    assert len(canvas.get_resize_events()) == 2
    assert canvas.get_resize_events()[1]["width"] == 200.0
    assert canvas._canvas_context.size_history[-1]["logical_size"] == (200.0, 200.0)

    canvas.close()


def test_resize_during_draw_triggers_next_draw():
    canvas = make_canvas(update_mode="ondemand", use_loop=True)
    canvas._size_info.set_physical_size(100, 100, 1.0)

    def draw():
        canvas.draw_count += 1
        if canvas.draw_count == 1:
            # Change the size during the draw; the change is not consumed by
            # this draw, so the scheduler should draw again.
            canvas._size_info.set_physical_size(200, 200, 1.0)

    canvas.request_draw(draw)

    # Wait for the first (and, due to the resize, second) draw.
    canvas.active_sleep(0.3)

    assert canvas.draw_count == 2
    # The size changed during the first draw; the second draw consumes it.
    assert canvas._size_info["changed"] is False

    resize_events = canvas.get_resize_events()
    assert [e["width"] for e in resize_events] == [100.0, 200.0]
    # Each resize precedes its draw.
    event_types = [e["event_type"] for e in canvas.events]
    assert event_types == ["resize", "before_draw", "resize", "before_draw"]

    canvas.close()


def test_cancelled_draw_without_context_does_not_consume():
    canvas = make_canvas()
    context = canvas._canvas_context
    canvas._canvas_context = None
    canvas._size_info.set_physical_size(100, 100, 1.0)

    canvas.request_draw(lambda: None)

    # No context: the draw is cancelled and the change is not consumed.
    canvas.force_draw()
    assert canvas._size_info["changed"] is True
    assert canvas.get_resize_events() == []

    # With a context, the next draw reports the size.
    canvas._canvas_context = context
    canvas.force_draw()
    assert canvas._size_info["changed"] is False
    resize_events = canvas.get_resize_events()
    assert len(resize_events) == 1
    assert resize_events[0]["width"] == 100.0
    assert resize_events[0]["height"] == 100.0
    assert context.size_info["physical_size"] == (100, 100)

    canvas.close()


def test_zero_size_does_not_consume_size_change():
    canvas = make_canvas()
    canvas._size_info.set_physical_size(0, 0, 1.0)
    assert canvas._size_info["changed"] is True

    def draw():
        canvas.draw_count += 1

    canvas.request_draw(draw)

    # The draw is cancelled because the size is zero.
    canvas.force_draw()
    assert canvas.draw_count == 0
    assert canvas._size_info["changed"] is True

    # The next valid draw still reports the (new) size.
    canvas._size_info.set_physical_size(100, 100, 1.0)
    canvas.force_draw()
    assert canvas.draw_count == 1
    assert canvas._size_info["changed"] is False
    resize_events = canvas.get_resize_events()
    assert len(resize_events) == 1
    assert resize_events[0]["width"] == 100.0
    assert resize_events[0]["height"] == 100.0

    canvas.close()


def test_manual_mode_resize_does_not_draw():
    canvas = make_canvas(update_mode="manual", use_loop=True)

    def draw():
        canvas.draw_count += 1

    canvas.request_draw(draw)
    canvas._size_info.set_physical_size(100, 100, 1.0)

    # The scheduler processes events, but does not draw.
    canvas.active_sleep(0.2)
    assert canvas.draw_count == 0
    assert canvas._size_info["changed"] is True
    # The resize is reported (once), even though no draw is done.
    assert len(canvas.get_resize_events()) == 1

    # Only a forced draw draws, and consumes the size change.
    canvas.force_draw()
    assert canvas.draw_count == 1
    assert canvas._size_info["changed"] is False
    assert len(canvas.get_resize_events()) == 1

    canvas.close()


def test_same_size_twice_does_not_emit_resize_twice():
    canvas = make_canvas()

    def draw():
        canvas.draw_count += 1

    canvas.request_draw(draw)

    # Two size "changes" with the same dimensions.
    canvas._size_info.set_physical_size(100, 100, 1.0)
    canvas._size_info.set_physical_size(100, 100, 1.0)
    assert canvas._size_info["changed"] is True

    canvas.force_draw()
    canvas.force_draw()
    assert canvas.draw_count == 2
    assert len(canvas.get_resize_events()) == 1

    # Even when the backend reports the same size again later.
    canvas._size_info.set_physical_size(100, 100, 1.0)
    canvas.force_draw()
    assert canvas.draw_count == 3
    assert len(canvas.get_resize_events()) == 1

    canvas.close()


if __name__ == "__main__":
    run_tests(globals())
