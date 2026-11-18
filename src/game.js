'use strict';
// ============================================================ data
const W = D.W, H = D.H, CN = D.countries, NC = CN.length, NP = D.prov.length;
const $ = id => document.getElementById(id);
const P = D.prov.map((p, i) => ({ i, r: p[0], sx: p[1], sy: p[2], x: p[3], y: p[4], pop0: p[5], eco: p[6], area: p[7], rad: p[8], adj: D.adj[i], sea: [], nb: null, path: null, name: '' }));
D.sea.forEach(([a, b]) => { P[a].sea.push(b); P[b].sea.push(a); });
P.forEach(p => { p.lane = []; });
(D.lanes || []).forEach(([a, b]) => { P[a].lane.push(b); P[b].lane.push(a); });   // long sea lanes: only fleets can use them
P.forEach(p => { p.nb = p.adj.concat(p.sea); p.isSea = new Set(p.sea); p.isLane = new Set(p.lane); p.port = p.sea.length + p.lane.length > 0; });
const RG = D.regions.map((r, ri) => {
  const path = new Path2D(); let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  r.polys.forEach(rings => rings.forEach(ring => {
    for (let k = 0; k < ring.length; k += 2) {
      const x = ring[k] / 10, y = ring[k + 1] / 10;
      if (k === 0) path.moveTo(x, y); else path.lineTo(x, y);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    path.closePath();
  }));
  return { i: ri, o: r.o, name: r.name || CN[r.o].name, path, x0, y0, x1, y1, provs: [], edges: [] };
});
P.forEach(p => RG[p.r].provs.push(p.i));
P.forEach(p => { p.home = RG[p.r].o; });
// province cells: Voronoi of the region's seeds, by half-plane clipping
function clipHP(poly, nx, ny, c, tag) {
  const out = [], n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const da = nx * a.x + ny * a.y - c, db = nx * b.x + ny * b.y - c;
    if (da <= 0) {
      out.push(a);
      if (db > 0) { const t = da / (da - db); out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, t: tag }); }
    } else if (db <= 0) { const t = da / (da - db); out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, t: a.t }); }
  }
  return out;
}
RG.forEach(r => {
  const m = 3;
  r.provs.forEach((pi, k) => {
    const p = P[pi];
    let poly = [{ x: r.x0 - m, y: r.y0 - m, t: -1 }, { x: r.x1 + m, y: r.y0 - m, t: -1 }, { x: r.x1 + m, y: r.y1 + m, t: -1 }, { x: r.x0 - m, y: r.y1 + m, t: -1 }];
    for (const qi of r.provs) {
      if (qi === pi || !poly.length) continue;
      const q = P[qi], nx = q.sx - p.sx, ny = q.sy - p.sy;
      poly = clipHP(poly, nx, ny, nx * (p.sx + q.sx) / 2 + ny * (p.sy + q.sy) / 2, qi);
    }
    const path = new Path2D();
    poly.forEach((v, j) => j ? path.lineTo(v.x, v.y) : path.moveTo(v.x, v.y));
    path.closePath(); p.path = path;
    poly.forEach((v, j) => { if (v.t > pi) { const w = poly[(j + 1) % poly.length]; r.edges.push([v.x, v.y, w.x, w.y, pi, v.t]); } });
    p.name = D.names && D.names[pi] ? D.names[pi] : r.name + ' ' + (k + 1);
  });
});
CN.forEach((c, ci) => { P[c.cap].name = c.capName; P[c.cap].capOf = ci; });

// ============================================================ helpers
let seed = (Math.random() * 2 ** 32) >>> 0;
function rnd() { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }
const rr = (a, b) => a + rnd() * (b - a);
const ri_ = (a, b) => Math.floor(rr(a, b + 1));
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const pk = (a, b) => a < b ? a * NC + b : b * NC + a;
function fmt(n) { n = Math.round(n); const a = Math.abs(n); if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M'; if (a >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'; return n.toLocaleString('en-US'); }
const fpop = m => m >= 1 ? m.toFixed(1) + 'M' : Math.max(1, Math.round(m * 1000)) + 'k';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateOf = t => MONTHS[(t - 1) % 12] + ' ' + (2026 + Math.floor((t - 1) / 12));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cname = c => esc(CN[c].name);
const byId = {}; CN.forEach((c, i) => byId[c.id] = i);

// ============================================================ game state
let G = null;        // game
let UI = { slot: 0, pickNaval: -1, pickFrom: -1, sel: -1, move: null, mode: 'pol', picking: true, pick: byId.AZE, busy: false };
const MAXDEV = 5, DEV_TURNS = 10;   // one development takes 10 turns to pay off, one province at a time
// fleets: a ship carries 500 soldiers over the long sea lanes. Ships cost gold once and a little every turn.
const SHIP_COST = 15, SHIP_CAP = 500, SHIP_UPKEEP = 0.2, SHIP_MAX = 40, SHIP_BUY = 6;

function newGame(player) {
  const g = {
    turn: 1, player, mp: 0, over: false, won: false,
    owner: new Int16Array(NP), army: new Int32Array(NP), fleet: new Int16Array(NP), pendF: new Int16Array(NP), dev: new Uint8Array(NP), devT: new Uint8Array(NP), stab: new Uint8Array(NP),
    pop: new Float32Array(NP), pend: new Int32Array(NP), recd: new Int32Array(NP),
    gold: new Float64Array(NC), alive: new Uint8Array(NC), cap: new Int16Array(NC), aggr: new Float32Array(NC), prov0: new Int16Array(NC),
    rel: new Int8Array(NC * NC), wars: new Map(), allies: new Set(), truces: new Map(), orders: [], log: [], lastInc: 0,
    marches: [], mid: 1, dp: 1, phase: 0, lostCap: new Uint8Array(NC), slot: UI.slot
  };
  G = g; lastDemand.clear();
  for (let i = 0; i < NP; i++) { g.owner[i] = P[i].home; g.pop[i] = P[i].pop0; g.stab[i] = 100; }
  const nbC = neighbourCountries();
  for (let a = 0; a < NC; a++) for (let b = a + 1; b < NC; b++) {
    let v = ri_(-15, 25); if (nbC[a].has(b)) v += ri_(-28, 8);
    setRel(a, b, v);
  }
  const R = (x, y, v) => { if (byId[x] != null && byId[y] != null) setRel(byId[x], byId[y], v); };
  [['AZE', 'ARM', -75], ['AZE', 'TUR', 85], ['ARM', 'TUR', -45], ['IND', 'PAK', -65], ['PRK', 'KOR', -75], ['ISR', 'IRN', -75], ['ISR', 'PSE', -70],
   ['RUS', 'UKR', -90], ['RUS', 'BLR', 75], ['USA', 'GBR', 75], ['USA', 'CAN', 75], ['USA', 'IRN', -55], ['USA', 'PRK', -60], ['CHN', 'TWN', -65],
   ['SRB', 'KOS', -65], ['GRC', 'TUR', -30], ['SAU', 'IRN', -35], ['ETH', 'ERI', -35], ['MAR', 'DZA', -40], ['MAR', 'ESH', -55], ['USA', 'RUS', -45],
   ['CHN', 'IND', -30], ['USA', 'JPN', 65], ['USA', 'KOR', 65], ['FRA', 'DEU', 70], ['AZE', 'GEO', 45], ['AZE', 'PAK', 60], ['TUR', 'PAK', 55],
   ['AUS', 'NZL', 80], ['RUS', 'KAZ', 40], ['CHN', 'PRK', 50], ['USA', 'ISR', 70], ['SYR', 'ISR', -60], ['VEN', 'USA', -45], ['CUB', 'USA', -40]
  ].forEach(t => R(t[0], t[1], t[2]));
  const nato = 'USA,CAN,GBR,FRA,DEU,ITA,ESP,PRT,NLD,BEL,LUX,DNK,NOR,ISL,POL,CZE,SVK,HUN,ROU,BGR,GRC,TUR,EST,LVA,LTU,HRV,SVN,ALB,MNE,MKD,FIN,SWE'.split(',').map(x => byId[x]);
  for (const a of nato) for (const b of nato) if (a < b && relOf(a, b) < 40 && relOf(a, b) > -20) setRel(a, b, ri_(40, 60));
  for (let c = 0; c < NC; c++) {
    g.alive[c] = 1; g.cap[c] = CN[c].cap; g.aggr[c] = rr(0.25, 1);
    const own = []; for (let i = 0; i < NP; i++) if (g.owner[i] === c) own.push(i);
    g.prov0[c] = own.length;
    const total = 1500 * Math.pow(CN[c].pop, 0.55) * Math.pow(CN[c].gdp, 0.2) * CN[c].mil;
    const border = own.filter(i => i !== g.cap[c] && P[i].nb.some(j => g.owner[j] !== c));
    const capShare = border.length ? 0.35 : 1;
    g.army[g.cap[c]] = Math.max(100, Math.round(total * capShare / 100) * 100);
    border.forEach(i => { g.army[i] = Math.round(total * (1 - capShare) / border.length * rr(0.7, 1.3) / 100) * 100; });
    const ports = own.filter(i => P[i].port).sort((a, b) => P[b].pop0 - P[a].pop0).slice(0, 5);   // starting fleets sit in the biggest ports
    if (ports.length) { const ships = clamp(Math.round(total / 9000), 1, 60); ports.forEach(i => { g.fleet[i] = Math.round(ships / ports.length * rr(0.7, 1.3)); }); }
    g.gold[c] = Math.round(incomeOf(c) * 3);
  }
  g.mp = maxMP(player);
  UI.sel = g.cap[player]; UI.move = null;
  note(`You now lead <b>${cname(player)}</b>. Orders are carried out when you end the turn.`, 'me');
  return g;
}
function neighbourCountries() {
  const s = Array.from({ length: NC }, () => new Set());
  for (let i = 0; i < NP; i++) for (const j of P[i].nb) { const a = G.owner[i], b = G.owner[j]; if (a !== b) s[a].add(b); }
  return s;
}
// armies are visible only on your own land, in nations at war with you and in allied nations
function armyKnown(c) { const pl = G.player; return pl < 0 || !G.alive[pl] || c === pl || atWar(c, pl) || allied(c, pl); }
const armySeen = i => !!G && armyKnown(G.owner[i]);
const armyTxt = c => armyKnown(c) ? fmt(armyOf(c)) : '?';
const reachOf = i => G.fleet[i] >= 2 ? P[i].nb.concat(P[i].lane) : P[i].nb;   // where a nation can strike from here, fleets included
const relOf = (a, b) => G.rel[a * NC + b];
function setRel(a, b, v) { v = clamp(Math.round(v), -100, 100); G.rel[a * NC + b] = v; G.rel[b * NC + a] = v; }
const addRel = (a, b, d) => setRel(a, b, relOf(a, b) + d);
const atWar = (a, b) => G.wars.has(pk(a, b));
const allied = (a, b) => G.allies.has(pk(a, b));
function partners(set, c) { const out = []; for (const k of (set.keys ? set.keys() : set)) { const a = Math.floor(k / NC), b = k % NC; if (a === c) out.push(b); else if (b === c) out.push(a); } return out; }
const enemiesOf = c => partners(G.wars, c);
const alliesOf = c => partners(G.allies, c);
function ownedBy(c) { const o = []; for (let i = 0; i < NP; i++) if (G.owner[i] === c) o.push(i); return o; }
// income of a province from its people and economy; 0.87 keeps total income at the old level now that provinces are twice as small
const baseOf = (pop, eco) => 0.87 * (6 * Math.pow(pop, 0.8) + 5 * Math.pow(eco / 10, 0.8));
const effDev = i => G.dev[i] + (G.devT[i] > 0 ? (DEV_TURNS - G.devT[i]) / DEV_TURNS : 0);   // a development in progress adds its income a little each turn
function provBase(i) { return baseOf(G.pop[i], P[i].eco) * (1 + 0.2 * effDev(i)); }
// difficulty: every nation's gold surplus (income minus the upkeep of its starting forces) is cut by 30%, worked out for each nation on its own
const SURPLUS_KEEP = 0.7;
let FIN = null;
function finOf(c) {
  if (!FIN) {
    FIN = new Float64Array(NC).fill(1); const inc = new Float64Array(NC), fleetP = new Uint8Array(NC);
    for (let i = 0; i < NP; i++) { inc[P[i].home] += baseOf(P[i].pop0, P[i].eco); if (P[i].port) fleetP[P[i].home] = 1; }
    for (let k = 0; k < NC; k++) {
      const total = 1500 * Math.pow(CN[k].pop, 0.55) * Math.pow(CN[k].gdp, 0.2) * CN[k].mil, up = total / 1000 + (fleetP[k] ? clamp(Math.round(total / 9000), 1, 60) * SHIP_UPKEEP : 0);
      if (inc[k] > up) FIN[k] = (SURPLUS_KEEP * (inc[k] - up) + up) / inc[k];
    }
  }
  return FIN[c];
}
const provInc = i => provBase(i) * G.stab[i] / 100 * finOf(G.owner[i]);
function incomeOf(c) { let s = 0; for (let i = 0; i < NP; i++) if (G.owner[i] === c) s += provInc(i); return s; }
function armyOf(c) { let s = 0; for (let i = 0; i < NP; i++) if (G.owner[i] === c) s += G.army[i]; return s; }
function fleetOf(c) { let s = 0; for (let i = 0; i < NP; i++) if (G.owner[i] === c) s += G.fleet[i]; return s; }
const upkeepOf = c => armyOf(c) / 1000 + fleetOf(c) * SHIP_UPKEEP;
function countOf(c) { let s = 0; for (let i = 0; i < NP; i++) if (G.owner[i] === c) s++; return s; }
const maxMP = c => 6 + Math.floor(2 * Math.sqrt(countOf(c)));
const strength = c => armyOf(c) + Math.max(0, G.gold[c]) * 40 + incomeOf(c) * 120;
const devCost = i => Math.max(20, Math.round(baseOf(G.pop[i], P[i].eco) * 5 * (G.dev[i] + 1)));
const canDev = i => G.dev[i] < MAXDEV && G.devT[i] === 0;
function recruitMax(i) { return Math.max(0, Math.floor(G.pop[i] * 1e6 * 0.01 * G.stab[i] / 100 / 100) * 100 - G.recd[i]); }
function availAt(i) { let a = G.army[i]; for (const o of G.orders) if (o.from === i && o.c === G.owner[i]) a -= o.n; return a; }
function availShips(i) { let a = G.fleet[i]; for (const o of G.orders) if (o.naval && o.from === i && o.c === G.owner[i]) a -= o.ships; return a; }
function defMult(i) { return 1.1 + (G.cap[G.owner[i]] === i ? 0.15 : 0); }
function note(html, cls) { G.log.push({ t: G.turn, h: html, c: cls || '' }); if (G.log.length > 80) G.log.shift(); }

// ============================================================ diplomacy
let pendingEvents = [];
const lastDemand = new Map();   // AI nation -> turn of its last peace demand, so demands do not come every turn
function declareWar(a, b) {
  if (a === b || atWar(a, b) || !G.alive[a] || !G.alive[b]) return;
  G.allies.delete(pk(a, b)); G.truces.delete(pk(a, b));
  G.wars.set(pk(a, b), { s: G.turn, last: G.turn });
  setRel(a, b, Math.min(relOf(a, b) - 50, -60));
  const mine = a === G.player || b === G.player;
  note(`<b>${cname(a)}</b> declared war on <b>${cname(b)}</b>.`, mine ? 'war' : '');
  if (b === G.player && a !== G.player) pendingEvents.push({ type: 'wardecl', from: a });
  for (let c = 0; c < NC; c++) if (c !== a && c !== b && G.alive[c] && relOf(c, b) > 20) addRel(c, a, -6);
  for (const z of alliesOf(b)) {
    if (z === a || atWar(z, a) || allied(z, a) || !G.alive[z]) continue;
    if (z === G.player) pendingEvents.push({ type: 'allycall', ally: b, foe: a });
    else if (rnd() < 0.75) joinWar(z, a, b);
  }
}
function joinWar(z, foe, ally) {
  if (atWar(z, foe)) return;
  G.truces.delete(pk(z, foe));
  G.wars.set(pk(z, foe), { s: G.turn, last: G.turn });
  setRel(z, foe, Math.min(relOf(z, foe) - 40, -50));
  note(`<b>${cname(z)}</b> joined the war against <b>${cname(foe)}</b> to defend ${cname(ally)}.`, (z === G.player || foe === G.player) ? 'war' : '');
}
function makePeace(a, b) {
  if (!G.wars.delete(pk(a, b))) return;
  G.truces.set(pk(a, b), 10);
  setRel(a, b, Math.max(relOf(a, b) + 25, -35));
  note(`<b>${cname(a)}</b> and <b>${cname(b)}</b> signed a peace treaty.`, (a === G.player || b === G.player) ? 'good' : '');
}
function formAlliance(a, b) { G.allies.add(pk(a, b)); addRel(a, b, 15); note(`<b>${cname(a)}</b> and <b>${cname(b)}</b> formed an alliance.`, (a === G.player || b === G.player) ? 'good' : ''); }
function breakAlliance(a, b) { if (G.allies.delete(pk(a, b))) { addRel(a, b, -35); note(`The alliance between <b>${cname(a)}</b> and <b>${cname(b)}</b> has ended.`, (a === G.player || b === G.player) ? 'war' : ''); } }
function eliminate(x, by, gaveUp) {
  G.alive[x] = 0;
  for (const k of [...G.wars.keys()]) if (Math.floor(k / NC) === x || k % NC === x) G.wars.delete(k);
  for (const k of [...G.allies]) if (Math.floor(k / NC) === x || k % NC === x) G.allies.delete(k);
  for (const k of [...G.truces.keys()]) if (Math.floor(k / NC) === x || k % NC === x) G.truces.delete(k);
  G.orders = G.orders.filter(o => o.c !== x);
  note(gaveUp ? `<b>${cname(x)}</b> capitulated to <b>${cname(by)}</b>.` : `<b>${cname(x)}</b> has been conquered by <b>${cname(by)}</b>.`, x === G.player ? 'war' : (by === G.player ? 'good' : ''));
}
const DP_MAX = 5;   // diplomacy points: a slow resource, spent on improving relations
const dpIncome = c => 0.4 + 0.08 * Math.sqrt(countOf(c));
function dpUpkeep(c) { let n = 0; for (let o = 0; o < NC; o++) if (o !== c && G.alive[o] && relOf(c, o) >= 50 && !allied(c, o)) n++; return n * 0.2; }   // every friendly nation costs 0.2 a turn
function giftCost(c) { return Math.max(20, Math.round(10 + incomeOf(c) * 0.25)); }
function aiAcceptsPeace(ai, pl) {
  const w = G.wars.get(pk(ai, pl)); if (!w) return false;
  const dur = G.turn - w.s, sa = armyOf(ai), sp = armyOf(pl);
  if (dur < 2) return false;
  if (sa > sp * 1.6 && dur < 12) return false;
  return sa < sp * 0.95 || dur >= 8 || countOf(ai) < G.prov0[ai] * 0.7;
}
function aiAcceptsAlliance(ai, pl) { return relOf(ai, pl) >= 50 && alliesOf(ai).length < 3 && !atWar(ai, pl) && !enemiesOf(pl).some(e => allied(ai, e)); }

