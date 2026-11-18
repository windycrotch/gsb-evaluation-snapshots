"""Travel-minimising order for the non-planar sections.

Each section is a short stroke with two ends.  Which end is printed first is not
only a print-quality question ("uphill first", see :mod:`impasto.direction`) but also
a travel question: every gap between two sections is a retract, a hop and a
prime, and a long gap leaves a blob.  This module orders the sections and
chooses their direction so that the travels stay short, while a downhill
millimetre is charged like ``weight`` millimetres of travel.

``weight = 0`` orders purely by travel (downhill ignored), a large weight keeps
the uphill decision of the planner untouched.
"""
from __future__ import annotations

import math

import numpy as np
from scipy.spatial import cKDTree


def _neighbours(P: np.ndarray, n: int, k: int) -> list[list[int]]:
    """nearest other sections per section, measured between any two ends"""
    if n < 2:
        return [[] for _ in range(n)]
    k = max(1, min(k, n - 1))
    tree = cKDTree(P)
    _, idx = tree.query(P, k=min(len(P), 2 * k + 2))
    idx = np.atleast_2d(idx)
    out = []
    for i in range(n):
        cand = np.unique(np.concatenate([idx[i], idx[i + n]])) % n
        out.append([int(c) for c in cand if c != i][:k])
    return out


_EXACT_N = 9   # up to this many sections the order is solved exactly (Held-Karp)


def _preds(n: int, before) -> list[set[int]]:
    """predecessor sets from ``before`` = [(a, b)]: a must be printed before b"""
    pr: list[set[int]] = [set() for _ in range(n)]
    for a, b in before or ():
        a, b = int(a), int(b)
        if a != b and 0 <= a < n and 0 <= b < n:
            pr[b].add(a)
    return pr


def feasible(ids, preds) -> bool:
    """every predecessor of a section comes earlier in ``ids``"""
    pos = {k: t for t, k in enumerate(ids)}
    return all(pos[a] < pos[b] for b in ids for a in preds[b])


def _repair(ids, fls, preds):
    """stable topological order: keep ``ids`` as priority, pull predecessors forward"""
    n = len(ids)
    rank = {k: t for t, k in enumerate(ids)}
    fl = dict(zip(ids, fls))
    need = [len(preds[k]) for k in range(n)]
    succ: list[list[int]] = [[] for _ in range(n)]
    for b in range(n):
        for a in preds[b]:
            succ[a].append(b)
    import heapq
    heap = [(rank[k], k) for k in range(n) if need[k] == 0]
    heapq.heapify(heap)
    out = []
    while heap:
        _, k = heapq.heappop(heap)
        out.append(k)
        for b in succ[k]:
            need[b] -= 1
            if need[b] == 0:
                heapq.heappush(heap, (rank[b], b))
    return out, [fl[k] for k in out]


