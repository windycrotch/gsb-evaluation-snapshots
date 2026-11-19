// js/versus.js: versus mode (PvP), 2 to 4 players, every pilot for themselves. Runs inside a co-op room (coop.js
// owns the room, the connections, the other planes and the power-ups); this file adds the fighting rules.
//
// Who decides what (the "victim decides" rule, so nobody is hit by a bullet that missed on their own screen):
//   everyone  flies their own plane; fires; checks OTHER players' bullets, missiles and rams against their OWN
//             plane only; reports their own death and who got them
//   host      keeps the score table and the clock, spawns power-ups, ends the match, relays everyone's messages
//
// The rules that can freeze or end a match (pause, away, budget, host gone, result confirmation) live in
// js/matchSession.js (protocol) on top of js/matchState.js (state machine), so they can be driven headlessly by
// test/. This file is the 3D half: planes, collisions, death reports, power-ups. It forwards to the session.

import * as THREE from 'three';
import { CFG } from './config.js';
import { spawnAltitude } from './terrain.js';
import { MatchSession } from './matchSession.js';
import { EndReason, LeaveReason, rankRows, newMatchId } from './matchState.js';

const V = CFG.versus;
const r1 = v => Math.round(v * 10) / 10;
const r3 = v => Math.round(v * 1000) / 1000;
const UP = new THREE.Vector3(0, 1, 0);

// a random id for one match (the server needs two players to report the same id and table).
// Kept here as a re-export, so existing callers (coop.js) keep working; the generator itself lives in matchState.js.
export { newMatchId };

// final order: anyone who left is last; then most kills, then fewest deaths; equal = same place
// (the server ranks the same way)
export function standings(rows) { return rankRows([...rows]); }

// spawn points: evenly spaced on a circle around the middle of the map, facing inward
export function spawnPoint(i, n, radius = V.spawnRadius) {
  const a = (i / Math.max(1, n)) * Math.PI * 2;
  const x = Math.sin(a) * radius, z = Math.cos(a) * radius;
  return { x, z, yaw: Math.atan2(x, z) };            // forward (0,0,-1) turned by yaw points at the middle
}
// respawn: of 8 points on the circle, the one farthest from every living opponent
export function safestSpawn(others, radius = V.spawnRadius) {
  let best = spawnPoint(0, 8, radius), bestD = -1;
  for (let i = 0; i < 8; i++) {
    const s = spawnPoint(i, 8, radius);
    let d = Infinity;
    for (const o of others) d = Math.min(d, Math.hypot(o.pos.x - s.x, o.pos.z - s.z));
    if (d > bestD) { bestD = d; best = s; }
  }
  return best;
}

function pickWeighted(weights, rand = Math.random) {
  const entries = Object.entries(weights);
  let t = rand() * entries.reduce((s, [, w]) => s + w, 0);
  for (const [k, w] of entries) { t -= w; if (t <= 0) return k; }
  return entries[0][0];
}

export class Versus {
  constructor(coop) {
    this.c = coop;
    this.g = coop.g;
    // the protocol+state machine: host/peer are read live, so a rematch or a reconnect always gets the truth
    this.session = new MatchSession(coop.net, {
      isHost: () => this.c.isHost,
      peer: () => (this.c.net.me ? this.c.net.me.peer : 'g'),
      killsToWin: V.killsToWin,
      stateOptions: { quietAfter: V.quietAfter, awayLimit: V.awayLimit, pauseBudget: V.pauseBudget, timeLimit: V.timeLimit, hostPeer: 'h' },
    });
    this.session.onPause = p => { if (this.onPause) this.onPause(p); };
    this.session.onScore = m => { this.feed = { text: m.f, t: this.clock }; if (this.onScore) this.onScore(m); };
    this.session.onOver = m => { if (this.onOver) this.onOver(m); };
    this.session.onConsensus = (s, r) => { if (this.onConsensus) this.onConsensus(s, r); };
    this.session.onLeave = (peer, why) => {
      // a pilot left the running match (tab closed, link failed, or away/budget): the host frees the connection at
      // the end of the frame (coop.releaseDropped), so the plane, lobby row and link do not linger as a ghost who
      // is still treated as "in the room"
      if (this.c.isHost && this.c.dropped) this.c.dropped.add(peer);
    };
    this.session.onBegin = () => { if (this.onBegin) this.onBegin(); };
    this.clock = 0;
    this.deadSent = false; this.respawnT = 0;
    this.lastHit = null; this.killedBy = null; this.watch = null;
    this.dropT = V.dropEvery / 2;
    this.feed = null;
    this.dealt = new Map();
    this.missileN = 0;
  }

