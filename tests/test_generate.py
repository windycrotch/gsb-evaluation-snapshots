import hashlib
import io
import re
import zipfile
from pathlib import Path

import numpy as np
import pytest

from impasto import bambu, generate, merge, parse, surface

ROOT = Path(__file__).resolve().parents[1]
SAMPLE3MF = ROOT / "Brille_RIG_MKV_2026_Master_plate_2.gcode.3mf"

pytestmark = pytest.mark.skipif(not SAMPLE3MF.exists(), reason="sample missing")


@pytest.fixture(scope="module")
def setup():
    job = bambu.load_path(SAMPLE3MF)
    tp = parse.parse(job.lines, job.exec_start, job.insert_at)
    g = surface.analyze(surface.heightmap(tp))
    return job, tp, g


def design():
    paths = []
    for y in np.arange(56, 61, 0.45):
        paths.append({"slot": 0, "pts": [[60, y], [120, y]]})
    for x in np.arange(80, 100, 0.9):           # crossing lines in another colour
        paths.append({"slot": 1, "pts": [[x, 55], [x, 62]]})
    t = np.linspace(0, 2 * np.pi, 120)
    paths.append({"slot": 3, "pts": np.c_[92 + 3 * np.cos(t), 59 + 3 * np.sin(t)].tolist(), "closed": True})
    return paths


def block_moves(text):
    x = y = z = None
    out = []
    for ln in text.split("\n"):
        if not ln.startswith("G1"):
            continue
        d = dict((w[0], float(w[1:])) for w in ln.split(";")[0].split()[1:] if w[0] in "XYZEF")
        nx, ny, nz = d.get("X", x), d.get("Y", y), d.get("Z", z)
        if "E" in d and d["E"] > 0 and ("X" in d or "Y" in d):
            out.append((x, y, z, nx, ny, nz, d["E"]))
        x, y, z = nx, ny, nz
    return out


def test_layer_header_and_colours(setup):
    job, tp, g = setup
    res = generate.generate(job, tp, g, design(), generate.Params())
    st = res.stats
    assert st["colors"] == [0, 1, 3]            # starts with the loaded filament (white, slot 0)
    assert st["toolchanges"] == 2
    assert "M620 S1A" in res.gcode and "M620 S3A" in res.gcode
    assert res.gcode.count("; CHANGE_LAYER") == 1
    assert "M73 L218" in res.gcode


def test_never_below_surface(setup):
    job, tp, g = setup
    p = generate.Params()
    res = generate.generate(job, tp, g, design(), p)
    mv = block_moves(res.gcode)
    assert len(mv) > 500
    arr = np.array(mv, dtype=float)
    zs = surface.sample_max(g.ZN, g, arr[:, 3], arr[:, 4])
    ok = np.isfinite(zs)
    gap = arr[ok, 5] - zs[ok]
    assert gap.min() >= p.z_offset - 1e-3          # nozzle never deeper than offset above the dilated surface
    assert (arr[:, 6] > 0).all()


def test_crossings_are_lifted(setup):
    job, tp, g = setup
    res = generate.generate(job, tp, g, design(), generate.Params(stack=True))
    res0 = generate.generate(job, tp, g, design(), generate.Params(stack=False))
    assert res.stats["max_z"] > res0.stats["max_z"] - 1e-6
    a = np.array(block_moves(res.gcode))
    b = np.array(block_moves(res0.gcode))
    assert a[:, 5].mean() > b[:, 5].mean()


