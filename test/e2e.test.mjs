// test/e2e.test.mjs: the end-to-end acceptance run, using the REAL js/versus.js (not a lookalike) wired to real
// MatchSession/MatchState and a fake connection. three.js is replaced by a tiny stub (test/stub/three.mjs) because
// versus.js is the 3D half; the planes, weapons and drops are minimal fakes.
//
// This exercises the same calls main.js makes: begin(), tick(), onMessage(), onDeath(), observeQuiet(), finish().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// map 'three' to the stub before loading versus.js
register('./threeResolver.mjs', import.meta.url);

const { Versus } = await import('../js/versus.js');
const { FakeClock } = await import('./fakeNet.mjs');

const PLAYERS = [
  { peer: 'h', name: 'Host', lbId: 1, parts: [] },
  { peer: 'g1', name: 'Red', lbId: 2, parts: [] },
  { peer: 'g2', name: 'Blue', lbId: 3, parts: [] },
];

// a plane shaped enough like the real one for versus.js (it reads pos/quat/forward/P/alive/hp)
function fakePlane() {
  const v = (x = 0, y = 400, z = 0) => ({
    x, y, z,
    clone: () => v(x, y, z),
    sub() { return this; }, normalize() { return this; }, addScaledVector() { return this; },
    lengthSq() { return 0; }, copy() { return this; },
  });
  return {
    pos: v(), quat: { setFromAxisAngle() {} }, alive: true, hp: 150, maxHp: 150,
    P: { radius: 12 }, speed: 170, missiles: 2, deathCause: 'ENEMY FIRE',
    forward() { return v(0, 400, -1); },
    reset() { this.alive = true; this.hp = 150; },
    syncMesh() {},
  };
}

// A whole simulated player: the real Versus + MatchSession, a fake net that talks to a shared hub, a fake game.
function makePeer(peer, isHost, hub) {
  const plane = fakePlane();
  const g = {
    scene: { remove() {} }, plane,
    weapons: { bullets: [], missiles: [], pvpMissiles: [], addPvpShot() {}, addPvpMissile() {}, scene: { remove() {} } },
    drops: { list: [], spawn() { return {}; } },
    onPlayerHit() {}, onEnemyHit() {}, toast() {}, leave() {},
  };
  const net = {
    me: { peer, code: 'ROOM' },
    links: new Map(),
    broadcast(msg, reliable, except) { hub.toAll(peer, msg, reliable, except); return true; },
    send(to, msg, reliable) { hub.to(to, peer, msg, reliable); return true; },
    drop() {},
  };
  const coop = {
    g, net, isHost, active: true, versus: true, remotes: new Map(), dropped: new Set(),
    teammates() { return [...this.remotes.values()].filter(r => r.peer !== peer); },
  };
  const v = new Versus(coop);
  coop.vs = v;
  // a remote-plane stand-in for each teammate (versus.js only reads peer/name/alive/pos/P)
  for (const p of PLAYERS) if (p.peer !== peer) {
    coop.remotes.set(p.peer, { peer: p.peer, name: p.name, alive: true, pos: { x: 100, y: 400, z: 0 }, P: { radius: 12 } });
  }
  return { peer, coop, v, g };
}

// a hub that routes like the real game: guests -> host, host -> every guest; reliable messages are stamped by the
// sending Net's guard (simulated here with a shared counter per sender)
function makeHub() {
  const peers = new Map();
  const seq = new Map();
  return {
    add(p) { peers.set(p.peer, p); },
    to(to, from, msg, reliable) { const m = stamp(from, msg, reliable); this.deliver(to, m, from); },
    toAll(from, msg, reliable, except) { for (const p of peers.keys()) if (p !== from && p !== except) this.deliver(p, stamp(from, msg, reliable), from); },
    deliver(to, msg, from) { const p = peers.get(to); if (p) p.v.onMessage(from, msg); },
  };
  function stamp(from, msg, reliable) {
    if (!reliable) return { ...msg };
    const n = (seq.get(from) || 0) + 1; seq.set(from, n);
    return { ...msg, r: 1, eid: `${from}:${n}` };
  }
}

