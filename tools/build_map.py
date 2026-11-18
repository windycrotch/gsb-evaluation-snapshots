import json, math, colorsys, sys
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.spatial import cKDTree
from countries import C, ATTACHED, MERGE, MIL, IDS, EN, ATT_EN

A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
IDX = {c: i for i, c in enumerate(A)}
import os
HERE = os.path.dirname(os.path.abspath(__file__))
S = open(os.path.join(HERE, 'map-source.txt')).read().strip()
pos = 0
def u():
    global pos
    c = S[pos]
    if c == '-':
        v = IDX[S[pos+1]]*62 + IDX[S[pos+2]]; pos += 3
    elif c == '_':
        v = IDX[S[pos+1]]*3844 + IDX[S[pos+2]]*62 + IDX[S[pos+3]]; pos += 4
    else:
        v = IDX[c]; pos += 1
    return v
def z():
    v = u()
    return -(v+1)//2 if v & 1 else v//2
def f3():
    global pos
    v = IDX[S[pos]]*3844 + IDX[S[pos+1]]*62 + IDX[S[pos+2]]; pos += 3
    return v

SX, SY, TX, TY = 0.036003600360036005, 0.016927109510951093, -180, -85.609038
arcs = []
for _ in range(u()):
    n = u(); x = f3(); y = f3(); pts = [(x, y)]
    for _ in range(n-1):
        x += z(); y += z(); pts.append((x, y))
    arcs.append([(px*2*SX+TX, py*4*SY+TY) for px, py in pts])
ng = u()
assert ng == len(IDS) == 176, (ng, len(IDS))
geoms = []
for gi in range(ng):
    polys = []
    for _ in range(u()):
        rings = []
        for _ in range(u()):
            ring = []
            for _ in range(u()):
                s = z()
                a = arcs[~s][::-1] if s < 0 else arcs[s]
                ring.extend(a if not ring else a[1:])
            rings.append(ring)
        polys.append(rings)
    geoms.append(polys)
assert pos == len(S), (pos, len(S))

# ---------- proyeksiya (Miller) ----------
W = 3000
LAT_MAX, LAT_MIN = 84.0, -58.0
def my(lat): return 1.25*math.log(math.tan(math.pi/4 + 0.4*math.radians(lat)))
K = W/(2*math.pi)
YT = my(LAT_MAX)
H = int(math.ceil((YT - my(LAT_MIN))*K))
def proj(lon, lat):
    lat = max(min(lat, LAT_MAX), LAT_MIN)
    return ((lon+180)/360*W, (YT - my(lat))*K)

# ---------- regionlar ----------
regions = {}   # key -> dict(owner, polys)
order = []
for code, polys in zip(IDS, geoms):
    key = MERGE.get(code, code)
    owner = ATTACHED[key][0] if key in ATTACHED else key
    if key == 'RUS':
        east = [p for p in polys if max(pt[0] for pt in p[0]) < -150]
        polys = [p for p in polys if not max(pt[0] for pt in p[0]) < -150]
        if east:
            regions['RUS_E'] = dict(owner='RUS', polys=east); order.append('RUS_E')
    if key not in regions:
        regions[key] = dict(owner=owner, polys=[]); order.append(key)
    regions[key]['polys'].extend(polys)
for key in order:
    r = regions[key]
    pp = []
    for rings in r['polys']:
        prs = []
        for ring in rings:
            lons = [p[0] for p in ring]
            if max(lons) - min(lons) > 300:   # antimeridian sığortası
                ring = [((lo+360 if lo < 0 else lo), la) for lo, la in ring]
                ring = [(min(lo, 180), la) for lo, la in ring]
            prs.append([proj(lo, la) for lo, la in ring])
        pp.append(prs)
    if key not in ('RUS','RUS_E','USA'):
        left=[p for p in pp if max(q[0] for q in p[0]) < W*0.1]; right=[p for p in pp if min(q[0] for q in p[0]) > W*0.9]
        if left and right:
            drop = left if sum(len(p[0]) for p in left) <= sum(len(p[0]) for p in right) else right
            pp=[p for p in pp if p not in drop]; print('dropped antimeridian part', key)
    r['pp'] = pp
