"""Colour order, batches and stacking precedences of the non-planar layer.

The tests run on a small synthetic job (flat plate + Bambu-style config), so they
do not need a sliced sample file.
"""
from __future__ import annotations

import re

import numpy as np
import pytest

from impasto import bambu, generate, toolchange
from impasto.parse import Toolpaths
from impasto.surface import Grid

N = 4
COLORS = ["#FFFFFF", "#FF0000", "#000000", "#FFFF00"]

# asymmetric flush matrix (row = old filament, col = new), mm3
FLUSH = np.array([
    [0, 200, 300, 110],
    [180, 0, 250, 140],
    [260, 240, 0, 150],
    [120, 130, 140, 0],
], dtype=float)

CHANGE_TPL = (
    "M620 S{next_extruder}A\n"
    "M400\n"
    "G1 E-2 F1800\n"
    "M104 S{new_filament_temp}\n"
    "M109 S{new_filament_temp}\n"
    "T{next_extruder}\n"
    "G1 E2 F1800\n"
    "G1 X{x_after_toolchange} Y{y_after_toolchange} F{new_filament_e_feedrate}\n"
    "M621 S{next_extruder}A\n"
)


def make_job(order_override: list[list[float]] | None = None,
             multiplier: float = 1.0, grab: float = 0.0) -> bambu.Job:
    mat = (order_override if order_override is not None else FLUSH)
    cfg = {
        "printer_model": "Bambu Lab A1 mini",
        "nozzle_diameter": "0.4",
        "filament_colour": ";".join(COLORS[:N]),
        "filament_type": ";".join(["PHA"] * N),
        "filament_settings_id": ";".join(["PHA"] * N),
        "filament_diameter": ";".join(["1.75"] * N),
        "filament_density": ";".join(["1.24"] * N),
        "filament_flow_ratio": ";".join(["1.0"] * N),
        "filament_max_volumetric_speed": ";".join(["2.0"] * N),
        "filament_flush_volumetric_speed": ";".join(["2.0"] * N),
        "filament_flush_temp": ";".join(["220"] * N),
        "nozzle_temperature_range_high": ";".join(["230"] * N),
        "nozzle_temperature": ";".join(["220"] * N),
        "fan_max_speed": ";".join(["100"] * N),
        "retraction_length": ";".join(["0.8"] * N),
        "retract_length_toolchange": ";".join(["2.0"] * N),
        "filament_retract_length_nc": ";".join(["2.0"] * N),
        "retract_before_wipe": ";".join(["0"] * N),
        "wipe": ";".join(["0"] * N),
        "wipe_distance": ";".join(["2.0"] * N),
        "flush_volumes_matrix": ";".join(f"{v:g}" for v in np.asarray(mat).reshape(-1)),
        "flush_multiplier": f"{multiplier:g}",
        "grab_length": f"{grab:g}",
        "outer_wall_line_width": "0.45",
        "line_width": "0.45",
        "layer_height": "0.2",
        "outer_wall_speed": "60",
        "default_acceleration": "6000",
        "change_filament_gcode": '"' + CHANGE_TPL.replace("\n", "\\n") + '"',
    }
    lines = ["; CONFIG_BLOCK_START"]
    lines += [f"; {k} = {v}" for k, v in cfg.items()]
    lines += ["; CONFIG_BLOCK_END"]
    return bambu._from_text("\n".join(lines), "gcode")


def make_grid(z: float = 5.0, res: float = 0.5, size: float = 80.0) -> Grid:
    n = int(size / res) + 1
    H = np.full((n, n), z, dtype=np.float32)
    return Grid(x0=0.0, y0=0.0, res=res, nx=n, ny=n, H=H)


def make_tp(z: float = 5.0, last: int = 0) -> Toolpaths:
    empty = np.zeros((0, 5), dtype=np.float32)
    return Toolpaths(seg=empty, width=np.zeros(0, np.float32), feat=np.zeros(0, np.uint8),
                     fil=np.zeros(0, np.int8), layer=np.zeros(0, np.int16),
                     features=[""], layer_z=[z], last_filament=last, max_z=z,
                     end_pos=(0.0, 0.0, z))


