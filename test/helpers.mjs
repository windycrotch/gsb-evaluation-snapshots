// test/helpers.mjs: an in-memory star network (one host, guests) plus a fake game object, so Coop and Versus
// can run their whole session lifecycle — pause, drop, reconnect, forfeit — without a browser or WebRTC.

import { Vector3, Quaternion } from './three.stub.mjs';

// ---------------- fake game object (the `g` Coop expects) ----------------
export function fakePlane() {
  return {
    pos: new Vector3(0, 340, 0), quat: new Quaternion(), alive: true, hp: 150, maxHp: 150, speed: 170,
    P: { radius: 12 }, ramCd: 0, deathCause: '', missiles: 4,
    forward(out = new Vector3()) { return out.set(0, 0, -1); },
    up(out = new Vector3()) { return out.set(0, 1, 0); },
    reset() { this.alive = true; this.hp = this.maxHp; },
    syncMesh() {}, heal(n) { this.hp = Math.min(this.maxHp, this.hp + n); },
    hurt(dmg, cause) { this.hp -= dmg; if (this.hp <= 0) { this.alive = false; this.deathCause = cause; } return true; },
  };
}

export function fakeGame(net) {
  const toasts = [];
  const g = {
    scene: { add() {}, remove() {} },
    plane: fakePlane(),
    weapons: {
      bullets: [], missiles: [], pvpMissiles: [], enemyShots: [], onEnemyFire: null,
      addRemoteBullet() {}, addPvpShot() {}, addPvpMissile() {}, fireEnemy() {}, fireMissile() {},
    },
    waves: { enemies: [], wave: 0, playerCount: 1, setTargets() {} },
    drops: { list: [], geo: null, take() { return null; }, spawn() { return null; }, mat() { return null; }, update() { return []; } },
    fx: { pulse() {} },
    hud: { message() {} },
    net,
    Weather: { onBolt: null, remoteBolts: false, addBolt() {}, wind: new Vector3() },
    applyPowerup() { return ''; },
    onEnemyHit() {}, onPlayerHit() {},
    launches: [], leaves: 0, toasts,
    launch(map, slot, n) { this.launches.push({ map, slot, n }); },
    leave() { this.leaves++; },
    toast(t) { toasts.push(t); },
    score() { return 0; },
    respawn() {},
  };
  return g;
}

// ---------------- fake net: same API Coop uses, delivered over an in-memory hub ----------------
let msgId = 0;

export class Hub {
  constructor() {
    this.nets = new Map();          // peer -> FakeNet
    this.links = new Set();         // 'a|b' (a < b)
    this.cut = new Set();           // links whose delivery is suspended (messages dropped, not queued)
  }
  key(a, b) { return [a, b].sort().join('|'); }
  add(peer) { const n = new FakeNet(this, peer); this.nets.set(peer, n); return n; }
  connect(a, b) {
    this.links.add(this.key(a, b));
    for (const [x, y] of [[a, b], [b, a]]) {
      const n = this.nets.get(x);
      if (n && n.onPeer) n.onPeer(y, 'open');
    }
  }
  connected(a, b) { return this.links.has(this.key(a, b)) && !this.cut.has(this.key(a, b)); }
  // the connection dies (network dropped): both sides get 'closed', like Net.drop does
  drop(a, b) {
    const k = this.key(a, b);
    if (!this.links.delete(k)) return;
    for (const [x, y] of [[a, b], [b, a]]) {
      const n = this.nets.get(x);
      if (n && n.onPeer) n.onPeer(y, 'closed');
    }
  }
  deliver(from, to, msg) {
    if (!this.connected(from, to)) return false;
    const n = this.nets.get(to);
    if (n && n.onMessage) n.onMessage(from, JSON.parse(JSON.stringify(msg)));
    return true;
  }
}

