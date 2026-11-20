# Regression tests for the Court.draw / utils.transform coordinate contract.
#
# These tests pin down the three ways the plotting/transform chain used to
# silently misalign: orientation, origin and units. The reference math below is
# implemented independently from the library (pure geometric rotation about the
# shared coordinate origin, plus 180 deg half-court normalization).

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
import pytest

from mplbasketball import Court
from mplbasketball.utils import transform

ORIGINS = ["center", "top-left", "bottom-left", "top-right", "bottom-right"]
FRAMES = ["h", "hl", "hr", "v", "vu", "vd"]
FT_DIMS = {
    "nba": (94.0, 50.0),
    "wnba": (94.0, 50.0),
    "ncaa": (94.0, 50.0),
    "fiba": (91.8635, 49.2126),
}
M_FACTOR = 0.3048


def _center(dims, origin):
    hx, hy = dims[0] / 2.0, dims[1] / 2.0
    return {
        "center": (0.0, 0.0),
        "top-left": (hx, -hy),
        "bottom-left": (hx, hy),
        "top-right": (-hx, -hy),
        "bottom-right": (-hx, hy),
    }[origin]


def _r180(x, y, cx, cy):
    return 2 * cx - x, 2 * cy - y


def _reference(x, y, fr, to, dims, origin):
    """Independent scalar reference implementation of the full transform."""
    cx, cy = _center(dims, origin)
    x, y = float(x), float(y)
    # 1. normalize the source half frame onto its own half
    if fr == "hl" and x > cx:
        x, y = _r180(x, y, cx, cy)
    elif fr == "hr" and x < cx:
        x, y = _r180(x, y, cx, cy)
    elif fr == "vu" and y < cx:  # v-frame center is (-cy, cx)
        x, y = _r180(x, y, -cy, cx)
    elif fr == "vd" and y > cx:
        x, y = _r180(x, y, -cy, cx)
    # 2. pure 90 deg rotation about the shared coordinate origin
    if fr[0] == "h" and to[0] == "v":
        x, y = -y, x
    elif fr[0] == "v" and to[0] == "h":
        x, y = y, -x
    # 3. normalize onto the target half
    if to == "hl" and x > cx:
        x, y = _r180(x, y, cx, cy)
    elif to == "hr" and x < cx:
        x, y = _r180(x, y, cx, cy)
    elif to == "vu" and y < cx:
        x, y = _r180(x, y, -cy, cx)
    elif to == "vd" and y > cx:
        x, y = _r180(x, y, -cy, cx)
    return x, y


def _point_in_frame(rng, frame, dims, origin):
    cx, cy = _center(dims, origin)
    hx, hy = dims[0] / 2.0, dims[1] / 2.0
    if frame in ("h", "hl"):
        return rng.uniform(cx - hx + 1, cx - 1), rng.uniform(cy - hy + 1, cy + hy - 1)
    if frame == "hr":
        return rng.uniform(cx + 1, cx + hx - 1), rng.uniform(cy - hy + 1, cy + hy - 1)
    if frame in ("v", "vd"):  # v-frame x spans the rotated h-frame y (around cy)
        return rng.uniform(cy - hy + 1, cy + hy - 1), rng.uniform(cx - hx + 1, cx - 1)
    if frame == "vu":
        return rng.uniform(cy - hy + 1, cy + hy - 1), rng.uniform(cx + 1, cx + hx - 1)
    raise AssertionError(frame)


# --------------------------------------------------------------------- identity
@pytest.mark.parametrize("units", ["ft", "m"])
@pytest.mark.parametrize("origin", ORIGINS)
@pytest.mark.parametrize("frame", FRAMES)
def test_fr_equals_to_is_identity(units, origin, frame):
    dims = FT_DIMS["nba"] if units == "ft" else tuple(v * M_FACTOR for v in FT_DIMS["nba"])
    rng = np.random.default_rng(abs(hash((units, origin, frame))) % (2**32))
    x0, y0 = _point_in_frame(rng, frame, dims, origin)
    x = np.array([x0, x0 + 1.5])
    y = np.array([y0, y0 - 1.5])
    xo, yo = transform(x.copy(), y.copy(), frame, frame, origin, "nba", units)
    np.testing.assert_array_equal(xo, x)
    np.testing.assert_array_equal(yo, y)