// ---- peace terms: land and gold, between the player and the AI and between AI nations
const provValue = i => Math.round(provInc(i) * 12 + 15);
const dealValue = d => d.prov.reduce((a, i) => a + provValue(i), 0) + d.gold;
function pressure(g, t) {   // 0..1: how badly nation g needs peace with nation t
  const ag = armyOf(g), at = armyOf(t), p0 = G.prov0[g] || 1, lost = Math.max(0, p0 - countOf(g)) / p0;
  const w = G.wars.get(pk(g, t)), dur = w ? G.turn - w.s : 0;
  return clamp(Math.max(clamp((at / (ag + 1) - 0.9) / 2, 0, 1), clamp(lost * 2, 0, 1)) + clamp((dur - 6) / 24, 0, 0.4), 0, 1);
}
function budget(g, t) { const p = pressure(g, t); return p < 0.12 ? 0 : p * (incomeOf(g) * 14 + Math.max(0, G.gold[g]) * 0.5); }
function dealText(d) { const a = d.prov.map(i => `<b>${esc(P[i].name)}</b>`); if (d.gold > 0) a.push(`<b>${fmt(d.gold)} gold</b>`); return a.length ? a.join(', ') : 'nothing'; }
function judgeDeal(raw, ai, pl) {
  const w = G.wars.get(pk(ai, pl)); if (!w) return { ok: false, why: 'You are not at war.' };
  if (!G.tut && G.turn - w.s < 2) return { ok: false, why: 'The war has only just begun.' };
  const d = normalizeDeal(raw);   // judge exactly what would change hands
  const v = dealValue(d), white = G.tut || aiAcceptsPeace(ai, pl);   // in the tutorial the beaten nation always agrees to white peace
  if (v <= 0) return white ? { ok: true, why: 'They are ready to end the war.' } : { ok: false, why: 'They want to keep fighting.' };
  if (d.giver === ai) { const B = budget(ai, pl); return v <= B ? { ok: true, why: 'They will pay this price.' } : { ok: false, why: B <= 0 ? 'They do not feel beaten and will give nothing.' : 'The price is too high for them.' }; }
  const B = budget(pl, ai); return white || v >= 0.5 * B ? { ok: true, why: 'They accept your offer.' } : { ok: false, why: 'They want more.' };
}
function cede(i, to) {
  const from = G.owner[i];
  if (from < 0 || from === to) return;
  if (G.cap[from] === i) return;                       // the capital can never be traded away
  const cap = G.cap[from];
  if (G.owner[cap] === from) G.army[cap] += G.army[i];   // the garrison withdraws to the giver's capital
  G.army[i] = 0;
  capture(i, to);
}
// One canonical view of a deal, used both by the verdict and by the transfer, so what is
// promised is exactly what changes hands: only provinces the giver still owns (its capital
// excluded, no duplicates), and no more gold than the giver can actually pay.
function normalizeDeal(d) {
  const giver = d.giver, taker = d.taker;
  const seen = new Set(), prov = [];
  if (G.alive[giver] && giver !== taker) {
    for (const i of d.prov) {
      if (i == null || seen.has(i)) continue;
      seen.add(i);
      if (G.owner[i] === giver && G.cap[giver] !== i) prov.push(i);
    }
  }
  const gold = G.alive[giver] ? Math.max(0, Math.min(Math.floor(d.gold) || 0, Math.floor(Math.max(0, G.gold[giver])))) : 0;
  return { giver, taker, prov, gold };
}
function applyDeal(d) {
  const n = normalizeDeal(d);
  const t = tally; tally = { won: 0, lost: 0 };
  for (const i of n.prov) if (G.owner[i] === n.giver && G.cap[n.giver] !== i) cede(i, n.taker);
  tally = t;
  G.gold[n.giver] -= n.gold; G.gold[n.taker] += n.gold;   // n.gold is already capped at the giver's treasury
  mapDirty = true;
}
function aiTerms(giver, taker, share) {   // what the giver can be made to hand over: border provinces first, then gold
  let B = budget(giver, taker) * share; if (B <= 0) return null;
  const front = ownedBy(giver).filter(i => G.cap[giver] !== i && P[i].nb.some(j => G.owner[j] === taker)).sort((a, b) => provValue(b) - provValue(a));
  const prov = []; for (const i of front) { const v = provValue(i); if (v <= B && prov.length < 4) { prov.push(i); B -= v; } }
  const gold = Math.max(0, Math.min(Math.floor(B * 0.5 / 10) * 10, Math.floor(G.gold[giver] * 0.5)));
  return prov.length || gold >= 10 ? { giver, taker, prov, gold } : null;
}
function aiPeace(a, b) {   // two AI nations end a war: the weaker side may pay
  const pa = pressure(a, b), pb = pressure(b, a), giver = pa >= pb ? a : b, taker = giver === a ? b : a;
  const d = Math.max(pa, pb) >= 0.3 ? aiTerms(giver, taker, 0.6) : null;
  if (d) { applyDeal(d); note(`<b>${cname(giver)}</b> gave ${dealText(d)} to <b>${cname(taker)}</b> for peace.`, ''); }
  makePeace(a, b);
}

// ============================================================ movement and battle
let flashes = [], tally = { won: 0, lost: 0 };
function capture(t, c) {
  const prev = G.owner[t]; if (c === G.player) tally.won++; if (prev === G.player) tally.lost++;
  G.owner[t] = c; G.stab[t] = 40; G.pop[t] *= 0.97; G.pend[t] = 0; G.fleet[t] = 0; G.pendF[t] = 0; G.devT[t] = 0;
  const w = G.wars.get(pk(prev, c)); if (w) w.last = G.turn;
  if (G.cap[prev] === t) {
    G.lostCap[prev] = 1;
    const loot = Math.max(0, Math.floor(G.gold[prev] * 0.2)); G.gold[prev] -= loot; G.gold[c] += loot;
    const rest = ownedBy(prev);
    if (rest.length) { rest.sort((a, b) => G.pop[b] - G.pop[a]); G.cap[prev] = rest[0]; }
  }
  const left = countOf(prev);
  if (left === 0) eliminate(prev, c);
  else if (prev !== G.player && G.lostCap[prev] && left <= Math.ceil(G.prov0[prev] * 0.4)) {
    for (let i = 0; i < NP; i++) if (G.owner[i] === prev) { G.owner[i] = c; G.army[i] = 0; G.fleet[i] = 0; G.pendF[i] = 0; G.stab[i] = 40; G.pend[i] = 0; if (c === G.player) tally.won++; }
    eliminate(prev, c, true);
  }
  mapDirty = true;
}
function battle(c, t, g) {
  const d = G.owner[t], A = g.n, Dn = G.army[t];
  const involved = c === G.player || d === G.player;
  if (Dn <= 0) {
    G.army[t] = A; capture(t, c);
    if (involved) { note(c === G.player ? `Your troops occupied <b>${esc(P[t].name)}</b> without a fight.` : `<b>${cname(c)}</b> seized undefended <b>${esc(P[t].name)}</b>.`, c === G.player ? 'good' : 'war'); flashes.push({ p: t, t: performance.now(), win: c === G.player }); }
    return;
  }
  const att = A * rr(0.9, 1.1) * (g.sea ? 0.75 : 1), def = Dn * defMult(t) * rr(0.9, 1.1);
  if (att > def) {
    const lossA = Math.min(A - 1, Math.round(A * Math.min(0.95, Math.pow(def / att, 1.3) * 0.8)));
    G.army[t] = A - lossA; capture(t, c);
    if (involved) { note(c === G.player ? `Victory at <b>${esc(P[t].name)}</b>: taken from ${cname(d)}. Lost ${fmt(lossA)}, destroyed ${fmt(Dn)}.` : `<b>${cname(c)}</b> captured <b>${esc(P[t].name)}</b>. You lost ${fmt(Dn)} defenders.`, c === G.player ? 'good' : 'war'); flashes.push({ p: t, t: performance.now(), win: c === G.player }); }
  } else {
    const lossD = Math.round(Dn * Math.min(0.9, Math.pow(att / def, 1.3) * 0.7));
    G.army[t] = Dn - lossD;
    if (involved) { note(c === G.player ? `Defeat at <b>${esc(P[t].name)}</b>: your ${fmt(A)} attackers were lost. The enemy lost ${fmt(lossD)}.` : `You held <b>${esc(P[t].name)}</b> against ${cname(c)}. Lost ${fmt(lossD)}, destroyed ${fmt(A)}.`, c === G.player ? 'war' : 'good'); flashes.push({ p: t, t: performance.now(), win: d === G.player }); }
  }
}
function shipsHome(g) {   // surviving ships sail back to the ports they left
  if (g.ships <= 0 || !g.fsrc.length) return;
  const tot = g.fsrc.reduce((a, x) => a + x[1], 0); let left = g.ships;
  g.fsrc.forEach(([f, sh], k) => { const q = k === g.fsrc.length - 1 ? left : Math.min(left, Math.round(g.ships * sh / tot)); left -= q; if (G.owner[f] === g.c) G.fleet[f] += q; });
  g.ships = 0;
}
function navalClash(c, t, g) {
  const d = G.owner[t], D = G.fleet[t], S = g.ships, involved = c === G.player || d === G.player;
  if (D <= 0) {
    if (g.n <= 0) { G.stab[t] = Math.max(0, G.stab[t] - 12); if (involved) note(c === G.player ? `Your ships raided the port of <b>${esc(P[t].name)}</b>.` : `<b>${cname(c)}</b> raided the port of <b>${esc(P[t].name)}</b>.`, c === G.player ? 'good' : 'war'); }
    return;
  }
  const att = S * rr(0.9, 1.1), def = D * 1.1 * rr(0.9, 1.1);
  if (att > def) {
    const lossS = Math.min(S - 1, Math.round(S * Math.min(0.9, Math.pow(def / att, 1.3) * 0.8)));
    G.fleet[t] = 0; g.ships = S - lossS; g.n = Math.round(g.n * g.ships / S);
    if (involved) { note(c === G.player ? `Naval victory off <b>${esc(P[t].name)}</b>: ${fmt(D)} enemy ${D > 1 ? 'ships' : 'ship'} sunk, ${fmt(lossS)} of yours lost.` : `<b>${cname(c)}</b> destroyed your fleet at <b>${esc(P[t].name)}</b>.`, c === G.player ? 'good' : 'war'); flashes.push({ p: t, t: performance.now(), win: c === G.player }); }
  } else {
    const lossD = Math.round(D * Math.min(0.9, Math.pow(att / def, 1.3) * 0.7));
    G.fleet[t] = D - lossD; g.ships = 0; const lost = g.n; g.n = 0;
    if (involved) { note(c === G.player ? `Naval defeat off <b>${esc(P[t].name)}</b>: your ${fmt(S)} ${S > 1 ? 'ships' : 'ship'} and ${fmt(lost)} soldiers were lost.` : `Your fleet held <b>${esc(P[t].name)}</b> against <b>${cname(c)}</b>. Lost ${fmt(lossD)}, sank ${fmt(S)}.`, c === G.player ? 'war' : 'good'); flashes.push({ p: t, t: performance.now(), win: d === G.player }); }
  }
}
function resolveMoves() {
  const arr = new Map();
  for (const o of G.orders) {
    if (!G.alive[o.c] || G.owner[o.from] !== o.c) continue;
    const n = Math.min(o.n, G.army[o.from]), sh = o.naval ? Math.min(o.ships, G.fleet[o.from]) : 0;
    if (o.naval ? sh <= 0 : n <= 0) continue;
    G.army[o.from] -= n; G.fleet[o.from] -= sh;
    if (!arr.has(o.to)) arr.set(o.to, new Map());
    const m = arr.get(o.to); if (!m.has(o.c)) m.set(o.c, { c: o.c, n: 0, src: [], sea: true, ships: 0, fsrc: [] });
    const g = m.get(o.c); g.n += n; if (n) g.src.push([o.from, n]); g.ships += sh; if (sh) g.fsrc.push([o.from, sh]);
    if (!o.naval && !P[o.from].isSea.has(o.to)) g.sea = false;
  }
  G.orders = [];
  const targets = [...arr.keys()].sort(() => rnd() - 0.5);
  for (const t of targets) {
    const m = arr.get(t);
    const own = m.get(G.owner[t]); if (own) { G.army[t] += own.n; shipsHome(own); m.delete(G.owner[t]); }
    const groups = [...m.entries()].sort((a, b) => b[1].n - a[1].n);
    for (const [c, g] of groups) {
      if (!G.alive[c]) continue;
      const cur = G.owner[t];
      if (cur === c) { G.army[t] += g.n; shipsHome(g); }
      else if (atWar(c, cur)) { if (g.ships > 0) navalClash(c, t, g); if (g.n > 0) battle(c, t, g); shipsHome(g); }
      else { for (const [f, n] of g.src) if (G.owner[f] === c) G.army[f] += n; shipsHome(g); }
    }
  }
}

// ============================================================ routes and marches
function pathTo(from, dest, c) {
  const pass = j => { const o = G.owner[j]; return o === c || atWar(o, c); };
  if (from === dest || !pass(dest)) return null;
  const dist = new Float64Array(NP).fill(Infinity), prev = new Int32Array(NP).fill(-1), done = new Uint8Array(NP), open = [from];
  dist[from] = 0;
  while (open.length) {
    let bi = 0; for (let k = 1; k < open.length; k++) if (dist[open[k]] < dist[open[bi]]) bi = k;
    const i = open[bi]; open[bi] = open[open.length - 1]; open.pop(); done[i] = 1;
    if (i === dest) break;
    for (const j of P[i].nb) {
      if (done[j] || !pass(j)) continue;
      const nd = dist[i] + (G.owner[j] === c ? 1 : 2.5) + (P[i].isSea.has(j) ? 0.3 : 0);
      if (nd < dist[j]) { if (dist[j] === Infinity) open.push(j); dist[j] = nd; prev[j] = i; }
    }
  }
  if (prev[dest] < 0) return null;
  const path = [dest]; while (path[0] !== from) path.unshift(prev[path[0]]);
  return path;
}
function ownPath(from, dest) {   // shortest route that stays inside your own land
  const pl = G.player; if (from === dest || G.owner[dest] !== pl || G.owner[from] !== pl) return null;
  const prev = new Int32Array(NP).fill(-1), q = [from]; prev[from] = from;
  for (let k = 0; k < q.length && prev[dest] < 0; k++) for (const j of P[q[k]].nb) if (prev[j] < 0 && G.owner[j] === pl) { prev[j] = q[k]; q.push(j); }
  if (prev[dest] < 0) return null;
  const path = [dest]; while (path[0] !== from) path.unshift(prev[path[0]]); return path;
}
const isFront = d => G.owner[d] === G.player && P[d].nb.some(j => atWar(G.owner[j], G.player));
const instantOK = (f, d) => G.owner[f] === G.player && G.owner[d] === G.player && f !== d && P[f].nb.includes(d) && isFront(d);   // reinforce the front line at once
function instantMove(f, d, n) {
  n = Math.min(n, availAt(f)); if (n <= 0 || !instantOK(f, d)) return false;
  G.army[f] -= n; G.army[d] += n; mapDirty = true; return true;
}
function startMarch(from, dest, n, path, free) {
  const pl = G.player, ord = { c: pl, from, to: path[1], n };
  if (free) ord.free = true;
  if (path.length > 2) { const id = G.mid++; ord.m = id; G.marches.push({ id, at: from, next: path[1], dest, n, path, sent: true }); }
  G.orders.push(ord);
}
function updateMarches() {
  const pl = G.player, keep = [];
  if (pl >= 0 && G.alive[pl]) for (const m of G.marches) {
    if (!m.sent) { keep.push(m); continue; }
    if (G.owner[m.next] === pl) {
      m.at = m.next; m.n = Math.min(m.n, G.army[m.at]);
      if (m.n <= 0) continue;
      if (m.at === m.dest) { note(`Your army of ${fmt(m.n)} reached <b>${esc(P[m.dest].name)}</b>.`, 'me'); continue; }
      keep.push(m);
    } else note(`The march to <b>${esc(P[m.dest].name)}</b> was stopped at ${esc(P[m.next].name)}.`, 'war');
  }
  G.marches = keep;
}
function planMarches() {
  const pl = G.player, keep = [];
  if (pl >= 0 && G.alive[pl] && !G.over) for (const m of G.marches) {
    m.sent = false;
    if (G.owner[m.at] !== pl) continue;
    const path = pathTo(m.at, m.dest, pl), n = Math.min(m.n, availAt(m.at));
    if (!path) { note(`No route is left to <b>${esc(P[m.dest].name)}</b>. The march was called off.`, 'war'); continue; }
    if (n <= 0) continue;
    m.path = path; m.next = path[1]; m.n = n; m.sent = true;
    G.orders.push({ c: pl, from: m.at, to: m.next, n, m: m.id, free: true }); keep.push(m);
  }
  G.marches = keep;
}
function gatherAll(dest) {
  const pl = G.player; let cnt = 0, men = 0;
  for (const i of ownedBy(pl)) {
    if (i === dest) continue; const n = availAt(i); if (n <= 0) continue;
    if (instantOK(i, dest) && instantMove(i, dest, n)) { cnt++; men += n; continue; }   // reinforcing the front line: at once
    const path = G.phase === 1 ? ownPath(i, dest) : pathTo(i, dest, pl); if (!path) continue;
    startMarch(i, dest, n, path, true); cnt++; men += n;
  }
  return { cnt, men };
}
function borderOf(pl) {
  const en = new Set(enemiesOf(pl)), front = [], border = [];
  for (const i of ownedBy(pl)) { let f = false, b = false; for (const j of P[i].nb) { const o = G.owner[j]; if (o !== pl) { b = true; if (en.has(o)) f = true; } } if (f) front.push(i); if (b) border.push(i); }
  return { front, border };
}
function planDevelop() {
  const pl = G.player; let gold = G.gold[pl]; const list = [];
  const c = ownedBy(pl).filter(canDev).map(i => ({ i, cost: devCost(i), v: provBase(i) / devCost(i) })).sort((a, b) => b.v - a.v);
  for (const x of c) if (x.cost <= gold) { gold -= x.cost; list.push(x); }
  return { list, total: G.gold[pl] - gold };
}
function planRecruit(frac) {
  const pl = G.player, b = borderOf(pl), spots = b.front.length ? b.front : b.border.length ? b.border : [G.cap[pl]];
  const budget = Math.max(0, Math.floor(G.gold[pl] * frac)), per = Math.floor(budget * 100 / spots.length / 100) * 100, list = []; let total = 0;
  for (const i of spots) { const n = Math.min(per, recruitMax(i)); if (n >= 100) { list.push({ i, n }); total += n; } }
  return { list, total, cost: total / 100, front: b.front.length > 0 };
}