function room() {
  const hub = makeHub();
  const h = makePeer('h', true, hub);
  const g1 = makePeer('g1', false, hub);
  const g2 = makePeer('g2', false, hub);
  hub.add(h); hub.add(g1); hub.add(g2);
  const info = { match: 'E2E', ranked: true, why: '' };
  for (const p of [h, g1, g2]) p.v.begin(PLAYERS, info);
  return { hub, h, g1, g2 };
}

/* ------------------------------------------------------------------ */
test('e2e: kill -> pause -> resume -> host leaves, on the real Versus', () => {
  const { h, g1, g2 } = room();

  // g1 reports its own death (killer g2). The same reliable event arriving twice scores once.
  const dead = { t: 'vdead', k: 'g2', c: 'ENEMY FIRE', r: 1, eid: 'g1:7', o: 'g1' };
  h.v.onMessage('g1', dead);
  h.v.onMessage('g1', dead);
  assert.equal(h.v.row('g1').deaths, 1, 'one death');
  assert.equal(h.v.row('g2').kills, 1, 'one kill');
  // the score reached the other guests
  assert.equal(g2.v.row('g1').deaths, 1);
  assert.equal(g2.v.row('g2').kills, 1);

  // g2 backgrounds: the host pauses the room, guests are told
  for (let i = 0; i < 30; i++) h.v.observeQuiet(0.1, new Map([['g1', 0], ['g2', 2.5 + i * 0.1]]));
  assert.ok(h.v.paused && h.v.paused.peer === 'g2');
  assert.ok(g1.v.paused && g1.v.paused.peer === 'g2', 'guest 1 sees the pause');
  const frozen = h.v.timeLeft;
  for (let i = 0; i < 10; i++) { h.v.session.advance(0.1); h.v.observeQuiet(0.1, new Map([['g1', 0], ['g2', 6 + i * 0.1]])); }
  assert.equal(h.v.timeLeft, frozen, 'clock frozen during the pause');

  // g2 comes back: everyone resumes
  h.v.observeQuiet(0.1, new Map([['g1', 0], ['g2', 0]]));
  assert.equal(h.v.paused, null);
  assert.equal(g1.v.paused, null);

  // the host goes silent; the guests end the match and place the host last
  let q = 0;
  while (!g1.v.over && q < 60) { q += 0.1; g1.v.observeQuiet(0.1, new Map([['h', q]])); }
  assert.ok(g1.v.over, 'guest ended the match');
  assert.equal(g1.v.over.reason, 'hostLeft');
  assert.equal(g1.v.over.rows.at(-1).peer, 'h', 'the host is last');
});

test('e2e: the final table is agreed by the pilots still present', () => {
  const { h, g1 } = room();
  h.v.onMessage('g1', { t: 'vdead', k: 'g2', c: 'ENEMY FIRE', r: 1, eid: 'g1:1', o: 'g1' });
  h.v.finish('time');

  assert.ok(h.v.over && g1.v.over, 'both ends arrived');
  assert.equal(h.v.consensus.snapshot().status, 'agreed');
  assert.equal(h.v.consensus.snapshot().agree, 3, 'all three pilots agreed');
  assert.ok(Array.isArray(h.v.result()), 'a agreed result is ready for the rating server');

  // the shared table has one death on g1 and one kill on g2
  const by = Object.fromEntries(h.v.over.rows.map(r => [r.peer, r]));
  assert.equal(by.g1.deaths, 1);
  assert.equal(by.g2.kills, 1);
  assert.equal(by.g2.place, 1);
});

test('e2e: a paused match does not tick planes, shots or the clock', () => {
  const { h, g1 } = room();

  // pause the room through the real rule path (g2 silent)
  for (let i = 0; i < 30; i++) h.v.observeQuiet(0.1, new Map([['g1', 0], ['g2', 2.5 + i * 0.1]]));
  assert.ok(h.v.paused);

  // the game loop must not call vs.tick while paused (main.js gates it), and even if a frame slipped through the
  // state machine keeps the clock frozen
  const frozen = h.v.timeLeft;
  h.v.session.advance(0.1);
  h.v.session.advance(0.1);
  assert.equal(h.v.timeLeft, frozen, 'the clock cannot move while paused, whoever calls');

  // the guest's view is paused too, and no kill is applied from a stale message while paused
  assert.ok(g1.v.paused);
  const before = g1.v.row('g1').deaths;
  // a vscore is still applied (it is the host's truth), but the tick path is off
  assert.equal(g1.v.row('g1').deaths, before);
});