# ----------------------------------------------------------- already-on-half no-op
@pytest.mark.parametrize("origin", ORIGINS)
def test_points_already_in_target_half_are_unchanged(origin):
    dims = FT_DIMS["nba"]
    cx, cy = _center(dims, origin)
    xl, yl = cx - 10.0, cy + 3.0
    xr, yr = cx + 10.0, cy - 3.0
    xo, yo = transform(np.array([xl]), np.array([yl]), "h", "hl", origin)
    np.testing.assert_allclose(xo, [xl])
    np.testing.assert_allclose(yo, [yl])
    xo, yo = transform(np.array([xr]), np.array([yr]), "h", "hr", origin)
    np.testing.assert_allclose(xo, [xr])
    np.testing.assert_allclose(yo, [yr])
    xo, yo = transform(np.array([cy]), np.array([cx - 12.0]), "v", "vd", origin)
    np.testing.assert_allclose(xo, [cy])
    np.testing.assert_allclose(yo, [cx - 12.0])
    xo, yo = transform(np.array([cy]), np.array([cx + 12.0]), "v", "vu", origin)
    np.testing.assert_allclose(xo, [cy])
    np.testing.assert_allclose(yo, [cx + 12.0])


# --------------------------------------------- exhaustive agreement with reference
@pytest.mark.parametrize("court_type", list(FT_DIMS))
@pytest.mark.parametrize("units", ["ft", "m"])
@pytest.mark.parametrize("origin", ORIGINS)
@pytest.mark.parametrize("fr", FRAMES)
@pytest.mark.parametrize("to", FRAMES)
def test_matches_independent_reference(court_type, units, origin, fr, to):
    dims = FT_DIMS[court_type] if units == "ft" else tuple(v * M_FACTOR for v in FT_DIMS[court_type])
    rng = np.random.default_rng(abs(hash((court_type, units, origin, fr, to))) % (2**32))
    pts = [_point_in_frame(rng, fr, dims, origin) for _ in range(6)]
    x = np.array([p[0] for p in pts])
    y = np.array([p[1] for p in pts])
    xo, yo = transform(x.copy(), y.copy(), fr, to, origin, court_type, units)
    expected = np.array([_reference(p[0], p[1], fr, to, dims, origin) for p in pts])
    np.testing.assert_allclose(xo, expected[:, 0], atol=1e-10)
    np.testing.assert_allclose(yo, expected[:, 1], atol=1e-10)


# ------------------------------------------------------------- cross-axis roundtrip
@pytest.mark.parametrize("origin", ORIGINS)
@pytest.mark.parametrize("fr,to", [("hl", "vd"), ("vd", "hl")])
def test_hl_vd_roundtrip(origin, fr, to):
    dims = FT_DIMS["nba"]
    rng = np.random.default_rng(11)
    x0, y0 = _point_in_frame(rng, fr, dims, origin)
    x1, y1 = transform(np.array([x0]), np.array([y0]), fr, to, origin)
    x2, y2 = transform(x1.copy(), y1.copy(), to, fr, origin)
    np.testing.assert_allclose(x2, [x0], atol=1e-10)
    np.testing.assert_allclose(y2, [y0], atol=1e-10)


def test_h_v_roundtrip_center():
    x, y = np.array([-33.0, 12.5]), np.array([7.0, -18.25])
    xv, yv = transform(x.copy(), y.copy(), "h", "v", "center")
    xb, yb = transform(xv, yv, "v", "h", "center")
    np.testing.assert_allclose(xb, x)
    np.testing.assert_allclose(yb, y)


# ----------------------------------------------------------------- units / meters
@pytest.mark.parametrize("court_type", ["nba", "fiba"])
@pytest.mark.parametrize("origin", ORIGINS)
def test_meter_mirror_axis_matches_meter_court(court_type, origin):
    dims = tuple(v * M_FACTOR for v in FT_DIMS[court_type])
    cx, cy = _center(dims, origin)
    hx, hy = dims[0] / 2, dims[1] / 2
    rng = np.random.default_rng(3)
    xr = rng.uniform(cx + 0.5, cx + hx - 0.5, 20)
    yr = rng.uniform(cy - hy + 0.5, cy + hy - 0.5, 20)
    xt, yt = transform(xr, yr, "hr", "hl", origin, court_type, "m")
    np.testing.assert_allclose(xt + xr, 2 * cx, atol=1e-9)
    np.testing.assert_allclose(yt + yr, 2 * cy, atol=1e-9)