@pytest.fixture(scope="module")
def env():
    return make_job(), make_tp(), make_grid()


def run(env, paths, **kw):
    job, tp, g = env
    return generate.generate(job, tp, g, paths, generate.Params(dir_opt=False, **kw))


def change_sequence(res) -> list[int]:
    """slot of every filament change, in G-code order"""
    return [int(m[1]) for m in res.moves if m[0] == 2]


def change_blocks(gcode: str):
    lines = gcode.split("\n")
    starts = [i for i, l in enumerate(lines) if l.startswith("; FilamentChangeGCodeStart")]
    ends = [i for i, l in enumerate(lines) if l.startswith("; FilamentChangeGCodeEnd")]
    return lines, starts, ends


def test_least_purge_order_from_loaded_filament(env):
    # loaded slot is 0; 0->3 (110) then 3->1 (130) = 240, beating 0->1->3 = 350
    paths = [{"slot": 0, "order": 0, "pts": [[20, 30], [30, 30]]},
             {"slot": 1, "order": 1, "pts": [[20, 35], [30, 35]]},
             {"slot": 3, "order": 2, "pts": [[20, 40], [30, 40]]}]
    res = run(env, paths)
    assert change_sequence(res) == [3, 1]
    assert res.stats["toolchanges"] == 2
    assert res.stats["batches"] == 3
    exp = (max(50.0, toolchange.purge_volume(make_job(), 0, 3))
           + max(50.0, toolchange.purge_volume(make_job(), 3, 1)))
    assert abs(res.stats["purge_mm3"] - exp) < 1e-6


def test_purge_factor_and_min_purge_are_respected(env):
    paths = [{"slot": 0, "pts": [[20, 30], [30, 30]]},
             {"slot": 1, "pts": [[20, 35], [30, 35]]}]
    res = run(env, paths, purge_factor=0.5, min_purge=10.0)
    exp = max(10.0, toolchange.purge_volume(make_job(), 0, 1) * 0.5)
    assert abs(res.stats["purge_mm3"] - exp) < 1e-6
    res2 = run(env, paths, purge_factor=1.0, min_purge=500.0)
    assert res2.stats["purge_mm3"] == 500.0


def test_no_overlap_two_colours_change_once(env):
    paths = [{"slot": 0, "order": 0, "pts": [[20, 30], [30, 30]]},
             {"slot": 0, "order": 1, "pts": [[50, 30], [60, 30]]},
             {"slot": 1, "order": 2, "pts": [[20, 35], [30, 35]]},
             {"slot": 1, "order": 3, "pts": [[50, 35], [60, 35]]}]
    res = run(env, paths)
    assert res.stats["batches"] == 2
    assert res.stats["toolchanges"] == 1
    assert change_sequence(res) == [1]


def test_white_colour_white_three_batches_far_element_first(env):
    # white below, colour crosses, white on top, plus a far white element that
    # has no constraint and therefore belongs to the first white batch
    paths = [{"slot": 0, "order": 0, "pts": [[30, 36], [50, 36]]},
             {"slot": 1, "order": 1, "pts": [[40, 32], [40, 40]]},
             {"slot": 0, "order": 2, "pts": [[38, 35], [42, 37]]},
             {"slot": 0, "order": 3, "pts": [[60, 35], [70, 35]]}]
    res = run(env, paths)
    assert res.stats["batches"] == 3
    assert res.stats["toolchanges"] == 2
    assert change_sequence(res) == [1, 0]            # white -> colour -> white
    ch = np.nonzero(res.moves[:, 0] == 2)[0]
    first = res.moves[:ch[0]]
    ex = first[first[:, 0] == 0]
    assert (ex[:, 5] > 59).any()                     # the far white element is in batch 1


