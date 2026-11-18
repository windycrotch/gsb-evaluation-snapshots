"""Print-head collision check for the generated non-planar moves.

Head geometry: axis-aligned boxes in the nozzle-tip frame (mm), taken from the PancakeSlicer
head profiles (impasto/heads/*.json, AGPL-3.0, see impasto/heads/ATTRIBUTION.md).

Obstacles: the top-down heightmap H of the already printed part; empty cells count as the bed
(z = 0). A box at tip position (x, y, z) collides if the highest obstacle cell under its
(conservatively rasterised) footprint is above z + clearance:

    nozzle boxes inside the allowance disk: clearance = max(min_z, allowance_height)
    other nozzle boxes:                     clearance = min_z
    all other boxes:                        clearance = min_z - margin, footprint +- lateral_margin

Non-planar beads printed earlier in the same layer are not part of the obstacle map.
"""
from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path

import numpy as np
from scipy import ndimage

from .surface import Grid

HEADS = Path(__file__).resolve().parent / "heads"
COARSE = 0.5      # mm, raster for the non-nozzle boxes
STEP = 0.5        # mm, sample spacing along the moves


# ------------------------------------------------------------------ head profiles

@lru_cache(maxsize=1)
def head_index() -> list[dict]:
    out = []
    for f in sorted(HEADS.glob("*.json")):
        try:
            d = json.loads(f.read_text())
        except Exception:
            continue
        out.append({"id": d.get("id") or f.stem, "name": d.get("name") or f.stem,
                    "file": f.name, "boxes": len(d.get("boxes") or []),
                    "tip_flat_radius": (d.get("nozzle") or {}).get("tip_flat_radius")})
    out.sort(key=lambda h: h["name"].lower())
    return out


@lru_cache(maxsize=16)
def _load(head_id: str) -> str:
    for h in head_index():
        if h["id"] == head_id:
            return (HEADS / h["file"]).read_text()
    raise KeyError(head_id)


def load_head(head_id: str) -> dict:
    return json.loads(_load(head_id))


def default_head(nozzle_d: float | None) -> str:
    if nozzle_d and nozzle_d >= 0.75:
        return "bambu-a1-mini-nozzle-08"
    if nozzle_d and nozzle_d >= 0.55:
        return "bambu-a1-mini-nozzle-06"
    return "bambu-a1-mini"


# ------------------------------------------------------------------ geometry helpers

def _in_disk(b: dict, r: float) -> bool:
    (x0, y0, _), (x1, y1, _) = b["min"], b["max"]
    return all(math.hypot(x, y) <= r + 1e-9 for x in (x0, x1) for y in (y0, y1))


def _offsets(lo_mm: float, hi_mm: float, res: float) -> tuple[int, int]:
    """Cell offsets relative to c = floor(u + 0.5) that cover [u+lo, u+hi] conservatively."""
    return int(math.floor(lo_mm / res)), int(math.floor(hi_mm / res)) + 1


def _maxmap(A: np.ndarray, sy: int | None, sx: int | None) -> np.ndarray:
    """Max filter of size (sy, sx); None = the whole axis (infinite boxes)."""
    M = A
    if sx is None:
        M = np.broadcast_to(M.max(axis=1, keepdims=True), M.shape)
    elif sx > 1:
        M = ndimage.maximum_filter1d(M, sx, axis=1, mode="constant", cval=0.0)
    if sy is None:
        M = np.broadcast_to(M.max(axis=0, keepdims=True), M.shape)
    elif sy > 1:
        M = ndimage.maximum_filter1d(M, sy, axis=0, mode="constant", cval=0.0)
    return M


class _Level:
    """Obstacle raster (fine or coarse) padded with bed (0) so off-grid samples work."""

    def __init__(self, A: np.ndarray, x0: float, y0: float, res: float, pad: int):
        self.res, self.pad = res, pad
        self.x0, self.y0 = x0, y0
        self.A = np.pad(A, pad, mode="constant", constant_values=0.0)

    def cells(self, x, y):
        cx = np.floor((x - self.x0) / self.res + 0.5).astype(np.int64)
        cy = np.floor((y - self.y0) / self.res + 0.5).astype(np.int64)
        return cy, cx

    def lookup(self, M, cy, cx, oy, ox, infy=False, infx=False):
        jy = cy + self.pad + oy
        jx = cx + self.pad + ox
        ny, nx = M.shape
        if infx:            # the box spans the whole axis -> position along it does not matter
            jx = np.clip(jx, 0, nx - 1)
        if infy:
            jy = np.clip(jy, 0, ny - 1)
        ok = (jy >= 0) & (jy < ny) & (jx >= 0) & (jx < nx)
        out = np.zeros(cy.shape, dtype=np.float32)
        out[ok] = M[jy[ok], jx[ok]]
        return out