@pytest.mark.parametrize("units", ["ft", "m"])
def test_scatter_overlay_lands_inside_drawn_haves(units):
    court = Court("nba", "bottom-left", units)
    dims = court.court_parameters["court_dims"]
    rng = np.random.default_rng(5)
    x = rng.uniform(0.5, dims[0] - 0.5, 40)
    y = rng.uniform(0.5, dims[1] - 0.5, 40)
    for orient in ["hl", "hr", "vu", "vd"]:
        fig, ax = court.draw(orientation=orient)
        xt, yt = transform(x, y, "h", orient, "bottom-left", "nba", units)
        xl, xh = ax.get_xlim()
        yl, yh = ax.get_ylim()
        assert (xt >= xl - 1e-9).all() and (xt <= xh + 1e-9).all()
        assert (yt >= yl - 1e-9).all() and (yt <= yh + 1e-9).all()
        plt.close(fig)


# -------------------------------------------------------------- draw ranges/contract
@pytest.mark.parametrize("units", ["ft", "m"])
@pytest.mark.parametrize("orient", ["h", "v", "hl", "hr", "vu", "vd"])
def test_draw_ranges_match_orientation(units, orient):
    court = Court("nba", "center", units)
    dims = court.court_parameters["court_dims"]
    hx, hy = dims[0] / 2, dims[1] / 2
    pad = 5.0
    cf = (1.0 / 12.0) if units == "ft" else (1.0 / 12.0) * 0.3045
    expected = {
        "h": (-(hx + pad), hx + pad, -(hy + pad), hy + pad),
        "v": (-(hy + pad), hy + pad, -(hx + pad), hx + pad),
        "hl": (-(hx + pad), cf, -(hy + pad), hy + pad),
        "hr": (-cf, hx + pad, -(hy + pad), hy + pad),
        "vu": (-(hy + pad), hy + pad, -cf, hx + pad),
        "vd": (-(hy + pad), hy + pad, -(hx + pad), cf),
    }[orient]
    fig, ax = court.draw(orientation=orient)
    actual = (*ax.get_xlim(), *ax.get_ylim())
    np.testing.assert_allclose(actual, expected, atol=1e-6)
    plt.close(fig)


def test_draw_multi_subplot_returns_ndarray_of_half_courts():
    court = Court("nba", "center", "ft")
    fig, axs = court.draw(orientation="hl", nrows=2, ncols=3)
    assert isinstance(axs, np.ndarray) and axs.shape == (2, 3)
    for ax in axs.flatten():
        assert ax.get_xlim()[0] < -45 and ax.get_xlim()[1] <= 0.2
    plt.close(fig)


def test_draw_existing_ax_returns_single_ax_with_half_range():
    court = Court("nba", "center", "ft")
    fig, ax_in = plt.subplots()
    returned = court.draw(ax_in, orientation="hr")
    assert returned is ax_in
    assert ax_in.get_xlim()[0] >= -0.2 and ax_in.get_xlim()[1] > 45
    plt.close(fig)


def test_draw_single_returns_fig_ax_tuple():
    court = Court("nba", "center", "ft")
    result = court.draw(orientation="hl")
    assert isinstance(result, tuple) and len(result) == 2
    plt.close(result[0])


# ------------------------------------------------------------- invalid argument guards
@pytest.mark.parametrize("kwargs", [
    {"orientation": "sideways"}, {"orientation": "HL"},
    {"dpi": 199}, {"dpi": 0}, {"dpi": -5},
])
def test_invalid_draw_args_assert_without_leaving_figures(kwargs):
    n_before = len(plt.get_fignums())
    with pytest.raises(AssertionError):
        Court("nba", "center", "ft").draw(**kwargs)
    assert len(plt.get_fignums()) == n_before


@pytest.mark.parametrize("fr,to,origin,units", [
    ("x", "h", "center", "ft"),
    ("h", "x", "center", "ft"),
    ("h", "v", "nope", "ft"),
    ("h", "v", "center", "cubits"),
])
def test_transform_rejects_invalid_enums(fr, to, origin, units):
    with pytest.raises(ValueError):
        transform(np.array([1.0]), np.array([1.0]), fr, to, origin, "nba", units)