def test_stacking_precedences_are_kept(env):
    # three parallel lines 0.4 mm apart, i.e. within line_width + tip_r + 0.05:
    # white (order 0) under colour (order 1) under white (order 2).  The stacking
    # forces exactly that print order, hence three batches and two changes.
    paths = [{"slot": 0, "order": 0, "pts": [[20, 30.0], [50, 30.0]]},
             {"slot": 1, "order": 1, "pts": [[20, 30.4], [50, 30.4]]},
             {"slot": 0, "order": 2, "pts": [[20, 30.8], [50, 30.8]]}]
    res = run(env, paths)
    assert res.stats["precedences"] == 2
    assert res.stats["batches"] == 3
    assert change_sequence(res) == [1, 0]               # white -> colour -> white
    # reconstruct which y line each colour run printed, in G-code order
    runs: list[tuple[int, list[float]]] = []
    cur = 0
    for row in res.moves:
        if row[0] == 2:
            cur = int(row[1])
            runs.append((cur, []))
        elif row[0] == 0:
            if not runs or runs[-1][0] != cur:
                runs.append((cur, []))
            runs[-1][1].append(float(row[3]))            # y of the move start
    ys = [round(float(np.mean(v)), 1) for _, v in runs if v]
    assert ys == [30.0, 30.4, 30.8]


def test_explicit_color_order_is_honoured(env):
    paths = [{"slot": 0, "order": 0, "pts": [[20, 30], [30, 30]]},
             {"slot": 1, "order": 1, "pts": [[20, 35], [30, 35]]},
             {"slot": 3, "order": 2, "pts": [[20, 40], [30, 40]]}]
    res = run(env, paths, color_order=[3, 1, 0])
    assert change_sequence(res) == [3, 1, 0]


def test_explicit_color_order_drops_unused_and_duplicates(env):
    paths = [{"slot": 0, "order": 0, "pts": [[20, 30], [30, 30]]},
             {"slot": 1, "order": 1, "pts": [[20, 35], [30, 35]]},
             {"slot": 3, "order": 2, "pts": [[20, 40], [30, 40]]}]
    # slot 2 is not in the design, the repeated 3 is ignored; slot 0 is appended
    res = run(env, paths, color_order=[2, 3, 3, 1])
    assert change_sequence(res) == [3, 1, 0]


def test_all_changes_are_inside_filament_change_markers(env):
    paths = [{"slot": 0, "order": 0, "pts": [[30, 36], [50, 36]]},
             {"slot": 1, "order": 1, "pts": [[40, 32], [40, 40]]},
             {"slot": 0, "order": 2, "pts": [[38, 35], [42, 37]]},
             {"slot": 2, "order": 3, "pts": [[60, 35], [70, 35]]}]
    for p in (generate.Params(dir_opt=False),
              generate.Params(dir_opt=False, color_order=[2, 1, 0])):
        job, tp, g = env
        res = generate.generate(job, tp, g, paths, p)
        lines, starts, ends = change_blocks(res.gcode)
        assert len(starts) == len(ends) == res.stats["toolchanges"]
        inside: set[int] = set()
        for a, b in zip(starts, ends):
            assert a < b
            inside |= set(range(a + 1, b))
        for i, l in enumerate(lines):
            if re.match(r"^T\d", l) or l.startswith("M620") or l.startswith("M621"):
                assert i in inside, f"change command outside the markers: {l!r}"


def test_repeat_generation_is_byte_identical(env):
    paths = [{"slot": 0, "order": 0, "pts": [[30, 36], [50, 36]]},
             {"slot": 1, "order": 1, "pts": [[40, 32], [40, 40]]},
             {"slot": 0, "order": 2, "pts": [[38, 35], [42, 37]]}]
    a = run(env, paths)
    b = run(env, paths)
    assert a.gcode == b.gcode
    c = run(env, paths, color_order=[1, 0])
    d = run(env, paths, color_order=[1, 0])
    assert c.gcode == d.gcode


def test_least_purge_order_is_optimal(env):
    import itertools

    def cost(old, new):
        if old == new:
            return 0.0
        return max(50.0, toolchange.purge_volume(make_job(), old, new))

    for slots, start in [([0, 1, 3], 0), ([1, 2, 3], 1), ([0, 2, 3], 2), ([0, 1, 2, 3], 0)]:
        got = generate._least_purge_order(slots, start, cost)

        def total(seq):
            c, prev = 0.0, start
            for s in seq:
                c += cost(prev, s)
                prev = s
            return c

        best = min(total(list(p)) for p in itertools.permutations(slots))
        assert sorted(got) == sorted(slots)
        assert abs(total(got) - best) < 1e-9
