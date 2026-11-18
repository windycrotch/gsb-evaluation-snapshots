"""Fast-enough G-code move parser for Bambu Studio output.

Produces extrusion segments (arcs are linearised) with feature / filament / layer
information.  Only what we need for the surface analysis and the preview.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

# Features that are not part of the final object surface.
NON_OBJECT = {"support", "support interface", "support transition", "prime tower", "wipe tower",
              "brim", "skirt", "custom", ""}


@dataclass
class Toolpaths:
    seg: np.ndarray          # (N,5) float32: x0 y0 x1 y1 z
    width: np.ndarray        # (N,) float32
    feat: np.ndarray         # (N,) uint8 index into features
    fil: np.ndarray          # (N,) int8 filament index (0-based), -1 unknown
    layer: np.ndarray        # (N,) int16
    features: list[str]
    layer_z: list[float]
    last_filament: int       # filament loaded at the end of the print
    max_z: float
    end_pos: tuple[float, float, float]

    @property
    def object_mask(self) -> np.ndarray:
        bad = np.array([f.lower() in NON_OBJECT for f in self.features] + [True], dtype=bool)
        return ~bad[self.feat]


def _arc_points(x0, y0, x1, y1, cx, cy, cw, full):
    r = math.hypot(x0 - cx, y0 - cy)
    a0 = math.atan2(y0 - cy, x0 - cx)
    a1 = math.atan2(y1 - cy, x1 - cx)
    if cw:
        sweep = a1 - a0
        if sweep >= -1e-9:
            sweep -= 2 * math.pi
    else:
        sweep = a1 - a0
        if sweep <= 1e-9:
            sweep += 2 * math.pi
    if full:
        sweep = -2 * math.pi if cw else 2 * math.pi
    tol = 0.01
    if r <= tol * 2:
        n = 1
    else:
        dth = 2 * math.acos(max(-1.0, 1 - tol / r))
        n = max(1, min(720, int(math.ceil(abs(sweep) / dth))))
    pts = []
    for k in range(1, n + 1):
        a = a0 + sweep * k / n
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    if not full:
        pts[-1] = (x1, y1)
    return pts


def parse(lines: list[str], start: int = 0, end: int | None = None) -> Toolpaths:
    if end is None:
        end = len(lines)
    x = y = z = 0.0
    abs_xyz = True
    abs_e = False
    width = 0.42
    feature = ""
    in_tower = False
    fil = -1
    layer = -1
    layer_z: list[float] = []
    feats: dict[str, int] = {}
    out_seg = []
    out_w = []
    out_f = []
    out_fil = []
    out_l = []
    e_last = 0.0
    max_z = 0.0
    fidx = 0

    def feat_id(name):
        v = feats.get(name)
        if v is None:
            v = feats[name] = len(feats)
        return v

    fidx = feat_id("")
    for i in range(start, end):
        ln = lines[i]
        if not ln:
            continue
        c0 = ln[0]
        if c0 == " " or c0 == "\t":
            ln = ln.lstrip()
            if not ln:
                continue
            c0 = ln[0]
        if c0 == ";":
            if ln.startswith("; FEATURE: "):
                feature = ln[11:].strip()
                fidx = feat_id("Prime tower" if in_tower else feature)
            elif ln.startswith("; LINE_WIDTH: "):
                try:
                    width = float(ln[14:])
                except ValueError:
                    pass
            elif ln.startswith("; CHANGE_LAYER"):
                layer += 1
            elif ln.startswith("; Z_HEIGHT: "):
                try:
                    layer_z.append(float(ln[12:]))
                except ValueError:
                    pass
            elif ln.startswith("; WIPE_TOWER_START"):
                in_tower = True
                fidx = feat_id("Prime tower")
            elif ln.startswith("; WIPE_TOWER_END"):
                in_tower = False
                fidx = feat_id(feature)
            continue
        if c0 == "G":
            code = ln.split(";", 1)[0].split()
            if not code:
                continue
            cmd = code[0]
            if cmd in ("G1", "G0", "G2", "G3"):
                nx, ny, nz = x, y, z
                ev = None
                ii = jj = None
                pfull = False
                for w in code[1:]:
                    k = w[0]
                    try:
                        v = float(w[1:])
                    except ValueError:
                        continue
                    if k == "X":
                        nx = v if abs_xyz else x + v
                    elif k == "Y":
                        ny = v if abs_xyz else y + v
                    elif k == "Z":
                        nz = v if abs_xyz else z + v
                    elif k == "E":
                        ev = v
                    elif k == "I":
                        ii = v
                    elif k == "J":
                        jj = v
                    elif k == "P":
                        pfull = v >= 1
                de = 0.0
                if ev is not None:
                    de = ev if not abs_e else ev - e_last
                    if abs_e:
                        e_last = ev
                extruding = de > 0 and (nx != x or ny != y)
                if extruding:
                    if cmd in ("G2", "G3") and ii is not None and jj is not None:
                        pts = _arc_points(x, y, nx, ny, x + ii, y + jj, cmd == "G2", False)
                    else:
                        pts = [(nx, ny)]
                    px, py = x, y
                    for (qx, qy) in pts:
                        out_seg.append((px, py, qx, qy, nz))
                        px, py = qx, qy
                    m = len(pts)
                    out_w.extend([width] * m)
                    out_f.extend([fidx] * m)
                    out_fil.extend([fil] * m)
                    out_l.extend([layer] * m)
                    if nz > max_z and fidx != feats.get("Prime tower", -99):
                        max_z = nz
                x, y, z = nx, ny, nz
            elif cmd == "G90":
                abs_xyz = True
            elif cmd == "G91":
                abs_xyz = False
            elif cmd == "G92":
                for w in code[1:]:
                    if w[0] == "E":
                        try:
                            e_last = float(w[1:])
                        except ValueError:
                            e_last = 0.0
            continue
        if c0 == "M":
            if ln.startswith("M83"):
                abs_e = False
            elif ln.startswith("M82"):
                abs_e = True
            continue
        if c0 == "T":
            t = ln.split(";", 1)[0].strip()[1:]
            if t.isdigit():
                n = int(t)
                if n < 255:
                    fil = n
    features = [None] * len(feats)
    for k, v in feats.items():
        features[v] = k
    seg = np.asarray(out_seg, dtype=np.float32).reshape(-1, 5)
    return Toolpaths(
        seg=seg,
        width=np.asarray(out_w, dtype=np.float32),
        feat=np.asarray(out_f, dtype=np.uint8),
        fil=np.asarray(out_fil, dtype=np.int8),
        layer=np.asarray(out_l, dtype=np.int16),
        features=features,
        layer_z=layer_z,
        last_filament=fil,
        max_z=max_z,
        end_pos=(x, y, z),
    )