def test_merge_and_3mf(setup):
    job, tp, g = setup
    res = generate.generate(job, tp, g, design(), generate.Params())
    text = merge.merged_text(job, res)
    lines = text.split("\n")
    assert "; total layer number: 218" in lines[:20]
    # original content preserved before the insertion point (except M73 progress values)
    for a, b in zip(job.lines[job.exec_start:job.insert_at], lines[job.exec_start:job.insert_at]):
        if a != b:
            assert a.startswith("M73 P") and b.startswith("M73 P")
    i = lines.index("; ===== NON-PLANAR LAYER (Impasto) START =====")
    assert i == job.insert_at
    # end gcode lowered-z line raised above the decoration
    m = [l for l in lines if "lower z a little" in l][-1]
    assert float(re.search(r"Z([\d.]+)", m).group(1)) >= res.max_z
    data = merge.build_3mf(job, res, text)
    zf = zipfile.ZipFile(io.BytesIO(data))
    g2 = zf.read(f"Metadata/plate_{job.plate}.gcode")
    assert zf.read(f"Metadata/plate_{job.plate}.gcode.md5").decode() == hashlib.md5(g2).hexdigest().upper()
    si = zf.read("Metadata/slice_info.config").decode()
    for fid in ("1", "2", "3", "4"):
        assert f'<filament id="{fid}"' in si
    # the merged G-code parses and contains the extra layer
    j2 = bambu.load_bytes(data, "x.gcode.3mf")
    tp2 = parse.parse(j2.lines, j2.exec_start, j2.insert_at)
    assert len(tp2.layer_z) == len(tp.layer_z) + 1


def test_element_order_stacks(setup):
    job, tp, g = setup
    paths = [{"slot": 0, "pts": [[60, 56], [90, 56]], "order": 0},
             {"slot": 0, "pts": [[60, 56], [90, 56]], "order": 1}]      # same line, later element
    res = generate.generate(job, tp, g, paths, generate.Params(z_offset=0.15, dir_opt=False))
    assert res.stats["elements"] == 2
    assert res.gcode.count("; CHANGE_LAYER") == 1
    z = res.moves[res.moves[:, 0] == 0][:, 7]
    n = len(z) // 2
    assert z[n:].mean() - z[:n].mean() > 0.1            # second element lies on the first
    assert res.stats["stacked_mm"] > 10


def test_partly_overlapping_element_falls_back_to_the_surface(setup):
    job, tp, g = setup
    paths = [{"slot": 0, "pts": [[60, 56], [75, 56]], "order": 0},
             {"slot": 0, "pts": [[60, 56], [105, 56]], "order": 1}]     # overlaps on the left only
    res = generate.generate(job, tp, g, paths, generate.Params(z_offset=0.15, dir_opt=False))
    ex = res.moves[res.moves[:, 0] == 0]
    z = ex[:, 7]
    n = len(z) // 2
    z2 = z[n:]
    assert z2.max() - z2.min() > 0.1                    # part lifted, part on the surface
    assert res.stats["stacked_mm"] > 5


def test_single_element_header(setup):
    job, tp, g = setup
    paths = [{"slot": 0, "pts": [[60, 56], [90, 56]]}]
    res = generate.generate(job, tp, g, paths, generate.Params(z_offset=0.15))
    assert res.stats["elements"] == 1
    assert res.gcode.count("; CHANGE_LAYER") == 1
    head = res.gcode.split("\n")[:14]
    assert head[1] == "; CHANGE_LAYER"
    assert any(l.startswith("; Z_HEIGHT:") for l in head)
    assert any(l.startswith("; layer num/total_layer_count:") for l in head)


def travel_mm(res):
    mv = np.asarray(res.moves, dtype=float).reshape(-1, 9)
    d = np.hypot(mv[:, 5] - mv[:, 2], mv[:, 6] - mv[:, 3])
    return float(d[(mv[:, 0] == 1) & (d > 1e-3)].sum())


def test_planned_travel_matches_the_gcode(setup):
    job, tp, g = setup
    # without wipe: a wipe ends the line up to 2 mm away from where the plan expects it
    res = generate.generate(job, tp, g, design(), generate.Params(wipe=0))
    planned = res.stats["dir"]["travel_mm"]
    assert planned > 0
    assert abs(planned - travel_mm(res)) < 0.05 * travel_mm(res)
    assert abs(res.stats["dir"]["travel_real_mm"] - travel_mm(res)) < 1.0


