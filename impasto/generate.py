"""Generates the single non-planar decoration layer as Bambu-compatible G-code."""
from __future__ import annotations

import copy
import math
from dataclasses import dataclass, field, asdict

import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

from . import direction, surface, toolchange, tour
from .bambu import Job
from .parse import Toolpaths
from .surface import Grid


@dataclass
class Params:
    z_offset: float = 0.15        # nozzle height above the printed surface = bead height (mm);
                                  # negative = sink the nozzle a bit into the estimated surface
    line_width: float = 0.45      # mm
    flow: float = 1.0             # multiplier (on top of the filament flow ratio from Bambu)
    use_filament_flow_ratio: bool = True
    speed: float = 15.0           # print speed mm/s (capped by filament max volumetric speed)
    travel_speed: float = 150.0   # mm/s
    hop: float = 0.8              # travel lift above the highest surface point along the travel (mm)
    retract: float = -1.0         # mm, <0 = from Bambu config (retraction_length)
    retract_speed: float = 30.0   # mm/s
    step: float = 0.25            # resampling step so the nozzle follows the surface (mm)
    min_len: float = 0.5          # drop shorter strokes (mm)
    gap_flow: bool = True         # adapt extrusion to the real gap below the nozzle
    stack: bool = True            # lift over already printed non-planar lines (crossings)
    ramp: float = 0.5             # max dz/ds of crossing ramps
    accel: int = 2000             # M204 acceleration
    fan: int = -1                 # part fan %, <0 = Bambu filament fan_max_speed
    prime: float = 0.2            # extra mm filament after a filament change
    short_travel: float = 1.0     # travels shorter than this stay down, no retract (mm)
    purge_factor: float = 1.0     # multiplier on Bambu's purge volume for a filament change
    min_purge: float = 50.0       # mm3, at least this much is purged on every change
    color_order: list[int] = field(default_factory=list)  # explicit slot order (optional)
    dir_opt: bool = True          # print every section uphill where possible
    dir_min_rise: float = 0.10    # mm – a turn in the surface only cuts the stroke above this
    dir_end_len: float = 0.5      # mm – no cut closer than this to a stroke end
    dir_cap: int = 0              # max sections per stroke, 0 = unlimited
    dir_travel_weight: float = 10.0 # ordering: 1 mm downhill counts like N mm of travel
    dir_stub_slope: float = 0.25  # an end stub shorter than dir_end_len is still cut off when
                                  # it falls steeper than this (dz/ds); 0 = never
    wipe: float = -1.0            # mm wipe back along the last line while retracting,
                                  # <0 = from Bambu (wipe + wipe_distance), 0 = off
    retract_before_wipe: float = -1.0  # % of the retraction done before the wipe, <0 = Bambu
    coast: float = 0.0            # mm – stop extruding this far before a line that ends in a retract
    hop_bead: float = 0.4         # mm – travel clearance over already printed non-planar lines
    curve_radius: float = 1.0     # mm – slow down in curves tighter than this, 0 = off
    curve_min: float = 0.5        # slowest speed factor in the tightest curves
    warp_ends: float = 0.0        # mm – the part's ends sit this much higher than sliced
                                  # (grows with the square of the distance from the middle
                                  # along the long axis); 0 = off
    warp_edge: float = 0.0        # mm – extra lift right at the part's outline (warped edges)
    warp_edge_width: float = 3.0  # mm – the edge lift fades out over this distance inwards
    slope_comp: float = 0.0       # 0..1 – on slopes the flat nozzle face sits higher than the
                                  # line centre (tip radius x tan angle); take this share of that
                                  # extra gap back (the face keeps >= 0.03 mm clearance); 0 = off
    # touch-off (experimental): the nozzle touches the real part (G380 S3) and the
    # coordinate system is re-zeroed there (G92) – corrects warp and Z errors locally
    probe: bool = False
    probe_region: float = 40.0    # mm – the layer is printed in cells of this size, one touch per
                                  # cell; 0 = a single touch for the whole layer
    probe_temp: float = 140.0     # °C nozzle temperature for touching (Bambu touches at 140), 0 = as is
    probe_depth: float = 0.5      # mm – how far below the planned surface the touch may go
    probe_clear: float = 1.5      # mm – the touch starts at least this far above the planned
                                  # surface (the whole descent is a guarded G380 move)
    probe_speed: float = 5.0      # mm/s touch speed
    # old keys dir_min_len / dir_max_parts / dir_smooth are ignored on purpose:
    # their old defaults (1.5 / 6 / 0.8) hid real dips and left downhill lines.

    @classmethod
    def from_dict(cls, d: dict | None) -> "Params":
        p = cls()
        for k, v in (d or {}).items():
            if hasattr(p, k):
                cur = getattr(p, k)
                if isinstance(cur, bool):
                    v = bool(v)
                elif isinstance(cur, int) and not isinstance(cur, bool):
                    v = int(round(float(v)))
                elif isinstance(cur, float):
                    v = float(v)
                setattr(p, k, v)
        return p


def _f(v: float, nd: int = 3) -> str:
    s = f"{v:.{nd}f}"
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    if s in ("-0", ""):
        s = "0"
    return s


def _resample(pts: np.ndarray, step: float) -> np.ndarray:
    out = [pts[0]]
    for a, b in zip(pts[:-1], pts[1:]):
        d = float(np.hypot(*(b - a)))
        n = max(1, int(math.ceil(d / step)))
        for k in range(1, n + 1):
            out.append(a + (b - a) * (k / n))
    return np.asarray(out)


def _length(p: np.ndarray) -> float:
    return float(np.hypot(*np.diff(p, axis=0).T).sum()) if len(p) > 1 else 0.0


def _least_purge_order(used: list[int], start: int, cost_fn) -> list[int]:
    """Visit every slot once, starting from ``start``, with the least total purge.

    ``cost_fn(old, new)`` is the purge volume of one change (as it is rendered in
    the G-code).  The Bambu flush matrix is asymmetric, so the order matters.
    Up to 10 colours the optimum is found exactly (Held-Karp over all orders);
    beyond that a deterministic nearest-neighbour tour is used.
    """
    used = sorted({int(u) for u in used})
    n = len(used)
    if n <= 1:
        return used
    if n <= 10:
        INF = float("inf")
        full = 1 << n
        cost = [[cost_fn(a, b) for b in used] for a in used]
        first = [cost_fn(start, a) for a in used]
        dp = [[INF] * n for _ in range(full)]
        par = [[-1] * n for _ in range(full)]
        for j in range(n):
            dp[1 << j][j] = first[j]
        for mask in range(full):
            row = dp[mask]
            for j in range(n):
                c = row[j]
                if c == INF:
                    continue
                cj = cost[j]
                for k in range(n):
                    if mask >> k & 1:
                        continue
                    v = c + cj[k]
                    nm = mask | (1 << k)
                    if v < dp[nm][k] - 1e-12:
                        dp[nm][k] = v
                        par[nm][k] = j
        mask = full - 1
        j = min(range(n), key=lambda q: (dp[mask][q], q))
        seq: list[int] = []
        while j >= 0:
            seq.append(used[j])
            pj = par[mask][j]
            mask ^= 1 << j
            j = pj
        seq.reverse()
        return seq
    # many colours: nearest neighbour by purge, then a deterministic 2-opt pass
    rem = list(used)
    seq = []
    cur = start
    while rem:
        k = min(range(len(rem)), key=lambda t: (cost_fn(cur, rem[t]), rem[t]))
        cur = rem.pop(k)
        seq.append(cur)

    def total(s):
        c, prev = 0.0, start
        for v in s:
            c += cost_fn(prev, v)
            prev = v
        return c

    improved = True
    best_c = total(seq)
    while improved:
        improved = False
        for i in range(len(seq) - 1):
            for j in range(i + 1, len(seq)):
                cand = seq[:i] + seq[i:j + 1][::-1] + seq[j + 1:]
                c = total(cand)
                if c < best_c - 1e-9:
                    seq, best_c, improved = cand, c, True
    return seq