// ============================================================ AI
function aiTurn(c, own, movesOnly) {
  const g = G, enemies = new Set(enemiesOf(c)), war = enemies.size > 0;
  const inc = incomeOf(c); let upk = 0; for (const i of own) upk += g.army[i] + g.fleet[i] * SHIP_UPKEEP * 1000; upk /= 1000;
  // --- diplomacy
  if (!movesOnly) {
  if (!war && g.turn >= 4) {
    const nb = new Set(); for (const i of own) for (const j of reachOf(i)) if (g.owner[j] !== c) nb.add(g.owner[j]);
    let best = -1, bs = 0, bBusy = false; const mine = strength(c);
    for (const n of nb) {
      if (allied(c, n) || g.truces.has(pk(c, n)) || relOf(c, n) > 5) continue;
      const busy = enemiesOf(n).length > 0;   // a nation already fighting someone else is a tempting target, even for a third party
      let their = strength(n); for (const z of alliesOf(n)) their += strength(z) * 0.5; if (busy) their *= 0.7;
      const ratio = mine / (their + 1); if (ratio < (busy ? 1.25 : 1.6)) continue;
      const sc = ratio * (1 - relOf(c, n) / 100) * (n === g.player ? 0.9 : 1);
      if (sc > bs) { bs = sc; best = n; bBusy = busy; }
    }
    if (best >= 0 && rnd() < 0.017 * g.aggr[c] * (g.gold[c] > inc * 2 ? 1.4 : 1) * (bBusy ? 2.2 : 1)) { declareWar(c, best); enemies.add(best); }
  }
  if (rnd() < 0.012 && alliesOf(c).length < 2) {
    const nb = new Set(); for (const i of own) for (const j of reachOf(i)) if (g.owner[j] !== c) nb.add(g.owner[j]);
    for (const n of nb) if (relOf(c, n) >= 55 && !allied(c, n) && !atWar(c, n) && alliesOf(n).length < 2) {
      if (n === g.player) pendingEvents.push({ type: 'allyoffer', from: c }); else formAlliance(c, n);
      break;
    }
  }
  for (const e of [...enemies]) {
    const w = g.wars.get(pk(c, e)); if (!w) continue;
    const dur = g.turn - w.s, quiet = g.turn - w.last;
    if (e === g.player) {
      if (pendingEvents.some(v => (v.type === 'peaceoffer' || v.type === 'peacedemand') && v.from === c)) continue;
      const dem = dur >= 3 && g.turn - (lastDemand.get(c) || -99) >= 6 && pressure(e, c) >= 0.35 && rnd() < 0.25 ? aiTerms(e, c, 0.7) : null;   // the AI is winning: it names its price
      if (dem && (dem.prov.length || dem.gold >= 100)) { pendingEvents.push({ type: 'peacedemand', from: c, deal: dem }); lastDemand.set(c, g.turn); }
      else if (dur >= 4 && (quiet >= 5 || armyOf(c) < armyOf(e) * 0.5 || countOf(c) < g.prov0[c] * 0.6) && rnd() < 0.35) pendingEvents.push({ type: 'peaceoffer', from: c, deal: pressure(c, e) >= 0.3 ? aiTerms(c, e, 0.5) : null });
    } else if (c < e && dur >= 3 && rnd() < Math.min(0.5, 0.03 + 0.03 * quiet + 0.01 * dur)) { aiPeace(c, e); enemies.delete(e); }
  }
  }
  const atwar = enemies.size > 0;
  // --- situation
  const front = [], border = [];
  for (const i of own) {
    let f = false, b = false;
    for (const j of P[i].nb) { const o = g.owner[j]; if (o !== c) { b = true; if (enemies.has(o)) f = true; } }
    if (f) front.push(i); else if (b) border.push(i);
  }
  // --- economy
  let gold = g.gold[c];
  if (gold > 0 && !movesOnly) {
    const share = atwar ? 0.92 : 0.5;
    const room = Math.max(0, (inc * share - upk) * 1000);
    let want = Math.min(gold * (atwar ? 0.9 : 0.4) * 100, room);
    const spots = (atwar && front.length ? front : border.length ? border : [g.cap[c]]).slice().sort(() => rnd() - 0.5).slice(0, 3);
    if (!spots.includes(g.cap[c]) && !atwar) spots.push(g.cap[c]);
    for (const i of spots) {
      if (want < 100) break;
      const n = Math.min(Math.floor(want / spots.length / 100) * 100 || 100, recruitMax(i));
      if (n >= 100 && n / 100 <= gold) { g.pend[i] += n; g.recd[i] += n; g.pop[i] -= n / 1e6; gold -= n / 100; want -= n; }
    }
    if (atwar) {   // ships for an overseas war
      const pw = own.filter(i => P[i].port && P[i].lane.some(j => enemies.has(g.owner[j])));
      if (pw.length && gold > SHIP_COST * 4 && fleetOf(c) < 3 + own.length * 0.3) {
        const i = pw[Math.floor(rnd() * pw.length)], k = Math.min(SHIP_BUY, Math.floor(gold * 0.25 / SHIP_COST), SHIP_MAX - g.fleet[i] - g.pendF[i]);
        if (k > 0) { g.pendF[i] += k; gold -= k * SHIP_COST; }
      }
    }
    if (!atwar && gold > inc * 3 + 60) {
      let did = false;
      for (let k = 0; k < 4 && gold > inc * 3 + 60; k++) {
        let bi = -1, bv = 0; for (const i of own) if (g.dev[i] < MAXDEV && !g.devT[i]) { const v = provBase(i) / devCost(i); if (v > bv) { bv = v; bi = i; } }
        if (bi >= 0 && devCost(bi) <= gold * 0.6) { gold -= devCost(bi); g.devT[bi] = DEV_TURNS; did = true; } else break;
      }
      if (did) { /* invested */ }
    }
    g.gold[c] = gold;
  }
  // --- movement
  const av = new Map(); for (const i of own) { const a = movesOnly ? availAt(i) : g.army[i]; if (a > 0) av.set(i, a); }
  const order = (from, to, n) => { n = Math.floor(n); if (n > 0) { g.orders.push({ c, from, to, n }); av.set(from, av.get(from) - n); } };
  if (atwar && front.length) {
    const tg = new Map();
    for (const i of front) for (const j of P[i].nb) if (enemies.has(g.owner[j])) { if (!tg.has(j)) tg.set(j, []); tg.get(j).push(i); }
    const list = [...tg.entries()].map(([t, src]) => ({ t, src, d: g.army[t] * defMult(t) - (g.cap[g.owner[t]] === t ? g.army[t] * 0.2 : 0) })).sort((a, b) => a.d - b.d);
    for (const { t, src, d } of list) {
      let sum = 0; for (const s of src) sum += (av.get(s) || 0) * (P[s].isSea.has(t) ? 0.75 : 1);
      const need = d * 1.3 + 60;
      if (sum < need) continue;
      const frac = Math.min(1, Math.max(need * 1.25, sum * 0.6) / sum);
      for (const s of src) { const a = av.get(s) || 0; if (a > 0) order(s, t, a * frac); }
    }
  }
  if (atwar) {   // naval invasions over the long sea lanes
    const used = new Map(); let launched = 0;
    for (const i of own) {
      if (launched >= 2 || g.turn < 3) break;
      const f = g.fleet[i] - (used.get(i) || 0), a = av.get(i) || 0;
      if (!P[i].lane.length || f <= 0 || a < 400) continue;
      const cap = Math.min(a, f * SHIP_CAP); let best = -1, bd = 1e18;
      for (const t of P[i].lane) if (enemies.has(g.owner[t]) && g.fleet[t] < f * 0.8) { const d = g.army[t] * defMult(t); if (cap * 0.75 > d * 1.3 + 60 && d < bd) { bd = d; best = t; } }
      if (best >= 0 && rnd() < 0.5) {
        const n = Math.min(cap, Math.max(Math.ceil(bd * 1.7 / 100) * 100, 400)), ships = Math.max(1, Math.ceil(n / SHIP_CAP));
        g.orders.push({ c, from: i, to: best, n, ships, naval: true }); av.set(i, a - n); used.set(i, (used.get(i) || 0) + ships); launched++;
      }
    }
  }
  const goals = atwar && front.length ? front : border;
  if (goals.length && own.length > goals.length) {
    const dist = new Map(); let fr = goals.slice(); fr.forEach(i => dist.set(i, 0)); let dd = 0;
    while (fr.length) { dd++; const nx = []; for (const i of fr) for (const j of P[i].nb) if (g.owner[j] === c && !dist.has(j)) { dist.set(j, dd); nx.push(j); } fr = nx; }
    for (const i of own) {
      const a = av.get(i) || 0, di = dist.get(i); if (a < 100 || !di) continue;
      let best = -1, bd = di; for (const j of P[i].nb) if (g.owner[j] === c && dist.has(j) && dist.get(j) < bd) { bd = dist.get(j); best = j; }
      if (best >= 0) order(i, best, i === g.cap[c] ? a * 0.6 : a);
    }
  }
}

// ============================================================ turn
function endTurn() {
  if (UI.busy || !G || UI.picking) return;
  const g = G, twoPhase = g.alive[g.player] && !g.over && enemiesOf(g.player).length > 0;
  UI.move = null; UI.pickFrom = -1; UI.pickNaval = -1; cv.classList.remove('aim');
  if (g.phase !== 1) {
    pendingEvents = []; tally = { won: 0, lost: 0 };
    resolveMoves();   // your armies move and fight
    if (twoPhase) {   // at war the enemy now waits: do what you like, then press End turn to let it answer
      g.phase = 1; updateMarches(); mapDirty = true; save(); refresh();
      toast('Your moves are carried out. Now the enemy moves when you press End turn. Recruit, build or talk first.');
      if (tally.won || tally.lost) toast(`${tally.won ? tally.won + (tally.won > 1 ? ' provinces' : ' province') + ' captured' : ''}${tally.won && tally.lost ? ', ' : ''}${tally.lost ? tally.lost + (tally.lost > 1 ? ' provinces' : ' province') + ' lost' : ''}.`);
      return;
    }
  } else { pendingEvents = []; tally = { won: 0, lost: 0 }; }
  UI.busy = true; g.phase = 0;
  enemyMoves(g);
}
function enemyMoves(g) {
  if (G !== g) return;   // the game was replaced meanwhile
  const lists = Array.from({ length: NC }, () => []);
  for (let i = 0; i < NP; i++) lists[g.owner[i]].push(i);
  const seq = []; for (let c = 0; c < NC; c++) if (g.alive[c] && c !== g.player) seq.push(c);
  seq.sort(() => rnd() - 0.5);
  if (!g.tut) for (const c of seq) if (g.alive[c]) aiTurn(c, lists[c].filter(i => g.owner[i] === c));   // the tutorial world stands still
  resolveMoves(); updateMarches();
  for (let i = 0; i < NP; i++) { if (g.pend[i]) { g.army[i] += g.pend[i]; g.pend[i] = 0; } if (g.pendF[i]) { g.fleet[i] += g.pendF[i]; g.pendF[i] = 0; } g.recd[i] = 0; }
  // economy
  const inc = new Float64Array(NC), arm = new Float64Array(NC);
  for (let i = 0; i < NP; i++) { const o = g.owner[i]; inc[o] += provInc(i); arm[o] += g.army[i] + g.fleet[i] * SHIP_UPKEEP * 1000; g.pop[i] *= 1.0012; if (g.stab[i] < 100) g.stab[i] = Math.min(100, g.stab[i] + 6); }
  for (let c = 0; c < NC; c++) {
    if (!g.alive[c]) continue;
    g.gold[c] += inc[c] - arm[c] / 1000;
    if (g.gold[c] < 0) {
      for (let i = 0; i < NP; i++) if (g.owner[i] === c) { g.army[i] = Math.floor(g.army[i] * 0.9); g.fleet[i] = Math.floor(g.fleet[i] * 0.9); }
      if (c === g.player) note('The treasury is empty. A tenth of your soldiers and ships deserted.', 'war');
      g.gold[c] = Math.max(g.gold[c], -inc[c]);
    }
  }
  for (let i = 0; i < NP; i++) if (g.devT[i] > 0 && --g.devT[i] === 0) g.dev[i]++;   // development finished
  for (const [k, v] of [...g.truces]) { if (v <= 1) g.truces.delete(k); else g.truces.set(k, v - 1); }
  // slow drift of relations
  for (let n = 0; n < 60; n++) { const a = ri_(0, NC - 1), b = ri_(0, NC - 1); if (a !== b && g.alive[a] && g.alive[b] && !atWar(a, b)) { const v = relOf(a, b); addRel(a, b, ri_(-3, 3) + (allied(a, b) ? 1 : 0) - Math.sign(v) * (Math.abs(v) > 60 && !allied(a, b) ? 1 : 0)); } }
  if (g.alive[g.player]) g.dp = clamp(g.dp + dpIncome(g.player) - dpUpkeep(g.player), 0, DP_MAX);
  g.turn++;
  if (g.player >= 0 && !g.alive[g.player]) { g.over = true; }
  if (g.player >= 0 && g.alive[g.player]) { g.mp = maxMP(g.player); if (countOf(g.player) === NP) { g.over = true; g.won = true; } }
  if (UI.sel >= 0 && g.player >= 0 && !g.alive[g.player]) UI.sel = -1;
  planMarches();
  mapDirty = true; save();
  UI.busy = false;
  refresh();
  if (g.over && !g.spectate) return showEnd();
  if (tally.won || tally.lost) toast(`Turn ${g.turn - 1}: ${tally.won ? tally.won + (tally.won > 1 ? ' provinces' : ' province') + ' captured' : ''}${tally.won && tally.lost ? ', ' : ''}${tally.lost ? tally.lost + (tally.lost > 1 ? ' provinces' : ' province') + ' lost' : ''}.`);
  nextEvent();
}
function nextEvent() {
  const ev = pendingEvents.shift(); if (!ev) return;
  const pl = G.player;
  if (ev.type === 'peaceoffer') {
    if (!atWar(ev.from, pl) || !G.alive[ev.from]) return nextEvent();
    const d = ev.deal;
    modal(`${CN[ev.from].name} offers peace`, `<p>Envoys from <b>${cname(ev.from)}</b> propose to end the war. Each side keeps the provinces it holds, and a truce of 10 turns follows.</p>${d ? `<p>To win your agreement they offer: ${dealText(d)}.</p>` : ''}`,
      [['Refuse', '', () => nextEvent()], ['Accept peace', 'brass', () => { if (atWar(pl, ev.from)) { if (d) applyDeal(d); makePeace(pl, ev.from); } refresh(); nextEvent(); }]]);
  } else if (ev.type === 'peacedemand') {
    if (!atWar(ev.from, pl) || !G.alive[ev.from]) return nextEvent();
    modal(`${CN[ev.from].name} demands terms`, `<p><b>${cname(ev.from)}</b> is winning the war and will make peace only if you hand over: ${dealText(ev.deal)}.</p><p>If you refuse, the war goes on.</p>`,
      [['Refuse', '', () => nextEvent()], ['Accept terms', 'brass war', () => { if (atWar(pl, ev.from)) { applyDeal(ev.deal); makePeace(pl, ev.from); } refresh(); nextEvent(); }]]);
  } else if (ev.type === 'wardecl') {
    if (!atWar(ev.from, pl)) return nextEvent();
    modal(`${CN[ev.from].name} declares war!`, `<p><b>${cname(ev.from)}</b> has declared war on you. Their army: <b>${armyTxt(ev.from)}</b>. Check your borders${fleetOf(ev.from) ? ' and your coast: they have ships' : ''}.</p>`,
      [['Understood', 'brass war', () => nextEvent()]]);
  } else if (ev.type === 'allyoffer') {
    if (allied(ev.from, pl) || atWar(ev.from, pl) || !G.alive[ev.from]) return nextEvent();
    modal(`${CN[ev.from].name} proposes an alliance`, `<p><b>${cname(ev.from)}</b> wants a defensive alliance. Allies are called to help when one of them is attacked.</p>`,
      [['Decline', '', () => nextEvent()], ['Sign alliance', 'brass', () => { formAlliance(pl, ev.from); refresh(); nextEvent(); }]]);
  } else if (ev.type === 'allycall') {
    if (!allied(ev.ally, pl) || atWar(pl, ev.foe) || !G.alive[ev.foe] || !G.alive[ev.ally]) return nextEvent();
    modal(`${CN[ev.ally].name} calls for help`, `<p><b>${cname(ev.foe)}</b> has declared war on your ally <b>${cname(ev.ally)}</b>. Refusing ends the alliance.</p>`,
      [['Stay out', '', () => { breakAlliance(pl, ev.ally); refresh(); nextEvent(); }], ['Join the war', 'brass war', () => { joinWar(pl, ev.foe, ev.ally); refresh(); nextEvent(); }]]);
  } else nextEvent();
}
function showEnd() {
  if (G.won) modal('The world is yours', `<p>Every province on the map flies the flag of <b>${cname(G.player)}</b>. It took ${G.turn - 1} turns.</p>`, [['New game', 'brass', toStart]]);
  else modal('Your nation has fallen', `<p><b>${cname(G.player)}</b> has lost its last province after ${G.turn - 1} turns.</p>`, [['Keep watching', '', () => { G.spectate = true; refresh(); }], ['New game', 'brass', toStart]]);
}