def _exact(ax, ay, bx, by, down_f, down_b, w, sx, sy, preds=None):
    """optimal open tour with free direction per section, dynamic programming
    over (visited set, last section, last direction); 2^n * 2n states.
    ``preds`` (list of sets) restricts the order: j may only follow once all
    its predecessors are visited."""
    n = len(ax)
    pm = [sum(1 << a for a in (preds[j] if preds else ())) for j in range(n)]
    hyp = math.hypot
    ent = [[(ax[i], ay[i]), (bx[i], by[i])] for i in range(n)]   # [f] -> entry
    ext = [[(bx[i], by[i]), (ax[i], ay[i])] for i in range(n)]   # [f] -> exit
    dw = [[down_f[i], down_b[i]] for i in range(n)]
    # gap[i][fi][j][fj]: travel from exit of (i, fi) to entry of (j, fj)
    gap = [[[[hyp(ent[j][fj][0] - ext[i][fi][0], ent[j][fj][1] - ext[i][fi][1])
              for fj in (0, 1)] for j in range(n)] for fi in (0, 1)] for i in range(n)]
    INF = float("inf")
    full = 1 << n
    D = [[INF] * (2 * n) for _ in range(full)]
    P = [[-1] * (2 * n) for _ in range(full)]
    for j in range(n):
        if pm[j]:
            continue
        for fj in (0, 1):
            D[1 << j][2 * j + fj] = hyp(ent[j][fj][0] - sx, ent[j][fj][1] - sy) + w * dw[j][fj]
    for m in range(1, full):
        row = D[m]
        for s in range(2 * n):
            c = row[s]
            if c == INF:
                continue
            i, fi = divmod(s, 2)
            g = gap[i][fi]
            for j in range(n):
                if m >> j & 1 or (pm[j] & m) != pm[j]:
                    continue
                mj = m | (1 << j)
                gj = g[j]
                for fj in (0, 1):
                    v = c + gj[fj] + w * dw[j][fj]
                    if v < D[mj][2 * j + fj] - 1e-12:
                        D[mj][2 * j + fj] = v
                        P[mj][2 * j + fj] = s
    last = min(range(2 * n), key=lambda s: D[full - 1][s])
    order = []
    m, s = full - 1, last
    while s >= 0:
        order.append(s)
        ps = P[m][s]
        m ^= 1 << (s // 2)
        s = ps
    order.reverse()
    ids = [s // 2 for s in order]
    fls = [bool(s % 2) for s in order]
    travel, down = 0.0, 0.0
    px, py = sx, sy
    for i, f in zip(ids, fls):
        e = ent[i][f]
        travel += hyp(e[0] - px, e[1] - py)
        px, py = ext[i][f]
        down += dw[i][f]
    return ids, fls, {"travel": travel, "downhill": down, "cost": travel + w * down}


def _solve(sections, start, weight: float, passes: int, cand: int, kicks: int = 0,
           starts=None, before=None):
    n = len(sections)
    if n == 0:
        return [], [], {"travel": 0.0, "downhill": 0.0, "cost": 0.0}
    preds = _preds(n, before)
    has_c = any(preds)
    # plain python floats: the inner loops run millions of times
    ax = [float(s[0][0]) for s in sections]
    ay = [float(s[0][1]) for s in sections]
    bx = [float(s[1][0]) for s in sections]
    by = [float(s[1][1]) for s in sections]
    down_f = [max(0.0, -float(s[2])) for s in sections]     # downhill for a -> b
    down_b = [max(0.0, float(s[2])) for s in sections]      # downhill for b -> a
    w = max(0.0, float(weight))
    sx, sy = float(start[0]), float(start[1])
    hyp = math.hypot
    if starts is None:
        starts = [w]

    if n <= _EXACT_N:
        return _exact(ax, ay, bx, by, down_f, down_b, w, sx, sy, preds if has_c else None)

    # ---- nearest neighbour with a free direction -----------------------------
    A = np.array([ax, ay], dtype=np.float64).T
    B = np.array([bx, by], dtype=np.float64).T
    df = np.array(down_f)
    db = np.array(down_b)

    def nearest(wn):
        ids: list[int] = []
        fls: list[bool] = []
        free = np.ones(n, dtype=bool)
        need = np.array([len(preds[k]) for k in range(n)], dtype=np.int64)
        px, py = sx, sy
        for _ in range(n):
            idx = np.nonzero(free & (need == 0))[0] if has_c else np.nonzero(free)[0]
            cf = np.hypot(A[idx, 0] - px, A[idx, 1] - py) + wn * df[idx]
            cb = np.hypot(B[idx, 0] - px, B[idx, 1] - py) + wn * db[idx]
            if cf.min() <= cb.min():
                j = int(idx[int(np.argmin(cf))])
                ids.append(j)
                fls.append(False)
                px, py = bx[j], by[j]
            else:
                j = int(idx[int(np.argmin(cb))])
                ids.append(j)
                fls.append(True)
                px, py = ax[j], ay[j]
            free[j] = False
            if has_c:
                for b in succ[j]:
                    need[b] -= 1
        return ids, fls

    succ: list[list[int]] = [[] for _ in range(n)]
    for b in range(n):
        for a in preds[b]:
            succ[a].append(b)

    def rev_ok(ids, pos, t, k):
        """reversing ids[t..k] keeps every precedence"""
        for u in ids[t:k + 1]:
            for a in preds[u]:
                if t <= pos[a] <= k:
                    return False
        return True

    def move_ok(ids, pos, t, L, g, rev):
        """moving the block ids[t:t+L] in front of old index g keeps every precedence"""
        blk = ids[t:t + L]
        if rev and L > 1:
            for u in blk:
                for a in preds[u]:
                    if t <= pos[a] < t + L:
                        return False
        if g < t:
            for u in blk:
                for a in preds[u]:
                    if g <= pos[a] < t:
                        return False
        else:
            for v in ids[t + L:g]:
                for a in preds[v]:
                    if t <= pos[a] < t + L:
                        return False
        return True

    nb = _neighbours(np.vstack([A, B]), n, cand)

    def entry(i, f):
        return (bx[i], by[i]) if f else (ax[i], ay[i])

    def exit_(i, f):
        return (ax[i], ay[i]) if f else (bx[i], by[i])

    def dwn(i, f):
        return down_b[i] if f else down_f[i]

    def improve(ids, fls, w=w):
        """first-improvement 2-opt + or-opt (blocks of 1-3, both directions)
        until no move helps or ``passes`` sweeps without progress are used up"""
        sweeps = 0
        while sweeps < passes:
            sweeps += 1
            moved = False
            # ---- 2-opt: reverse a block, every section inside flips ----------
            pos = {k: t for t, k in enumerate(ids)}
            ps = [0.0]
            for i, f in zip(ids, fls):
                ps.append(ps[-1] + dwn(i, not f) - dwn(i, f))   # flip delta prefix
            t = 0
            while t < n:
                if t > 0:
                    px, py = exit_(ids[t - 1], fls[t - 1])
                    cands = set(nb[ids[t - 1]]) | set(nb[ids[t]])
                else:
                    px, py = sx, sy
                    cands = set(nb[ids[t]])
                ex0, ey0 = entry(ids[t], fls[t])
                head = hyp(ex0 - px, ey0 - py)
                best = None
                found = []
                for j in cands:
                    k = pos[j]
                    if k <= t:
                        continue
                    old = head
                    new = 0.0
                    if k + 1 < n:
                        qx, qy = entry(ids[k + 1], fls[k + 1])
                        kx, ky = exit_(ids[k], fls[k])
                        old += hyp(kx - qx, ky - qy)
                        new += hyp(ex0 - qx, ey0 - qy)      # flipped first exits at its old entry
                    nx0, ny0 = exit_(ids[k], fls[k])         # flipped last enters at its old exit
                    new += hyp(nx0 - px, ny0 - py)
                    delta = new - old + w * (ps[k + 1] - ps[t])
                    if delta < -1e-7:
                        found.append((delta, k))
                if found:
                    found.sort()
                    if has_c:
                        found = [c for c in found if rev_ok(ids, pos, t, c[1])]
                    best = found[0] if found else None
                if best is not None:
                    k = best[1]
                    ids[t:k + 1] = ids[t:k + 1][::-1]
                    fls[t:k + 1] = [not f for f in fls[t:k + 1][::-1]]
                    pos = {kk: tt for tt, kk in enumerate(ids)}
                    ps = [0.0]
                    for i, f in zip(ids, fls):
                        ps.append(ps[-1] + dwn(i, not f) - dwn(i, f))
                    moved = True
                t += 1
            # ---- or-opt: move a block of 1-3 sections, optionally reversed ---
            for L in (1, 2, 3):
                if L >= n:
                    break
                t = 0
                pos = {kk: tt for tt, kk in enumerate(ids)}
                while t + L <= n:
                    a, fa = ids[t], fls[t]
                    b, fb = ids[t + L - 1], fls[t + L - 1]
                    sa = entry(a, fa)                      # block entry
                    sb = exit_(b, fb)                      # block exit
                    flipd = sum(dwn(ids[u], not fls[u]) - dwn(ids[u], fls[u])
                                for u in range(t, t + L))
                    pre = exit_(ids[t - 1], fls[t - 1]) if t > 0 else (sx, sy)
                    post = entry(ids[t + L], fls[t + L]) if t + L < n else None
                    gain = -hyp(sa[0] - pre[0], sa[1] - pre[1])
                    if post is not None:
                        gain += hyp(post[0] - pre[0], post[1] - pre[1]) \
                            - hyp(post[0] - sb[0], post[1] - sb[1])
                    best = None
                    found = []
                    gaps = set()
                    for j in set(nb[a]) | set(nb[b]):
                        q = pos[j]
                        gaps.add(q)
                        gaps.add(q + 1)
                    gaps.add(0)
                    for g in gaps:
                        if t <= g <= t + L or g > n:
                            continue
                        gp = exit_(ids[g - 1], fls[g - 1]) if g > 0 else (sx, sy)
                        gq = entry(ids[g], fls[g]) if g < n else None
                        base = hyp(gq[0] - gp[0], gq[1] - gp[1]) if gq is not None else 0.0
                        for rev in (False, True):
                            en, ex = (sb, sa) if rev else (sa, sb)
                            add = hyp(en[0] - gp[0], en[1] - gp[1])
                            if gq is not None:
                                add += hyp(gq[0] - ex[0], gq[1] - ex[1])
                            delta = add - base + gain + (w * flipd if rev else 0.0)
                            if delta < -1e-7:
                                found.append((delta, g, rev))
                    if found:
                        found.sort()
                        if has_c:
                            found = [c for c in found if move_ok(ids, pos, t, L, c[1], c[2])]
                        best = found[0] if found else None
                    if best is not None:
                        _, g, rev = best
                        bi = ids[t:t + L]
                        bf = fls[t:t + L]
                        if rev:
                            bi = bi[::-1]
                            bf = [not f for f in bf[::-1]]
                        if g > t:
                            g -= L
                        del ids[t:t + L]
                        del fls[t:t + L]
                        ids[g:g] = bi
                        fls[g:g] = bf
                        pos = {kk: tt for tt, kk in enumerate(ids)}
                        moved = True
                    else:
                        t += 1
            if not moved:
                break
        return ids, fls

    def cost(ids, fls):
        tr = 0.0
        px, py = sx, sy
        dn = 0.0
        for i, f in zip(ids, fls):
            ex, ey = entry(i, f)
            tr += hyp(ex - px, ey - py)
            px, py = exit_(i, f)
            dn += dwn(i, f)
        return tr + w * dn

    # every start weight seeds a tour, which is then polished with the real
    # weight; the cheapest one goes on to the kicks
    best_c = None
    for ws in starts:
        ti, tf = nearest(ws)
        if ws != w:
            ti, tf = improve(ti, tf, ws)
        ti, tf = improve(ti, tf)
        c = cost(ti, tf)
        if best_c is None or c < best_c - 1e-9:
            ids, fls, best_c = ti, tf, c

    # ---- a few deterministic kicks (double bridge) + local search ------------
    if n >= 8 and kicks > 0:
        rng = np.random.default_rng(len(ids))
        for _ in range(kicks):
            p1, p2, p3 = sorted(rng.choice(np.arange(1, n), size=3, replace=False))
            ti = ids[:p1] + ids[p2:p3] + ids[p1:p2] + ids[p3:]
            tf = fls[:p1] + fls[p2:p3] + fls[p1:p2] + fls[p3:]
            if has_c and not feasible(ti, preds):
                ti, tf = _repair(ti, tf, preds)
            ti, tf = improve(ti, tf)
            c = cost(ti, tf)
            if c < best_c - 1e-7:
                ids, fls, best_c = ti, tf, c

    travel = 0.0
    px, py = sx, sy
    for t, (i, f) in enumerate(zip(ids, fls)):
        ex, ey = entry(i, f)
        travel += hyp(ex - px, ey - py)
        px, py = exit_(i, f)
    downhill = float(sum(dwn(i, f) for i, f in zip(ids, fls)))
    info = {"travel": travel, "downhill": downhill, "cost": travel + w * downhill}
    return ids, fls, info


def _d2(p, q):
    return (p[0] - q[0], p[1] - q[1])


def plan(sections, start, *, weight: float = 10.0, passes: int | None = None, cand: int = 12,
         kicks: int | None = None, before=None):
    """Order ``sections`` from ``start``.

    ``sections`` is a sequence of ``(a, b, drop)``: the two end points in index
    order and the extra downhill (mm) that printing ``a -> b`` costs compared to
    printing ``b -> a``.

    Returns ``(order, flips, info)`` with ``order`` = section indices in print
    order, ``flips[k]`` = print ``order[k]`` backwards, and ``info`` holding
    ``travel`` (mm), ``downhill`` (mm) and ``cost`` (both combined).

    Two seed tours are built - nearest neighbour with the requested weight and
    purely by travel - both are polished with the requested weight and the
    better one goes on to ``kicks`` deterministic double-bridge perturbations
    (fixed seed, so the same input always gives the same order).

    ``before`` is an optional list of ``(a, b)`` pairs: section ``a`` must be
    printed before section ``b`` (stacking order of overlapping elements).  The
    pairs must not form a cycle.
    """
    n = len(sections)
    w = max(0.0, float(weight))
    if passes is None:
        passes = 40 if n <= 400 else 15 if n <= 1500 else 6
    if kicks is None:
        kicks = 20 if n <= 150 else 10 if n <= 400 else 0
    return _solve(sections, start, w, passes, cand, kicks,
                  starts=[w, 0.0] if w > 0 else [0.0], before=before)