def test_travel_weight_shortens_the_travel(setup):
    job, tp, g = setup
    paths = [{"slot": 0, "pts": [[60.0, y], [92.0, y]]} for y in np.arange(55.0, 61.0, 0.5)]
    strict = generate.generate(job, tp, g, paths, generate.Params(dir_travel_weight=500.0))
    loose = generate.generate(job, tp, g, paths, generate.Params(dir_travel_weight=0.0))
    assert travel_mm(loose) < 0.8 * travel_mm(strict)       # short ways win
    assert strict.stats["dir"]["down_mm"] <= loose.stats["dir"]["down_mm"] + 1e-9


def test_closed_ring_stays_closed(setup):
    # a closed outline may be entered at any vertex (it is rolled to the cheapest
    # one); rolling must not lose or duplicate a segment
    job, tp, g = setup
    t = np.linspace(0, 2 * np.pi, 200)
    pts = np.c_[106 + 2.0 * np.cos(t), 24 + 2.0 * np.sin(t)]
    res = generate.generate(job, tp, g, [{"slot": 0, "pts": pts.tolist(), "closed": True}],
                            generate.Params(dir_min_rise=5.0))
    ex = res.moves[res.moves[:, 0] == 0]
    ring_len = float(np.hypot(*np.diff(pts, axis=0).T).sum())
    assert res.stats["strokes"][0] == 1                      # not cut
    assert abs(res.stats["length_mm"][0] - ring_len) < 0.01   # nothing lost
    assert np.hypot(ex[0, 2] - ex[-1, 5], ex[0, 3] - ex[-1, 6]) < 0.1   # closes


def e_values(text):
    out = []
    for ln in text.split("\n"):
        m = re.search(r"\bE(-?[\d.]+)", ln.split(";")[0]) if ln.startswith("G1") else None
        if m:
            out.append((ln, float(m.group(1))))
    return out


def test_wipe_retracts_along_the_line(setup):
    job, tp, g = setup
    paths = [{"slot": 0, "pts": [[60, 56], [75, 56]]}, {"slot": 0, "pts": [[60, 59], [75, 59]]}]
    res = generate.generate(job, tp, g, paths, generate.Params(wipe=2.0, retract=0.8, retract_before_wipe=0))
    wipes = res.moves[res.moves[:, 0] == 3]
    assert len(wipes) > 0
    assert (res.flags[res.moves[:, 0] == 3] & generate.FLAG_WIPE).all()
    # the wipe runs back over the line just printed, 2 mm long
    d = np.hypot(wipes[:, 5] - wipes[:, 2], wipes[:, 6] - wipes[:, 3]).sum()
    assert abs(d - 2.0 * res.stats["retracts"]) < 0.05 * res.stats["retracts"] + 1e-6
    # every retract pulls exactly the retract length back, partly during the wipe
    neg = [e for ln, e in e_values(res.gcode) if e < 0]
    assert abs(sum(neg) + 0.8 * res.stats["retracts"]) < 1e-3
    off = generate.generate(job, tp, g, paths, generate.Params(wipe=0, retract=0.8))
    assert (off.moves[:, 0] == 3).sum() == 0


def test_coasting_ends_lines_without_material(setup):
    job, tp, g = setup
    paths = [{"slot": 0, "pts": [[60, 56], [75, 56]]}, {"slot": 0, "pts": [[60, 54.5], [75, 54.5]]}]
    a = generate.generate(job, tp, g, paths, generate.Params(coast=0.4, wipe=0))
    b = generate.generate(job, tp, g, paths, generate.Params(coast=0.0, wipe=0))
    assert a.stats["coast_mm"] > 0.7
    assert ((a.flags & generate.FLAG_COAST) > 0).sum() > 0
    assert sum(a.stats["filament_mm"].values()) < sum(b.stats["filament_mm"].values())