// ============================================================ save / load
// Two save slots. The game saves itself into the slot it was started in (or last saved to) at the start of every turn.
const SLOTS = 2, KEY = 'borders-crowns-save-v2-slot';
const slotKey = s => KEY + (s + 1);
function readSlot(s) { try { const t = localStorage.getItem(slotKey(s)); const v = t ? JSON.parse(t) : null; return v && v.v === 2 && v.np === NP && v.nc === NC ? v : null; } catch (e) { return null; } }
function saveTo(s) { try { localStorage.setItem(slotKey(s), JSON.stringify(serialize())); return true; } catch (e) { return false; } }
function clearSlot(s) { try { localStorage.removeItem(slotKey(s)); } catch (e) { /* storage may be unavailable */ } }
function save() { if (G && G.slot >= 0) saveTo(G.slot); }
const slotText = s => { const v = readSlot(s); return v ? `${CN[v.player].name}, turn ${v.turn}` : 'empty'; };
function serialize() {
  const g = G;
  return { v: 2, np: NP, nc: NC, slot: g.slot, turn: g.turn, player: g.player, mp: g.mp, over: g.over, won: g.won, spectate: !!g.spectate,
    owner: Array.from(g.owner), army: Array.from(g.army), fleet: Array.from(g.fleet), pendF: Array.from(g.pendF), dev: Array.from(g.dev), devT: Array.from(g.devT), stab: Array.from(g.stab),
    pop: Array.from(g.pop, v => +v.toFixed(4)), pend: Array.from(g.pend), recd: Array.from(g.recd), gold: Array.from(g.gold, v => +v.toFixed(2)), alive: Array.from(g.alive), cap: Array.from(g.cap),
    aggr: Array.from(g.aggr, v => +v.toFixed(3)), prov0: Array.from(g.prov0), rel: Array.from(g.rel), wars: [...g.wars], allies: [...g.allies], truces: [...g.truces], orders: g.orders, log: g.log.slice(-40), marches: g.marches, mid: g.mid, dp: g.dp, phase: g.phase, lostCap: Array.from(g.lostCap) };
}
function restore(s, slot) {
  if (!s || s.v !== 2 || s.np !== NP || s.nc !== NC) return false;
  lastDemand.clear();
  G = { turn: s.turn, player: s.player, mp: s.mp, over: s.over, won: s.won, spectate: s.spectate, slot: slot != null ? slot : (s.slot >= 0 ? s.slot : 0),
    owner: Int16Array.from(s.owner), army: Int32Array.from(s.army), fleet: s.fleet ? Int16Array.from(s.fleet) : new Int16Array(NP), pendF: s.pendF ? Int16Array.from(s.pendF) : new Int16Array(NP), dev: Uint8Array.from(s.dev), devT: s.devT ? Uint8Array.from(s.devT) : new Uint8Array(NP), stab: Uint8Array.from(s.stab),
    pop: Float32Array.from(s.pop), pend: Int32Array.from(s.pend), recd: Int32Array.from(s.recd), gold: Float64Array.from(s.gold), alive: Uint8Array.from(s.alive), cap: Int16Array.from(s.cap),
    aggr: Float32Array.from(s.aggr), prov0: Int16Array.from(s.prov0), rel: Int8Array.from(s.rel), wars: new Map(s.wars), allies: new Set(s.allies), truces: new Map(s.truces), orders: s.orders || [], log: s.log || [], marches: s.marches || [], mid: s.mid || 1, dp: s.dp != null ? s.dp : 1, phase: s.phase || 0, lostCap: s.lostCap ? Uint8Array.from(s.lostCap) : new Uint8Array(NC) };
  return true;
}

