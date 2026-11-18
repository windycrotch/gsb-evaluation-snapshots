"""Filament change G-code exactly like Bambu Studio renders it (no prime tower path).

Mirrors GCode::set_extruder() of BambuStudio (src/libslic3r/GCode.cpp): purge volume from
flush_volumes_matrix * flush_multiplier - grab_length*area, split into up to 4 flushes of
~135 mm3, rendered through the printer's own change_filament_gcode template.
"""
from __future__ import annotations

import math

from . import template as T
from .bambu import Job

G_MIN_PURGE = 100.0
G_PURGE_ONE_TIME = 135.0
G_MAX_FLUSH_COUNT = 4


def filament_area(job: Job, idx: int) -> float:
    d = job.float_at("filament_diameter", idx, 1.75)
    return math.pi / 4 * d * d


def flow_mm3_per_mm(width: float, height: float) -> float:
    # Slic3r Flow::mm3_per_mm for extrusions (rounded rectangle)
    if width <= height:
        return width * height
    return height * (width - height * (1 - math.pi / 4))


def purge_volume(job: Job, old: int, new: int) -> float:
    n = job.n_filaments
    mat = job.floats("flush_volumes_matrix")
    if len(mat) < n * n:
        return 0.0
    v = mat[old * n + new] * job.float_at("flush_multiplier", 0, 1.0)
    v -= job.float_at("grab_length", 0, 0.0) * filament_area(job, new)
    return max(0.0, v)


def base_env(job: Job) -> dict:
    return T.config_vars(job.config)


def change_env(job: Job, old: int, new: int, *, max_layer_z: float, layer_z: float, layer_num: int,
               pos: tuple[float, float, float], toolchange_count: int = 1,
               purge_vol: float | None = None) -> dict:
    env = base_env(job)
    n = job.n_filaments
    temps = job.floats("nozzle_temperature")
    fvs = job.floats("filament_flush_volumetric_speed")
    mvs = job.floats("filament_max_volumetric_speed")
    ftemp = job.floats("filament_flush_temp")
    rhigh = job.floats("nozzle_temperature_range_high")

    def at(lst, i, d=0.0):
        return lst[i] if i < len(lst) else (lst[0] if lst else d)

    flush_v = T.VList(T.Num(at(fvs, i) or at(mvs, i)) for i in range(n))
    flush_t = T.VList(T.INum(int(at(ftemp, i) or at(rhigh, i))) for i in range(n))
    wipe_vol = purge_volume(job, old, new) if purge_vol is None else purge_vol
    area_new = filament_area(job, new)
    wipe_len = wipe_vol / area_new
    flush_count = min(G_MAX_FLUSH_COUNT, int(round(wipe_vol / G_PURGE_ONE_TIME)))
    if flush_count == 0 and wipe_vol > 0:
        flush_count = 1
    unit = wipe_len / flush_count if flush_count else 0.0

    ow_w = job.float_at("outer_wall_line_width", 0, 0.42) or job.float_at("line_width", 0, 0.42)
    lh = job.float_at("layer_height", 0, 0.2)
    ow_speed = job.float_at("outer_wall_speed", 0, 100)
    ow_vol = min(ow_speed * flow_mm3_per_mm(ow_w, lh), at(mvs, new, 10))

    def efeed(i):
        f = int(60.0 * at(mvs, i, 0) / filament_area(job, i))
        return f or 100

    env.update({
        "previous_extruder": T.INum(old), "next_extruder": T.INum(new),
        "current_extruder": T.INum(new),
        "current_extruder_id": T.INum(0), "next_extruder_id": T.INum(0),
        "current_nozzle_id": T.INum(0), "next_nozzle_id": T.INum(0), "next_hotend": T.INum(0),
        "current_filament_id": T.INum(old), "next_filament_id": T.INum(new),
        "outer_wall_volumetric_speed": T.Num(ow_vol),
        "layer_num": T.INum(layer_num), "layer_z": T.Num(layer_z), "max_layer_z": T.Num(max_layer_z),
        "toolchange_z": T.Num(layer_z),
        "relative_e_axis": True, "toolchange_count": T.INum(toolchange_count), "fan_speed": T.INum(0),
        "old_retract_length": T.Num(job.float_at("retraction_length", old)),
        "new_retract_length": T.Num(job.float_at("retraction_length", new)),
        "filament_retract_length_nc": T.Num(job.float_at("filament_retract_length_nc", old)),
        "old_retract_length_toolchange": T.Num(job.float_at("retract_length_toolchange", old)),
        "new_retract_length_toolchange": T.Num(job.float_at("retract_length_toolchange", new)),
        "new_extruder_retracted_length": T.Num(0.0),
        "old_filament_temp": T.INum(int(at(temps, old, 210))),
        "new_filament_temp": T.INum(int(at(temps, new, 210))),
        "x_after_toolchange": T.Num(pos[0]), "y_after_toolchange": T.Num(pos[1]), "z_after_toolchange": T.Num(pos[2]),
        "first_flush_volume": T.Num(wipe_len / 2), "second_flush_volume": T.Num(wipe_len / 2),
        "old_filament_e_feedrate": T.INum(efeed(old)), "new_filament_e_feedrate": T.INum(efeed(new)),
        "old_extruder_variant": T.Str(""), "new_extruder_variant": T.Str(""),
        "travel_point_1_x": T.Num(0), "travel_point_1_y": T.Num(0), "travel_point_2_x": T.Num(0),
        "travel_point_2_y": T.Num(0), "travel_point_3_x": T.Num(0), "travel_point_3_y": T.Num(0),
        "wipe_avoid_perimeter": False, "wipe_avoid_pos_x": T.Num(110.0),
        "wipe_tower_center_pos_x": T.Num(0), "wipe_tower_center_pos_y": T.Num(0),
        "wipe_tower_center_pos_valid": False, "is_prime_tower_interface": False,
        "filament_tower_interface_purge_volume": T.Num(0), "filament_tower_interface_print_temp": T.INum(-1),
        "filament_cooling_before_tower": T.VList(T.Num(0) for _ in range(n)),
        "flush_volumetric_speeds": flush_v, "flush_temperatures": flush_t,
        "flush_length": T.Num(wipe_len),
    })
    for k in range(G_MAX_FLUSH_COUNT):
        env[f"flush_length_{k + 1}"] = T.Num(unit if k < flush_count else 0.0)
    env["_purge_volume"] = wipe_vol
    return env


def render_change(job: Job, old: int, new: int, **kw) -> tuple[str, float]:
    env = change_env(job, old, new, **kw)
    tpl = job.template("change_filament_gcode")
    txt = T.render(tpl, env, current_extruder=new)
    return txt, env["_purge_volume"]
