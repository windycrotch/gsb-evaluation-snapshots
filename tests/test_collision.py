import numpy as np
import pytest

from impasto import collision
from impasto.surface import Grid


def grid(H, res=0.1, x0=0.0, y0=0.0):
    H = np.asarray(H, dtype=np.float32)
    return Grid(x0=x0, y0=y0, res=res, nx=H.shape[1], ny=H.shape[0], H=H)


def move(x0, y0, z0, x1, y1, z1, typ=0):
    return [typ, 0, x0, y0, z0, x1, y1, z1, 1]


def flat(z=5.0, n=400):
    return np.full((n, n), z, dtype=np.float32)        # 40 x 40 mm


HEAD = collision.load_head("bambu-a1-mini")


def test_index_and_defaults():
    ids = {h["id"] for h in collision.head_index()}
    assert len(ids) >= 50
    for d in (0.2, 0.4, 0.6, 0.8):
        assert collision.default_head(d) in ids


def test_flat_surface_no_collision():
    g = grid(flat())
    mv = np.array([move(5, 20, 5.2, 35, 20, 5.2)])
    r = collision.check(g, mv, HEAD)
    assert r["count"] == 0 and r["max_depth"] == 0


def test_nozzle_below_surface_hits_nozzle_boxes():
    g = grid(flat())
    mv = np.array([move(5, 20, 4.0, 35, 20, 4.0)])        # 1 mm into the part
    r = collision.check(g, mv, HEAD)
    assert r["count"] == 1 and r["extrusion"] == 1
    assert r["max_depth"] >= 0.9
    assert any(n.startswith("nozzle") for n in r["box_names"])


def test_tall_pillar_hits_duct():
    H = flat(2.0)
    H[190:210, 150:160] = 12.0                             # pillar at x 15..16, y 19..21
    g = grid(H)
    # nozzle passes 4 mm beside the pillar at 2.2 mm: duct outlets reach x +-24 at z +4.76
    mv = np.array([move(30, 20, 2.2, 30, 20.5, 2.2)])
    r = collision.check(g, mv, HEAD)
    assert r["count"] == 1
    assert any("duct" in n for n in r["box_names"])
    assert not any(n.startswith("nozzle") for n in r["box_names"])


def test_empty_cells_are_bed():
    H = np.full((200, 200), np.nan, dtype=np.float32)
    g = grid(H)
    ok = np.array([move(5, 10, 0.3, 15, 10, 0.3)])
    assert collision.check(g, ok, HEAD)["count"] == 0
    # off-grid travel below the bed must still collide (bed = 0 outside the grid too)
    bad = np.array([move(-30, -30, -0.5, -20, -30, -0.5, typ=1)])
    r = collision.check(g, bad, HEAD)
    assert r["count"] == 1 and r["extrusion"] == 0


def test_infinite_gantry():
    H = np.zeros((400, 2000), dtype=np.float32)            # 200 x 40 mm
    H[195:205, 1900:1910] = 40.0                           # tall spike 180 mm away in x
    g = grid(H)
    mv = np.array([move(10, 20, 5.0, 12, 20, 5.0)])
    r = collision.check(g, mv, HEAD)
    assert "x_gantry" in r["box_names"]


def test_retracts_and_other_types_ignored():
    g = grid(flat())
    mv = np.array([move(5, 20, 1.0, 35, 20, 1.0, typ=2)])
    assert collision.check(g, mv, HEAD)["count"] == 0


@pytest.mark.parametrize("hid", [h["id"] for h in collision.head_index()])
def test_all_heads_run(hid):
    g = grid(flat())
    mv = np.array([move(5, 20, 5.2, 35, 20, 5.2), move(5, 20, 4.0, 35, 20, 4.0)])
    r = collision.check(g, mv, collision.load_head(hid))
    assert [e["i"] for e in r["moves"]] == [1]


def _slope(deg=22.0, n=400, res=0.1):
    x = np.arange(n) * res
    return np.tile(5.0 + np.tan(np.radians(deg)) * x, (n, 1)).astype(np.float32)


def _tip_names(r):
    return "nozzle_tip" in r["box_names"]


def test_tip_just_above_slope_no_hit():
    H = _slope()
    g = grid(H)
    t = np.tan(np.radians(22.0))
    # move up the slope, tip 0.04 mm above the surface
    mv = np.array([move(10, 20, 5 + t * 10 + 0.04, 30, 20, 5 + t * 30 + 0.04)])
    r = collision.check(g, mv, HEAD, tip_tol=0.1)
    assert not _tip_names(r)


def test_tip_slightly_sunk_within_tol_no_hit():
    g = grid(flat())
    mv = np.array([move(5, 20, 4.95, 35, 20, 4.95)])
    r = collision.check(g, mv, HEAD, tip_tol=0.1)
    assert not _tip_names(r)


def test_tip_sunk_beyond_tol_hits():
    g = grid(flat())
    mv = np.array([move(5, 20, 4.7, 35, 20, 4.7)])
    r = collision.check(g, mv, HEAD, tip_tol=0.1)
    assert _tip_names(r)
    assert r["max_depth"] >= 0.15