// ============================================================ map view
const cv = $('map'), ctx = cv.getContext('2d');
const base = document.createElement('canvas'), bctx = base.getContext('2d');
const hitCtx = document.createElement('canvas').getContext('2d');
let cw = 0, ch = 0, dpr = 1, minS = 0.3;
const view = { x: W / 2, y: H / 2, s: 0.5 };
let baseTime = 0, baseView = null, mapDirty = true, needDraw = true, interacting = 0, idleTimer = 0, labelCache = null;
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2); cw = cv.clientWidth; ch = cv.clientHeight;
  cv.width = base.width = Math.round(cw * dpr); cv.height = base.height = Math.round(ch * dpr);
  minS = Math.min(cw / W, ch / H) * 0.96; clampView(); baseView = null; needDraw = true;
}
function clampView() {
  view.s = clamp(view.s, minS, 14);
  const hw = cw / 2 / view.s, hh = ch / 2 / view.s;
  view.x = hw >= W / 2 ? W / 2 : clamp(view.x, hw - 40, W - hw + 40);
  view.y = hh >= H / 2 ? H / 2 : clamp(view.y, hh - 40, H - hh + 40);
}
const toWorld = (sx, sy) => [(sx - cw / 2) / view.s + view.x, (sy - ch / 2) / view.s + view.y];
function setT(c, v) { c.setTransform(dpr * v.s, 0, 0, dpr * v.s, dpr * (cw / 2 - v.x * v.s), dpr * (ch / 2 - v.y * v.s)); }
function provAt(wx, wy) {
  for (const r of RG) {
    if (wx < r.x0 || wx > r.x1 || wy < r.y0 || wy > r.y1) continue;
    if (!hitCtx.isPointInPath(r.path, wx, wy, 'evenodd')) continue;
    let best = -1, bd = 1e18; for (const i of r.provs) { const d = (P[i].sx - wx) ** 2 + (P[i].sy - wy) ** 2; if (d < bd) { bd = d; best = i; } }
    return best;
  }
  return -1;
}
function mix(hex, t, to) { const n = parseInt(hex.slice(1), 16), r = n >> 16, g = n >> 8 & 255, b = n & 255; return `rgb(${Math.round(r + (to[0] - r) * t)},${Math.round(g + (to[1] - g) * t)},${Math.round(b + (to[2] - b) * t)})`; }
function ramp(t, a, b) { t = clamp(t, 0, 1); return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`; }
function colorOf(i) {
  const o = G ? G.owner[i] : P[i].home;
  if (UI.picking) return o === UI.pick ? CN[o].color : mix(CN[o].color, 0.45, [22, 30, 42]);
  switch (UI.mode) {
    case 'dip': {
      const pl = G.player; if (pl < 0 || !G.alive[pl]) return CN[o].color;
      if (o === pl) return '#d9a441'; if (atWar(o, pl)) return '#5c0f0a'; if (allied(o, pl)) return '#173f80';
      const v = relOf(o, pl); return v < 0 ? ramp(-v / 100, [212, 210, 202], [150, 46, 34]) : ramp(v / 100, [212, 210, 202], [20, 100, 58]);
    }
    case 'pop': return ramp(Math.log10(G.pop[i] * 1e6 / P[i].area + 0.5) / 2.9, [238, 228, 204], [56, 22, 8]);
    case 'inc': return ramp(Math.log10(provInc(i) + 1) / 2.4, [226, 238, 228], [6, 56, 42]);
    default: return CN[o].color;
  }
}
function renderBase() {
  const c = bctx, v = view;
  c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = '#0a0e14'; c.fillRect(0, 0, base.width, base.height);
  setT(c, v);
  const x0 = v.x - cw / 2 / v.s, x1 = v.x + cw / 2 / v.s, y0 = v.y - ch / 2 / v.s, y1 = v.y + ch / 2 / v.s;
  // graticule
  c.strokeStyle = '#18222f'; c.lineWidth = 1 / v.s; c.beginPath();
  for (let lon = -180; lon <= 180; lon += 15) { const x = (lon + 180) / 360 * W; c.moveTo(x, 0); c.lineTo(x, H); }
  for (let lat = -45; lat <= 75; lat += 15) { const y = (YT - 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * lat * Math.PI / 180))) * W / (2 * Math.PI); c.moveTo(0, y); c.lineTo(W, y); }
  c.stroke();
  const own = G ? G.owner : null;
  for (const r of RG) {
    if (r.x1 < x0 || r.x0 > x1 || r.y1 < y0 || r.y0 > y1) continue;
    let uniform = true; const c0 = colorOf(r.provs[0]);
    for (let k = 1; k < r.provs.length && uniform; k++) if (colorOf(r.provs[k]) !== c0) uniform = false;
    if (uniform) { c.fillStyle = c0; c.fill(r.path, 'evenodd'); }
    if (r.provs.length > 1) {
      c.save(); c.clip(r.path, 'evenodd');
      if (!uniform) { c.lineWidth = 1 / v.s; for (const i of r.provs) { c.fillStyle = c.strokeStyle = colorOf(i); c.fill(P[i].path); c.stroke(P[i].path); } }
      if (v.s > 0.55) { c.beginPath(); for (const e of r.edges) if (!own || own[e[4]] === own[e[5]]) { c.moveTo(e[0], e[1]); c.lineTo(e[2], e[3]); } c.strokeStyle = 'rgba(8,10,14,.30)'; c.lineWidth = 0.8 / v.s; c.stroke(); }
      if (own) { c.beginPath(); let any = false; for (const e of r.edges) if (own[e[4]] !== own[e[5]]) { c.moveTo(e[0], e[1]); c.lineTo(e[2], e[3]); any = true; } if (any) { c.strokeStyle = 'rgba(8,10,14,.9)'; c.lineWidth = 1.5 / v.s; c.stroke(); } }
      c.restore();
    }
    c.strokeStyle = 'rgba(8,10,14,.85)'; c.lineWidth = 1.1 / v.s; c.lineJoin = 'round'; c.stroke(r.path);
  }
  baseView = { x: v.x, y: v.y, s: v.s }; mapDirty = false;
}
const YT = 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * 84 * Math.PI / 180));
function computeLabels() {
  const own = G ? G.owner : P.map(p => p.home), seen = new Uint8Array(NP), best = new Map();
  for (let s = 0; s < NP; s++) {
    if (seen[s]) continue; const c = own[s]; const comp = [s]; seen[s] = 1; let area = 0, sx = 0, sy = 0;
    for (let k = 0; k < comp.length; k++) { const i = comp[k], a = P[i].rad * P[i].rad + 4; area += a; sx += P[i].x * a; sy += P[i].y * a; for (const j of P[i].adj) if (!seen[j] && own[j] === c) { seen[j] = 1; comp.push(j); } }
    const capIn = comp.includes(G ? G.cap[c] : CN[c].cap) ? 1 : 0; const b = best.get(c); if (!b || capIn > b.capIn || (capIn === b.capIn && area > b.area)) best.set(c, { area, x: sx / area, y: sy / area, comp, capIn });
  }
  labelCache = [];
  for (const [c, b] of best) {
    let bi = b.comp[0], bd = 1e18; for (const i of b.comp) { const d = (P[i].x - b.x) ** 2 + (P[i].y - b.y) ** 2 - P[i].rad * P[i].rad * 0.5; if (d < bd) { bd = d; bi = i; } }
    const x = (P[bi].x + b.x) / 2, y = (P[bi].y + b.y) / 2;
    labelCache.push({ c, x, y, size: Math.sqrt(b.area) * 0.42, text: CN[c].name.toUpperCase() });
  }
  labelCache.sort((a, b) => b.size - a.size);
}
function badgeText(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n); }
function draw() {
  needDraw = false;
  const v = view;
  const nowT = performance.now(); if (!baseView || mapDirty || ((baseView.x !== v.x || baseView.y !== v.y || baseView.s !== v.s) && (!interacting || nowT - baseTime > 350))) { if (mapDirty) labelCache = null; renderBase(); baseTime = performance.now(); }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (baseView.x === v.x && baseView.y === v.y && baseView.s === v.s) ctx.drawImage(base, 0, 0);
  else {
    ctx.fillStyle = '#0a0e14'; ctx.fillRect(0, 0, cv.width, cv.height);
    const k = v.s / baseView.s, ox = dpr * (cw / 2 - (v.x - baseView.x) * v.s) - cv.width / 2 * k, oy = dpr * (ch / 2 - (v.y - baseView.y) * v.s) - cv.height / 2 * k;
    ctx.imageSmoothingEnabled = true; ctx.drawImage(base, ox, oy, cv.width * k, cv.height * k);
  }
  setT(ctx, v);
  const x0 = v.x - cw / 2 / v.s, x1 = v.x + cw / 2 / v.s, y0 = v.y - ch / 2 / v.s, y1 = v.y + ch / 2 / v.s;
  const vis = p => p.x > x0 - 30 && p.x < x1 + 30 && p.y > y0 - 30 && p.y < y1 + 30;
  const now = performance.now(); let anim = false;
  const hi = (i, fill, stroke, lw) => { const r = RG[P[i].r]; ctx.save(); ctx.clip(r.path, 'evenodd'); ctx.clip(P[i].path); if (fill) { ctx.fillStyle = fill; ctx.fill(P[i].path); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2 * lw / v.s; ctx.lineJoin = 'round'; ctx.stroke(P[i].path); ctx.stroke(r.path); } ctx.restore(); };
  if (G && !UI.picking) {
    const pl = G.player;
    // battle flashes
    flashes = flashes.filter(f => now - f.t < 2200);
    for (const f of flashes) { const a = 1 - (now - f.t) / 2200; hi(f.p, f.win ? `rgba(120,220,160,${0.5 * a})` : `rgba(230,90,70,${0.55 * a})`); anim = true; }
    if (UI.sel >= 0) {
      const s = UI.sel, mine = G.owner[s] === pl && !G.over;
      if (mine && availAt(s) > 0) for (const j of P[s].nb) { const o = G.owner[j]; if (o === pl) hi(j, 'rgba(217,164,65,.16)', 'rgba(217,164,65,.75)', 2.4); else if (atWar(o, pl)) hi(j, 'rgba(210,85,63,.28)', 'rgba(240,120,95,.95)', 2.4); }
      const pulse = 0.5 + 0.5 * Math.sin(now / 320); anim = true;
      hi(s, `rgba(255,255,255,${0.10 + 0.08 * pulse})`, '#f4e3b5', 3.2);
      if (mine && availShips(s) > 0) {   // long sea lanes of a port with free ships
        ctx.setLineDash([2 / v.s, 6 / v.s]); ctx.strokeStyle = 'rgba(120,190,255,.5)'; ctx.lineWidth = 1.2 / v.s; ctx.beginPath();
        for (const j of P[s].lane) { ctx.moveTo(P[s].x, P[s].y); ctx.lineTo(P[j].x, P[j].y); } ctx.stroke(); ctx.setLineDash([]);
        if (UI.pickNaval === s) for (const j of P[s].lane) { const o = G.owner[j]; if (o === pl || atWar(o, pl)) hi(j, 'rgba(110,170,240,.22)', 'rgba(140,195,255,.9)', 2.2); }
      }
      // sea routes of the selection
      ctx.setLineDash([5 / v.s, 5 / v.s]); ctx.strokeStyle = 'rgba(190,215,240,.75)'; ctx.lineWidth = 1.4 / v.s; ctx.beginPath();
      for (const j of P[s].sea) { ctx.moveTo(P[s].x, P[s].y); ctx.lineTo(P[j].x, P[j].y); } ctx.stroke(); ctx.setLineDash([]);
    }
    if (v.s > 1.5) { ctx.setLineDash([3 / v.s, 6 / v.s]); ctx.strokeStyle = 'rgba(150,180,210,.28)'; ctx.lineWidth = 1 / v.s; ctx.beginPath(); for (const [a, b] of D.sea) if (vis(P[a]) || vis(P[b])) { ctx.moveTo(P[a].x, P[a].y); ctx.lineTo(P[b].x, P[b].y); } ctx.stroke(); ctx.setLineDash([]); }
  }
  // country names
  if (!labelCache) computeLabels();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const placed = [];
  for (const L of labelCache) {
    if (G && !G.alive[L.c]) continue;
    let fs = L.size * v.s; if (fs < 9) continue; fs = Math.min(fs, 46);
    if (L.x < x0 - 200 || L.x > x1 + 200 || L.y < y0 - 60 || L.y > y1 + 60) continue;
    const sx = (L.x - v.x) * v.s + cw / 2, sy = (L.y - v.y) * v.s + ch / 2;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `400 ${fs}px Marcellus, Georgia, serif`;
    const sp = fs * 0.14, w = ctx.measureText(L.text).width + sp * (L.text.length - 1), h = fs;
    if (placed.some(b => Math.abs(b.x - sx) < (b.w + w) / 2 && Math.abs(b.y - sy) < (b.h + h) / 2)) continue;
    placed.push({ x: sx, y: sy, w, h });
    if ('letterSpacing' in ctx) ctx.letterSpacing = sp + 'px';
    ctx.globalAlpha = clamp(1.05 - v.s * 0.13, 0.4, 0.85); ctx.lineWidth = Math.max(2, fs * 0.16); ctx.strokeStyle = 'rgba(8,10,14,.55)'; ctx.lineJoin = 'round';
    ctx.strokeText(L.text, sx + sp / 2, sy); ctx.fillStyle = '#f3ecd9'; ctx.fillText(L.text, sx + sp / 2, sy);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px'; ctx.globalAlpha = 1;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (G && !UI.picking) {
    const pl = G.player;
    // planned routes
    const line = (path, from, col, wd) => { ctx.strokeStyle = col; ctx.lineWidth = wd; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.setLineDash([2, 7]); ctx.beginPath(); for (let k = from; k < path.length; k++) { const q = P[path[k]], x = (q.x - v.x) * v.s + cw / 2, y = (q.y - v.y) * v.s + ch / 2; if (k === from) ctx.moveTo(x, y); else ctx.lineTo(x, y); } ctx.stroke(); ctx.setLineDash([]); const d = P[path[path.length - 1]], dx = (d.x - v.x) * v.s + cw / 2, dy = (d.y - v.y) * v.s + ch / 2; ctx.beginPath(); ctx.arc(dx, dy, 6, 0, 7); ctx.lineWidth = 2; ctx.stroke(); };
    for (const m of G.marches) if (m.path && m.path.length > 2) line(m.path, 1, 'rgba(240,197,109,.75)', 3);
    if (UI.move && UI.move.path && UI.move.path.length > 2) line(UI.move.path, 0, '#fff3cf', 4);
    // orders
    for (const o of G.orders) {
      if (o.c !== pl) continue;
      const a = P[o.from], b = P[o.to];
      const ax = (a.x - v.x) * v.s + cw / 2, ay = (a.y - v.y) * v.s + ch / 2, bx = (b.x - v.x) * v.s + cw / 2, by = (b.y - v.y) * v.s + ch / 2;
      const ang = Math.atan2(by - ay, bx - ax), L = Math.hypot(bx - ax, by - ay); if (L < 6) continue;
      const ex = bx - Math.cos(ang) * 9, ey = by - Math.sin(ang) * 9, att = G.owner[o.to] !== pl;
      ctx.strokeStyle = o.naval ? '#8fc3f0' : att ? '#f08a70' : '#f0c56d'; ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.setLineDash([8, 6]); ctx.lineDashOffset = -now / 60; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ex, ey); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx - Math.cos(ang - 0.45) * 13, by - Math.sin(ang - 0.45) * 13); ctx.lineTo(bx - Math.cos(ang + 0.45) * 13, by - Math.sin(ang + 0.45) * 13); ctx.closePath(); ctx.fill();
      anim = true;
    }
    // capitals and armies
    ctx.font = '600 12px "Barlow Semi Condensed", "Arial Narrow", sans-serif';
    for (let i = 0; i < NP; i++) {
      const p = P[i]; if (!vis(p)) continue;
      const o = G.owner[i], rpx = p.rad * v.s, mine = o === pl, foe = pl >= 0 && atWar(o, pl);
      const sx = (p.x - v.x) * v.s + cw / 2, sy = (p.y - v.y) * v.s + ch / 2;
      const isCap = G.cap[o] === i && G.alive[o];
      const n = G.army[i];
      const seen = armySeen(i);
      const show = seen && n > 0 && (rpx > 13 || rpx > 6 || i === UI.sel);
      if (isCap && rpx > 5) {
        const cy = show ? sy - 13 : sy; ctx.beginPath();
        for (let k = 0; k < 10; k++) { const rad = k % 2 ? 2.4 : 5.6, an = -Math.PI / 2 + k * Math.PI / 5; ctx.lineTo(sx + Math.cos(an) * rad, cy + Math.sin(an) * rad); }
        ctx.closePath(); ctx.fillStyle = mine ? '#f0c56d' : '#f3ecd9'; ctx.strokeStyle = '#0a0e14'; ctx.lineWidth = 1.2; ctx.stroke(); ctx.fill();
      }
      if ((isCap && rpx > 16) || rpx > 24) {   // city names: capitals sooner, every other province once zoomed in
        ctx.font = (isCap ? '600 12px' : '500 11px') + ' "Barlow Semi Condensed", "Arial Narrow", sans-serif';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,.75)'; ctx.lineJoin = 'round'; const ny = sy + (show ? 17 : 13);
        ctx.strokeText(p.name, sx, ny); ctx.fillStyle = isCap ? '#f3ecd9' : 'rgba(233,227,211,.8)'; ctx.fillText(p.name, sx, ny);
        ctx.font = '600 12px "Barlow Semi Condensed", "Arial Narrow", sans-serif';
      }
      const fl = G.fleet[i];
      if (seen && fl > 0 && (rpx > 9 || i === UI.sel)) {   // fleet badge below the army badge
        const t = String(fl), w = ctx.measureText(t).width + 24, fy = Math.round(show ? sy + 20 : sy), fx = Math.round(sx - w / 2);
        ctx.fillStyle = mine ? '#0f1a26' : foe ? '#3a1712' : 'rgba(12,16,22,.86)'; ctx.strokeStyle = mine ? '#8fc3f0' : foe ? '#e0705a' : 'rgba(233,227,211,.35)'; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.rect(fx + 0.5, fy - 8 + 0.5, Math.round(w), 16); ctx.fill(); ctx.stroke();
        const col = mine ? '#8fc3f0' : foe ? '#f6b3a4' : '#e9e3d3'; ctx.fillStyle = col;
        const ix = fx + 11, iy = fy - 1;
        ctx.beginPath(); ctx.moveTo(ix - 5, iy + 2); ctx.lineTo(ix + 5, iy + 2); ctx.lineTo(ix + 3, iy + 6); ctx.lineTo(ix - 3, iy + 6); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(ix - 0.5, iy - 6); ctx.lineTo(ix - 0.5, iy + 1); ctx.lineTo(ix - 5, iy + 1); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(ix + 0.5, iy - 5); ctx.lineTo(ix + 0.5, iy + 1); ctx.lineTo(ix + 4, iy + 1); ctx.closePath(); ctx.fill();
        ctx.fillText(t, Math.round(sx + 8), fy + 1);
      }
      if (!show) continue;
      const t = badgeText(n), w = ctx.measureText(t).width + 9;
      ctx.fillStyle = mine ? '#1d1608' : foe ? '#3a1712' : 'rgba(12,16,22,.86)';
      ctx.strokeStyle = mine ? '#d9a441' : foe ? '#e0705a' : 'rgba(233,227,211,.35)'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.rect(Math.round(sx - w / 2) + 0.5, Math.round(sy - 8) + 0.5, Math.round(w), 16); ctx.fill(); ctx.stroke();
      ctx.fillStyle = mine ? '#f0c56d' : foe ? '#f6b3a4' : '#e9e3d3'; ctx.fillText(t, Math.round(sx), Math.round(sy) + 1);
    }
  }
  if (T && STEPS[T.i] && STEPS[T.i].ring) {   // tutorial: pulsing rings on the provinces to click
    for (const i of STEPS[T.i].ring()) {
      if (i == null || i < 0) continue; const p = P[i], sx = (p.x - v.x) * v.s + cw / 2, sy = (p.y - v.y) * v.s + ch / 2, ph = (now % 1200) / 1200, r0 = Math.max(13, p.rad * v.s * 0.55);
      ctx.lineWidth = 3; ctx.strokeStyle = '#ffd479'; ctx.beginPath(); ctx.arc(sx, sy, r0, 0, 7); ctx.stroke();
      ctx.lineWidth = 2.5; ctx.strokeStyle = `rgba(255,212,121,${(1 - ph).toFixed(2)})`; ctx.beginPath(); ctx.arc(sx, sy, r0 + ph * 16, 0, 7); ctx.stroke();
    }
    anim = true;
  }
  if (anim) needDraw = true;
}
function loop() { if (needDraw) draw(); requestAnimationFrame(loop); }
function touchView() { clampView(); interacting = 1; clearTimeout(idleTimer); idleTimer = setTimeout(() => { interacting = 0; needDraw = true; }, 90); needDraw = true; }
function flyTo(x, y, s) { const a = { x: view.x, y: view.y, s: view.s }, t0 = performance.now(), red = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; const step = () => { const t = red ? 1 : clamp((performance.now() - t0) / 520, 0, 1), e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; view.x = a.x + (x - a.x) * e; view.y = a.y + (y - a.y) * e; view.s = a.s * Math.pow(s / a.s, e); touchView(); if (t < 1) requestAnimationFrame(step); }; step(); }
function focusCountry(c, zoom) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; const own = G ? G.owner : null; const capP = P[G ? G.cap[c] : CN[c].cap];
  for (let i = 0; i < NP; i++) if ((own ? own[i] : P[i].home) === c && Math.abs(P[i].x - capP.x) < 700 && Math.abs(P[i].y - capP.y) < 500) { x0 = Math.min(x0, P[i].x - P[i].rad); x1 = Math.max(x1, P[i].x + P[i].rad); y0 = Math.min(y0, P[i].y - P[i].rad); y1 = Math.max(y1, P[i].y + P[i].rad); }
  const s = clamp(Math.min(cw / (x1 - x0 + 1), ch / (y1 - y0 + 1)) * (zoom || 0.3), minS, 7);
  flyTo((x0 + x1) / 2, (y0 + y1) / 2, s);
}

// pointer input
const ptrs = new Map(); let dragStart = null, moved = false, pinch = null;
cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY }); if (ptrs.size === 1) { dragStart = { x: e.offsetX, y: e.offsetY, vx: view.x, vy: view.y }; moved = false; } else if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: view.s }; moved = true; } });
cv.addEventListener('pointermove', e => {
  if (!ptrs.has(e.pointerId)) return; ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  if (ptrs.size === 2 && pinch) { const [a, b] = [...ptrs.values()]; const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, w0 = toWorld(mx, my); view.s = clamp(pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d, minS, 14); view.x = w0[0] - (mx - cw / 2) / view.s; view.y = w0[1] - (my - ch / 2) / view.s; touchView(); return; }
  if (!dragStart) return; const dx = e.offsetX - dragStart.x, dy = e.offsetY - dragStart.y;
  if (!moved && Math.hypot(dx, dy) < 5) return; moved = true; cv.classList.add('drag');
  view.x = dragStart.vx - dx / view.s; view.y = dragStart.vy - dy / view.s; touchView();
});
const up = e => { if (!ptrs.has(e.pointerId)) return; ptrs.delete(e.pointerId); cv.classList.remove('drag'); if (ptrs.size < 2) pinch = null; if (ptrs.size === 0) { if (!moved && e.type === 'pointerup' && e.button === 0) { const w = toWorld(e.offsetX, e.offsetY); clickProv(provAt(w[0], w[1])); } dragStart = null; } };
cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
cv.addEventListener('contextmenu', e => { e.preventDefault(); if (!G || UI.picking || UI.busy || G.over) return; const s = UI.sel; if (s < 0 || G.owner[s] !== G.player) return; const w = toWorld(e.offsetX, e.offsetY), i = provAt(w[0], w[1]); if (i >= 0 && i !== s) planMove(s, i); });
cv.addEventListener('wheel', e => { e.preventDefault(); const w0 = toWorld(e.offsetX, e.offsetY); view.s = clamp(view.s * Math.exp(-e.deltaY * 0.0016), minS, 14); view.x = w0[0] - (e.offsetX - cw / 2) / view.s; view.y = w0[1] - (e.offsetY - ch / 2) / view.s; touchView(); }, { passive: false });
window.addEventListener('resize', resize);
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if ($('veil').style.display === 'flex') return;
  if (e.key === 'Escape') { if (UI.pickFrom >= 0 || UI.pickNaval >= 0) { UI.pickFrom = -1; UI.pickNaval = -1; cv.classList.remove('aim'); } else { UI.move = null; UI.sel = -1; } refresh(); }
  if ((e.key === 'Enter' || e.key === ' ') && !UI.picking && e.target.tagName !== 'BUTTON') { e.preventDefault(); endTurn(); }
});

// ============================================================ UI
function toast(msg) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => t.style.display = 'none', 2600); }
function modal(title, body, acts) {
  $('m-title').textContent = title; $('m-body').innerHTML = body; const a = $('m-acts'); a.innerHTML = '';
  (acts || [['Close', 'brass', () => {}]]).forEach(([label, cls, fn]) => { const b = document.createElement('button'); b.className = 'btn ' + cls; b.textContent = label; b.onclick = () => { closeModal(); fn(); }; a.appendChild(b); });
  $('veil').style.display = 'flex'; const f = a.querySelector('.brass') || a.querySelector('button'); if (f) f.focus();
}
function closeModal() { $('veil').style.display = 'none'; }
function clickProv(i) {
  if (UI.picking) { if (i >= 0) setPick(P[i].home); return; }
  if (!G || UI.busy) return;
  if (i < 0) { UI.pickFrom = -1; UI.pickNaval = -1; cv.classList.remove('aim'); UI.sel = -1; UI.move = null; return refresh(); }
  const pl = G.player, s = UI.sel;
  if (UI.pickNaval >= 0) { const f = UI.pickNaval; UI.pickNaval = -1; cv.classList.remove('aim'); if (f !== i) return planNaval(f, i); return refresh(); }
  if (UI.pickFrom >= 0) { const f = UI.pickFrom; UI.pickFrom = -1; cv.classList.remove('aim'); if (f !== i) return planMove(f, i); return refresh(); }
  if (s >= 0 && s !== i && !G.over && G.owner[s] === pl && P[s].nb.includes(i) && availAt(s) > 0 && (G.owner[i] === pl || (atWar(G.owner[i], pl) && G.phase !== 1))) {
    UI.move = { from: s, to: i, dest: i, path: [s, i], n: availAt(s) }; return refresh();
  }
  UI.sel = i; UI.move = null; refresh();
}
function planNaval(f, i) {
  const pl = G.player, o = G.owner[i];
  if (G.phase === 1) { toast('Enemy phase: your armies wait. Press End turn.'); return refresh(); }
  if (G.over || G.owner[f] !== pl) return refresh();
  if (!P[f].isLane.has(i)) { toast('That coast is out of reach of this port.'); return refresh(); }
  if (o !== pl && !atWar(o, pl)) { toast('Ships can only sail to your own land or a nation you are at war with.'); return refresh(); }
  const ships = availShips(f); if (ships <= 0) { toast('No free ships in this port.'); return refresh(); }
  UI.sel = f; UI.move = { naval: true, from: f, to: i, dest: i, path: [f, i], ships: Math.min(ships, Math.max(1, Math.ceil(availAt(f) / SHIP_CAP))), n: Math.min(availAt(f), ships * SHIP_CAP) }; refresh();
}
function planMove(f, i) {
  const pl = G.player; if (G.over || G.owner[f] !== pl || availAt(f) <= 0) return refresh();
  const o = G.owner[i];
  if (o !== pl && !atWar(o, pl)) { toast('Armies can only march into your own land or a nation you are at war with.'); return refresh(); }
  if (G.phase === 1 && o !== pl) { toast('Enemy phase: your armies can move only inside your own land.'); return refresh(); }
  if (G.phase !== 1 && P[f].isLane.has(i) && availShips(f) > 0) return planNaval(f, i);   // across open water: by ship
  const path = ownPath(f, i) || (G.phase === 1 ? null : pathTo(f, i, pl));
  if (!path) { toast(G.phase === 1 ? 'There is no route through your own land.' : 'There is no route through your land or enemy land.'); return refresh(); }
  UI.sel = f; UI.move = { from: f, to: path[1], dest: i, path, n: availAt(f) }; refresh();
}
function openPeace(o) {
  const pl = G.player, st = { mode: 'white', prov: new Set(), gold: 0 };
  const near = (i, who) => P[i].nb.some(j => G.owner[j] === who);
  const ask = ownedBy(o).filter(i => G.cap[o] !== i).sort((a, b) => (near(b, pl) - near(a, pl)) || provValue(b) - provValue(a)).slice(0, 16);
  const give = ownedBy(pl).filter(i => G.cap[pl] !== i && near(i, o)).sort((a, b) => provValue(b) - provValue(a)).slice(0, 16);
  const dealOf = () => {
    const giver = st.mode === 'ask' ? o : pl, taker = giver === o ? pl : o;
    return st.mode === 'white' ? { giver, taker, prov: [], gold: 0 } : { giver, taker, prov: [...st.prov], gold: Math.min(st.gold, Math.floor(Math.max(0, G.gold[giver]))) };
  };
  const verdict = () => { const j = judgeDeal(dealOf(), o, pl); $('pt-verdict').innerHTML = `<b style="color:${j.ok ? 'var(--peace)' : 'var(--war)'}">${j.ok ? 'They would accept.' : 'They would refuse.'}</b> ${esc(j.why)}`; };
  const terms = () => {
    const el = $('pt-terms'); if (st.mode === 'white') { el.innerHTML = ''; return verdict(); }
    const askMode = st.mode === 'ask', list = askMode ? ask : give;
    const maxG = askMode ? Math.round(incomeOf(o) * 2) * 10 : Math.floor(Math.max(0, G.gold[pl]) / 10) * 10;
    el.innerHTML = `<h4>${askMode ? 'Provinces they give you' : 'Provinces you give them'}</h4>` + (list.length ? list.map(i => `<label class="chk"><input type="checkbox" data-p="${i}"> ${esc(P[i].name)} <span class="num" style="color:var(--dim)">· income ${provInc(i).toFixed(1)}</span></label>`).join('') : '<p class="hint">No border provinces to trade.</p>')
      + `<h4>${askMode ? 'Gold they pay you' : 'Gold you pay them'}</h4><div class="row"><input type="range" id="pt-gold" min="0" max="${maxG}" step="10" value="0" aria-label="Gold"><b class="num" id="pt-goldn">0</b></div>`;
    el.querySelectorAll('input[data-p]').forEach(cb => cb.onchange = () => { const i = +cb.dataset.p; if (cb.checked) st.prov.add(i); else st.prov.delete(i); verdict(); });
    const gs = $('pt-gold'); gs.oninput = () => { st.gold = +gs.value; $('pt-goldn').textContent = fmt(st.gold); verdict(); };
    verdict();
  };
  modal(`Peace with ${CN[o].name}`, `<p>Set the terms of peace with <b>${cname(o)}</b>. A truce of 10 turns follows. The capital cannot be traded.</p>
    <div class="row"><select id="pt-mode" aria-label="Kind of peace"><option value="white">White peace: no terms</option><option value="ask">I demand terms</option><option value="give">I offer terms</option></select></div>
    <div id="pt-terms"></div><p class="hint" id="pt-verdict"></p>`,
    [['Cancel', '', () => {}], ['Propose peace · 2 actions', 'brass', () => {
      if (!atWar(pl, o) || !spend(2)) return;
      const d = dealOf(), j = judgeDeal(d, o, pl);
      if (j.ok) { applyDeal(d); makePeace(pl, o); toast(`${CN[o].name} accepted peace.`); if (d.prov.length || d.gold > 0) note(`Peace terms: <b>${cname(d.giver)}</b> gave ${dealText(d)} to <b>${cname(d.taker)}</b>.`, 'me'); }
      else { toast(`${CN[o].name} refused: ${j.why}`); note(`${cname(o)} refused your peace terms.`, 'me'); }
      mapDirty = true; refresh();
    }]]);
  $('pt-mode').onchange = e => { st.mode = e.target.value; st.prov.clear(); st.gold = 0; terms(); };
  terms();
}
function statusOf(c) {
  const pl = G.player;
  if (atWar(c, pl)) return '<span class="pill war">At war</span>';
  if (allied(c, pl)) return '<span class="pill ally">Allied</span>';
  const t = G.truces.get(pk(c, pl)); if (t) return `<span class="pill truce">Truce, ${t} turns</span>`;
  return '<span class="pill peace">At peace</span>';
}
function oddsText(from, to, n) {
  const d = G.army[to] * defMult(to), a = n * (P[from].isSea.has(to) || P[from].isLane.has(to) ? 0.75 : 1);
  if (G.army[to] <= 0) return 'Undefended';
  const r = a / d; return r > 1.5 ? 'Odds: strong' : r > 1.12 ? 'Odds: good' : r > 0.9 ? 'Odds: even' : 'Odds: poor';
}
function navalOdds(m) {
  const to = m.to, att = G.owner[to] !== G.player;
  let t = `${m.ships} ${m.ships > 1 ? 'ships carry' : 'ship carries'} up to ${fmt(m.ships * SHIP_CAP)} soldiers. The fleet sails home after the landing.`;
  if (!att) return t;
  const D = G.fleet[to];
  if (D > 0) t += ` Enemy fleet in port: ${D} ${D > 1 ? 'ships' : 'ship'}. ${m.ships > D * 1.1 ? 'Sea battle: good odds.' : m.ships > D * 0.9 ? 'Sea battle: even.' : 'Sea battle: poor odds. A lost sea battle sinks the transports.'}`;
  t += m.n > 0 ? ` ${oddsText(m.from, to, m.n)} · sea landing, attack −25% · defenders ${fmt(G.army[to])}` : ' With no soldiers the fleet only raids the port.';
  return t;
}
function navalBlock(i, av) {
  const m = UI.move, fa = Math.max(1, availShips(i)), att = G.owner[m.to] !== G.player;
  m.ships = clamp(m.ships, 1, fa); const mx = Math.min(av, m.ships * SHIP_CAP); m.n = clamp(m.n, 0, mx);
  return `<div class="sect"><h4>${att ? 'Naval invasion of ' : 'Sail to '}${esc(P[m.to].name)}</h4>
    <div class="row"><small style="width:62px;color:var(--dim)">Ships</small><input type="range" id="nsh" min="1" max="${fa}" value="${m.ships}" aria-label="Ships to send"><b class="num" id="nshn">${m.ships}</b></div>
    <div class="row"><small style="width:62px;color:var(--dim)">Soldiers</small><input type="range" id="nmv" min="0" max="${mx}" step="${mx > 2000 ? 100 : 1}" value="${m.n}" aria-label="Soldiers to carry"><b class="num" id="nmvn">${fmt(m.n)}</b></div>
    <p class="hint" id="mvo">${navalOdds(m)}</p>
    <div class="row"><button class="btn brass" data-a="nvok">${att ? 'Order invasion' : 'Order voyage'} (1 action)</button><button class="btn" data-a="mvno">Cancel</button></div></div>`;
}
function fleetCell(i, mine) {
  if (!P[i].port) return '';
  return `<div><small>Fleet</small><b>${armySeen(i) ? fmt(G.fleet[i]) + (mine && G.pendF[i] ? ` <span style="color:var(--peace);font-size:13px">+${G.pendF[i]}</span>` : '') : '?'}</b></div>`;
}
function shipSection(i) {
  if (!P[i].port) return '';
  const room = Math.min(SHIP_BUY, SHIP_MAX - G.fleet[i] - G.pendF[i], Math.floor(Math.max(0, G.gold[G.player]) / SHIP_COST));
  let h = `<div class="sect"><h4>Fleet</h4>`;
  if (room >= 1) h += `<div class="row"><input type="range" id="sh" min="1" max="${room}" value="${Math.min(room, 2)}" aria-label="Ships to build"><b class="num" id="shn"></b></div><div class="row"><button class="btn" data-a="shok" id="shb"></button></div><p class="hint">A ship carries ${SHIP_CAP} soldiers over the long sea lanes and costs ${SHIP_UPKEEP} gold per turn.</p>`;
  else h += `<p class="hint">${G.fleet[i] + G.pendF[i] >= SHIP_MAX ? 'This port holds as many ships as it can.' : `Not enough gold. A ship costs ${SHIP_COST} gold.`}</p>`;
  return h + '</div>';
}
function renderPanel() {
  const el = $('panel');
  if (!G || UI.picking || UI.sel < 0) { el.style.display = 'none'; return; }
  const i = UI.sel, p = P[i], o = G.owner[i], pl = G.player, mine = o === pl && !G.over, can = !G.over;
  let h = `<button class="x" data-a="close" style="float:right;font-size:22px;line-height:1" aria-label="Close panel">×</button><h3>${esc(p.name)}${G.cap[o] === i ? ' ★' : ''}</h3><div class="sub"><span class="chip" style="background:${CN[o].color}"></span>${cname(o)}${G.cap[o] === i ? ' · capital' : ''}${o !== p.home ? ' · taken from ' + cname(p.home) : ''}</div>`;
  h += `<div class="grid num"><div><small>Army</small><b>${armySeen(i) ? fmt(G.army[i]) : '?'}${G.pend[i] && mine ?` <span style="color:var(--peace);font-size:13px">+${fmt(G.pend[i])}</span>` : ''}</b></div><div><small>Population</small><b>${fpop(G.pop[i])}</b></div>
    <div><small>Income</small><b>${provInc(i).toFixed(1)}</b></div><div><small>Stability</small><b>${G.stab[i]}%</b></div>
    <div><small>Defence</small><b>+${Math.round((defMult(i) - 1) * 100)}%</b></div><div><small>Development</small><b>${G.dev[i]} / ${MAXDEV}</b></div>${fleetCell(i, mine)}</div>`;
  if (mine) {
    const av = availAt(i);
    if (UI.move && UI.move.from === i && UI.move.naval) h += navalBlock(i, av);
    else if (UI.move && UI.move.from === i) {
      const m = UI.move, att = G.owner[m.to] !== pl, far = m.path && m.path.length > 2, turns = far ? m.path.length - 1 : 1; m.n = clamp(m.n, 1, av);
      h += `<div class="sect">${G.phase === 1 ? '<p class="hint" style="margin:0 0 6px">Enemy phase: this move happens right now.</p>' : ''}<h4>${far ? 'March to ' + esc(P[m.dest].name) : (att ? 'Attack ' : 'Move to ') + esc(P[m.to].name)}</h4>
        <div class="row"><input type="range" id="mv" min="1" max="${av}" step="${av > 2000 ? 100 : 1}" value="${m.n}" aria-label="Soldiers to send"><b class="num" id="mvn">${fmt(m.n)}</b></div>
        <p class="hint" id="mvo">${instantOK(m.from, m.dest) ? 'Your army joins the front line at once.' : far ? `${turns} turns by the shortest route. The army moves one province each turn on its own${G.owner[m.dest] !== pl ? ' and attacks what stands in its way' : ''}.` : att ? oddsText(i, m.to, m.n) + (P[i].isSea.has(m.to) ? ' · sea landing, attack −25%' : '') + ' · defenders ' + fmt(G.army[m.to]) : 'Arrives at the end of the turn.'}</p>
        <div class="row"><button class="btn brass" data-a="mvok">${instantOK(m.from, m.dest) ? 'Move now' : far ? 'Order march' : att ? 'Order attack' : 'Order move'} (1 action)</button><button class="btn" data-a="mvno">Cancel</button></div></div>`;
    } else {
      h += `<p class="hint">${G.phase === 1 ? 'Enemy phase: you can still recruit and reinforce the front line from next door, at once. Other moves go one province per turn. Attacks wait for your next move. Press End turn to let the enemy move.' : UI.pickFrom === i ? 'Now click the destination province on the map.' : av > 0 ? `${fmt(av)} soldiers free. Click a highlighted neighbour, or right-click any province to march there.` : 'No free soldiers here.'}</p>
        <div class="row"><button class="btn sm" data-a="march" ${av > 0 ? '' : 'disabled'}>March to a distant province</button><button class="btn sm" data-a="gather">Gather all armies here · 2 actions</button></div>${P[i].lane.length ? `<div class="row"><button class="btn sm" data-a="naval" ${availShips(i) > 0 && G.phase !== 1 ? '' : 'disabled'}>Naval invasion · ${availShips(i)} ${availShips(i) === 1 ? 'ship' : 'ships'} free</button></div>` : ''}`;
    }
    const rm = Math.min(recruitMax(i), Math.floor(Math.max(0, G.gold[pl]) * 100 / 100) * 100);
    h += `<div class="sect"><h4>Recruit</h4>`;
    if (rm >= 100) h += `<div class="row"><input type="range" id="rc" min="100" max="${rm}" step="100" value="${Math.min(rm, Math.max(100, Math.floor(rm / 2 / 100) * 100))}" aria-label="Soldiers to recruit"><b class="num" id="rcn"></b></div><div class="row"><button class="btn" data-a="rcok" id="rcb"></button></div>`;
    else h += `<p class="hint">${recruitMax(i) < 100 ? 'No more recruits available here this turn.' : 'Not enough gold. 100 soldiers cost 1 gold.'}</p>`;
    h += `</div><div class="sect"><h4>Develop</h4><div class="row">
      <button class="btn sm" data-a="dev" ${!canDev(i) || G.gold[pl] < devCost(i) ? 'disabled' : ''}>${G.dev[i] >= MAXDEV ? 'Fully developed' : G.devT[i] ? `Developing · ${G.devT[i]} ${G.devT[i] > 1 ? 'turns' : 'turn'} left` : `Develop +20% income · ${devCost(i)} gold`}</button></div><p class="hint">${G.devT[i] ? 'The income grows a little every turn until the work is done.' : 'The extra income arrives gradually over ' + DEV_TURNS + ' turns. One development at a time.'}</p></div>`;
    h += shipSection(i);
  } else if (pl >= 0 && G.alive[pl] && o !== pl) {
    const v = relOf(o, pl), w = atWar(o, pl), al = allied(o, pl), tr = G.truces.get(pk(o, pl));
    h += `<div class="sect"><h4>${cname(o)}</h4><div class="row">${statusOf(o)}<span class="num">Relations ${v > 0 ? '+' : ''}${v}</span></div>
      <div class="relbar"><i style="left:${(v + 100) / 2}%"></i></div>
      <div class="grid num"><div><small>Army</small><b>${armyTxt(o)}</b></div><div><small>Provinces</small><b>${countOf(o)}</b></div><div><small>Income</small><b>${incomeOf(o).toFixed(0)}</b></div><div><small>Allies</small><b>${alliesOf(o).length}</b></div></div>`;
    if (can) {
      h += `<div class="row">`;
      if (w) h += `<button class="btn" data-a="peace">Peace talks · 2 actions</button>`;
      else {
        h += `<button class="btn sm" data-a="gift" ${G.dp < 1 ? 'disabled' : ''}>Improve relations · 1 diplomacy point</button>`;
        if (al) h += `<button class="btn sm" data-a="unally">End alliance</button>`;
        else { h += `<button class="btn sm" data-a="ally">Propose alliance</button>`; h += `<button class="btn sm war" data-a="war" ${tr ? 'disabled' : ''}>Declare war</button>`; }
      }
      h += `</div>${tr && !w ? '<p class="hint">A truce forbids war for now.</p>' : ''}`;
    }
    h += `</div>`;
  }
  const mineOrders = G.orders.filter(q => q.c === pl);
  if (mineOrders.length && !G.over) {
    h += `<div class="sect"><h4>Orders this turn (${mineOrders.length})</h4><ul class="orders num">`;
    mineOrders.forEach(q => { h += `<li><span>${fmt(q.n)} · ${esc(P[q.from].name)} → ${esc(P[q.to].name)}${q.m ? ' <span style="color:var(--dim)">(march)</span>' : ''}${q.naval ? ` <span style="color:var(--dim)">(naval, ${q.ships} ${q.ships > 1 ? 'ships' : 'ship'})</span>` : ''}</span><button class="x" data-a="del" data-k="${G.orders.indexOf(q)}" aria-label="Cancel order">×</button></li>`; });
    h += `</ul></div>`;
  }
  if (G.marches.length && !G.over) {
    h += `<div class="sect"><h4>Marches under way (${G.marches.length})</h4><ul class="orders num">`;
    G.marches.forEach(q => { h += `<li><span>${fmt(q.n)} → ${esc(P[q.dest].name)} · ${Math.max(1, q.path.length - 1)} ${q.path.length - 1 > 1 ? 'turns' : 'turn'} left</span><button class="x" data-a="mdel" data-k="${q.id}" aria-label="Cancel march">×</button></li>`; });
    h += `</ul></div>`;
  }
  el.innerHTML = h; el.style.display = 'block';
  const nsh = $('nsh'), nmv = $('nmv');
  if (nsh && nmv) {
    nsh.oninput = () => { const m = UI.move; m.ships = +nsh.value; const mx = Math.min(availAt(m.from), m.ships * SHIP_CAP); nmv.max = mx; if (m.n > mx) { m.n = mx; nmv.value = mx; } $('nshn').textContent = m.ships; $('nmvn').textContent = fmt(m.n); $('mvo').textContent = navalOdds(m); };
    nmv.oninput = () => { UI.move.n = +nmv.value; $('nmvn').textContent = fmt(UI.move.n); $('mvo').textContent = navalOdds(UI.move); };
  }
  const sh = $('sh'); if (sh) { const upd = () => { $('shn').textContent = sh.value; $('shb').textContent = `Build ${sh.value} ${+sh.value > 1 ? 'ships' : 'ship'} for ${sh.value * SHIP_COST} gold (1 action)`; }; sh.oninput = upd; upd(); }
  const rc = $('rc'); if (rc) { const upd = () => { $('rcn').textContent = fmt(+rc.value); $('rcb').textContent = `Recruit for ${(+rc.value / 100)} gold (1 action)`; }; rc.oninput = upd; upd(); }
  const mv = $('mv'); if (mv) mv.oninput = () => { UI.move.n = +mv.value; $('mvn').textContent = fmt(UI.move.n); const m = UI.move; if (G.owner[m.to] !== pl && !(m.path && m.path.length > 2)) $('mvo').textContent = oddsText(m.from, m.to, m.n) + (P[m.from].isSea.has(m.to) ? ' · sea landing, attack −25%' : '') + ' · defenders ' + fmt(G.army[m.to]); };
}
function spend(mp) { if (G.mp < mp) { toast('Not enough actions left this turn.'); return false; } G.mp -= mp; return true; }
$('panel').addEventListener('click', e => {
  const b = e.target.closest('[data-a]'); if (!b || b.disabled || !G) return;
  if (b.dataset.a === 'close') { UI.sel = -1; UI.move = null; return refresh(); }
  if (G.over) return;
  const a = b.dataset.a, i = UI.sel, pl = G.player, o = G.owner[i];
  if (G.phase === 1 && ['nvok', 'naval'].includes(a)) { toast('Enemy phase: ships and attacks wait. Press End turn.'); return; }
  if (a === 'mvok') { const m = UI.move; if (!m) return; if (G.phase === 1 && G.owner[m.dest] !== pl) { toast('Enemy phase: your armies can move only inside your own land.'); return; } if (!spend(1)) return; if (instantOK(m.from, m.dest)) { if (instantMove(m.from, m.dest, clamp(m.n, 1, availAt(m.from)))) { toast(`${fmt(m.n)} soldiers moved up to the front at ${P[m.dest].name}.`); UI.sel = m.dest; } else { G.mp++; toast('No route through your own land.'); } } else startMarch(m.from, m.dest, clamp(m.n, 1, availAt(m.from)), m.path); UI.move = null; }
  else if (a === 'nvok') { const m = UI.move; if (!m || !m.naval) return; if (!spend(1)) return; G.orders.push({ c: pl, from: m.from, to: m.to, n: clamp(m.n, 0, availAt(m.from)), ships: clamp(m.ships, 1, availShips(m.from)), naval: true }); UI.move = null; }
  else if (a === 'naval') { UI.pickNaval = i; UI.pickFrom = -1; UI.move = null; cv.classList.add('aim'); toast('Click a highlighted coast to sail to. Esc cancels.'); }
  else if (a === 'shok') { const n = +$('sh').value, c = n * SHIP_COST; if (G.gold[pl] < c || !spend(1)) return; G.gold[pl] -= c; G.fleet[i] += n; toast(`${n} ${n > 1 ? 'ships are' : 'ship is'} ready now.`); }
  else if (a === 'mvno') UI.move = null;
  else if (a === 'del') { const q = G.orders[+b.dataset.k]; if (!q) return; if (q.m) G.marches = G.marches.filter(x => x.id !== q.m); G.orders.splice(+b.dataset.k, 1); if (!q.free) G.mp = Math.min(maxMP(pl), G.mp + 1); }
  else if (a === 'mdel') { const id = +b.dataset.k; G.marches = G.marches.filter(x => x.id !== id); G.orders = G.orders.filter(x => x.m !== id); }
  else if (a === 'march') { UI.pickFrom = i; UI.move = null; cv.classList.add('aim'); toast('Click the destination province. Esc cancels.'); }
  else if (a === 'gather') { if (!spend(2)) return; const r = gatherAll(i); if (!r.cnt) { G.mp += 2; toast('No other free armies can reach this province.'); } else toast(`${r.cnt} ${r.cnt > 1 ? 'armies' : 'army'} (${fmt(r.men)} soldiers) set out for ${P[i].name}.`); }
  else if (a === 'rcok') { const n = +$('rc').value; if (n / 100 > G.gold[pl] + 1e-6) return; if (!spend(1)) return; G.gold[pl] -= n / 100; G.army[i] += n; G.recd[i] += n; G.pop[i] -= n / 1e6; toast(`${fmt(n)} recruits are ready now.`); }
  else if (a === 'dev') { const c = devCost(i); if (!canDev(i) || G.gold[pl] < c || !spend(1)) return; G.gold[pl] -= c; G.devT[i] = DEV_TURNS; mapDirty = UI.mode === 'inc'; }
  else if (a === 'gift') { if (G.dp < 1) { toast('You need 1 diplomacy point. They come slowly, every turn.'); return; } G.dp -= 1; addRel(pl, o, 10); toast(`Relations with ${CN[o].name} improved.`); mapDirty = true; }
  else if (a === 'war') {
    modal(`Declare war on ${CN[o].name}?`, `<p>Their army: <b>${armyKnown(o) ? fmt(armyOf(o)) : 'unknown'}</b>. Yours: <b>${fmt(armyOf(pl))}</b>.</p><p>${alliesOf(o).length ? 'Their allies may join: ' + alliesOf(o).map(cname).join(', ') + '.' : 'They have no allies.'} Other nations will trust you less.</p>`,
      [['Cancel', '', () => {}], ['Declare war', 'brass', () => { if (!spend(2)) return; declareWar(pl, o); mapDirty = true; refresh(); nextEvent(); }]]); return;
  }
  else if (a === 'peace') { openPeace(o); return; }
  else if (a === 'ally') { if (!spend(2)) return; if (aiAcceptsAlliance(o, pl)) { formAlliance(pl, o); toast(`${CN[o].name} is now your ally.`); } else toast(`${CN[o].name} declined. Relations of +50 or better are needed.`); mapDirty = true; }
  else if (a === 'unally') { breakAlliance(pl, o); mapDirty = true; }
  refresh();
});
function refresh() {
  const g = G; needDraw = true;
  const inGame = g && !UI.picking;
  $('bar').style.display = inGame ? 'flex' : 'none'; $('endturn').style.display = inGame ? 'block' : 'none'; $('btn-auto').style.display = inGame && !T ? 'block' : 'none'; $('log').style.display = inGame ? 'block' : 'none'; $('start').style.display = UI.picking ? 'block' : 'none';
  if (!inGame) { $('panel').style.display = 'none'; return; }
  const pl = g.player, live = g.alive[pl];
  $('b-chip').style.background = CN[pl].color; $('b-name').textContent = CN[pl].name + (live ? '' : ' (fallen)');
  const inc = live ? incomeOf(pl) : 0, net = inc - (live ? upkeepOf(pl) : 0);
  $('b-gold').innerHTML = `${fmt(Math.floor(g.gold[pl]))} <i class="${net < 0 ? 'neg' : ''}">${net >= 0 ? '+' : ''}${net.toFixed(1)}</i>`;
  { const net = dpIncome(pl) - dpUpkeep(pl); $('b-dp').innerHTML = live ? `${g.dp.toFixed(1)} <i class="${net < 0 ? 'neg' : ''}">${net >= 0 ? '+' : ''}${net.toFixed(1)}</i>` : '0'; }
  $('b-mp').textContent = live ? `${g.mp} / ${maxMP(pl)}` : '0'; $('b-army').textContent = fmt(live ? armyOf(pl) : 0); $('b-prov').textContent = live ? countOf(pl) : 0;
  $('b-turn').textContent = `${g.turn} · ${dateOf(g.turn)}${g.phase === 1 ? ' · enemy phase' : ''}`;
  const atw = live && enemiesOf(pl).length > 0;
  $('endturn').textContent = g.over ? 'Next turn' : g.phase === 1 ? 'Enemy moves' : atw ? 'End move' : 'End turn';
  const foes = live ? enemiesOf(pl) : []; $('b-warbox').style.display = foes.length ? 'flex' : 'none';
  $('b-war').textContent = foes.slice(0, 3).map(c => CN[c].name).join(', ') + (foes.length > 3 ? ` +${foes.length - 3}` : '');
  const lg0 = $('legend'), LG = { dip: ['Hostile', 'linear-gradient(90deg,#5c0f0a,#962e22,#d4d2ca 50%,#14643a,#173f80)', 'Friendly', 'Darker means stronger feeling. Darkest red is war, dark blue is an ally.'], pop: ['Few people', 'linear-gradient(90deg,#eee4cc,#381608)', 'Many people', 'Darker means more people per area.'], inc: ['Low income', 'linear-gradient(90deg,#e2eee4,#06382a)', 'High income', 'Darker means more income.'] }[UI.mode];
  if (LG) { lg0.style.display = 'block'; lg0.innerHTML = `<div class="row" style="flex-wrap:nowrap"><span>${LG[0]}</span><i style="background:${LG[1]}"></i><span>${LG[2]}</span></div><small>${LG[3]}</small>`; } else lg0.style.display = 'none';
  const lg = $('log'); lg.innerHTML = g.log.slice(-30).map(l => `<p class="${l.c}"><span class="num">T${l.t}</span>${l.h}</p>`).join(''); lg.scrollTop = lg.scrollHeight;
  renderPanel();
}
function openDiplomacy() {
  const pl = G.player, nb = new Set(); for (let i = 0; i < NP; i++) if (G.owner[i] === pl) for (const j of P[i].nb) if (G.owner[j] !== pl) nb.add(G.owner[j]);
  const rows = []; for (let c = 0; c < NC; c++) if (c !== pl && G.alive[c]) rows.push(c);
  const rank = c => (atWar(c, pl) ? 0 : allied(c, pl) ? 1 : nb.has(c) ? 2 : 3);
  rows.sort((a, b) => rank(a) - rank(b) || armyOf(b) - armyOf(a));
  let h = `<p>Click a nation to see it on the map and act. Neighbours and nations at war with you come first.</p><div class="tblwrap"><table><tr><th>Nation</th><th>Status</th><th class="r">Relations</th><th class="r">Army</th><th class="r">Provinces</th></tr>`;
  for (const c of rows) h += `<tr class="click" data-c="${c}"><td><span class="chip" style="display:inline-block;height:12px;width:10px;vertical-align:-1px;margin-right:6px;background:${CN[c].color}"></span>${cname(c)}${nb.has(c) ? ' <span style="color:var(--dim)">· neighbour</span>' : ''}</td><td>${statusOf(c)}</td><td class="r num">${relOf(c, pl) > 0 ? '+' : ''}${relOf(c, pl)}</td><td class="r num">${armyTxt(c)}</td><td class="r num">${countOf(c)}</td></tr>`;
  modal('Diplomacy', h + '</table></div>');
  $('m-body').querySelectorAll('tr.click').forEach(tr => tr.onclick = () => { const c = +tr.dataset.c; closeModal(); UI.sel = G.cap[c]; UI.move = null; focusCountry(c); refresh(); });
}
function openRankings() {
  const rows = []; for (let c = 0; c < NC; c++) if (G.alive[c]) rows.push({ c, n: countOf(c), a: armyOf(c), i: incomeOf(c) });
  rows.forEach(r => r.sc = r.n * 12 + r.a / 1000 + r.i); rows.sort((a, b) => b.sc - a.sc);
  let h = `<p>${rows.length} nations remain.</p><div class="tblwrap"><table><tr><th>#</th><th>Nation</th><th class="r">Provinces</th><th class="r">Army</th><th class="r">Income</th></tr>`;
  rows.forEach((r, k) => { if (k < 25 || r.c === G.player) h += `<tr class="${r.c === G.player ? 'me' : ''}"><td class="num">${k + 1}</td><td>${cname(r.c)}</td><td class="r num">${r.n}</td><td class="r num">${armyKnown(r.c) ? fmt(r.a) : '?'}</td><td class="r num">${r.i.toFixed(0)}</td></tr>`; });
  modal('Rankings', h + '</table></div>');
}
function openMenu() {
  if (T) return modal('Tutorial', '<p>You are in the practice game. Nothing here is saved.</p>', [['Leave tutorial', '', tutExit], ['Back to tutorial', 'brass', () => {}]]);
  const saveBtn = s => [`Save to Slot ${s + 1}`, '', () => {
    const doSave = () => { const was = G.slot; G.slot = s; if (saveTo(s)) toast(`Saved to Slot ${s + 1}.`); else { G.slot = was; toast('Could not save: browser storage is unavailable.'); } };
    if (G.slot !== s && readSlot(s)) modal(`Replace Slot ${s + 1}?`, `<p>Slot ${s + 1} holds ${esc(slotText(s))}. Saving here replaces it, and the game will keep saving into Slot ${s + 1}.</p>`, [['Cancel', '', () => {}], ['Replace', 'brass', doSave]]);
    else doSave();
  }];
  modal('Menu', `<p>The game saves itself in this browser at the start of every turn, into <b>Slot ${G.slot + 1}</b>. Slot 1: ${esc(slotText(0))}. Slot 2: ${esc(slotText(1))}. On the start screen, right-click a slot to reset or delete it.</p><p><b>Controls.</b> Click your province, then a highlighted neighbour, to move or attack. To send an army far away, right-click the destination or press March to a distant province: it walks there by the shortest route, one province per turn. Gather all armies here brings every army to one province. Ports can build ships: a ship carries 500 soldiers over the long dotted sea lanes, and a naval invasion sails with its fleet, fights any enemy fleet in the target port first, and then lands. The Realm button holds one-click orders for all provinces. Dashed lines are sea routes. Enter or Space ends the turn. Auto turns presses End turn three times a second until you press it again; it stops by itself when a dialog opens or the game ends. Esc clears the selection.</p><p><b>Rules.</b> Improving relations with a nation costs 1 diplomacy point. You earn a fraction of a point each turn (more with a bigger realm, up to 5 saved), and every friendly nation costs 0.2 a turn to keep. Each turn your moves resolve first, then the other nations answer. Recruiting happens at once, whoever's turn it is, and so does a step from a province next door into a front-line province of yours (one that borders a nation you are at war with); every other journey takes one province per turn. While you are at war a turn has two parts: End move carries out your attacks and marches into enemy land; then, while the enemy waits, you can still rearrange your armies and recruit; Enemy moves lets it answer and it meets whatever you have then. 100 soldiers cost 1 gold to recruit and 0.1 gold per turn to keep. Developing a province costs gold and adds up to +20% income, a little each turn over 10 turns; a province can develop only one level at a time. Captured provinces start at 40% stability and recover over time. Sea landings attack at −25%. In peace talks you can demand or offer provinces and gold, and the nation tells you at once whether it would accept. Rivals can make such demands of you and of each other. A nation that has lost its capital and most of its land capitulates to the conqueror.</p>`,
    [saveBtn(0), saveBtn(1), ['New game', '', () => modal('Start a new game?', '<p>You choose the save slot for the new game on the next screen. This game stays saved in its slot.</p>', [['Cancel', '', () => {}], ['New game', 'brass', toStart]])], ['Back to game', 'brass', () => {}]]);
}
$('btn-dip').onclick = openDiplomacy; $('btn-rank').onclick = openRankings; $('btn-menu').onclick = openMenu;
$('endturn').onclick = endTurn;
// auto turns: presses End turn three times a second until you press the button again. It never moves armies, and it waits while a dialog is open.
let autoTimer = 0;
function setAuto(on) {
  clearInterval(autoTimer); autoTimer = 0; const b = $('btn-auto'); b.classList.toggle('brass', on); b.textContent = on ? 'Stop auto' : 'Auto turns';
  if (on) autoTimer = setInterval(() => {
    if (!G || UI.picking || (G.over && !G.spectate)) return setAuto(false);
    if (UI.busy || $('veil').style.display === 'flex') return;
    endTurn();
  }, 333);
}
$('btn-auto').onclick = () => setAuto(!autoTimer);
$('mode').onchange = e => { UI.mode = e.target.value; mapDirty = true; refresh(); };
function openRealm() {
  if (G.over || !G.alive[G.player]) return toast('Your nation has fallen.');
  const pl = G.player, d = planDevelop(), r1 = planRecruit(0.5), r2 = planRecruit(1);
  const where = r1.front ? 'front-line' : 'border';
  const row = (id, label, sub, ok) => `<div class="sect"><div class="row" style="justify-content:space-between"><div style="flex:1;min-width:200px"><b>${label}</b><div class="hint" style="margin:0">${sub}</div></div><button class="btn" data-r="${id}" ${ok ? '' : 'disabled'}>Do it · 2 actions</button></div></div>`;
  let h = `<p>Orders for the whole realm in one click. You have <b class="num">${fmt(Math.floor(G.gold[pl]))} gold</b> and <b class="num">${G.mp} actions</b>.</p>`;
  h += row('dev', `Develop ${d.list.length} ${d.list.length === 1 ? 'province' : 'provinces'}`, d.list.length ? `Best returns first, ${fmt(d.total)} gold in total.` : 'Not enough gold for any province.', d.list.length);
  h += row('r1', `Recruit ${fmt(r1.total)} soldiers, using up to half the treasury`, r1.total ? `Spread over ${r1.list.length} ${where} provinces, ${fmt(r1.cost)} gold.` : 'Not enough gold or recruits.', r1.total);
  if (r2.total > r1.total) h += row('r2', `Recruit ${fmt(r2.total)} soldiers, using the whole treasury`, r2.total ? `Spread over ${r2.list.length} ${where} provinces, ${fmt(r2.cost)} gold.` : 'Not enough gold or recruits.', r2.total);
  h += `<div class="sect"><div class="hint" style="margin:0">To bring every army to one place, select one of your provinces and press <b>Gather all armies here</b>.</div></div>`;
  modal('Realm', h, [['Close', 'brass', () => {}]]);
  $('m-body').querySelectorAll('[data-r]').forEach(b => b.onclick = () => {
    if (!spend(2)) return; const k = b.dataset.r;
    if (k === 'dev') { d.list.forEach(x => { G.gold[pl] -= x.cost; G.devT[x.i] = DEV_TURNS; }); toast(`${d.list.length} ${d.list.length > 1 ? 'provinces start' : 'province starts'} developing.`); }
    else { const r = k === 'r1' ? r1 : r2; r.list.forEach(x => { G.gold[pl] -= x.n / 100; G.army[x.i] += x.n; G.recd[x.i] += x.n; G.pop[x.i] -= x.n / 1e6; }); toast(`${fmt(r.total)} recruits are ready now.`); }
    mapDirty = true; closeModal(); refresh();
  });
}
$('btn-realm').onclick = openRealm;

