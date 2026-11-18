import math

import numpy as np

from impasto import tour


def cost(sections, start, ids, flips, weight):
    t = 0.0
    cx, cy = start
    for k, f in zip(ids, flips):
        a, b, _ = sections[k]
        e, x = (b, a) if f else (a, b)
        t += math.hypot(e[0] - cx, e[1] - cy)
        cx, cy = x
    down = sum(max(0.0, (sections[k][2] if f else -sections[k][2])) for k, f in zip(ids, flips))
    return t, down, t + weight * down


def flip_of(order, flips, section):
    return flips[order.index(section)]


def test_permutation_and_cost_report():
    segs = [((0, 0), (5, 0), 0.3), ((5, 1), (10, 1), -0.4), ((10, 2), (15, 2), 0.0)]
    ids, fls, info = tour.plan(segs, (0, 0), weight=2.0)
    assert sorted(ids) == [0, 1, 2]
    t, d, c = cost(segs, (0, 0), ids, fls, 2.0)
    assert abs(info["travel"] - t) < 1e-9
    assert abs(info["downhill"] - d) < 1e-9
    assert abs(info["cost"] - c) < 1e-9


def test_weight_zero_takes_the_near_end():
    # second stroke is downhill towards +x, its left end is the near one
    segs = [((0.0, 0.0), (10.0, 0.0), 0.0), ((9.5, 0.5), (20.0, 0.5), -2.0)]
    ids, fls, info = tour.plan(segs, (0.0, 0.0), weight=0.0)
    assert info["travel"] < 1.0
    assert flip_of(ids, fls, 1) is False            # a -> b, i.e. downhill


def test_big_weight_keeps_the_uphill_direction():
    segs = [((0.0, 0.0), (10.0, 0.0), 0.0), ((9.5, 0.5), (20.0, 0.5), -2.0)]
    ids, fls, info = tour.plan(segs, (0.0, 0.0), weight=100.0)
    assert flip_of(ids, fls, 1) is True             # b -> a, uphill
    assert info["downhill"] == 0.0


def test_ring_sections_stay_chained():
    n, r = 60, 20.0
    pts = [(r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n)) for i in range(n)]
    segs = [(pts[i], pts[(i + 1) % n], (pts[(i + 1) % n][0] - pts[i][0]) * 0.05) for i in range(n)]
    ids, fls, info = tour.plan(segs, (r, 0.0), weight=5.0)
    assert sorted(ids) == list(range(n))
    assert info["travel"] < 2.0                     # neighbour to neighbour, no jumps


def test_local_search_is_not_worse_than_greedy():
    rng = np.random.default_rng(11)
    segs = []
    for _ in range(80):
        x, y = rng.uniform(0, 60), rng.uniform(0, 40)
        a = rng.uniform(0, math.pi)
        L = rng.uniform(0.5, 8.0)
        segs.append(((x, y), (x + L * math.cos(a), y + L * math.sin(a)), rng.uniform(-1, 1)))
    for w in (0.0, 3.0, 20.0):
        ids, fls, info = tour.plan(segs, (0.0, 0.0), weight=w)
        greedy = tour.plan(segs, (0.0, 0.0), weight=w, passes=0)
        assert info["cost"] <= greedy[2]["cost"] + 1e-6


def test_parallel_strokes_across_a_slope_get_short_travel():
    # a fan of strokes that must run uphill towards -x: a naive left-to-right
    # order pays the stroke length on every hop, ordering must avoid that
    segs = [((10.0, y), (25.0, y), -0.6) for y in np.arange(0, 30, 1.0)]
    ids, fls, info = tour.plan(segs, (30.0, 0.0), weight=5.0)
    assert info["travel"] < 120.0                   # was ~30 * 15 mm = 450


def test_small_cases_reach_the_brute_force_optimum():
    import itertools
    rng = np.random.default_rng(5)
    for trial in range(12):
        n = int(rng.integers(3, 7))
        segs = []
        for _ in range(n):
            a = tuple(rng.uniform(0, 30, 2))
            b = (a[0] + rng.uniform(-6, 6), a[1] + rng.uniform(-6, 6))
            segs.append((a, b, float(rng.uniform(-1.5, 1.5))))
        for w in (0.0, 2.0, 10.0):
            ids, fls, info = tour.plan(segs, (0.0, 0.0), weight=w)
            assert abs(info["cost"] - cost(segs, (0.0, 0.0), ids, fls, w)[2]) < 1e-9
            best = min(
                cost(segs, (0.0, 0.0), list(p), list(f), w)[2]
                for p in itertools.permutations(range(n))
                for f in itertools.product((False, True), repeat=n))
            assert info["cost"] <= best + 1e-6, (trial, n, w, info["cost"], best)


def test_same_input_same_order():
    rng = np.random.default_rng(3)
    segs = [(tuple(rng.uniform(0, 50, 2)), tuple(rng.uniform(0, 50, 2)), float(rng.uniform(-1, 1)))
            for _ in range(80)]
    a = tour.plan(segs, (0.0, 0.0), weight=10.0)
    b = tour.plan(segs, (0.0, 0.0), weight=10.0)
    assert a[0] == b[0] and a[1] == b[1]


def test_precedence_is_kept_small_and_large():
    rng = np.random.default_rng(7)
    for n in (6, 9, 40, 160):
        segs = [(tuple(rng.uniform(0, 50, 2)), tuple(rng.uniform(0, 50, 2)), float(rng.normal()))
                for _ in range(n)]
        before = [(a, b) for a in range(n) for b in range(a + 1, n) if rng.random() < 3 / n]
        ids, fls, info = tour.plan(segs, (0.0, 0.0), weight=5.0, before=before)
        assert sorted(ids) == list(range(n))
        pos = {k: t for t, k in enumerate(ids)}
        assert all(pos[a] < pos[b] for a, b in before)
        assert abs(info["cost"] - cost(segs, (0.0, 0.0), ids, fls, 5.0)[2]) < 1e-6


def test_precedence_overrides_the_shortest_order():
    # from the start, section 1 is right here and section 0 far away – but 0 must go first
    segs = [((50.0, 0.0), (60.0, 0.0), 0.0), ((0.5, 0.0), (5.0, 0.0), 0.0)]
    ids, _, _ = tour.plan(segs, (0.0, 0.0), weight=0.0, before=[(0, 1)])
    assert ids == [0, 1]
    ids, _, _ = tour.plan(segs, (0.0, 0.0), weight=0.0)
    assert ids == [1, 0]


def test_precedence_is_deterministic():
    rng = np.random.default_rng(3)
    segs = [(tuple(rng.uniform(0, 30, 2)), tuple(rng.uniform(0, 30, 2)), float(rng.normal())) for _ in range(60)]
    before = [(a, a + 7) for a in range(0, 50, 3)]
    a = tour.plan(segs, (0.0, 0.0), weight=4.0, before=before)
    b = tour.plan(segs, (0.0, 0.0), weight=4.0, before=before)
    assert a[0] == b[0] and a[1] == b[1]