countries = sorted(set(r['owner'] for r in regions.values()))
assert all(c in C for c in countries), [c for c in countries if c not in C]
cidx = {c: i for i, c in enumerate(countries)}
print('regions', len(order), 'countries', len(countries), 'H', H)

# ---------- rasterləşdirmə ----------
def poly_area(ring):
    a = 0
    for i in range(len(ring)):
        x1, y1 = ring[i]; x2, y2 = ring[(i+1) % len(ring)]
        a += x1*y2 - x2*y1
    return abs(a)/2
reg_raster = np.full((H, W), -1, np.int16)
jobs = []
for ri, key in enumerate(order):
    for rings in regions[key]['pp']:
        jobs.append((poly_area(rings[0]), ri, rings))
jobs.sort(key=lambda j: -j[0])
for area, ri, rings in jobs:
    xs = [p[0] for p in rings[0]]; ys = [p[1] for p in rings[0]]
    x0 = max(int(min(xs))-1, 0); y0 = max(int(min(ys))-1, 0)
    x1 = min(int(max(xs))+2, W); y1 = min(int(max(ys))+2, H)
    if x1 <= x0 or y1 <= y0: continue
    im = Image.new('L', (x1-x0, y1-y0), 0); d = ImageDraw.Draw(im)
    d.polygon([(x-x0-0.5, y-y0-0.5) for x, y in rings[0]], fill=1)
    for hole in rings[1:]:
        d.polygon([(x-x0-0.5, y-y0-0.5) for x, y in hole], fill=0)
    m = np.array(im, bool)
    sub = reg_raster[y0:y1, x0:x1]; sub[m] = ri
for ri, key in enumerate(order):   # heç bir xanası olmayan region
    if not (reg_raster == ri).any():
        rings = max(regions[key]['pp'], key=lambda r: poly_area(r[0]))
        cx = int(np.mean([p[0] for p in rings[0]])); cy = int(np.mean([p[1] for p in rings[0]]))
        reg_raster[min(cy, H-1), min(cx, W-1)] = ri
        print('forced cell', key)
# kiçik dəniz dəliklərini doldur
sea = reg_raster < 0
lab, nlab = ndimage.label(sea)
sizes = ndimage.sum(sea, lab, range(1, nlab+1))
small = np.isin(lab, np.where(sizes < 6)[0]+1)
if small.any():
    idx = ndimage.distance_transform_edt(reg_raster < 0, return_distances=False, return_indices=True)
    reg_raster[small] = reg_raster[idx[0][small], idx[1][small]]

# ---------- sahələr ----------
rows = np.arange(H) + 0.5
lat_rows = (np.arctan(np.exp((YT - rows/K)/1.25)) - math.pi/4)/0.4
R = 6371.0
cell_area = (R*2*math.pi/W) * np.cos(lat_rows) * (R/K*np.cos(0.8*lat_rows))   # km2
area_img = np.repeat(cell_area[:, None], W, 1)
reg_area = ndimage.sum(area_img, reg_raster+1, range(1, len(order)+1))

