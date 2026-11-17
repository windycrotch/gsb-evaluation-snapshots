"""Offline tests for the scheduling rules in ``polyreel.scheduler``.

Every test uses fake ``Item`` objects (id, aspect, probed, error, resume_pos)
— no video files, no libmpv, no Qt.  The search budgets are disabled by the
autouse fixture in ``conftest.py``, so results are deterministic.
"""

import pytest

from polyreel import layout, scheduler
from polyreel.layout import Layout
from polyreel.playlist import Item, Playlists
from polyreel.scheduler import plan

W, H = 1600, 900


def make(*aspects):
    """Probed, error-free queue items with the given aspect ratios."""
    out = []
    for a in aspects:
        it = Item(f"/v/{len(out)}.mp4")
        it.aspect, it.probed = a, True
        out.append(it)
    return out


# ---------------------------------------------------------------- fill


def test_free_slots_are_filled_in_queue_order():
    playing = make(16 / 9, 16 / 9)
    q = make(16 / 9, 4 / 3, 9 / 16)
    p = plan(playing, q, W, H, max_streams=4, min_area=0.01)
    assert p.demote == []
    assert p.start == q[:2]                     # two free slots, first two queued
    assert p.layout.valid
    assert set(p.layout.rects) == {it.id for it in playing + q[:2]}


def test_bulk_fill_takes_the_longest_prefix_that_fits():
    q = make(*[16 / 9] * 20)
    p = plan([], q, W, H, max_streams=20, min_area=0.05)
    assert p.start == q[:16]                    # a prefix, in queue order
    assert p.layout.valid and p.layout.min_area >= 0.05
    assert len(p.layout.rects) == 16


# ------------------------------------------------------- probing & errors


def test_strict_order_waits_for_the_unprobed_head():
    q = make(16 / 9, 16 / 9, 16 / 9)
    q[0].probed = False                         # still being read
    p = plan([], q, W, H, max_streams=2, min_area=0.01, lookahead=1)
    assert p.start == []                        # later probed items may not jump ahead
    assert p.layout.tree is None
    q[0].probed = True                          # probing finishes: the head goes first
    p = plan([], q, W, H, max_streams=2, min_area=0.01, lookahead=1)
    assert p.start == q[:2]


def test_failed_probes_are_skipped_and_never_started():
    q = make(16 / 9, 16 / 9, 16 / 9)
    q[0].error = "could not read the file"      # probed, but broken
    p = plan([], q, W, H, max_streams=2, min_area=0.01, lookahead=1)
    assert p.start == q[1:]                     # skipped, but does not block the rest
    assert q[0] not in p.start
    # ...not even when it is the only candidate and slots are free.
    p = plan([], q[:1], W, H, max_streams=4, min_area=0.01)
    assert p.start == [] and p.layout.tree is None


def test_unprobed_head_does_not_block_when_lookahead_is_on():
    q = make(16 / 9, 9 / 16)
    q[0].probed = False
    p = plan([], q, W, H, max_streams=2, min_area=0.01, lookahead=2)
    assert p.start == [q[1]]


# -------------------------------------------------------------- lookahead


def test_lookahead_picks_the_candidate_that_fits_the_gap():
    # A portrait video is on the wall; the queue head is landscape, the next
    # one portrait.  Strict order takes the head; lookahead may prefer the
    # portrait one, which shares the wall more evenly.
    playing = make(9 / 16)
    q = make(16 / 9, 9 / 16)
    strict = plan(playing, q, W, H, max_streams=2, min_area=0.01, lookahead=1)
    loose = plan(playing, q, W, H, max_streams=2, min_area=0.01, lookahead=2)
    assert strict.start == [q[0]]
    assert loose.start == [q[1]]


def test_lookahead_never_reaches_beyond_the_first_n_candidates():
    playing = make(9 / 16)
    q = make(16 / 9, 16 / 9, 9 / 16)            # the good fit is third in line
    p = plan(playing, q, W, H, max_streams=2, min_area=0.01, lookahead=2)
    assert p.start == [q[0]]                    # only the first two were considered


# ---------------------------------------------------------------- demote