// ============================================================ tutorial
// A scripted practice game as China. It is never saved. Each step shows a card, makes the matching button or province glow, and moves on by itself when you do the thing.
let T = null;
const TUT_KEY = 'borders-crowns-tutorial-seen';
function tutSeen(set) { try { if (set) localStorage.setItem(TUT_KEY, '1'); return !!localStorage.getItem(TUT_KEY); } catch (e) { return true; } }
function tutPlan() {
  const pl = byId.CHN, own = i => G.owner[i] === pl, land = (i, j) => P[i].nb.includes(j) && !P[i].isSea.has(j);
  for (const id of ['VNM', 'LAO', 'MMR', 'MNG', 'NPL', 'BTN', 'PRK', 'KGZ', 'TJK', 'KAZ', 'AFG', 'PAK', 'IND', 'RUS']) {
    const e = byId[id]; if (e == null) continue;
    for (let B = 0; B < NP; B++) {
      if (!own(B) || B === G.cap[pl]) continue;
      const E = P[B].nb.find(j => G.owner[j] === e && land(B, j) && G.cap[e] !== j); if (E == null) continue;
      const safe = a => own(a) && a !== G.cap[pl] && !P[a].nb.some(j => G.owner[j] === e);
      const A = P[B].nb.find(a => land(B, a) && safe(a)); if (A == null) continue;
      const dist = new Map([[B, 0]]), q = [B]; let D = null;
      for (let k = 0; k < q.length && D == null; k++) for (const j of P[q[k]].nb) if (!dist.has(j) && own(j) && !P[q[k]].isSea.has(j)) { dist.set(j, dist.get(q[k]) + 1); q.push(j); if (dist.get(j) === 3 && j !== A && safe(j)) { D = j; break; } }
      if (D == null) continue;
      let port = -1; for (let i = 0; i < NP; i++) if (own(i) && P[i].port && G.fleet[i] > 0 && (port < 0 || G.fleet[i] > G.fleet[port])) port = i;
      return { A, B, D, E, e, port };
    }
  }
  return null;
}
const STEPS = [
  { t: 'Welcome', x: 'This is a short practice game. You lead <b>China</b>. Nothing here is saved, and when you finish you return to the main menu. Follow the glowing hints, or skip any step.', info: 1 },
  { t: 'Moving the map', x: 'Drag the map to pan it. Scroll the wheel, or pinch on a phone, to zoom. The closer you zoom, the more city names you see.', info: 1 },
  { t: 'Map modes', x: 'The box at the top changes what the map shows. Open it and choose <b>Diplomatic map</b>.', hl: ['#mode'], done: () => UI.mode === 'dip' },
  { t: 'The diplomatic map', x: 'Every country is tinted by how it feels about you: red is hostile, grey is neutral, blue is friendly. The Population and Income maps work the same way. Now go back to the <b>Political map</b>.', hl: ['#mode'], done: () => UI.mode === 'pol' },
  { t: 'The top bar', x: '<b>Gold</b> pays for soldiers and development, with your income per turn beside it. <b>Actions</b> limit how many orders you can give each turn. <b>Diplomacy</b> points buy better relations. <b>Army</b> is all your soldiers, and <b>Turn</b> is the date.', hl: ['#bar'], info: 1 },
  { t: 'Select a province', x: 'The map is split into provinces, each named after a real city. The glowing one is yours. <b>Click it.</b>', focus: T_ => [T_.B], ring: () => [T.A], done: () => UI.sel === T.A },
  { t: 'Recruit soldiers', x: 'The panel shows the province: soldiers, people, income, stability. Soldiers come from the people here and cost gold (100 soldiers for 1 gold). Drag the slider, then press <b>Recruit</b>.', hl: ['#panel #rc', '#panel #rcb'], done: () => G.recd[T.A] > 0 },
  { t: 'Develop the province', x: 'Developing raises the income of a province by 20%, gradually over 10 turns, and a province can develop only one level at a time. Press <b>Develop</b>.', hl: ['#panel [data-a="dev"]'], done: () => G.devT[T.A] > 0 },
  { t: 'Move an army', x: 'Armies move one province at a time. With your province selected, <b>click the glowing neighbour</b>, choose how many soldiers, and press <b>Order move</b>.', ring: () => UI.sel === T.A ? [T.B] : [T.A], hl: ['#panel [data-a="mvok"]'], done: () => G.orders.some(o => o.c === G.player && o.from === T.A && o.to === T.B) },
  { t: 'A long march', x: 'To send soldiers far away, select the glowing province, press <b>March to a distant province</b> and click the glowing target. You can also right-click the target. The army then walks on its own, one province each turn.', focus: T_ => [T_.D, T_.B], ring: () => UI.sel === T.D || UI.pickFrom === T.D ? [T.B] : [T.D], hl: ['#panel [data-a="march"]', '#panel [data-a="mvok"]'], done: () => G.marches.length > 0 },
  { t: 'End the turn', x: 'Orders are carried out when you end the turn. Press <b>End turn</b>. You will see the date move on and your gold grow.', hl: ['#endturn'], done: () => G.turn > T.t0 },
  { t: 'Meet a neighbour', x: 'You share a border with <b>NAME</b>. Press <b>Diplomacy</b> to list every nation, then click <b>NAME</b> in the list.', hl: ['#btn-dip', '#modal tr.click[data-c="E"]'], done: () => UI.sel >= 0 && G.owner[UI.sel] === T.e },
  { t: 'Relations', x: 'You see their status, how they feel about you, and the size of their land. Their army shows <b>?</b> because you can only see armies of your own land, your allies and nations at war with you. Try <b>Improve relations</b>; it costs 1 diplomacy point.', hl: ['#panel [data-a="gift"]'], done: () => relOf(G.player, T.e) > T.rel0 },
  { t: 'Declare war', x: 'Friendly nations can become allies: press <b>Propose alliance</b>. Here we want the opposite. Press <b>Declare war</b> and confirm. Armies can enter foreign land only in war.', hl: ['#panel [data-a="war"]', '#m-acts .brass'], done: () => atWar(G.player, T.e) },
  { t: 'You are at war', x: 'You can now see their armies, and the top bar shows who you fight. While you are at war every turn has <b>two parts</b>: first your moves and attacks, then the enemy answers.', info: 1 },
  { t: 'Attack', x: 'Select your glowing border province, <b>click the glowing enemy province</b> next to it, and press <b>Order attack</b>. The panel tells you the odds.', focus: T_ => [T_.B, T_.E], ring: () => UI.sel === T.B ? [T.E] : [T.B], hl: ['#panel [data-a="mvok"]'], done: () => G.orders.some(o => o.c === G.player && o.from === T.B && o.to === T.E) },
  { t: 'Carry it out', x: 'Press <b>End move</b>. Your army fights at once.', hl: ['#endturn'], done: () => G.owner[T.E] === G.player || G.phase === 1 },
  { t: 'The enemy phase', x: 'Now the enemy waits. You can still <b>recruit</b> and reinforce your front line before it moves. Then press <b>Enemy moves</b> to let it answer and start the next turn.', hl: ['#endturn'], done: () => G.phase === 0 && G.turn > T.t0 },
  { t: 'Making peace', x: 'When you have had enough, click an enemy province, press <b>Peace talks</b> and <b>Propose peace</b>. You can ask for land or gold, or offer it, and the nation tells you at once if it would accept.', ring: () => [T.foe()], hl: ['#panel [data-a="peace"]', '#m-acts .brass'], done: () => !atWar(G.player, T.e) },
  { t: 'Ships', x: 'Ports build ships. One ship carries 500 soldiers over the dotted sea lanes. In a war, select a port, press <b>Naval invasion</b> and click a coast. The glowing province is one of your ports.', focus: T_ => [T_.port], ring: () => T.port >= 0 ? [T.port] : [], hl: ['#panel [data-a="shok"]', '#panel #shb'], info: 1 },
  { t: 'You are ready', x: 'That is the basics: recruit, move, talk, fight and make peace. Press <b>Finish</b> to go back to the main menu and start a real game.', last: 1 }
];
function tutStart() {
  closeModal(); setAuto(false); tutSeen(true);
  newGame(byId.CHN); G.slot = -1; G.tut = true;
  const p = tutPlan(); if (!p) { G = null; toast('The tutorial could not be set up.'); return; }
  T = Object.assign({ i: -1, t0: 1, rel0: 0 }, p); T.foe = () => { const e = G.owner[T.E] === T.e ? T.E : P[T.E].nb.find(j => G.owner[j] === T.e); return e != null ? e : ownedBy(T.e)[0]; };
  G.army[T.A] = 30000; G.army[T.B] = 5000; G.army[T.D] = 15000; G.army[T.E] = 2500; setRel(G.player, T.e, 5); G.truces.clear();
  G.log.length = 0; note('Practice game: nothing here is saved.', 'me');
  UI.picking = false; UI.sel = -1; UI.move = null; UI.mode = 'pol'; $('mode').value = 'pol'; mapDirty = true; labelCache = null;
  refresh(); focusCountry(G.player, 0.34); tutGo(0);
}
function tutGo(k) {
  T.i = k; const s = STEPS[k], pl = G.player; T.t0 = G.turn; T.rel0 = relOf(pl, T.e);
  $('tut').style.display = 'block'; $('tut-n').textContent = `Tutorial · step ${k + 1} of ${STEPS.length}`; $('tut-bar').style.width = ((k + 1) / STEPS.length * 100) + '%';
  $('tut-t').textContent = s.t; $('tut-p').innerHTML = s.x.replace(/NAME/g, esc(CN[T.e].name));
  $('tut-next').style.display = s.info || s.last ? '' : 'none'; $('tut-next').textContent = s.last ? 'Finish' : 'Next'; $('tut-skip').style.display = s.info || s.last ? 'none' : '';
  const pts = s.focus ? s.focus(T).filter(i => i >= 0) : [];
  if (pts.length) { const xs = pts.map(i => P[i].x), ys = pts.map(i => P[i].y), w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys); flyTo((Math.min(...xs) + Math.max(...xs)) / 2 + (cw > 760 ? 90 : 0), (Math.min(...ys) + Math.max(...ys)) / 2, clamp(Math.min(cw * 0.4 / (w + 1), ch * 0.5 / (h + 1)), 2, 6)); }
  needDraw = true; tutHl();
}
function tutNext() { if (!T) return; if (T.i >= STEPS.length - 1) return tutExit(); tutGo(T.i + 1); }
function tutHl() {
  document.querySelectorAll('.tut-hl').forEach(e => e.classList.remove('tut-hl'));
  if (!T) return; const s = STEPS[T.i]; if (!s || !s.hl) return;
  for (const q of s.hl) document.querySelectorAll(q.replace('data-c="E"', `data-c="${T.e}"`)).forEach(e => e.classList.add('tut-hl'));
}
function tutExit() { T = null; $('tut').style.display = 'none'; document.querySelectorAll('.tut-hl').forEach(e => e.classList.remove('tut-hl')); toStart(); }
setInterval(() => {
  if (!T || !G || UI.picking) return;
  if (G.mp < 4) { G.mp = maxMP(G.player); refresh(); }   // a practice game never runs out of actions
  const s = STEPS[T.i]; if (s && s.done && s.done()) return tutNext();
  tutHl();
}, 200);
$('tut-next').onclick = tutNext; $('tut-skip').onclick = tutNext;
$('tut-x').onclick = () => modal('Leave the tutorial?', '<p>The practice game is discarded. Your saved games are not touched.</p>', [['Keep going', 'brass', () => {}], ['Leave', '', tutExit]]);
$('btn-tut').onclick = tutStart;