@dataclass
class Result:
    gcode: str
    moves: np.ndarray            # (N, 9) float32: type(0 extr/1 travel/2 change/3 wipe+coast) slot x0 y0 z0 x1 y1 z1 line
    stats: dict
    max_z: float
    end_slot: int
    flags: np.ndarray | None = None      # (N,) uint8 per move: FLAG_DOWN / FLAG_COAST / FLAG_WIPE
    retracts: np.ndarray | None = None   # (R, 3) float32 where the nozzle retracted
    touches: np.ndarray | None = None    # (T, 3) float32 touch-off points (x, y, planned surface z)


class Writer:
    def __init__(self):
        self.lines: list[str] = []
        self.moves: list[tuple] = []
        self.flags: list[int] = []
        self.retracts: list[tuple] = []
        self.x = self.y = self.z = None
        self.f = None

    def emit(self, s: str):
        self.lines.append(s)

    def move(self, x=None, y=None, z=None, e=None, f=None, kind=1, slot=-1, comment="", flag=0):
        parts = ["G1"]
        nx = self.x if x is None else x
        ny = self.y if y is None else y
        nz = self.z if z is None else z
        if x is not None and (self.x is None or abs(x - self.x) > 1e-4):
            parts.append("X" + _f(x))
        if y is not None and (self.y is None or abs(y - self.y) > 1e-4):
            parts.append("Y" + _f(y))
        if z is not None and (self.z is None or abs(z - self.z) > 1e-4):
            parts.append("Z" + _f(z))
        if e is not None:
            parts.append("E" + _f(e, 5))
        if f is not None and (self.f is None or abs(f - self.f) > 0.5):
            parts.append("F" + _f(f, 0))
            self.f = f
        if len(parts) == 1 or (len(parts) == 2 and parts[1][0] == "F"):
            if len(parts) == 2:
                self.f = None   # feedrate not emitted, force it on the next real move
            return
        self.emit(" ".join(parts) + (f" ; {comment}" if comment else ""))
        if None not in (self.x, self.y, self.z) and None not in (nx, ny, nz) and (x is not None or y is not None or z is not None):
            self.moves.append((kind, slot, self.x, self.y, self.z, nx, ny, nz, len(self.lines) - 1))
            self.flags.append(flag)
        self.x, self.y, self.z = nx, ny, nz


SLOPE_MIN_CLEAR = 0.03   # mm the nozzle face keeps above the surface with slope_comp

# move flags (Result.flags)
FLAG_DOWN = 1        # extrusion that runs downhill on the surface
FLAG_COAST = 2       # coasting: along the line without extrusion
FLAG_WIPE = 4        # wipe while retracting
FLAG_TOUCH = 8       # touch-off move (G380 down to the part, G92)


