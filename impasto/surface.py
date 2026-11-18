"""Top-down surface analysis from toolpaths.

H   : height of the topmost deposited material per cell (bead top = layer Z), NaN = empty
S   : surface slope in degrees, from a smoothed version of H (staircase removed)
ZN  : lowest nozzle Z for a flat tip of radius r without touching H (disk max filter)
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import ndimage

from .parse import Toolpaths


@dataclass
class Grid:
    x0: float
    y0: float
    res: float
    nx: int
    ny: int
    H: np.ndarray            # (ny, nx) float32, NaN where empty
    S: np.ndarray | None = None
    ZN: np.ndarray | None = None
    sigma: float = 0.0
    tip_r: float = 0.0

    def to_cell(self, x, y):
        return (np.asarray(x) - self.x0) / self.res, (np.asarray(y) - self.y0) / self.res

    def meta(self) -> dict:
        return {"x0": self.x0, "y0": self.y0, "res": self.res, "nx": self.nx, "ny": self.ny,
                "sigma": self.sigma, "tip_r": self.tip_r}


def _disk(r_cells: int) -> np.ndarray:
    r = max(0, int(r_cells))
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    return (xx * xx + yy * yy) <= (r + 0.25) ** 2


def heightmap(tp: Toolpaths, res: float = 0.1, margin: float = 3.0) -> Grid:
    m = tp.object_mask
    seg = tp.seg[m]
    w = tp.width[m]
    if len(seg) == 0:
        raise ValueError("Keine Objekt-Extrusionen im G-Code gefunden.")
    xs = np.concatenate([seg[:, 0], seg[:, 2]])
    ys = np.concatenate([seg[:, 1], seg[:, 3]])
    x0 = float(np.floor((xs.min() - margin) / res) * res)
    y0 = float(np.floor((ys.min() - margin) / res) * res)
    nx = int(np.ceil((xs.max() + margin - x0) / res)) + 1
    ny = int(np.ceil((ys.max() + margin - y0) / res)) + 1

    # sample every segment densely
    L = np.hypot(seg[:, 2] - seg[:, 0], seg[:, 3] - seg[:, 1])
    step = res * 0.6
    n = np.maximum(1, np.ceil(L / step).astype(np.int64)) + 1
    idx = np.repeat(np.arange(len(seg)), n)
    starts = np.cumsum(n) - n
    t = (np.arange(idx.size) - np.repeat(starts, n)) / np.repeat(n - 1, n).clip(min=1)
    px = seg[idx, 0] + (seg[idx, 2] - seg[idx, 0]) * t
    py = seg[idx, 1] + (seg[idx, 3] - seg[idx, 1]) * t
    pz = seg[idx, 4]
    pw = w[idx]
    order = np.argsort(pz, kind="stable")
    px, py, pz, pw = px[order], py[order], pz[order], pw[order]
    cx = np.rint((px - x0) / res).astype(np.int64)
    cy = np.rint((py - y0) / res).astype(np.int64)
    rc = np.clip(np.rint(pw * 0.5 / res).astype(np.int64), 1, 5)

    H = np.full(ny * nx, -np.inf, dtype=np.float32)
    for r in np.unique(rc):
        sel = rc == r
        sx, sy, sz = cx[sel], cy[sel], pz[sel]
        dk = _disk(int(r))
        oy, ox = np.nonzero(dk)
        oy -= int(r)
        ox -= int(r)
        tmp = np.full(ny * nx, -np.inf, dtype=np.float32)
        for dy, dx in zip(oy, ox):
            qx = sx + dx
            qy = sy + dy
            ok = (qx >= 0) & (qx < nx) & (qy >= 0) & (qy < ny)
            lin = qy[ok] * nx + qx[ok]
            # z is non-decreasing -> last write wins == max
            tmp[lin] = sz[ok]
            np.maximum(H, tmp, out=H)
    H = H.reshape(ny, nx)
    # fill pin holes (cells surrounded by material)
    valid = np.isfinite(H)
    for _ in range(2):
        cnt = ndimage.convolve(valid.astype(np.int8), np.ones((3, 3), np.int8), mode="constant")
        hole = (~valid) & (cnt >= 6)
        if not hole.any():
            break
        Hm = np.where(valid, H, -np.inf)
        mx = ndimage.maximum_filter(Hm, size=3, mode="constant", cval=-np.inf)
        H = np.where(hole, mx, H)
        valid = np.isfinite(H)
    H = np.where(valid, H, np.nan).astype(np.float32)
    return Grid(x0=x0, y0=y0, res=res, nx=nx, ny=ny, H=H)


def analyze(g: Grid, sigma_mm: float = 0.6, tip_r: float = 0.3) -> Grid:
    valid = np.isfinite(g.H)
    Hz = np.where(valid, g.H, 0.0).astype(np.float64)
    s = max(0.3, sigma_mm / g.res)
    num = ndimage.gaussian_filter(Hz, s, mode="constant")
    den = ndimage.gaussian_filter(valid.astype(np.float64), s, mode="constant")
    Hs = np.where(den > 1e-6, num / np.maximum(den, 1e-6), 0.0)
    gy, gx = np.gradient(Hs, g.res)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    slope = np.where(valid, slope, 90.0).astype(np.float32)
    g.S = slope
    rc = int(round(tip_r / g.res))
    Hm = np.where(valid, g.H, -np.inf)
    if rc > 0:
        zn = ndimage.maximum_filter(Hm, footprint=_disk(rc), mode="constant", cval=-np.inf)
    else:
        zn = Hm
    g.ZN = np.where(valid, zn, np.nan).astype(np.float32)
    g.sigma = sigma_mm
    g.tip_r = tip_r
    return g


def sample(arr: np.ndarray, g: Grid, x, y, mode: str = "bilinear") -> np.ndarray:
    """Sample a grid at bed coordinates. NaN outside / empty."""
    fx, fy = g.to_cell(x, y)
    if mode == "nearest":
        ix = np.rint(fx).astype(np.int64)
        iy = np.rint(fy).astype(np.int64)
        ok = (ix >= 0) & (ix < g.nx) & (iy >= 0) & (iy < g.ny)
        out = np.full(ix.shape, np.nan, dtype=np.float64)
        out[ok] = arr[iy[ok], ix[ok]]
        return out
    ix = np.floor(fx).astype(np.int64)
    iy = np.floor(fy).astype(np.int64)
    tx = fx - ix
    ty = fy - iy
    ok = (ix >= 0) & (ix < g.nx - 1) & (iy >= 0) & (iy < g.ny - 1)
    out = np.full(ix.shape, np.nan, dtype=np.float64)
    a = ix[ok]; b = iy[ok]; u = tx[ok]; v = ty[ok]
    z00 = arr[b, a]; z10 = arr[b, a + 1]; z01 = arr[b + 1, a]; z11 = arr[b + 1, a + 1]
    # nan-tolerant bilinear: fall back to max of available corners
    st = np.stack([z00, z10, z01, z11])
    wts = np.stack([(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v])
    fin = np.isfinite(st)
    wsum = (wts * fin).sum(0)
    val = np.where(fin, st, 0.0)
    res = np.where(wsum > 0.25, (wts * val).sum(0) / np.maximum(wsum, 1e-9), np.nan)
    out[ok] = res
    return out


def sample_max(arr: np.ndarray, g: Grid, x, y) -> np.ndarray:
    """Max of the 4 surrounding cells (conservative, never below the surface)."""
    fx, fy = g.to_cell(x, y)
    ix = np.floor(fx).astype(np.int64)
    iy = np.floor(fy).astype(np.int64)
    out = np.full(ix.shape, np.nan, dtype=np.float64)
    ok = (ix >= 0) & (ix < g.nx - 1) & (iy >= 0) & (iy < g.ny - 1)
    a = ix[ok]; b = iy[ok]
    st = np.stack([arr[b, a], arr[b, a + 1], arr[b + 1, a], arr[b + 1, a + 1]])
    with np.errstate(all="ignore"):
        out[ok] = np.nanmax(np.where(np.isfinite(st), st, -np.inf), axis=0)
    out[~np.isfinite(out)] = np.nan
    return out