// ============================================================ start screen
function pickStats(c) {
  let n = 0, pop = 0, inc = 0; const nb = new Set();
  for (let i = 0; i < NP; i++) if (P[i].home === c) { n++; pop += P[i].pop0; inc += baseOf(P[i].pop0, P[i].eco) * finOf(c); for (const j of P[i].nb) if (P[j].home !== c) nb.add(P[j].home); }
  const army = 1500 * Math.pow(CN[c].pop, 0.55) * Math.pow(CN[c].gdp, 0.2) * CN[c].mil;
  return { n, pop, inc, army, nb: nb.size };
}
function setPick(c) {
  UI.pick = c; const s = pickStats(c);
  $('pick').value = CN[c].name;
  $('pickinfo').innerHTML = `<div class="sub" style="margin:10px 0 0;display:flex;gap:8px;align-items:center"><span class="chip" style="background:${CN[c].color}"></span><b style="font:400 20px var(--display);letter-spacing:.03em">${cname(c)}</b><span style="color:var(--dim)">capital ${esc(CN[c].capName)}</span></div>
    <div class="grid num"><div><small>Provinces</small><b>${s.n}</b></div><div><small>Population</small><b>${fpop(s.pop)}</b></div><div><small>Army</small><b>${fmt(s.army)}</b></div><div><small>Income per turn</small><b>${s.inc.toFixed(0)}</b></div><div><small>Neighbours</small><b>${s.nb}</b></div><div><small>Challenge</small><b>${s.army > 150000 ? 'Easy' : s.army > 40000 ? 'Medium' : s.army > 12000 ? 'Hard' : 'Very hard'}</b></div></div>`;
  $('go').textContent = 'Start as ' + CN[c].name;
  mapDirty = true; needDraw = true;
}
function hideSlotMenu() { const m = $('slotmenu'); if (m) m.style.display = 'none'; }
function slotMenu(e, s) {
  e.preventDefault(); const v = readSlot(s); if (!v) return hideSlotMenu();
  const m = $('slotmenu'); m.innerHTML = '';
  const add = (label, cls, fn) => { const b = document.createElement('button'); b.className = 'btn ' + cls; b.textContent = label; b.onclick = () => { hideSlotMenu(); fn(); }; m.appendChild(b); };
  add('Reset', '', () => modal(`Reset Slot ${s + 1}?`, `<p>${esc(slotText(s))} will be replaced by a fresh game as <b>${esc(CN[v.player].name)}</b> at turn 1. This cannot be undone.</p>`, [['Cancel', '', () => {}], ['Reset', 'brass war', () => {
    const keep = UI.slot; UI.slot = s; G = null; newGame(v.player); save(); G = null; UI.slot = keep; UI.sel = -1; UI.move = null; renderSlots();
  }]]));
  add('Delete', 'war', () => modal(`Delete Slot ${s + 1}?`, `<p>${esc(slotText(s))} will be deleted. This cannot be undone.</p>`, [['Cancel', '', () => {}], ['Delete', 'brass war', () => { clearSlot(s); renderSlots(); }]]));
  m.style.display = 'flex'; m.style.left = Math.min(e.clientX, innerWidth - m.offsetWidth - 8) + 'px'; m.style.top = Math.min(e.clientY, innerHeight - m.offsetHeight - 8) + 'px';
}
document.addEventListener('pointerdown', e => { if (!e.target.closest('#slotmenu')) hideSlotMenu(); });
window.addEventListener('blur', hideSlotMenu);
window.addEventListener('keydown', e => { if (e.key === 'Escape') hideSlotMenu(); });
function renderSlots() {
  const sl = $('slots'); sl.innerHTML = '';
  for (let s = 0; s < SLOTS; s++) {
    const b = document.createElement('button'); b.className = 'btn slot' + (UI.slot === s ? ' brass' : ''); b.setAttribute('aria-pressed', UI.slot === s);
    b.innerHTML = `Slot ${s + 1}<small>${esc(slotText(s))}</small>`; b.onclick = () => { UI.slot = s; renderSlots(); }; b.oncontextmenu = e => slotMenu(e, s); sl.appendChild(b);
  }
  $('slothint').textContent = readSlot(UI.slot) ? `A new game here replaces ${slotText(UI.slot)}.` : '';
  const cs = $('conts'); cs.innerHTML = '';
  for (let s = 0; s < SLOTS; s++) {
    const v = readSlot(s); if (!v) continue;
    const row = document.createElement('div'); row.className = 'row'; row.style.flexWrap = 'nowrap';
    const b = document.createElement('button'); b.className = 'btn big'; b.style.flex = '1'; b.textContent = `Continue Slot ${s + 1}: ${CN[v.player].name}, turn ${v.turn}`;
    b.onclick = () => { if (restore(readSlot(s), s)) enterGame(); }; b.oncontextmenu = e => slotMenu(e, s);
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.title = `Delete Slot ${s + 1}`; x.setAttribute('aria-label', `Delete Slot ${s + 1}`);
    x.onclick = () => modal(`Delete Slot ${s + 1}?`, `<p>${esc(slotText(s))} will be deleted. This cannot be undone.</p>`, [['Cancel', '', () => {}], ['Delete', 'brass war', () => { clearSlot(s); renderSlots(); }]]);
    row.appendChild(b); row.appendChild(x); cs.appendChild(row);
  }
}
function toStart() {
  T = null; $('tut').style.display = 'none'; document.querySelectorAll('.tut-hl').forEach(e => e.classList.remove('tut-hl'));
  setAuto(false); UI.picking = true; UI.sel = -1; UI.move = null; closeModal();
  const empty = [...Array(SLOTS).keys()].find(s => !readSlot(s)); if (empty != null) UI.slot = empty;
  renderSlots(); G = null; labelCache = null; setPick(UI.pick); refresh(); focusCountry(UI.pick, 0.16);
}
function enterGame() { UI.picking = false; UI.mode = 'pol'; $('mode').value = 'pol'; mapDirty = true; labelCache = null; refresh(); if (G.alive[G.player]) focusCountry(G.player, 0.34); }
$('counts').textContent = `${NC} nations, ${NP.toLocaleString('en-US')} provinces named after real cities.`;
$('nations').innerHTML =CN.map(c => c.name).sort().map(n => `<option value="${esc(n)}">`).join('');
$('pick').addEventListener('input', e => { const v = e.target.value.trim().toLowerCase(); const c = CN.findIndex(x => x.name.toLowerCase() === v); if (c >= 0) { setPick(c); focusCountry(c, 0.16); } });
$('pick').addEventListener('focus', e => e.target.select());
$('go').onclick = () => { newGame(UI.pick); save(); enterGame(); };

// ============================================================ boot
function start(data) {
  resize(); requestAnimationFrame(loop);
  if (data && data.save && restore(data.save)) { enterGame(); }
  else {
    toStart();
    if (!tutSeen() && ![...Array(SLOTS).keys()].some(readSlot)) modal('New to Borders & Crowns?', '<p>Would you like a short practice game that teaches the basics: recruiting, moving armies, diplomacy, war and peace? You lead China, and nothing in it is saved.</p><p class="hint">You can start it later from the main menu with the Tutorial button.</p>',
      [['No, thanks', '', () => tutSeen(true)], ['Yes, teach me', 'brass', tutStart]]);
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { needDraw = true; });
}
if (window.claude && window.claude.hot) { try { window.claude.hot.snapshot(() => (G && !UI.picking ? { save: serialize() } : {})); } catch (e) {} }
if (window.claude && window.claude.hot && window.claude.hot.ready) window.claude.hot.ready(start); else start((window.claude && window.claude.hot && window.claude.hot.data) || {});
UI.pickFrom = -1;
window.__game = { get G() { return G; }, get T() { return T; }, STEPS, tutGo, UI, P, CN, endTurn, clickProv, view, byId };