def generate(job: Job, tp: Toolpaths, g: Grid, paths: list[dict], params: Params, *,
             layer_num: int | None = None) -> Result:
    p = params
    if g.ZN is None:
        surface.analyze(g)
    n_fil = job.n_filaments
    w = p.line_width
    off = p.z_offset
    bead = max(abs(off), 0.02)     # nominal bead height for flow / speed calculation
    tip_r = float(getattr(g, "tip_r", 0.3) or 0.0)

    # local mean surface for gap-adaptive flow
    valid = np.isfinite(g.H)
    sig = max(0.5, 0.25 * w / g.res)
    num = ndimage.gaussian_filter(np.where(valid, g.H, 0.0), sig, mode="constant")
    den = ndimage.gaussian_filter(valid.astype(np.float64), sig, mode="constant")
    HA = np.where(den > 0.2, num / np.maximum(den, 1e-9), np.nan).astype(np.float32)
    HNP = np.full_like(g.H, -np.inf)          # top of already printed non-planar beads
    # warp allowance: the real part may sit higher than the G-code says
    WL = warp_lift(g, p.warp_ends, p.warp_edge, p.warp_edge_width)
    if WL is not None:
        HA = (HA + WL).astype(np.float32)
        g = copy.copy(g)            # the session grid stays untouched
        g.ZN = (g.ZN + WL).astype(np.float32)

    # ---- clean & group input --------------------------------------------------
    # The element order is the stacking order: element 1 is printed first (on the part),
    # every later element is laid onto whatever is below it at that point.
    groups: dict[tuple[int, int], list[tuple[np.ndarray, bool]]] = {}
    for item in paths:
        slot = int(item.get("slot", 0))
        if slot < 0 or slot >= n_fil:
            slot = 0
        idx = int(item.get("order", 0) or 0)
        pts = np.asarray(item.get("pts", []), dtype=np.float64).reshape(-1, 2)
        if len(pts) < 2:
            continue
        keep = np.r_[True, np.hypot(*np.diff(pts, axis=0).T) > 1e-4]
        pts = pts[keep]
        if len(pts) < 2 or _length(pts) < p.min_len:
            continue
        gap0 = float(np.hypot(*(pts[0] - pts[-1])))
        closed = bool(item.get("closed", False)) or gap0 < 1e-3
        if closed and gap0 >= 1e-3:
            if len(pts) < 3:
                closed = False
            else:
                pts = np.vstack([pts, pts[:1]])     # closed means closed: print the last edge too
        groups.setdefault((idx, slot), []).append((pts, closed))

    cur_slot = tp.last_filament if tp.last_filament >= 0 else 0

    def purge_between(old: int, new: int) -> float:
        """purge volume of one filament change, exactly as it is rendered later"""
        if old == new:
            return 0.0
        return max(p.min_purge, toolchange.purge_volume(job, old, new) * p.purge_factor)

    def colour_order(slots_: list[int]) -> list[int]:
        """Order of the colours: explicit ``color_order`` wins, otherwise the
        sequence with the least total purge from the loaded filament."""
        used: list[int] = []            # slots in the order they appear in the design
        seen: set[int] = set()
        for s in slots_:
            s = int(s)
            if s not in seen:
                seen.add(s)
                used.append(s)
        if not used:
            return []
        if p.color_order:
            # keep the slots that occur in the design, in the requested order;
            # the rest follow in their original (slot) order
            picked: set[int] = set()
            first: list[int] = []
            for s in p.color_order:
                try:
                    s = int(s)
                except (TypeError, ValueError):
                    continue
                if s in seen and s not in picked:
                    picked.add(s)
                    first.append(s)
            return first + sorted(s for s in used if s not in picked)
        return _least_purge_order(used, cur_slot, purge_between)

    W = Writer()
    base_z = max(tp.max_z, max(tp.layer_z) if tp.layer_z else tp.max_z)
    zn_max = float(np.nanmax(g.ZN)) if np.isfinite(g.ZN).any() else base_z
    max_z_seen = base_z
    if layer_num is None:
        layer_num = len(tp.layer_z)            # 0-based index of the new layer
    total_layers = layer_num + 1

    retract_len = {s: (p.retract if p.retract >= 0 else job.float_at("retraction_length", s, 0.8)) for s in range(n_fil)}
    if p.wipe >= 0:
        wipe_len = {s: p.wipe for s in range(n_fil)}
    else:
        wipe_len = {s: (job.float_at("wipe_distance", s, 0.0) if job.float_at("wipe", s, 0.0) > 0 else 0.0)
                    for s in range(n_fil)}
    if p.retract_before_wipe >= 0:
        rbw = {s: min(1.0, p.retract_before_wipe / 100.0) for s in range(n_fil)}
    else:
        rbw = {s: min(1.0, max(0.0, job.float_at("retract_before_wipe", s, 0.0) / 100.0)) for s in range(n_fil)}
    temps = job.floats("nozzle_temperature")
    fan_cfg = job.floats("fan_max_speed")
    mvs = job.floats("filament_max_volumetric_speed")
    ratios = job.floats("filament_flow_ratio")

    stats = {"length_mm": {}, "filament_mm": {}, "volume_mm3": {}, "strokes": {}, "toolchanges": 0,
             "purge_mm3": 0.0, "time_s": 0.0, "max_z": 0.0, "min_z": 1e9,
             "cuts": [], "dir_up_mm": 0.0, "dir_down_mm": 0.0, "dir_before_mm": 0.0,
             "dir_down_max": 0.0, "stacked_mm": 0.0, "elements": len({i for (i, _) in groups}),
             "travel_plan_mm": 0.0, "down_plan_mm": 0.0, "travel_mm": 0.0, "retracts": 0,
             "short_travels": 0, "wipe_mm": 0.0, "coast_mm": 0.0, "self_lift_mm": 0.0,
             "slowed_mm": 0.0, "batches": 0, "precedences": 0, "touches": 0, "touch_skipped": 0}

    W.emit("; ===== NON-PLANAR LAYER (Impasto) START =====")
    W.emit("; CHANGE_LAYER")
    W.emit(f"; Z_HEIGHT: {_f(zn_max + off)}")
    W.emit(f"; LAYER_HEIGHT: {_f(off)}")
    W.emit(f"; layer num/total_layer_count: {layer_num + 1}/{total_layers}")
    W.emit("; update layer progress")
    W.emit(f"M73 L{layer_num + 1}")
    W.emit(f"M991 S0 P{layer_num} ;notify layer change")
    W.emit("; FEATURE: Top surface")
    W.emit(f"; LINE_WIDTH: {_f(w)}")
    W.emit("G90")
    W.emit("M83")
    W.emit(f"M204 S{p.accel}")
    if p.probe:
        W.emit("; impasto: touch-off is on - Z is re-zeroed on the part (G380 S3 + G92) at every touch")

    retracted = retract_len.get(cur_slot, 0.8)   # Bambu wipes+retracts at the end of the last layer
    safe_z = zn_max + max(p.hop, 0.4) + 0.4
    W.emit(f"G1 Z{_f(safe_z)} F1200 ; lift above the part")
    W.z = safe_z
    W.x, W.y = tp.end_pos[0], tp.end_pos[1]
    stats["time_s"] += abs(safe_z - tp.end_pos[2]) / 20.0
    last_line = None        # (P, z) of the last extruded line, for the wipe
    last_touch = None       # (x, y) of the last touch-off
    touches: list[tuple] = []
    if p.probe:
        valid_ = np.isfinite(g.H)
        edge_mm = ndimage.distance_transform_edt(valid_) * g.res
        S_ = g.S if g.S is not None else np.zeros_like(g.H)
        # on a slope the flat nozzle face touches its highest point first – exactly what
        # ZN (the disc maximum) describes, so moderate slopes are fine to touch on
        flat_ok = valid_ & (edge_mm >= 2.0) & (S_ <= 30.0) & np.isfinite(g.ZN)

    def line_max(x0, y0, x1, y1):
        """highest surface (ZN) and highest printed bead (HNP) along a travel"""
        d = math.hypot(x1 - x0, y1 - y0)
        n = max(2, int(d / 0.4) + 1)
        xs = np.linspace(x0, x1, n)
        ys = np.linspace(y0, y1, n)
        z = surface.sample_max(g.ZN, g, xs, ys)
        zs = np.nanmax(np.r_[z, -np.inf])
        zs = float(zs) if math.isfinite(zs) else base_z
        if p.stack:
            z2 = surface.sample_max(HNP, g, xs, ys)
            zb_ = np.nanmax(np.r_[z2, -np.inf])
            zb_ = float(zb_) if math.isfinite(zb_) else -math.inf
        else:
            zb_ = -math.inf
        return zs, zb_

    def fan_cmd(slot):
        pct = p.fan if p.fan >= 0 else (fan_cfg[slot] if slot < len(fan_cfg) else 100)
        W.emit(f"M106 P1 S{int(round(255 * max(0, min(100, pct)) / 100))}")

    def retract(slot_):
        """retract (with a wipe back along the last line when it just ended here)"""
        nonlocal retracted, last_line
        rl_ = retract_len[slot_]
        rf_ = int(p.retract_speed * 60)
        stats["retracts"] += 1
        W.retracts.append((W.x or 0.0, W.y or 0.0, W.z or 0.0))
        wd = wipe_len[slot_]
        done = 0.0
        if wd > 0 and last_line is not None and rl_ > 0:
            LP, LZ = last_line
            if W.x is not None and math.hypot(LP[-1, 0] - W.x, LP[-1, 1] - W.y) < 1e-3:
                # walk back along the line
                RP, RZ = LP[::-1], LZ[::-1]
                seg = np.hypot(*np.diff(RP, axis=0).T)
                cum = np.r_[0.0, np.cumsum(seg)]
                if cum[-1] > 1e-3:
                    tot = min(wd, float(cum[-1]))
                    k = int(np.searchsorted(cum, tot, side="left"))
                    k = max(1, min(k, len(RP) - 1))
                    pts = [RP[i] for i in range(1, k)]
                    zz = [RZ[i] for i in range(1, k)]
                    t = (tot - cum[k - 1]) / max(cum[k] - cum[k - 1], 1e-12)
                    pts.append(RP[k - 1] + (RP[k] - RP[k - 1]) * t)
                    zz.append(RZ[k - 1] + (RZ[k] - RZ[k - 1]) * t)
                    e_before = rl_ * rbw[slot_]
                    e_wipe = rl_ - e_before
                    if e_before > 1e-6:
                        W.emit(f"G1 E-{_f(e_before, 5)} F{rf_}")
                        stats["time_s"] += e_before / p.retract_speed
                    # the extruder must not retract faster than retract_speed
                    v = p.travel_speed if e_wipe <= 1e-9 else min(p.travel_speed, tot * p.retract_speed / e_wipe)
                    v = max(v, 5.0)
                    px, py = W.x, W.y
                    for q, qz in zip(pts, zz):
                        ln = math.hypot(q[0] - px, q[1] - py)
                        e = -e_wipe * ln / tot if e_wipe > 0 else None
                        W.move(x=float(q[0]), y=float(q[1]), z=float(qz), e=e, f=v * 60,
                               kind=3, slot=slot_, flag=FLAG_WIPE)
                        px, py = q[0], q[1]
                    stats["wipe_mm"] += tot
                    stats["time_s"] += tot / v
                    done = rl_
        if done <= 0:
            W.emit(f"G1 E-{_f(rl_, 5)} F{rf_}")
            stats["time_s"] += rl_ / p.retract_speed
        retracted = rl_
        last_line = None

    def item_points(it):
        return it["P"][it["i0"]:it["i1"] + 1]

    def touch_spot(x, y, r=3.0):
        """flat, solid spot near (x, y) without printed lines around: (x, y, ZN) or None"""
        cx_, cy_ = g.to_cell(np.array([x]), np.array([y]))
        cx_, cy_ = int(round(float(cx_[0]))), int(round(float(cy_[0])))
        k = int(math.ceil(r / g.res))
        x0, x1 = max(0, cx_ - k), min(g.nx, cx_ + k + 1)
        y0, y1 = max(0, cy_ - k), min(g.ny, cy_ + k + 1)
        if x0 >= x1 or y0 >= y1:
            return None
        ok = flat_ok[y0:y1, x0:x1].copy()
        if p.stack:     # keep 1 mm away from printed non-planar lines (they are not in ZN)
            pad = int(math.ceil(1.0 / g.res))
            ya, yb, xa, xb = max(0, y0 - pad), min(g.ny, y1 + pad), max(0, x0 - pad), min(g.nx, x1 + pad)
            hn = ndimage.maximum_filter(HNP[ya:yb, xa:xb], size=2 * pad + 1, mode="constant", cval=-np.inf)
            ok &= ~np.isfinite(hn[y0 - ya:y1 - ya, x0 - xa:x1 - xa])
        jj, ii = np.nonzero(ok)
        if not len(ii):
            return None
        xs = g.x0 + (ii + x0) * g.res
        ys = g.y0 + (jj + y0) * g.res
        d = np.hypot(xs - x, ys - y)
        m = int(np.argmin(d))
        if d[m] > r:
            return None
        return float(xs[m]), float(ys[m]), float(g.ZN[jj[m] + y0, ii[m] + x0])

    def touch_off(slot_, x, y, zt, print_temp):
        """touch the real surface and re-zero Z there (G380 S3 + G92)"""
        nonlocal last_touch, retracted
        if retracted <= 0:
            retract(slot_)
        cx, cy = W.x, W.y
        zs_, zbd = line_max(cx, cy, x, y)
        tz = max(zs_ + p.hop, zbd + p.hop_bead, zt + p.probe_clear, W.z or 0.0)
        W.emit(f"; impasto touch-off {stats['touches'] + 1} at X{x:.2f} Y{y:.2f}, planned surface Z{zt:.3f}")
        W.move(z=tz, f=1200, kind=1, slot=slot_)
        W.move(x=x, y=y, f=p.travel_speed * 60, kind=1, slot=slot_)
        stats["time_s"] += math.hypot(x - cx, y - cy) / p.travel_speed
        cool = 0 < p.probe_temp < print_temp - 1
        if cool:
            W.emit(f"M104 S{int(p.probe_temp)}")
            W.emit(f"M109 S{int(p.probe_temp)} ; Bambu waits for cooling as well")
            stats["time_s"] += 45.0
        # the whole way down is a guarded move: a part warped higher than expected
        # stops the nozzle instead of being run into
        z_from = W.z
        W.emit("G91")
        W.emit(f"G380 S3 Z-{_f(z_from - zt + p.probe_depth)} F{int(p.probe_speed * 60)} ; touch")
        W.emit("G90")
        W.emit("M400")
        W.emit(f"G92 Z{_f(zt)} ; the real surface here is the planned one")
        W.moves.append((1, slot_, x, y, z_from, x, y, zt, len(W.lines) - 1))
        W.flags.append(FLAG_TOUCH)
        W.z = zt
        W.f = None
        stats["time_s"] += (z_from - zt + p.probe_depth) / max(p.probe_speed, 0.5) + 1.0
        W.move(z=zt + max(p.hop, 1.0), f=600, kind=1, slot=slot_)
        if cool:
            # heat up off the part: what oozes while heating goes into the chute
            W.move(z=max(W.z, zn_max + max(p.hop, 1.0)), f=1200, kind=1, slot=slot_)
            # the same way into the chute as Bambu's own filament change: Y90, then slowly X-13.5
            W.move(y=90.0, f=9000, kind=1, slot=slot_)
            W.move(x=-13.5, f=3000, kind=1, slot=slot_)
            W.emit(f"M109 S{int(print_temp)}")
            W.move(x=0.0, f=18000, kind=1, slot=slot_)     # wipe and shake, like the template
            W.move(x=-13.5, f=3000, kind=1, slot=slot_)
            stats["time_s"] += 25.0 + 2 * abs(x + 13.5) / p.travel_speed
        touches.append((x, y, zt))
        stats["touches"] += 1
        last_touch = (x, y)

    # ---- plan every section of every group -----------------------------------
    gkeys = sorted(groups)
    items: list[dict] = []
    for key in gkeys:
        idx, slot = key
        for s, closed in groups[key]:
            dense = _resample(s, p.step)
            zs = surface.sample_max(g.ZN, g, dense[:, 0], dense[:, 1])
            ok = np.isfinite(zs)
            # split at holes
            pieces = []
            start = None
            for i, o in enumerate(ok):
                if o and start is None:
                    start = i
                if (not o or i == len(ok) - 1) and start is not None:
                    end = i + 1 if o else i
                    if end - start >= 2:
                        pieces.append((start, end))
                    start = None
            whole_ring = closed and len(pieces) == 1 and pieces[0] == (0, len(dense))
            for (a, b) in pieces:
                P = dense[a:b]
                if _length(P) < p.min_len:
                    continue
                zb = zs[a:b] + off
                if whole_ring and p.dir_opt and len(P) > 4:
                    # start the ring at its lowest point: the cuts then sit on real
                    # turns and no artificial seam splits a monotone flank in two
                    ring, zr = P[:-1], zb[:-1]
                    zm = np.median(np.stack([np.roll(zr, 1), zr, np.roll(zr, -1)]), axis=0)
                    r0 = int(np.argmin(zm))
                    if r0:
                        P = np.vstack([ring[r0:], ring[:r0], ring[r0:r0 + 1]])
                        zb = np.r_[zr[r0:], zr[:r0], zr[r0:r0 + 1]]
                ds = np.r_[0.0, np.hypot(*np.diff(P, axis=0).T)]
                comp = np.zeros(len(P))
                if p.slope_comp > 0 and off > SLOPE_MIN_CLEAR:
                    # nozzle face on a slope: its lowest point (ZN) is above the line centre;
                    # lower the nozzle by a share of that, keeping the face clear of the
                    # surface. Only the nozzle height changes – direction and the downhill
                    # measure keep looking at the surface.
                    hc = surface.sample(g.H, g, P[:, 0], P[:, 1])
                    extra = np.where(np.isfinite(hc), np.maximum(zb - off - hc, 0.0), 0.0)
                    comp = np.minimum(p.slope_comp * extra, off - SLOPE_MIN_CLEAR)
                dz0 = np.diff(zb)
                stats["dir_before_mm"] += float(ds[1:][dz0 < -1e-6].sum())
                # ---- uphill first: split the stroke where the surface turns ----
                if p.dir_opt:
                    secs = direction.plan(P, zb, min_rise=p.dir_min_rise, min_len=p.dir_end_len,
                                          max_parts=p.dir_cap, stub_slope=p.dir_stub_slope)
                else:
                    secs = [(0, len(P) - 1, False)]
                for k, (i0, i1, rev) in enumerate(secs):
                    if i1 - i0 < 1:
                        continue
                    ring = whole_ring and i0 == 0 and i1 == len(P) - 1
                    # downhill arc length of this section in both directions: a
                    # level but wavy section costs nothing when it is flipped
                    zi, di = zb[i0:i1 + 1], ds[i0:i1 + 1]
                    dz = np.diff(zi)
                    desc_f = float(di[1:][dz < -1e-6].sum())
                    desc_b = float(di[1:][dz > 1e-6].sum())
                    items.append({"P": P, "zb": zb, "comp": comp, "ds": ds, "key": key, "idx": idx, "slot": slot,
                                  "i0": i0, "i1": i1, "k": k, "n": len(secs),
                                  "down_f": desc_f, "down_b": desc_b, "ring": ring,
                                  "cut": (float(P[i0, 0]), float(P[i0, 1]), float(zb[i0]))})

    # ---- precedence: where two elements overlap, the lower one goes first -----
    # (only sections that really come close; everything else may be reordered)
    item_before: set[tuple[int, int]] = set()
    gpred: dict[tuple[int, int], set] = {k: set() for k in gkeys}
    if len({it["idx"] for it in items}) > 1:
        dep_r = w + tip_r + 0.05
        P_all = [item_points(it) for it in items]
        owner = np.repeat(np.arange(len(items)), [len(q) for q in P_all])
        tree = cKDTree(np.vstack(P_all))
        pr = tree.query_pairs(dep_r, output_type="ndarray")
        if len(pr):
            ia, ib = owner[pr[:, 0]], owner[pr[:, 1]]
            el = np.array([it["idx"] for it in items])
            m = el[ia] != el[ib]
            ia, ib = ia[m], ib[m]
            lo = np.where(el[ia] < el[ib], ia, ib)
            hi = np.where(el[ia] < el[ib], ib, ia)
            for a, b in set(zip(lo.tolist(), hi.tolist())):
                item_before.add((a, b))
                ka, kb = items[a]["key"], items[b]["key"]
                if ka != kb:
                    gpred[kb].add(ka)

    # ---- colour batches: all elements of a colour together, as far as the
    #      stacking allows (a colour comes back only where an overlap needs it)
    prio = colour_order([s for (_, s) in gkeys])
    rank = {s: i for i, s in enumerate(prio)}
    explicit = bool(p.color_order)
    printable = {it["key"] for it in items}

    def _grow(colour: int, remaining: list, done: set) -> set:
        """every remaining group of ``colour`` that can be printed in one go"""
        batch: set = set()
        changed = True
        while changed:
            changed = False
            for k in remaining:
                if k not in batch and k[1] == colour and gpred[k] <= (done | batch):
                    batch.add(k)
                    changed = True
        return batch

    batches: list[tuple[int, list]] = []
    done_g: set = set()
    source_slot = cur_slot                  # filament that is in the nozzle right now
    remaining = [k for k in gkeys if k in printable]
    while remaining:
        avail = [k for k in remaining if gpred[k] <= done_g]
        if not avail:                       # cannot happen unless the precedences form a cycle
            avail = remaining
        avail_slots = {k[1] for k in avail}
        per_colour = {s: {k for k in remaining if k[1] == s} for s in avail_slots}
        cover = {s: _grow(s, remaining, done_g) for s in avail_slots}
        # A colour that can be finished completely should be preferred: printing
        # part of a colour and coming back to it later always costs an extra change.
        complete = {s for s in avail_slots if cover[s] == per_colour[s]}
        if explicit:
            # the requested order is the plan: take the highest-ranked colour that may go now
            s_ = min(avail_slots, key=lambda x: (rank.get(x, len(rank)), x))
        else:
            # Prefer a colour that can be finished now (a colour only comes back
            # later when its stacking constraints really block it now); among
            # those keep the filament already loaded when possible - that saves a
            # change - and otherwise follow the least-purge colour order.
            cands = complete or avail_slots
            if source_slot in cands:
                s_ = source_slot
            else:
                s_ = min(cands, key=lambda x: (rank.get(x, len(rank)), x))
        batch = cover[s_]
        batches.append((s_, sorted(batch)))
        source_slot = s_
        done_g |= batch
        remaining = [k for k in remaining if k not in batch]
    # two batches of the same colour with nothing printed in between are one
    # colour run - coalesce them so ``batches`` counts real changes of colour
    merged: list[tuple[int, list]] = []
    for s_, keys in batches:
        if merged and merged[-1][0] == s_:
            merged[-1] = (s_, sorted(set(merged[-1][1]) | set(keys)))
        else:
            merged.append((s_, keys))
    batches = merged
    stats["batches"] = len(batches)
    # every stacking constraint between two elements is counted once, whether
    # the two land in the same colour batch or in different ones
    stats["precedences"] = sum(len(v) for v in gpred.values())

    first = True
    tc_count = 0
    for (slot, bkeys) in batches:
        bset = set(bkeys)
        bidx = [j for j, it in enumerate(items) if it["key"] in bset]
        if not bidx:
            continue
        loc = {j: t for t, j in enumerate(bidx)}
        bitems = [items[j] for j in bidx]
        before = sorted((loc[a], loc[b]) for (a, b) in item_before if a in loc and b in loc)
        if slot != cur_slot:
            # ---- filament change, rendered by the printer's own template ----
            lift = max(W.z or 0, zn_max + 1.0)
            if retracted <= 0:
                retract(cur_slot)
            W.move(z=lift, f=1200)
            tc_count += 1
            pv0 = toolchange.purge_volume(job, cur_slot, slot) * p.purge_factor
            txt, pv = toolchange.render_change(
                job, cur_slot, slot, max_layer_z=max(base_z, max_z_seen), layer_z=zn_max + off,
                layer_num=layer_num, pos=(W.x or 0, W.y or 0, W.z or 0), toolchange_count=tc_count,
                purge_vol=max(p.min_purge, pv0))
            tc_line = len(W.lines)
            W.emit("; FilamentChangeGCodeStart")
            for ln in txt.rstrip("\n").split("\n"):
                W.emit(ln)
            W.emit("; FilamentChangeGCodeEnd")
            W.moves.append((2, slot, W.x or 0, W.y or 0, W.z or 0, W.x or 0, W.y or 0, W.z or 0, tc_line))
            W.flags.append(0)
            stats["toolchanges"] += 1
            stats["purge_mm3"] += pv
            fvs = job.float_at("filament_max_volumetric_speed", slot, 2.0) or 2.0
            stats["time_s"] += 50.0 + pv / fvs
            # position after the template: unknown XY near the purge chute, Z at max_layer_z+3
            W.x, W.y = -13.5, 90.0
            W.z = max(base_z, max_z_seen) + 3.0
            W.f = None
            retracted = job.float_at("retract_length_toolchange", slot, 2.0) + p.prime
            last_line = None
            cur_slot = slot
            fan_cmd(slot)
        elif first:
            t = int(temps[slot]) if slot < len(temps) else 200
            W.emit(f"M104 S{t}")
            fan_cmd(slot)
        first = False

        fr = (ratios[slot] if (p.use_filament_flow_ratio and slot < len(ratios)) else 1.0) * p.flow
        fil_area = toolchange.filament_area(job, slot)
        vmax = mvs[slot] if slot < len(mvs) and mvs[slot] > 0 else 10.0
        nominal = toolchange.flow_mm3_per_mm(w, bead)
        v_print = min(p.speed, vmax / max(nominal, 1e-6))
        f_travel = p.travel_speed * 60
        rf = int(p.retract_speed * 60)

        # ---- order the sections so that the travels stay short: every hop is a
        #      retract + prime (oozing), so a section may also be printed the
        #      other way round when that saves more travel than the downhill
        #      costs (see impasto.tour); overlapping sections keep their stacking order
        plan_start = (W.x or 0.0), (W.y or 0.0)
        secs_ = [(it["P"][it["i0"]], it["P"][it["i1"]], it["down_b"] - it["down_f"]) for it in bitems]
        wt = p.dir_travel_weight if p.dir_opt else 0.0
        touch_at: dict[int, tuple] = {}         # position in the order -> cell centre to touch near
        if p.probe and p.probe_region > 0 and len(bitems) > 1:
            # every touch costs a cool-down: print cell by cell, one touch per cell
            order, flips, plan_info, touch_at = _plan_cells(bitems, secs_, before, plan_start, wt,
                                                            p.probe_region)
        else:
            order, flips, plan_info = tour.plan(secs_, plan_start, weight=wt, before=before)
            if p.probe and order:
                touch_at = {0: None}
        stats["travel_plan_mm"] += plan_info["travel"]
        stats["down_plan_mm"] += plan_info["downhill"]

        def emit_path(P, z, ds, gap, vseg, note="", dirz=None, coast=0.0):
            """Travel to P[0] and extrude along it."""
            nonlocal retracted, max_z_seen, last_line
            if note:
                W.emit(f"; impasto {note}")
            x0, y0, z0 = float(P[0, 0]), float(P[0, 1]), float(z[0])
            cx = W.x if W.x is not None else x0
            cy = W.y if W.y is not None else y0
            cz = W.z if W.z is not None else z0
            dist = math.hypot(x0 - cx, y0 - cy)
            zs_, zbd = line_max(cx, cy, x0, y0)
            # a short travel stays down: just clear the surface (and touch at most
            # the top of a printed bead, like a planar slicer does within a layer)
            z_short = max(cz, z0, zs_ + max(off, 0.05), zbd)
            short = (dist <= p.short_travel and retracted <= 0 and abs(cz - z0) < 1.0
                     and z_short - max(cz, z0) <= p.hop_bead)
            if short:
                stats["short_travels"] += 1
                if z_short > max(cz, z0) + 1e-4:
                    W.move(z=z_short, f=1200, kind=1, slot=slot)
                    W.move(x=x0, y=y0, f=f_travel, kind=1, slot=slot)
                else:
                    W.move(x=x0, y=y0, z=max(z0, cz) if dist > 0.05 else z0, f=f_travel, kind=1, slot=slot)
                if abs((W.z or z0) - z0) > 1e-4:
                    W.move(z=z0, f=600, kind=1, slot=slot)
                stats["time_s"] += dist / p.travel_speed
            else:
                if retracted <= 0:
                    retract(slot)
                    cx, cy, cz = W.x, W.y, W.z        # the wipe moved the nozzle
                    dist = math.hypot(x0 - cx, y0 - cy)
                    zs_, zbd = line_max(cx, cy, x0, y0)
                tz = max(zs_ + p.hop, zbd + p.hop_bead, max(z0, cz) + p.hop_bead)
                if W.z is None or tz > W.z:
                    W.move(z=tz, f=1200, kind=1, slot=slot)
                else:
                    tz = W.z
                W.move(x=x0, y=y0, f=f_travel, kind=1, slot=slot)
                W.move(z=z0, f=600, kind=1, slot=slot)
                stats["time_s"] += dist / p.travel_speed + 2 * abs(tz - z0) / 10.0
            stats["travel_mm"] += dist
            if retracted > 0:
                W.emit(f"G1 E{_f(retracted, 5)} F{rf}")
                retracted = 0.0
                stats["time_s"] += 0.05
            W.f = None
            tot_e = 0.0
            s_arc = np.cumsum(ds)
            L = float(s_arc[-1])
            coast = min(max(coast, 0.0), 0.5 * L)
            s_c = L - coast
            dzm = np.diff(z if dirz is None else dirz)
            for i in range(1, len(P)):
                hmid = 0.5 * (gap[i] + gap[i - 1])
                e = fr * toolchange.flow_mm3_per_mm(w, hmid) * ds[i] / fil_area
                if e <= 0:
                    continue
                flag = FLAG_DOWN if dzm[i - 1] < -1e-6 else 0
                kind = 0
                if coast > 0 and s_arc[i] > s_c + 1e-9:
                    frac = max(0.0, (s_c - s_arc[i - 1]) / max(ds[i], 1e-12))
                    stats["coast_mm"] += ds[i] * (1 - frac)
                    if frac <= 1e-6:
                        e, kind, flag = None, 3, FLAG_COAST
                    else:
                        e *= frac
                W.move(x=float(P[i, 0]), y=float(P[i, 1]), z=float(z[i]), e=e, f=vseg[i] * 60,
                       kind=kind, slot=slot, flag=flag)
                tot_e += e or 0.0
                ds3 = math.hypot(ds[i], z[i] - z[i - 1])
                stats["time_s"] += ds3 / vseg[i]
                if vseg[i] < v_print - 1e-6:
                    stats["slowed_mm"] += ds[i]
            stats["dir_up_mm"] += float(ds[1:][dzm > 1e-6].sum())
            stats["dir_down_mm"] += float(ds[1:][dzm < -1e-6].sum())
            if len(dzm) and float(dzm.min()) < 0:
                stats["dir_down_max"] = max(stats["dir_down_max"], float(-dzm.min()))
            stats["length_mm"][slot] = stats["length_mm"].get(slot, 0.0) + L
            stats["filament_mm"][slot] = stats["filament_mm"].get(slot, 0.0) + tot_e
            stats["volume_mm3"][slot] = stats["volume_mm3"].get(slot, 0.0) + tot_e * fil_area
            stats["strokes"][slot] = stats["strokes"].get(slot, 0) + 1
            stats["max_z"] = max(stats["max_z"], float(z.max()))
            stats["min_z"] = min(stats["min_z"], float(z.min()))
            max_z_seen = max(max_z_seen, float(z.max()))
            if p.stack:
                _stamp(HNP, g, P, z, w * 0.4)
            last_line = (np.asarray(P, dtype=np.float64), np.asarray(z, dtype=np.float64))

        # planned entry of every section: used to roll a closed ring to the
        # cheapest start (entering where the previous line ended, leaving
        # towards the next one) and to decide on coasting
        entries = [bitems[j]["P"][bitems[j]["i0"]] if not f else bitems[j]["P"][bitems[j]["i1"]]
                   for j, f in zip(order, flips)]

        for pos, (j, flip) in enumerate(zip(order, flips)):
            it = bitems[j]
            P, zb = it["P"], it["zb"]
            sl = slice(it["i0"], it["i1"] + 1)
            Pp, zp, cp = P[sl], zb[sl].copy(), it["comp"][sl]
            if flip:
                Pp, zp, cp = Pp[::-1], zp[::-1], cp[::-1]
            if it["ring"] and len(Pp) > 3:
                # rotate the ring: enter where the nozzle is, leave towards the next line
                px_, py_ = (W.x if W.x is not None else Pp[0, 0]), (W.y if W.y is not None else Pp[0, 1])
                nxt = entries[pos + 1] if pos + 1 < len(entries) else Pp[-1]
                d0 = np.hypot(Pp[:, 0] - px_, Pp[:, 1] - py_) + np.hypot(Pp[:, 0] - nxt[0], Pp[:, 1] - nxt[1])
                ri = int(np.argmin(d0[:-1]))
                if ri:
                    ringp = Pp[:-1]
                    Pp = np.vstack([ringp[ri:], ringp[:ri], ringp[ri:ri + 1]])
                    zp = np.r_[zp[:-1][ri:], zp[:-1][:ri], zp[ri:ri + 1]]
                    cp = np.r_[cp[:-1][ri:], cp[:-1][:ri], cp[ri:ri + 1]]
            dsp = np.r_[0.0, np.hypot(*np.diff(Pp, axis=0).T)]
            z_dir = zp.copy()        # surface only: the uphill metric ignores stacking and ramps
            zp = zp - cp             # slope compensation: nozzle height only
            # what is printed below this line right now (earlier sections and elements)
            if p.stack:
                hp = surface.sample(HNP, g, Pp[:, 0], Pp[:, 1], mode="nearest")
                hp = np.where(np.isfinite(hp), hp, -np.inf)
                on_top = (hp + bead) > (zp + 0.02)
                if on_top.any():
                    stats["stacked_mm"] += float(dsp[1:][on_top[1:]].sum())
                zp = np.maximum(zp, hp + bead)     # lay it onto the bead below
                z_before = zp.copy()
                zp = _self_lift(Pp, zp, dsp, w, bead, it["ring"])
                lifted = zp > z_before + 1e-6
                if lifted.any():
                    stats["self_lift_mm"] += float(dsp[lifted].sum())
            else:
                hp = np.full(len(Pp), -np.inf)
            nk = min(3, max(1, len(zp) // 4))
            rise, slen = float(zp[-nk:].mean() - zp[:nk].mean()), float(dsp.sum())
            if p.ramp > 0:
                for i in range(1, len(zp)):
                    zp[i] = max(zp[i], zp[i - 1] - p.ramp * dsp[i])
                for i in range(len(zp) - 2, -1, -1):
                    zp[i] = max(zp[i], zp[i + 1] - p.ramp * dsp[i + 1])
            if p.gap_flow:
                ha = surface.sample(HA, g, Pp[:, 0], Pp[:, 1])
                ha = np.maximum(np.where(np.isfinite(ha), ha, -np.inf), hp)
                gap = np.where(np.isfinite(ha), zp - ha, bead)
                gap = np.clip(gap, 0.5 * bead, 2.0 * bead)
            else:
                gap = np.full(len(zp), bead)
            # speed per segment: the filament's volumetric limit at the real gap
            # (a thick bead on a slope needs more material per mm) and slower in
            # tight curves
            hm = np.r_[gap[0], 0.5 * (gap[1:] + gap[:-1])]
            vol = np.array([fr * toolchange.flow_mm3_per_mm(w, h) for h in hm])
            vseg = np.minimum(v_print, vmax / np.maximum(vol, 1e-6))
            if p.curve_radius > 0:
                cf = _curve_factor(Pp, dsp, p.curve_radius, p.curve_min)
                vseg = vseg * np.minimum(cf, np.r_[cf[0], cf[:-1]])
            vseg = np.maximum(np.floor(vseg * 2.0 + 1e-9) / 2.0, 1.0)   # 0.5 mm/s steps, fewer F words

            # coast only where the next travel retracts
            coast = 0.0
            if p.coast > 0:
                if pos + 1 >= len(entries):
                    coast = p.coast
                else:
                    nx_ = entries[pos + 1]
                    if math.hypot(nx_[0] - Pp[-1, 0], nx_[1] - Pp[-1, 1]) > p.short_travel:
                        coast = p.coast

            note = ""
            if p.dir_opt and it["n"] > 1:
                way = "uphill" if rise > 1e-6 else ("downhill" if rise < -1e-6 else "flat")
                note = f"section {it['k'] + 1}/{it['n']}: {way} {rise:+.2f} mm over {slen:.1f} mm"
                if it["k"] > 0:
                    cx_, cy_, cz_ = it["cut"]
                    note += f" - cut at X{cx_:.2f} Y{cy_:.2f} Z{cz_:.2f}"
            ctr = touch_at.get(pos)
            near = (last_touch is not None and ctr is not None and
                    math.hypot(ctr[0] - last_touch[0], ctr[1] - last_touch[1]) < 0.35 * p.probe_region)
            if p.probe and pos in touch_at and (p.probe_region > 0 or last_touch is None) and not near:
                spot = None
                if ctr is not None:      # near the middle of the cell: the re-zero fits it best
                    spot = touch_spot(ctr[0], ctr[1], r=max(3.0, p.probe_region / 2))
                if spot is None:
                    spot = touch_spot(float(Pp[0, 0]), float(Pp[0, 1]))
                if spot is None:
                    spot = touch_spot(float(Pp[0, 0]), float(Pp[0, 1]), r=6.0)
                if spot is not None:
                    touch_off(slot, spot[0], spot[1], spot[2],
                              int(temps[slot]) if slot < len(temps) else 200)
                else:
                    stats["touch_skipped"] += 1
            emit_path(Pp, zp, dsp, gap, vseg, note, dirz=z_dir, coast=coast)
            if it["k"] > 0:
                cx_, cy_, cz_ = it["cut"]
                stats["cuts"].append({"x": round(cx_, 2), "y": round(cy_, 2), "z": round(cz_, 2),
                                      "rise": round(rise, 3), "len": round(slen, 2)})
        # end of colour batch

    if retracted <= 0 and W.x is not None:
        retract(cur_slot)
    end_z = max(W.z or 0, max_z_seen) + 1.0
    W.move(z=end_z, f=1200)
    W.emit(f"M204 S{int(job.float_at('default_acceleration', 0, 6000))}")
    W.emit("; ===== NON-PLANAR LAYER END =====")

    if stats["min_z"] > 1e8:
        stats["min_z"] = 0.0
    stats["dir"] = {"cuts": len(stats["cuts"]),
                    "up_mm": round(stats["dir_up_mm"], 2),
                    "down_mm": round(stats["dir_down_mm"], 2),
                    "before_mm": round(stats["dir_before_mm"], 2),
                    "down_max": round(stats["dir_down_max"], 3),
                    "travel_mm": round(stats["travel_plan_mm"], 1),
                    "plan_down_mm": round(stats["down_plan_mm"], 2),
                    "retracts": stats["retracts"],
                    "travel_real_mm": round(stats["travel_mm"], 1)}
    stats["end_z"] = end_z
    used_slots = sorted({s for (_, s) in groups})
    stats["colors"] = used_slots
    stats["speed_mm_s"] = {s: round(min(p.speed, (mvs[s] if s < len(mvs) and mvs[s] > 0 else 10) /
                                     max(toolchange.flow_mm3_per_mm(w, bead), 1e-6)), 2) for s in used_slots}
    mv = np.asarray(W.moves, dtype=np.float32).reshape(-1, 9)
    fl = np.asarray(W.flags, dtype=np.uint8)
    rt = np.asarray(W.retracts, dtype=np.float32).reshape(-1, 3)
    return Result(gcode="\n".join(W.lines) + "\n", moves=mv, stats=stats, max_z=end_z, end_slot=cur_slot,
                  flags=fl, retracts=rt, touches=np.asarray(touches, dtype=np.float32).reshape(-1, 3))


def _plan_cells(bitems, secs, before, start, weight, size):
    """order sections cell by cell (square cells of ``size`` mm): cells are
    visited nearest-first as the stacking precedences allow (cells that depend
    on each other both ways are merged), the sections inside a cell are ordered
    by :func:`impasto.tour.plan`.  Returns order, flips, info and {position: cell
    centre} where a new cell starts."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    n = len(bitems)
    cen = np.array([it["P"][it["i0"]:it["i1"] + 1].mean(axis=0) for it in bitems])
    keys = [tuple(k) for k in np.floor(cen / size).astype(np.int64).tolist()]
    uk = sorted(set(keys))
    cid = np.array([uk.index(k) for k in keys])
    m = len(uk)
    ea = [cid[a] for a, b in before if cid[a] != cid[b]]
    eb = [cid[b] for a, b in before if cid[a] != cid[b]]
    if ea:
        G = coo_matrix((np.ones(len(ea)), (ea, eb)), shape=(m, m))
        _, comp = connected_components(G, directed=True, connection="strong")
    else:
        comp = np.arange(m)
    grp = comp[cid]                                   # merged cell of every section
    ng = int(grp.max()) + 1
    gpred = [set() for _ in range(ng)]
    for a, b in before:
        if grp[a] != grp[b]:
            gpred[grp[b]].add(int(grp[a]))
    gcen = np.array([cen[grp == q].mean(axis=0) for q in range(ng)])
    order, flips, touch_at = [], [], {}
    info = {"travel": 0.0, "downhill": 0.0, "cost": 0.0}
    done: set = set()
    px, py = float(start[0]), float(start[1])
    while len(done) < ng:
        cand = [q for q in range(ng) if q not in done and gpred[q] <= done]
        q = min(cand, key=lambda c: (math.hypot(gcen[c, 0] - px, gcen[c, 1] - py), c))
        idx = [j for j in range(n) if grp[j] == q]
        loc = {j: t for t, j in enumerate(idx)}
        bb = [(loc[a], loc[b]) for a, b in before if a in loc and b in loc]
        o, f, inf = tour.plan([secs[j] for j in idx], (px, py), weight=weight, before=bb)
        touch_at[len(order)] = (float(gcen[q, 0]), float(gcen[q, 1]))
        order += [idx[k] for k in o]
        flips += f
        for k in ("travel", "downhill", "cost"):
            info[k] += inf[k]
        last = idx[o[-1]]
        ex = secs[last][0] if f[-1] else secs[last][1]
        px, py = float(ex[0]), float(ex[1])
        done.add(q)
    return order, flips, info, touch_at


def warp_lift(g: Grid, ends: float, edge: float, width: float):
    """extra height per grid cell for a warped part, or None.

    ``ends``: lift at the far ends of the footprint's long axis, growing with
    the square of the distance from the middle (a long part warps like a bow).
    ``edge``: lift right at the outline, fading out linearly over ``width`` mm."""
    if ends <= 0 and edge <= 0:
        return None
    valid = np.isfinite(g.H)
    if not valid.any():
        return None
    L = np.zeros(g.H.shape, dtype=np.float64)
    if ends > 0:
        lab, nlab = ndimage.label(valid, structure=np.ones((3, 3)))
        for q in range(1, nlab + 1):         # every separate part warps on its own
            yy, xx = np.nonzero(lab == q)
            if len(xx) < 3:
                continue
            c = np.c_[xx, yy].astype(np.float64)
            mu = c.mean(axis=0)
            ev, evec = np.linalg.eigh(np.cov((c - mu).T))
            t = (c - mu) @ evec[:, int(np.argmax(ev))]
            tm = max(float(np.abs(t).max()), 1e-9)
            L[yy, xx] += ends * (t / tm) ** 2
    if edge > 0:
        d = ndimage.distance_transform_edt(valid) * g.res
        L += np.where(valid, edge * np.clip(1.0 - d / max(width, 1e-6), 0.0, 1.0), 0.0)
    return L.astype(np.float32)


def _self_lift(P: np.ndarray, z: np.ndarray, ds: np.ndarray, w: float, bead: float, ring: bool) -> np.ndarray:
    """lift a line where it crosses itself: a later point within ~half a line
    width of an earlier one (that is not just its neighbour along the line)
    sits one bead higher"""
    n = len(P)
    if n < 6:
        return z
    s = np.cumsum(ds)
    pr = cKDTree(P).query_pairs(0.6 * w, output_type="ndarray")
    if not len(pr):
        return z
    a, b = pr.min(axis=1), pr.max(axis=1)
    gap = s[b] - s[a]
    if ring:
        gap = np.minimum(gap, s[-1] - gap)       # the closing seam is not a crossing
    m = gap > 2.5 * w
    if not m.any():
        return z
    a, b = a[m], b[m]
    o = np.argsort(b, kind="stable")
    z = z.copy()
    for ai, bi in zip(a[o].tolist(), b[o].tolist()):
        v = z[ai] + bead
        if v > z[bi]:
            z[bi] = v
    return z


def _curve_factor(P: np.ndarray, ds: np.ndarray, radius: float, fmin: float) -> np.ndarray:
    """speed factor per point: 1 on straight lines, down to ``fmin`` where the
    curve radius (measured over +-0.5 mm) is much smaller than ``radius``"""
    n = len(P)
    out = np.ones(n)
    if n < 3 or radius <= 0:
        return out
    d = np.diff(P, axis=0)
    ang = np.arctan2(d[:, 1], d[:, 0])
    turn = np.abs((np.diff(ang) + math.pi) % (2 * math.pi) - math.pi)      # at points 1..n-2
    s = np.cumsum(ds)[1:-1]                                                 # arc position of those points
    ct = np.r_[0.0, np.cumsum(turn)]
    win = 0.5
    lo = np.searchsorted(s, s - win, side="left")
    hi = np.searchsorted(s, s + win, side="right")
    tot = ct[hi] - ct[lo]
    # arc length over which that turn happens (at least one segment)
    span = np.maximum(s[hi - 1] - s[lo], 0.0) + 0.5 * (ds[1:-1] + ds[2:])
    R = np.where(tot > 1e-6, span / np.maximum(tot, 1e-9), np.inf)
    out[1:-1] = np.clip(R / radius, min(max(fmin, 0.05), 1.0), 1.0)
    return out


def _stamp(HNP: np.ndarray, g: Grid, P: np.ndarray, z: np.ndarray, radius: float):
    dense = _resample(P, g.res * 0.7)
    # interpolate z onto dense points by arc length
    s0 = np.r_[0.0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
    s1 = np.r_[0.0, np.cumsum(np.hypot(*np.diff(dense, axis=0).T))]
    zz = np.interp(s1 * (s0[-1] / max(s1[-1], 1e-9)), s0, z)
    cx = np.rint((dense[:, 0] - g.x0) / g.res).astype(np.int64)
    cy = np.rint((dense[:, 1] - g.y0) / g.res).astype(np.int64)
    r = max(0, int(round(radius / g.res)))
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx * dx + dy * dy > (r + 0.25) ** 2:
                continue
            qx = cx + dx
            qy = cy + dy
            ok = (qx >= 0) & (qx < g.nx) & (qy >= 0) & (qy < g.ny)
            np.maximum.at(HNP, (qy[ok], qx[ok]), zz[ok].astype(np.float32))