export class FakeNet {
  constructor(hub, peer) {
    this.hub = hub;
    this.me = { code: 'TEST', peer, key: 'k' + peer };
    this.onMessage = null;
    this.onPeer = null;
    this.polling = false;
    this.closed = false;
    this.reconnects = 0;
    this.failReconnect = false;      // tests: simulate a host that never answers
  }
  get isHost() { return this.me.peer === 'h'; }
  get code() { return this.me.code; }
  auth() { return { ...this.me }; }
  openPeers() {
    const out = [];
    for (const p of this.hub.nets.keys()) if (p !== this.me.peer && this.hub.connected(this.me.peer, p)) out.push(p);
    return out;
  }
  send(peer, msg) { return this.hub.deliver(this.me.peer, peer, msg); }
  broadcast(msg, _reliable = false, except = null) {
    for (const p of this.openPeers()) if (p !== except) this.send(p, msg);
  }
  drop(peer) { this.hub.drop(this.me.peer, peer); }
  close() {
    this.closed = true;
    for (const p of this.openPeers()) this.hub.drop(this.me.peer, p);
  }
  startPolling() { this.polling = true; }
  stopPolling() { this.polling = false; }
  async call() { return {}; }
  async reconnect() {
    if (this.failReconnect) throw new Error('could not reconnect to the host');
    this.reconnects++;
    this.hub.connect(this.me.peer, 'h');
    return this.me.peer;
  }
}

// run fn(dt) in dt steps for `seconds` of game time
export function run(seconds, dt, fn) {
  for (let t = 0; t < seconds; t += dt) fn(dt);
}

// a versus room: host + n guests, all wired to a hub, with fake games. CFG.versus is shrunk so tests run fast.
export async function versusRoom(Coop, guests = 1, cfgOverrides = {}) {
  const { CFG } = await import('../js/config.js');
  const saved = { ...CFG.versus };
  Object.assign(CFG.versus, { quietAfter: 0.5, awayLimit: 3, pauseBudget: 6, reconnectEvery: 0.05, timeLimit: 300, killsToWin: 5, ...cfgOverrides });

  const hub = new Hub();
  const host = { net: hub.add('h') };
  host.g = fakeGame(host.net);
  host.coop = new Coop(host.g);
  host.coop.role = 'host'; host.coop.mode = 'versus';
  host.coop.me = { name: 'Host', parts: [], lbId: 1, rankOk: true };

  const players = [{ peer: 'h', name: 'Host', parts: [], lbId: 1 }];
  const guestList = [];
  for (let i = 1; i <= guests; i++) {
    const peer = 'p' + i;
    const net = hub.add(peer);
    const g = fakeGame(net);
    const coop = new Coop(g);
    coop.role = 'guest'; coop.mode = 'versus';
    coop.me = { name: 'Guest' + i, parts: [], lbId: i + 1, rankOk: true };
    hub.connect(peer, 'h');
    coop.onMessage('h', { t: 'lobby', list: players.map(p => ({ peer: p.peer, name: p.name })), mode: 'versus' });
    host.coop.onMessage(peer, { t: 'hello', name: 'Guest' + i, parts: [], lbId: i + 1, rankOk: true });
    players.push({ peer, name: 'Guest' + i, parts: [], lbId: i + 1 });
    guestList.push({ peer, net, g, coop });
  }
  // host starts the match; everyone begins
  const vsInfo = { match: 'm1', ranked: false, why: '' };
  for (const gst of guestList) gst.coop.onMessage('h', { t: 'start', map: null, players, mode: 'versus', vs: vsInfo });
  host.coop.begin(null, players, 'versus', vsInfo);

  const all = [host, ...guestList];
  // one frame, like main.js: the room ticks, and the versus rules tick while nobody is paused
  const step = (c, dt, isHost) => {
    if (isHost) c.hostTick(dt); else c.guestTick(dt, 0);
    if (!c.vs.paused) c.vs.tick(dt, 0);
  };
  const tick = dt => { step(host.coop, dt, true); for (const gst of guestList) step(gst.coop, dt, false); };
  return { hub, host, guests: guestList, all, tick, restore: () => Object.assign(CFG.versus, saved) };
}
