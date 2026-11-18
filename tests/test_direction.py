import numpy as np

from impasto import direction


def _line(n=401, length=100.0):
    x = np.linspace(0.0, length, n)
    return np.c_[x, np.zeros(n)]


def _plan(z, P=None, **kw):
    P = _line(len(z)) if P is None else P
    return direction.plan(P, np.asarray(z, dtype=float), **kw)


def test_downhill_stroke_is_reversed():
    z = 5.0 - 0.02 * np.linspace(0, 100, 401)          # 2 mm fall over 100 mm
    secs = _plan(z)
    assert secs == [(0, 400, True)]                    # one piece, printed backwards


def test_uphill_stroke_stays_forward():
    z = 5.0 + 0.02 * np.linspace(0, 100, 401)
    secs = _plan(z)
    assert len(secs) == 1 and secs[0][2] is False


def test_level_stroke_direction_is_free():
    secs = _plan(np.full(401, 5.0))
    assert len(secs) == 1 and secs[0][2] is None


def test_dome_is_split_into_two_uphill_sections():
    x = np.linspace(0, 100, 401)
    z = 5.0 + 1.0 - np.abs(x - 50) / 50.0               # tent: up to 50, down to 100
    secs = _plan(z)
    assert len(secs) == 2
    assert secs[0] == (0, 200, False)
    assert secs[1] == (200, 400, True)


def test_valley_is_split_into_two_uphill_sections():
    x = np.linspace(0, 100, 401)
    z = 5.0 + np.abs(x - 50) / 50.0                     # down to the middle, up again
    secs = _plan(z)
    assert len(secs) == 2
    assert secs[0][2] is True                           # left flank starts at the valley
    assert secs[1][2] is False


def test_height_noise_does_not_cut():
    rng = np.random.default_rng(7)
    z = 5.0 - 0.01 * np.linspace(0, 100, 401) + rng.normal(0, 0.02, 401)
    secs = _plan(z, min_rise=0.10)
    assert len(secs) == 1


def test_sharp_turn_is_cut():
    x = np.linspace(0, 100, 401)
    z = 5.0 + 0.4 * np.sin(x / 100 * 4 * np.pi)         # four bumps, ~0.8 mm peak to peak
    secs = _plan(z, min_rise=0.10, min_len=3.0)
    assert len(secs) >= 3
    for i0, i1, rev in secs:                            # every section uphill
        rise = float(z[i1] - z[i0])
        assert (-rise if rev else rise) >= -direction.EPS


def test_max_parts_caps_the_cuts():
    x = np.linspace(0, 100, 401)
    z = 5.0 + 0.5 * np.sin(x / 100 * 8 * np.pi)
    secs = _plan(z, min_rise=0.10, min_len=1.0, max_parts=3)
    assert len(secs) <= 3
    assert secs[0][0] == 0 and secs[-1][1] == 400       # still covers the whole stroke


def test_short_strokes_stay_whole():
    z = np.array([5.0, 4.9, 4.8])
    secs = _plan(z, P=np.c_[np.arange(3) * 0.5, np.zeros(3)])
    assert secs == [(0, 2, True)]


def test_sections_cover_the_stroke_without_gaps():
    x = np.linspace(0, 100, 401)
    z = 5.0 + np.sin(x / 100 * 6 * np.pi)
    secs = direction.plan(_line(401), z, min_rise=0.1, min_len=2.0, max_parts=5)
    assert secs[0][0] == 0 and secs[-1][1] == 400
    for a, b in zip(secs[:-1], secs[1:]):
        assert a[1] == b[0]


def _down_inside(z, secs):
    """largest counter-movement inside any section, in print direction"""
    worst = 0.0
    for i0, i1, rev in secs:
        zz = z[i0:i1 + 1][::-1] if rev else z[i0:i1 + 1]
        run = np.maximum.accumulate(zz) - zz            # drop below the highest point so far
        worst = max(worst, float(run.max()))
    return worst


def test_zero_threshold_still_splits():
    x = np.linspace(0, 100, 401)
    z = 5.0 + 0.3 * np.sin(x / 100 * 6 * np.pi)
    secs = _plan(z, min_rise=0.0)
    assert len(secs) >= 6


def test_wave_on_slope_has_no_downhill_above_threshold():
    # the reported case: a wave pattern (0.6 amp, 8.2 mm wavelength) across a slope
    x = np.linspace(0, 125, 501)
    z = 5.0 + 0.1 * x + 0.6 * np.sin(x / 8.2 * 2 * np.pi)
    for h in (0.0, 0.05, 0.2):
        secs = _plan(z, P=_line(501, 125.0), min_rise=h)
        assert _down_inside(z, secs) <= max(h, direction.MIN_H) + 0.06   # one step of 0.25 mm


def test_old_caps_are_not_applied_by_default():
    x = np.linspace(0, 100, 401)
    z = 5.0 + 0.5 * np.sin(x / 100 * 16 * np.pi)          # 8 periods -> 16 sections
    assert len(_plan(z, min_rise=0.1)) >= 15


def test_single_sample_stair_spike_does_not_cut():
    z = np.r_[np.full(20, 5.0), 5.12, np.full(20, 5.0)] + np.linspace(0, 0.5, 41)
    assert len(_plan(z, P=_line(41, 10.0), min_rise=0.01)) == 1


def test_steep_end_stub_is_cut_when_allowed():
    # a long climb, then a steep drop within the last 0.3 mm (inside the end protection)
    s = np.arange(0, 10.0 + 1e-9, 0.1)
    z = 0.05 * s
    tail = s > 9.7 + 1e-6
    z[tail] = z[~tail][-1] - (s[tail] - 9.7) * 0.8
    P = np.c_[s, np.zeros_like(s)]
    keep = direction.plan(P, z, min_rise=0.1, min_len=0.5)
    cut = direction.plan(P, z, min_rise=0.1, min_len=0.5, stub_slope=0.25)
    assert len(keep) == 1
    assert len(cut) == 2
    assert cut[1][2] is True              # the stub is printed backwards = uphill
    flat = direction.plan(P, z, min_rise=0.1, min_len=0.5, stub_slope=5.0)
    assert len(flat) == 1                 # not steep enough for that limit
