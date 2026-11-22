// test/net.test.mjs: the connection layer — join, reconnect with the same seat, and the guarantee that
// messages from a dead connection never overwrite what the new one brings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Net } from '../js/net.js';

// ---------------- fake WebRTC ----------------
class FakeChannel {
  constructor(pc, label) { this.pc = pc; this.label = label; this.readyState = 'connecting'; this._l = {}; this.other = null; }
  addEventListener(t, f) { (this._l[t] ||= []).push(f); }
  emit(t, e = {}) { for (const f of this._l[t] || []) f(e); }
  open() { if (this.readyState !== 'open') { this.readyState = 'open'; this.emit('open'); } }
  send(data) { const o = this.other; if (o && this.readyState === 'open') setTimeout(() => o.emit('message', { data }), 0); }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed'; this.emit('close');
    if (this.other && this.other.readyState !== 'closed') { this.other.readyState = 'closed'; this.other.emit('close'); }
  }
}

class FakePC {
  constructor(hub) {
    this.hub = hub; this.id = ++hub.n; this.channels = []; this._l = {};
    this.connectionState = 'new'; this.iceGatheringState = 'complete';
    this.localDescription = null; this.remoteDescription = null; this.peer = null;
  }
  addEventListener(t, f) { (this._l[t] ||= []).push(f); }
  emit(t, e = {}) { for (const f of this._l[t] || []) f(e); }
  createDataChannel(label) { const ch = new FakeChannel(this, label); this.channels.push(ch); return ch; }
  async createOffer() { return { type: 'offer', sdp: `o${this.id}` }; }
  async createAnswer() { return { type: 'answer', sdp: `a${this.id}` }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { this.remoteDescription = d; this.hub.maybeConnect(); }
  close() {
    if (this.connectionState === 'closed') return;
    this.connectionState = 'closed'; this.emit('connectionstatechange');
    for (const ch of this.channels) ch.close();
  }
  // the network drops: both ends see the connection fail
  fail() {
    for (const pc of [this, this.peer].filter(Boolean)) {
      if (pc.connectionState === 'failed') continue;
      pc.connectionState = 'failed'; pc.emit('connectionstatechange');
      for (const ch of pc.channels) { ch.readyState = 'closed'; }
    }
  }
}

class RtcHub {
  constructor() { this.pcs = []; this.n = 0; }
  make() { const pc = new FakePC(this); this.pcs.push(pc); return pc; }
  maybeConnect() {
    for (const a of this.pcs) {
      if (a.peer || !a.localDescription || a.localDescription.type !== 'offer' || !a.remoteDescription) continue;
      const b = this.pcs.find(x => x !== a && !x.peer && x.localDescription && x.localDescription.type === 'answer' &&
        x.remoteDescription && x.remoteDescription.sdp === a.localDescription.sdp);
      if (!b) continue;
      a.peer = b; b.peer = a;
      for (const ch of a.channels) {
        const other = new FakeChannel(b, ch.label);
        b.channels.push(other);
        ch.other = other; other.other = ch;
        setTimeout(() => { b.emit('datachannel', { channel: other }); ch.open(); other.open(); }, 0);
      }
      a.connectionState = b.connectionState = 'connected';
      a.emit('connectionstatechange'); b.emit('connectionstatechange');
    }
  }
}

// ---------------- fake mailbox server (what the leaderboard Worker does for rooms) ----------------
function mailbox() {
  const rooms = new Map();
  let n = 0;
  return async function handle(path, body) {
    if (path === '/room/create') { const code = 'R' + ++n; rooms.set(code, new Map([['h', []]])); return { code, peer: 'h', key: 'kh' }; }
    if (path === '/room/join') {
      const r = rooms.get(body.code);
      if (!r) throw new Error('no such room');
      const peer = 'p' + r.size;
      r.set(peer, []);
      return { code: body.code, peer, key: 'k' + peer };
    }
    if (path === '/room/send') { rooms.get(body.code).get(body.to).push({ from: body.peer, data: body.data }); return {}; }
    if (path === '/room/recv') { const inbox = rooms.get(body.code).get(body.peer); return { messages: inbox.splice(0) }; }
    throw new Error('unknown path ' + path);
  };
}

function setup() {
  const rtc = new RtcHub();
  const server = mailbox();
  const fetchFn = async (url, opts) => {
    const path = url.replace('http://mb', '');
    try { return { ok: true, json: async () => await server(path, JSON.parse(opts.body)) }; }
    catch (e) { return { ok: false, status: 400, json: async () => ({ error: e.message }) }; }
  };
  const mk = () => new Net({ base: 'http://mb', RTC: function () { return rtc.make(); }, fetchFn });
  return { rtc, mk };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// the mailbox is polled every 900 ms; give a round trip room to happen
const settle = () => sleep(2200);

async function connectedPair() {
  const { mk } = setup();
  const host = mk(), guest = mk();
  const events = [];
  host.onPeer = (p, s) => events.push(['h', p, s]);
  guest.onPeer = (p, s) => events.push(['g', p, s]);
  const code = await host.host();
  await guest.join(code);
  return { host, guest, events };
}

test('guest joins and both sides exchange messages', async () => {
  const { host, guest, events } = await connectedPair();
  assert.equal(guest.me.peer, 'p1');
  assert.ok(events.some(e => e[0] === 'h' && e[1] === 'p1' && e[2] === 'open'));
  const got = [];
  host.onMessage = (p, m) => got.push(['h', p, m]);
  guest.onMessage = (p, m) => got.push(['g', p, m]);
  guest.send('h', { t: 'hello' }, true);
  host.send('p1', { t: 'snap' });
  await sleep(20);
  assert.deepEqual(got.find(x => x[0] === 'h')[2], { t: 'hello' });
  assert.deepEqual(got.find(x => x[0] === 'g')[2], { t: 'snap' });
  host.close(); guest.close();
});

test('reconnect keeps the same seat and kills the dead connection', async () => {
  const { host, guest, events } = await connectedPair();
  const oldHostSafe = host.links.get('p1').safe;
  const oldGuestSafe = guest.links.get('h').safe;

  // the network drops: both ends see it
  guest.links.get('h').pc.fail();
  assert.ok(events.some(e => e[0] === 'g' && e[2] === 'closed'));
  assert.ok(events.some(e => e[0] === 'h' && e[2] === 'closed'));

  // the guest comes back on the same seat
  await guest.reconnect();
  assert.equal(guest.me.peer, 'p1');
  assert.ok(events.some(e => e[0] === 'h' && e[1] === 'p1' && e[2] === 'open'));

  // messages flow again
  const got = [];
  host.onMessage = (p, m) => got.push(m);
  guest.send('h', { t: 'back' }, true);
  await sleep(20);
  assert.deepEqual(got, [{ t: 'back' }]);

  // ...but a late message on the DEAD connection's channels is dropped, not delivered
  const stale = [];
  host.onMessage = (p, m) => stale.push(m);
  oldHostSafe.emit('message', { data: JSON.stringify({ t: 'stale-from-before' }) });
  oldGuestSafe.emit('message', { data: JSON.stringify({ t: 'stale' }) });
  await sleep(20);
  assert.deepEqual(stale, []);
  host.close(); guest.close();
});

test('host replaces a zombie link when the same peer offers again', async () => {
  const { host, guest, events } = await connectedPair();
  // the guest's side dies silently (no close frame): it just builds a new connection
  const oldGuestPc = guest.links.get('h').pc;
  await guest.reconnect();                    // old link is dropped locally without a 'closed' storm
  assert.equal(guest.me.peer, 'p1');
  // the host saw the old link close and the new one open, in that order
  const seq = events.filter(e => e[0] === 'h').map(e => e[2]);
  assert.ok(seq.lastIndexOf('closed') < seq.lastIndexOf('open'), `expected closed before open, got ${seq}`);
  // and the zombie pc can no longer inject messages
  const stale = [];
  host.onMessage = (p, m) => stale.push(m);
  const zombie = oldGuestPc.channels.find(c => c.label === 'safe');
  if (zombie.other) zombie.other.emit('message', { data: JSON.stringify({ t: 'zombie' }) });
  await sleep(20);
  assert.deepEqual(stale, []);
  host.close(); guest.close();
});