  get st() { return this.session; }
  get me() { return this.session.me; }
  get over() { return this.session.overInfo; }
  get paused() { return this.session.paused; }
  get rows() { return this.session.rows; }
  get timeLeft() { return this.session.timeLeft; }
  set timeLeft(v) { this.session.timeLeft = v; }
  get phase() { return this.session.phase; }
  get match() { return this.session.match; }
  get ranked() { return this.session.ranked; }
  get why() { return this.session.why; }
  get consensus() { return this.session.consensus; }
  row(peer) { return this.session.row(peer); }
  name(peer) { return this.session.name(peer); }
  present(peer) { return this.session.present(peer); }
  standings() { return this.session.standings(); }

  // how much pause each pilot has used this match (seconds, for a HUD line if wanted)
  pauseUsed(peer) { return this.session.state.pauseUsed.get(peer) || 0; }

  // a new match (everyone): players [{ peer, name, lbId }], info { match, ranked, why }
  begin(players, info = {}) {
    this.session.begin(players, info);
    this.clock = 0;
    this.deadSent = false; this.respawnT = 0;
    this.lastHit = null; this.killedBy = null; this.watch = null;
    this.dropT = V.dropEvery / 2;
    this.feed = null;
    this.dealt = new Map();
  }

  // put my plane on spawn point i of n, facing the middle
  placeAt(s) {
    const p = this.g.plane;
    p.pos.set(s.x, spawnAltitude(), s.z);
    p.quat.setFromAxisAngle(UP, s.yaw);
    p.syncMesh();
  }
  spawnSlot(i, n) { this.placeAt(spawnPoint(i, n)); }
  respawn() {
    const p = this.g.plane;
    p.reset();                                        // full hull, a couple of seconds of invulnerability
    this.placeAt(safestSpawn(this.c.teammates().filter(r => r.alive)));
    this.deadSent = false; this.lastHit = null; this.watch = null; this.killedBy = null;
    if (this.onRespawn) this.onRespawn();
  }

  // someone's bullet or missile hit me: remember who, for the kill credit
  onHit(src) {
    if (src && src.owner && src.owner !== this.me) this.lastHit = { peer: src.owner, t: this.clock };
    if (src && src.vid) this.send({ t: 'vmx', id: src.vid });      // a missile hit me: it explodes on every screen
  }

  // one of my bullets or missiles reached another player on my screen (their own game decides the real damage).
  // The totals go to the rating server with the result: a pilot who took far more hits than any plane can take
  // without going down was running a modified game (no damage), and that match is not rated.
  landed(target, dmg) {
    if (!target || !target.peer || this.over) return;
    const d = dmg >= 60 ? V.missileDamage : dmg * V.gunMul;      // missiles do 90+ in PvE terms, cannon shots 16 or less
    this.dealt.set(target.peer, (this.dealt.get(target.peer) || 0) + d);
  }
  // { pilot id: damage } for the rating server
  dealtTable() {
    const out = {};
    for (const r of this.rows) if (r.lbId && r.peer !== this.me && this.dealt.has(r.peer)) out[r.lbId] = Math.round(this.dealt.get(r.peer));
    return out;
  }

  // guests talk to the host; the host talks to everyone
  send(m) { this.session.send(m); }

  // I fired a missile at another player (main.js calls this right after weapons.fireMissile)
  missileFired(target) {
    const m = this.g.weapons.missiles[this.g.weapons.missiles.length - 1];
    if (!m || !target || !target.peer) return;
    m.vid = `${this.me}:${++this.missileN}`;
    this.send({ t: 'vms', id: m.vid, o: this.me, tg: target.peer, p: [r1(m.pos.x), r1(m.pos.y), r1(m.pos.z)], d: [r3(m.dir.x), r3(m.dir.y), r3(m.dir.z)] });
  }

  // every frame, after my plane moved and fired (nb = how many bullets I had before firing this frame)
  tick(dt, nb) {
    const g = this.g, p = g.plane;
    if (this.over) return;
    this.clock += dt;

    // my new bullets: everyone else checks them against their own plane
    const fresh = g.weapons.bullets.slice(nb);
    if (fresh.length) {
      this.send({ t: 'vsh', o: this.me, b: fresh.map(b => [[r1(b.pos.x), r1(b.pos.y), r1(b.pos.z)], [r3(b.dir.x), r3(b.dir.y), r3(b.dir.z)], r1(b.dmg * V.gunMul)]) });
    }

    // mid-air collisions with other players: each side takes the hit on its own screen
    if (p.alive) {
      if (p.ramCd > 0) p.ramCd -= dt;
      for (const r of this.c.teammates()) {
        if (!r.alive) continue;
        const rr = r.P.radius + p.P.radius;
        if (r.pos.distanceToSquared(p.pos) >= rr * rr) continue;
        // bounce apart (each game moves only its own plane), so one collision is one hit
        const n = p.pos.clone().sub(r.pos);
        if (n.lengthSq() < 1e-6) n.set(0, 1, 0);
        p.pos.copy(r.pos).addScaledVector(n.normalize(), rr + 6);
        if (p.ramCd <= 0) {
          g.onPlayerHit(V.ramDamage, 'COLLISION', { owner: r.peer });
          p.ramCd = CFG.plane.ramCooldown;
        }
      }
    }

    // I went down: report it once (with whoever hit me last, if it was recent), then respawn after a short wait
    if (!p.alive) {
      if (!this.deadSent) this.reportDeath();
      else {
        this.respawnT -= dt;
        if (this.respawnT <= 0 && !this.over) this.respawn();
      }
    }

    // the match clock: the state machine only advances it while live, so a pause freezes it for everyone
    if (this.session.paused) return;
    this.session.advance(dt);
    if (this.c.isHost) {
      if (this.session.timeLeft <= 0) { this.session.finish(EndReason.TIME); return; }
      this.dropT -= dt;
      if (this.dropT <= 0) { this.dropT = V.dropEvery; this.spawnDrop(); }
    }
  }