# ---------- əyalət toxumları ----------
rng = np.random.default_rng(20261113)
prov_raster = np.full((H, W), -1, np.int32)
prov = []   # dict(r, x, y)
for ri, key in enumerate(order):
    ys, xs = np.nonzero(reg_raster == ri)
    pts = np.stack([xs, ys], 1).astype(np.float64)
    n0 = max(1, int(round(1.6*(reg_area[ri]/25000.0)**0.62)))   # the original count
    n = min(2*n0, max(1, len(pts)//4))                           # twice as many provinces
    if n == 1:
        seeds = pts.mean(0, keepdims=True)
    else:
        seeds = [pts[rng.integers(len(pts))]]
        d2 = ((pts - seeds[0])**2).sum(1)
        for _ in range(n-1):
            j = rng.choice(len(pts), p=d2/d2.sum())
            seeds.append(pts[j]); d2 = np.minimum(d2, ((pts - pts[j])**2).sum(1))
        seeds = np.array(seeds)
        for it in range(25):
            a = cKDTree(seeds).query(pts)[1]
            for k in range(len(seeds)):
                m = a == k
                if m.any(): seeds[k] = pts[m].mean(0)
    a = cKDTree(seeds).query(pts)[1]
    used = np.unique(a)
    remap = {int(k): len(prov)+i for i, k in enumerate(used)}
    for k in used:
        prov.append(dict(r=ri, x=float(seeds[k][0]), y=float(seeds[k][1])))
    prov_raster[ys, xs] = np.vectorize(remap.get)(a)
NP = len(prov)
print('provinces', NP)

parea = ndimage.sum(area_img, prov_raster+1, range(1, NP+1))
pcells = ndimage.sum(np.ones_like(area_img), prov_raster+1, range(1, NP+1))
cy_, cx_ = zip(*ndimage.center_of_mass(np.ones_like(area_img), prov_raster+1, range(1, NP+1)))

# etiket nöqtəsi
pr = prov_raster
inner = np.ones((H, W), bool)
inner[1:, :] &= pr[1:, :] == pr[:-1, :]; inner[:-1, :] &= pr[:-1, :] == pr[1:, :]
inner[:, 1:] &= pr[:, 1:] == pr[:, :-1]; inner[:, :-1] &= pr[:, :-1] == pr[:, 1:]
inner &= pr >= 0
edt = ndimage.distance_transform_edt(inner)
mx = ndimage.maximum(edt, pr+1, range(1, NP+1))
mp = ndimage.maximum_position(edt, pr+1, range(1, NP+1))
for i in range(NP):
    if mx[i] >= 1.5:
        prov[i]['ly'], prov[i]['lx'] = mp[i][0]+0.5, mp[i][1]+0.5
    else:
        ys, xs = np.nonzero(pr == i)
        j = np.argmin((xs-cx_[i])**2 + (ys-cy_[i])**2)
        prov[i]['ly'], prov[i]['lx'] = ys[j]+0.5, xs[j]+0.5
    prov[i]['rad'] = float(mx[i])

# ---------- qonşuluq ----------
from collections import defaultdict
cnt = defaultdict(int)
def contacts(a, b, w=1):
    m = (a != b) & (a >= 0) & (b >= 0)
    pa = a[m]; pb = b[m]
    lo = np.minimum(pa, pb).astype(np.int64); hi = np.maximum(pa, pb)
    keys, c = np.unique(lo*100000 + hi, return_counts=True)
    for k, n in zip(keys, c): cnt[(int(k//100000), int(k % 100000))] += int(n)*w
contacts(pr[:, 1:], pr[:, :-1]); contacts(pr[1:, :], pr[:-1, :])
contacts(pr[:, 2:], pr[:, :-2]); contacts(pr[2:, :], pr[:-2, :])
adj = [set() for _ in range(NP)]
for (a, b), n in cnt.items():
    if n >= 3 or min(pcells[a], pcells[b]) < 40:
        adj[a].add(b); adj[b].add(a)

# ---------- dəniz keçidləri ----------
land = pr >= 0
mass, nmass = ndimage.label(land, structure=np.ones((3, 3)))
seam = ~land
coast = land.copy()
nb = np.zeros((H, W), bool)
nb[1:, :] |= seam[:-1, :]; nb[:-1, :] |= seam[1:, :]; nb[:, 1:] |= seam[:, :-1]; nb[:, :-1] |= seam[:, 1:]
nb[0, :] = nb[-1, :] = True
coast &= nb
cys, cxs = np.nonzero(coast)
keep = ((cxs + cys) % 2 == 0)
cys, cxs = cys[keep], cxs[keep]
cp = pr[cys, cxs]; cm = mass[cys, cxs]
tree = cKDTree(np.stack([cxs, cys], 1))
pairs = tree.query_pairs(40, output_type='ndarray')
d = np.hypot(cxs[pairs[:, 0]]-cxs[pairs[:, 1]], cys[pairs[:, 0]]-cys[pairs[:, 1]])
o = np.argsort(d); pairs = pairs[o]; d = d[o]
pi, pj = cp[pairs[:, 0]], cp[pairs[:, 1]]; mi, mj = cm[pairs[:, 0]], cm[pairs[:, 1]]
sea_links = set()
def hop_far(a, b, lim=3):
    seen = {a}; fr = [a]
    for _ in range(lim):
        nx = []
        for q in fr:
            for t in adj[q]:
                if t == b: return False
                if t not in seen: seen.add(t); nx.append(t)
        fr = nx
    return True
seen_mass = set(); seen_pm = set(); strait_cnt = defaultdict(int)
for k in range(len(d)):
    a, b = int(pi[k]), int(pj[k])
    if a == b or b in adj[a]: continue
    key = (min(a, b), max(a, b))
    if key in sea_links: continue
    if mi[k] != mj[k]:
        mk = (min(mi[k], mj[k]), max(mi[k], mj[k]))
        if mk not in seen_mass:
            seen_mass.add(mk); sea_links.add(key); seen_pm.add((a, mj[k])); seen_pm.add((b, mi[k]))
        elif d[k] <= 15 and (a, mj[k]) not in seen_pm and (b, mi[k]) not in seen_pm:
            sea_links.add(key); seen_pm.add((a, mj[k])); seen_pm.add((b, mi[k]))
    elif d[k] <= 12 and strait_cnt[a] < 2 and strait_cnt[b] < 2 and hop_far(a, b):
        sea_links.add(key); strait_cnt[a] += 1; strait_cnt[b] += 1
print('sea links (near)', len(sea_links))
# əlaqəlilik
def comps():
    par = list(range(NP))
    def f(x):
        while par[x] != x: par[x] = par[par[x]]; x = par[x]
        return x
    for a in range(NP):
        for b in adj[a]: par[f(a)] = f(b)
    for a, b in sea_links: par[f(a)] = f(b)
    return np.array([f(i) for i in range(NP)])
allc = np.stack([cxs, cys], 1)
while True:
    cc = comps(); roots, sizes_ = np.unique(cc, return_counts=True)
    if len(roots) == 1: break
    small_root = roots[np.argmin(sizes_)]
    inside = cc[cp] == small_root
    t2 = cKDTree(allc[~inside]); dd, jj = t2.query(allc[inside])
    k = np.argmin(dd)
    a = int(cp[inside][k]); b = int(cp[~inside][jj[k]])
    sea_links.add((min(a, b), max(a, b)))
print('sea links (all)', len(sea_links))

# ---------- long sea lanes (for fleets and naval invasions) ----------
# Two coastal provinces are joined by a lane when a straight line between their coasts crosses open water only.
LANE_MAX, LANE_K = 120, 7
rng_l = np.random.default_rng(99)
byp = defaultdict(list)
for k in range(len(cxs)): byp[int(cp[k])].append(k)
sel = []
for p_, ks in byp.items():
    sel.extend(int(k) for k in rng_l.choice(np.array(ks), min(len(ks), 7), replace=False))
lx_, ly_, lp_ = cxs[sel], cys[sel], cp[sel]
pairs = cKDTree(np.stack([lx_, ly_], 1)).query_pairs(LANE_MAX, output_type='ndarray')
pairs = pairs[lp_[pairs[:, 0]] != lp_[pairs[:, 1]]]
ts = np.linspace(0.06, 0.94, 40)[None, :]
best = {}
for c0 in range(0, len(pairs), 60000):
    ch_ = pairs[c0:c0+60000]
    x0, y0, x1, y1 = lx_[ch_[:, 0]][:, None], ly_[ch_[:, 0]][:, None], lx_[ch_[:, 1]][:, None], ly_[ch_[:, 1]][:, None]
    X = np.rint(x0 + (x1-x0)*ts).astype(int); Y = np.rint(y0 + (y1-y0)*ts).astype(int)
    ok = (pr[np.clip(Y, 0, H-1), np.clip(X, 0, W-1)] < 0).all(1)
    dd = np.hypot(x1-x0, y1-y0)[:, 0]
    for (i_, j_), good, dv in zip(ch_, ok, dd):
        if not good or dv < 20: continue
        a, b = int(lp_[i_]), int(lp_[j_]); key = (min(a, b), max(a, b))
        if key not in best or dv < best[key]: best[key] = dv
cand = defaultdict(list)
for (a, b), dv in best.items():
    if b in adj[a] or (a, b) in sea_links: continue
    cand[a].append((dv, b)); cand[b].append((dv, a))
lanes = set()
for a, l in cand.items():
    l.sort(); n_ = 0
    for dv, b in l:
        if n_ >= LANE_K: break
        if not hop_far(a, b, 4): continue    # skip pairs that are close by land anyway
        lanes.add((min(a, b), max(a, b))); n_ += 1
print('sea lanes', len(lanes))

# ---------- paytaxt, əhali, iqtisadiyyat ----------
reg_owner = [cidx[regions[k]['owner']] for k in order]
cap = {}
for code in countries:
    name, capn, lon, lat, pop, gdp = C[code]
    x, y = proj(lon, lat)
    own = [i for i in range(NP) if order[prov[i]['r']] == code]
    hit = pr[min(int(y), H-1), min(int(x), W-1)]
    if hit >= 0 and hit in own: cap[code] = int(hit)
    else: cap[code] = min(own, key=lambda i: (prov[i]['lx']-x)**2 + (prov[i]['ly']-y)**2)
for ri, key in enumerate(order):
    ids = [i for i in range(NP) if prov[i]['r'] == ri]
    if key in ATTACHED: pop, gdp = ATTACHED[key][2], ATTACHED[key][3]
    elif key == 'RUS_E': pop, gdp = 0.05, 1
    else: pop, gdp = C[key][4], C[key][5]
    w = np.array([parea[i]**0.55 * rng.uniform(0.7, 1.3) * (2.2 if cap.get(key) == i else 1) for i in ids])
    w /= w.sum()
    w2 = w * np.array([rng.uniform(0.8, 1.25) * (1.5 if cap.get(key) == i else 1) for i in ids]); w2 /= w2.sum()
    for i, a, b in zip(ids, w, w2):
        prov[i]['pop'] = pop*a; prov[i]['eco'] = gdp*b

# ---------- rənglər ----------
cadj = defaultdict(set)
for a in range(NP):
    for b in adj[a]:
        ca, cb = reg_owner[prov[a]['r']], reg_owner[prov[b]['r']]
        if ca != cb: cadj[ca].add(cb); cadj[cb].add(ca)
for a, b in sea_links:
    ca, cb = reg_owner[prov[a]['r']], reg_owner[prov[b]['r']]
    if ca != cb: cadj[ca].add(cb); cadj[cb].add(ca)
carea = defaultdict(float)
for i in range(NP): carea[reg_owner[prov[i]['r']]] += parea[i]
hues = {}
variants = [(0.36, 0.50), (0.30, 0.58), (0.42, 0.44), (0.26, 0.53)]
cols = {}
for n_, ci in enumerate(sorted(range(len(countries)), key=lambda c: -carea[c])):
    best = None
    for t in range(48):
        h = (t*0.61803398875 + 0.07) % 1.0
        dmin = min([min(abs(h-hues[o]), 1-abs(h-hues[o])) for o in cadj[ci] if o in hues] or [1])
        dall = min([min(abs(h-hh), 1-abs(h-hh)) for hh in hues.values()] or [1])
        score = min(dmin, 0.12)*10 + dall
        if best is None or score > best[0]: best = (score, h)
    hues[ci] = best[1]
    s, l = variants[n_ % len(variants)]
    r_, g_, b_ = colorsys.hls_to_rgb(best[1], l, s)
    cols[ci] = '#%02x%02x%02x' % (int(r_*255), int(g_*255), int(b_*255))

# ---------- şəhər adları ----------
# Every province is named after a real city: the most populous one inside it, then the nearest unused city of the region.
import re, unicodedata
def fold(s):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]', '', s)
cities = json.load(open(os.path.join(HERE, 'cities.json'), encoding='utf-8'))
names = [''] * NP
for ri, key in enumerate(order):
    ids = [i for i in range(NP) if prov[i]['r'] == ri]
    if key == 'RUS_E':   rows = [c for c in cities.get('RUS', []) if c[1] < -150]
    elif key == 'RUS':   rows = [c for c in cities.get('RUS', []) if not c[1] < -150]
    else:                rows = list(cities.get(key, []))
    capi = cap.get(key)
    used = set()
    if capi in ids:
        names[capi] = EN[key][1]; used.add(capi)
        cn = fold(EN[key][1])
        rows = [c for c in rows if not (len(cn) >= 4 and (fold(c[0]).startswith(cn) or cn.startswith(fold(c[0])) and len(fold(c[0])) >= 4))]
    seen_names, clean = set(), []
    for c in rows:   # no repeated names inside a region
        nm = c[0]
        if nm.lower() in seen_names:
            nm = f'{nm} ({c[5]})' if c[5] and f'{nm} ({c[5]})'.lower() not in seen_names else None
        if nm: seen_names.add(nm.lower()); clean.append((nm, *proj(c[1], c[2])))
    if not clean: continue
    free = [i for i in ids if i not in used]
    if not free: continue
    tree = cKDTree(np.array([[prov[i]['x'], prov[i]['y']] for i in ids]))
    taken = set()
    for k, (nm, x, y) in enumerate(clean):   # clean is sorted by population, so the biggest city of a province wins
        i = ids[int(tree.query([x, y])[1])]
        if i in used or names[i]: continue
        names[i] = nm; used.add(i); taken.add(k)
    left = [i for i in ids if not names[i]]
    spare = [k for k in range(len(clean)) if k not in taken]
    if left and spare:
        pairs = sorted((((prov[i]['x']-clean[k][1])**2 + (prov[i]['y']-clean[k][2])**2), i, k) for i in left for k in spare)
        done_p, done_c = set(), set()
        for d2, i, k in pairs:
            if i in done_p or k in done_c: continue
            names[i] = clean[k][0]; done_p.add(i); done_c.add(k)
    # still unnamed (sparse land such as deserts): the nearest city plus a compass direction, e.g. "Northeast Agadez"
    left = [i for i in ids if not names[i]]
    if left:
        taken_names = {names[i] for i in ids if names[i]}
        for i in left:
            k = min(range(len(clean)), key=lambda k: (prov[i]['x']-clean[k][1])**2 + (prov[i]['y']-clean[k][2])**2)
            dx, dy = prov[i]['x']-clean[k][1], prov[i]['y']-clean[k][2]
            ang = (math.degrees(math.atan2(-dy, dx)) + 360) % 360
            dirs = ['East', 'Northeast', 'North', 'Northwest', 'West', 'Southwest', 'South', 'Southeast']
            nm = f'{dirs[int((ang + 22.5) // 45) % 8]} {clean[k][0]}'
            base, n_ = nm, 2
            while nm in taken_names: nm = f'{base} {n_}'; n_ += 1
            names[i] = nm; taken_names.add(nm)
print('named provinces', sum(1 for n in names if n), 'of', NP)

# ---------- çıxış ----------
def r1(v): return round(v*10)/10
out = dict(W=W, H=H,
    countries=[dict(id=c, name=EN[c][0], capName=EN[c][1], cap=cap[c], color=cols[cidx[c]], mil=MIL.get(c, 1),
                    pop=C[c][4], gdp=C[c][5]) for c in countries],
    regions=[dict(o=reg_owner[ri], name=(ATT_EN[k] if k in ATTACHED else None),
                  polys=[[[int(round(v*10)) for p in ring for v in p] for ring in rings] for rings in regions[k]['pp']])
             for ri, k in enumerate(order)],
    prov=[[p['r'], r1(p['x']), r1(p['y']), r1(p['lx']), r1(p['ly']), round(p['pop'], 4), round(p['eco'], 3), int(parea[i]), r1(p['rad'])] for i, p in enumerate(prov)],
    names=names,
    lanes=sorted([list(k) for k in lanes]),
    adj=[sorted(int(b) for b in s) for s in adj],
    sea=sorted([list(map(int, k)) for k in sea_links]))
json.dump(out, open(os.path.join(HERE, '..', 'src', 'data.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('bytes', len(json.dumps(out, ensure_ascii=False, separators=(',', ':'))))
# statistikalar
per = defaultdict(int)
for p in prov: per[countries[reg_owner[p['r']]]] += 1
print({k: per[k] for k in ['AZE', 'ARM', 'GEO', 'TUR', 'IRN', 'RUS', 'USA', 'CHN', 'DEU', 'FRA', 'GBR', 'LUX', 'BRA', 'IND', 'DNK']})
print('isolated', [i for i in range(NP) if not adj[i] and not any(i in k for k in sea_links)])
deg = [len(adj[i]) for i in range(NP)]
print('max deg', max(deg), 'avg', sum(deg)/NP)