def test_self_crossing_is_lifted(setup):
    job, tp, g = setup
    # a figure-eight crosses itself in the middle
    t = np.linspace(0, 2 * np.pi, 400)
    pts = np.c_[100 + 6 * np.sin(t), 55.2 + 1.2 * np.sin(2 * t)]
    p = generate.Params(dir_opt=False)
    res = generate.generate(job, tp, g, [{"slot": 0, "pts": pts.tolist()}], p)
    assert res.stats["self_lift_mm"] > 0
    ex = res.moves[res.moves[:, 0] == 0]
    near = np.hypot(ex[:, 5] - 100, ex[:, 6] - 55.2) < 0.15
    zs = surface.sample_max(g.ZN, g, ex[near, 5], ex[near, 6])
    assert (ex[near, 7] - zs).max() > p.z_offset + 0.1      # second pass sits on the first


def test_tight_curves_are_slower(setup):
    job, tp, g = setup
    t = np.linspace(0, 2 * np.pi, 200)
    ring = np.c_[92 + 0.8 * np.cos(t), 55.2 + 0.8 * np.sin(t)]
    slow = generate.generate(job, tp, g, [{"slot": 0, "pts": ring.tolist(), "closed": True}],
                             generate.Params(curve_radius=2.0, curve_min=0.5, speed=15, dir_min_rise=5))
    fast = generate.generate(job, tp, g, [{"slot": 0, "pts": ring.tolist(), "closed": True}],
                             generate.Params(curve_radius=0.0, speed=15, dir_min_rise=5))
    assert slow.stats["slowed_mm"] > 3
    assert slow.stats["time_s"] > fast.stats["time_s"]


def test_overlap_keeps_the_stacking_order_across_colours(setup):
    job, tp, g = setup
    # element 0 (white) below, element 1 (slot 1) crosses it, element 2 (white) lies on top
    paths = [{"slot": 0, "order": 0, "pts": [[70, 56], [90, 56]]},
             {"slot": 1, "order": 1, "pts": [[80, 54], [80, 60]]},
             {"slot": 0, "order": 2, "pts": [[78, 55], [82, 57]]},
             {"slot": 0, "order": 3, "pts": [[120, 55], [140, 55]]}]       # far away: joins the first batch
    res = generate.generate(job, tp, g, paths, generate.Params(dir_opt=False))
    assert res.stats["toolchanges"] == 2                  # white, slot 1, white again
    assert res.stats["batches"] == 3
    ch = np.nonzero(res.moves[:, 0] == 2)[0]
    ex = res.moves[:, 0] == 0
    first = res.moves[:ch[0]][ex[:ch[0]]]
    assert (first[:, 5] > 119).any()                      # the far element went with the first batch


def test_colours_are_not_interleaved_without_overlap(setup):
    job, tp, g = setup
    paths = [{"slot": 0, "order": 0, "pts": [[60, 56], [70, 56]]},
             {"slot": 1, "order": 0, "pts": [[60, 54.5], [70, 54.5]]},
             {"slot": 0, "order": 1, "pts": [[100, 56], [110, 56]]},
             {"slot": 1, "order": 1, "pts": [[100, 54.5], [110, 54.5]]}]
    res = generate.generate(job, tp, g, paths, generate.Params())
    assert res.stats["toolchanges"] == 1                  # was 3 with one group per element


def test_warp_lift_raises_the_ends(setup):
    job, tp, g = setup
    paths = [{"slot": 0, "pts": [[60, 56], [120, 56]]}]
    a = generate.generate(job, tp, g, paths, generate.Params(dir_opt=False))
    b = generate.generate(job, tp, g, paths, generate.Params(dir_opt=False, warp_ends=0.5))
    za, zb = a.moves[a.moves[:, 0] == 0][:, 7], b.moves[b.moves[:, 0] == 0][:, 7]
    assert len(za) == len(zb)
    d = zb - za
    assert d.max() > 0.05 and d.min() >= -1e-4
    assert g.ZN is not None and np.isfinite(g.ZN).any()          # session grid untouched
    a2 = generate.generate(job, tp, g, paths, generate.Params(dir_opt=False))
    assert np.allclose(a2.moves, a.moves)