  reportDeath() {
    const p = this.g.plane;
    this.deadSent = true;
    this.respawnT = V.respawnDelay;
    const k = this.lastHit && this.clock - this.lastHit.t <= V.creditWindow ? this.lastHit.peer : null;
    this.killedBy = k;
    this.watch = k ? this.c.remotes.get(k) || null : null;     // watch whoever got me until I am back
    if (this.c.isHost) this.onDeath('h', k, p.deathCause);
    else this.send({ t: 'vdead', k, c: p.deathCause || '' });
  }

  /* ---------------- pause / away / budget ----------------
     A game in a hidden tab stops. Only your own game counts hits on your plane, so a hidden player can't be hit
     (and a hidden host stops the clock and the other planes). So the whole match pauses for everyone while one
     pilot's game is quiet: nobody can move, shoot or be hit, and the clock stops. Back within awayLimit seconds =
     it goes on; quiet longer, or pausing more than pauseBudget seconds in total = that pilot left (a loss).
     The rules are MatchState.observe; MatchSession turns its events into reliable messages and HUD updates. */
  observeQuiet(dt, quiet) { return this.session.observe(dt, quiet); }

  // host: a power-up near the middle of the fight (between the living players)
  spawnDrop(rand = Math.random) {
    const g = this.g;
    if (g.drops.list.length >= V.maxDrops) return null;
    const alive = [g.plane, ...this.c.teammates()].filter(x => x.alive);
    if (!alive.length) return null;
    const c = new THREE.Vector3();
    for (const a of alive) c.add(a.pos);
    c.multiplyScalar(1 / alive.length);
    c.x += (rand() - 0.5) * 800; c.z += (rand() - 0.5) * 800;
    c.y = Math.max(c.y, spawnAltitude() - 60);
    return g.drops.spawn(c, pickWeighted(V.dropWeights, rand));
  }

  // host: someone went down. The eid makes the call idempotent: the same reliable 'vdead' twice adds one death.
  onDeath(victim, killer, cause, eid = null) { return this.session.score(victim, killer, cause, eid); }

  applyScore(m) { return this.session._applyScore(m); }

  // host: the match is over (someone reached the kill count, the clock ran out, or everyone else left)
  finish(reason) { this.session.finish(reason); }
  applyOver(m) { this.session.applyOver(m); }

  // leaving can't be stopped (a tab can always be closed), so in a running match it counts as a loss:
  // the player stays on the table, marked as left, and is placed last. The host leaving ends the match.
  get leavingLoses() { return this.ranked && !this.over && this.c.active && this.c.versus; }
  playerLeft(peer, why = LeaveReason.LEFT) { this.session.leave(peer, why); }

  // the table the server needs for the rating: [{ id, kills, deaths, left }] (null if someone has no pilot id)
  result() { return this.session.result(); }

  onMessage(from, m) {
    const g = this.g;
    switch (m.t) {
      case 'vsh':
        this.session.relay(m, from);
        if (m.o === this.me || !Array.isArray(m.b)) return;
        for (const b of m.b.slice(0, 64)) g.weapons.addPvpShot(b[0], b[1], Math.min(b[2], CFG.gun.damage * 3), m.o);
        return;
      case 'vms': {
        this.session.relay(m, from);
        if (m.o === this.me) return;
        const mine = m.tg === this.me;
        const target = mine ? g.plane : this.c.remotes.get(m.tg);
        if (!target) return;
        g.weapons.addPvpMissile({ pos: new THREE.Vector3(...m.p), dir: new THREE.Vector3(...m.d), target, dmg: V.missileDamage, owner: m.o, mine, vid: m.id });
        return;
      }
      case 'vmx': {                                     // that missile hit its target: remove my copy of it
        this.session.relay(m, from);
        const w = g.weapons;
        for (const list of [w.pvpMissiles, w.missiles]) {
          for (let i = list.length - 1; i >= 0; i--) if (list[i].vid === m.id) { w.scene.remove(list[i].mesh); list.splice(i, 1); }
        }
        return;
      }
      default:
        if (m.t && m.t[0] === 'v') this.session.handle(from, m);   // vpause / vresume / vdead / vscore / vover / vresult
    }
  }
}

export { EndReason, LeaveReason };