def test_over_the_stream_limit_demotes_newest_first_and_keeps_resume_pos():
    pl = Playlists()
    items = pl.add([f"/v/{i}.mp4" for i in range(5)])
    for it in items:
        it.aspect, it.probed = 16 / 9, True
        pl.start(it)                            # playing, oldest -> newest
    # The limit is lowered from 5 to 2: the newest three give way, most
    # recent first, before anything else happens.
    p = plan(list(pl.playing), list(pl.queued), W, H, max_streams=2, min_area=0.01)
    assert p.demote == items[4:1:-1]
    assert p.start == []
    # Applied the way the main window applies it: each bumped video goes back
    # to the front of the queue with the position it stopped at.
    positions = {it.id: 10.0 + i for i, it in enumerate(items)}
    for it in p.demote:
        pl.demote(it, positions[it.id])
    assert pl.playing == items[:2]
    assert pl.queued == items[2:]               # front of the queue, in start order
    assert [it.resume_pos for it in pl.queued] == [12.0, 13.0, 14.0]
    # When slots free up they start again, and planning never touches
    # resume_pos: the player seeks to where each one stopped.
    p2 = plan(list(pl.playing), list(pl.queued), W, H, max_streams=4, min_area=0.01)
    assert p2.start == items[2:4]
    assert [it.resume_pos for it in p2.start] == [12.0, 13.0]


def test_shrinking_window_demotes_one_by_one_until_the_layout_fits():
    playing = make(*[16 / 9] * 6)
    # Same videos, less room (a higher minimum size per video): six no longer
    # fit, five still don't, four do — the newest give way one at a time.
    p = plan(playing, [], W, H, max_streams=6, min_area=0.2)
    assert p.demote == playing[5:3:-1]          # newest first, exactly two
    assert p.start == []
    assert p.layout.valid and p.layout.min_area >= 0.2
    assert set(p.layout.rects) == {it.id for it in playing[:4]}


# ------------------------------------------------------- budget & fallback


class _Clock:
    """Deterministic stand-in for ``time.monotonic`` inside the scheduler."""

    def __init__(self, readings):
        self._readings = iter(readings)

    def monotonic(self):
        return next(self._readings, 1e9)


def test_running_out_of_time_returns_a_partial_plan_marked_more(monkeypatch):
    monkeypatch.setattr(scheduler, "FILL_BUDGET", 0.15)
    # Deadline is computed, two slots are filled, then the budget is spent.
    monkeypatch.setattr(scheduler, "time", _Clock([0.0, 0.0, 0.0, 1.0]))
    q = make(*[16 / 9] * 4)
    p = plan([], q, W, H, max_streams=3, min_area=0.01)
    assert p.start == q[:2]                     # what was decided is returned
    assert p.more is True                       # ...and the rest is left for later


def test_invalid_final_layout_falls_back_to_the_quick_search(monkeypatch):
    real_solve = layout.solve
    seen = []

    def wandering(items, width, height, min_area=0.0, prev=None, effort=1.0,
                  seed=None, budget=..., crop=0.0):
        lay = real_solve(items, width, height, min_area, prev, effort=effort,
                         seed=seed, budget=budget, crop=crop)
        if effort == 1.0:
            lay.valid = False                   # the thorough search "wandered"
        seen.append(effort)
        return lay

    monkeypatch.setattr(scheduler, "solve", wandering)
    q = make(16 / 9, 16 / 9)
    p = plan([], q, W, H, max_streams=2, min_area=0.01)
    assert p.layout.valid                       # the quick search's layout is used
    assert set(p.layout.rects) == {it.id for it in q}
    assert 1.0 in seen and 0.0 in seen


def test_an_invalid_layout_is_never_applied(monkeypatch):
    def hopeless(items, width, height, min_area=0.0, prev=None, effort=1.0,
                 seed=None, budget=..., crop=0.0):
        return Layout(tree=None, valid=False)

    monkeypatch.setattr(scheduler, "solve", hopeless)
    q = make(16 / 9, 16 / 9, 16 / 9)
    p = plan([], q, W, H, max_streams=4, min_area=0.01)
    assert p.start == q[:1]                     # one video always gets a chance
    assert p.layout.tree is None and not p.layout.rects