# ------------------------------------------------------------------ main check

def _samples(moves: np.ndarray, step: float):
    sel = np.nonzero(moves[:, 0] != 2)[0]            # 0 extrusion, 1 travel, 3 wipe/coast (2 = change)
    m = moves[sel]
    L = np.hypot(m[:, 5] - m[:, 2], m[:, 6] - m[:, 3])
    n = np.maximum(1, np.ceil(L / step).astype(np.int64)) + 1
    rep = np.repeat(np.arange(len(m)), n)
    starts = np.cumsum(n) - n
    t = (np.arange(rep.size) - np.repeat(starts, n)) / np.repeat(n - 1, n).clip(min=1)
    mm = m[rep]
    x = mm[:, 2] + (mm[:, 5] - mm[:, 2]) * t
    y = mm[:, 3] + (mm[:, 6] - mm[:, 3]) * t
    z = mm[:, 4] + (mm[:, 7] - mm[:, 4]) * t
    return sel[rep], x.astype(np.float64), y.astype(np.float64), z.astype(np.float32)


def check(grid: Grid, moves: np.ndarray, head: dict, step: float = STEP,
          max_markers: int = 2000, tip_tol: float = 0.1) -> dict:
    """tip_tol: how far the flat tip itself may sink into H (use > -z_offset for intended
    negative offsets). The allowance disk does not apply to the tip."""
    noz = head.get("nozzle") or {}
    tr = float(noz.get("tip_flat_radius") or 0.2)
    t_boxes = list(head.get("boxes") or [])
    TIP = len(t_boxes)
    if t_boxes:
        h = tr * 0.7      # square inside the flat tip disk (raster adds a cell anyway)
        t_boxes.append({"name": "nozzle_tip", "min": [-h, -h, 0.0], "max": [h, h, 0.0],
                        "nozzle": True})
    ar = float(noz.get("allowance_radius") or 0.0)
    ah = float(noz.get("allowance_height") or 0.0)
    margin = float(head.get("margin") or 0.0)
    lat = float(head.get("lateral_margin") or 0.0)

    empty = {"head": head.get("id"), "moves": [], "count": 0, "boxes": [], "markers": [],
             "max_depth": 0.0}
    if moves is None or len(moves) == 0 or not t_boxes:
        return empty
    mi, sx, sy, sz = _samples(np.asarray(moves, dtype=np.float64), step)
    if len(mi) == 0:
        return empty

    H = np.nan_to_num(grid.H.astype(np.float32), nan=0.0, neginf=0.0, posinf=0.0)
    H = np.maximum(H, 0.0)
    hmax = float(H.max()) if H.size else 0.0

    # box specs
    specs = []
    for bi, b in enumerate(t_boxes):
        mn, mx = b["min"], b["max"]
        if bi == TIP:
            clr, grow, fine = float(tip_tol), 0.0, True    # tip may sink tip_tol into H
        elif b.get("nozzle"):
            clr = max(mn[2], ah) if (ar > 0 and _in_disk(b, ar)) else mn[2]
            grow, fine = 0.0, True
        else:
            clr = mn[2] - margin
            grow, fine = lat, False
        specs.append(dict(i=bi, clr=float(clr), fine=fine,
                          lx=mn[0] - grow, hx=mx[0] + grow, ly=mn[1] - grow, hy=mx[1] + grow,
                          infx=bool(b.get("infinite_x")), infy=bool(b.get("infinite_y"))))

    # prune globally: a box can only hit where z + clearance < hmax
    zmin = float(sz.min())
    specs = [s for s in specs if zmin + s["clr"] < hmax]
    # The flat tip is checked separately and (almost) exactly: a conservative square raster
    # reaches ~0.4 mm sideways, which on a 22 deg slope already rises more than tip_tol.
    tip_spec = next((s for s in specs if s["i"] == TIP), None)
    specs = [s for s in specs if s["i"] != TIP]

    k = max(1, int(round(COARSE / grid.res)))
    levels = {}

    def level(fine: bool, pad: int) -> _Level:
        if fine not in levels:
            if fine:
                levels[True] = _Level(H, grid.x0, grid.y0, grid.res, pad)
            else:
                ny, nx = H.shape
                Hp = np.pad(H, ((0, (-ny) % k), (0, (-nx) % k)), constant_values=0.0)
                C = Hp.reshape(Hp.shape[0] // k, k, Hp.shape[1] // k, k).max(axis=(1, 3))
                # coarse cell j covers fine cells [j*k, j*k+k) -> centre at x0 + (j*k + (k-1)/2)*res
                cx0 = grid.x0 + (k - 1) * 0.5 * grid.res
                cy0 = grid.y0 + (k - 1) * 0.5 * grid.res
                levels[False] = _Level(C, cx0, cy0, grid.res * k, pad)
        return levels[False if not fine else True]

    # group by raster + footprint size so each max map is built once
    for s in specs:
        res = grid.res if s["fine"] else grid.res * k
        s["ox"] = _offsets(s["lx"], s["hx"], res)
        s["oy"] = _offsets(s["ly"], s["hy"], res)
        s["sx"] = None if s["infx"] else s["ox"][1] - s["ox"][0] + 1
        s["sy"] = None if s["infy"] else s["oy"][1] - s["oy"][0] + 1
    pads = {}
    for s in specs:
        p = max(abs(s["ox"][0]), abs(s["ox"][1]), abs(s["oy"][0]), abs(s["oy"][1]))
        p += max(s["sx"] or 1, s["sy"] or 1)
        pads[s["fine"]] = max(pads.get(s["fine"], 1), p)

    hit_depth = np.zeros(len(mi), dtype=np.float32)       # worst penetration per sample
    hit_any = np.zeros(len(mi), dtype=bool)
    per_move: dict[int, dict] = {}
    groups: dict[tuple, list[dict]] = {}
    for s in specs:
        groups.setdefault((s["fine"], s["sy"], s["sx"]), []).append(s)

    cell_cache = {}
    for (fine, gsy, gsx), lst in groups.items():
        lv = level(fine, pads[fine])
        if fine not in cell_cache:
            cell_cache[fine] = lv.cells(sx, sy)
        cy, cx = cell_cache[fine]
        M = None
        for s in lst:
            cand = np.nonzero(sz + s["clr"] < hmax)[0]
            if len(cand) == 0:
                continue
            if M is None:
                M = _maxmap(lv.A, gsy, gsx)
            ox = 0 if gsx is None else s["ox"][0] + gsx // 2
            oy = 0 if gsy is None else s["oy"][0] + gsy // 2
            v = lv.lookup(M, cy[cand], cx[cand], oy, ox, gsy is None, gsx is None)
            d = v - (sz[cand] + s["clr"])
            hit = d > 1e-4
            if not hit.any():
                continue
            hc = cand[hit]
            dh = d[hit]
            hit_any[hc] = True
            np.maximum.at(hit_depth, hc, dh)
            for m, dd in zip(mi[hc].tolist(), dh.tolist()):
                e = per_move.get(m)
                if e is None:
                    e = per_move[m] = {"i": m, "boxes": set(), "depth": 0.0}
                e["boxes"].add(s["i"])
                if dd > e["depth"]:
                    e["depth"] = dd

    if tip_spec is not None:
        # max of H over the cells whose centre lies within the flat tip disk, looked up at the
        # nearest cell (position error <= res/2 * sqrt2, i.e. ~0.03 mm height on 22 deg)
        r = int(math.ceil(tr / grid.res))
        yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
        fp = np.hypot(xx, yy) * grid.res <= tr + 1e-9
        Htip = ndimage.maximum_filter(H, footprint=fp, mode="constant", cval=0.0)
        cand = np.nonzero(sz + tip_spec["clr"] < hmax)[0]
        if len(cand):
            lv = _Level(Htip, grid.x0, grid.y0, grid.res, 1)
            cy, cx = lv.cells(sx[cand], sy[cand])
            v = lv.lookup(lv.A, cy, cx, 0, 0)
            d = v - (sz[cand] + tip_spec["clr"])
            hit = d > 1e-4
            hc, dh = cand[hit], d[hit]
            hit_any[hc] = True
            np.maximum.at(hit_depth, hc, dh)
            for m, dd in zip(mi[hc].tolist(), dh.tolist()):
                e = per_move.get(m)
                if e is None:
                    e = per_move[m] = {"i": m, "boxes": set(), "depth": 0.0}
                e["boxes"].add(TIP)
                if dd > e["depth"]:
                    e["depth"] = dd

    out_moves = []
    for m in sorted(per_move):
        e = per_move[m]
        out_moves.append({"i": int(m), "boxes": sorted(e["boxes"]), "depth": round(e["depth"], 3)})
    idx = np.nonzero(hit_any)[0]
    if len(idx) > max_markers:
        idx = idx[np.linspace(0, len(idx) - 1, max_markers).astype(np.int64)]
    markers = [[round(float(sx[j]), 3), round(float(sy[j]), 3), round(float(sz[j]), 3)] for j in idx]
    boxes_hit = sorted({b for e in out_moves for b in e["boxes"]})
    return {
        "head": head.get("id"),
        "moves": out_moves,
        "count": len(out_moves),
        "extrusion": int(sum(1 for e in out_moves if moves[e["i"], 0] < 0.5)),
        "boxes": boxes_hit,
        "box_names": [t_boxes[b].get("name", str(b)) for b in boxes_hit],
        "max_depth": round(float(hit_depth.max()) if hit_any.any() else 0.0, 3),
        "markers": markers,
    }