def test_downhill_flags_match_the_stats(setup):
    job, tp, g = setup
    res = generate.generate(job, tp, g, design(), generate.Params(dir_opt=False, coast=0))
    m = res.moves
    dn = (m[:, 0] == 0) & ((res.flags & generate.FLAG_DOWN) > 0)
    L = np.hypot(m[dn, 5] - m[dn, 2], m[dn, 6] - m[dn, 3]).sum()
    assert abs(L - res.stats["dir"]["down_mm"]) < 0.5
    assert len(res.flags) == len(res.moves)


def test_same_design_same_gcode(setup):
    job, tp, g = setup
    a = generate.generate(job, tp, g, design(), generate.Params())
    b = generate.generate(job, tp, g, design(), generate.Params())
    assert a.gcode == b.gcode


def test_touch_off_rezeroes_on_the_planned_surface(setup):
    job, tp, g = setup
    paths = [{"slot": 0, "pts": [[40, 55], [70, 55]]}, {"slot": 0, "pts": [[120, 55], [150, 55]]}]
    res = generate.generate(job, tp, g, paths, generate.Params(probe=True, probe_region=40))
    lines = res.gcode.split("\n")
    touch = [i for i, l in enumerate(lines) if l.startswith("G380 S3")]
    g92 = [l for l in lines if l.startswith("G92 Z")]
    assert res.stats["touches"] == len(touch) == len(g92) == len(res.touches) == 2
    for i in touch:                       # relative, guarded move, back to absolute right after
        assert lines[i - 1] == "G91" and lines[i + 1] == "G90"
        assert lines[i + 3].startswith("G92 Z")
    # G92 sets exactly the planned surface (ZN) of the touch spot
    for (x, y, z), l in zip(res.touches, g92):
        zn = surface.sample(g.ZN, g, np.array([x]), np.array([y]), mode="nearest")[0]
        assert abs(float(l.split("Z")[1].split()[0]) - zn) < 1e-3
        assert abs(z - zn) < 1e-3
    # cooled down for the touch, heated up again before printing
    assert "M109 S140" in res.gcode
    t = int(job.floats("nozzle_temperature")[0])
    assert res.gcode.count(f"M109 S{t}") >= 2


def test_single_touch_and_hot_touch(setup):
    job, tp, g = setup
    paths = [{"slot": 0, "pts": [[40, 55], [70, 55]]}, {"slot": 0, "pts": [[120, 55], [150, 55]]}]
    res = generate.generate(job, tp, g, paths, generate.Params(probe=True, probe_region=0, probe_temp=0))
    assert res.stats["touches"] == 1
    assert "M109 S140" not in res.gcode
    off = generate.generate(job, tp, g, paths, generate.Params())
    assert "G380" not in off.gcode and "G92 Z" not in off.gcode


def test_slope_compensation_lowers_but_keeps_clear(setup):
    job, tp, g = setup
    paths = design()
    a = generate.generate(job, tp, g, paths, generate.Params(dir_opt=False, stack=False, ramp=0))
    b = generate.generate(job, tp, g, paths, generate.Params(dir_opt=False, stack=False, ramp=0, slope_comp=1.0))
    ea, eb = a.moves[a.moves[:, 0] == 0], b.moves[b.moves[:, 0] == 0]
    assert len(ea) == len(eb)
    d = ea[:, 7] - eb[:, 7]
    assert d.max() > 0.02 and d.min() >= -1e-4             # lower on slopes, never higher
    zs = surface.sample_max(g.ZN, g, eb[:, 5], eb[:, 6])
    ok = np.isfinite(zs)
    assert (eb[ok, 7] - zs[ok]).min() >= generate.SLOPE_MIN_CLEAR - 1e-3
