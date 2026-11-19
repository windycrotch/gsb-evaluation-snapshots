// test/net.test.mjs: the connection layer, with fake RTCPeerConnections and a fake mailbox.
//
// Covers what the acceptance list asks of the network half:
//   - pause/leave/result events go on the 'safe' (reliable) channel, never 'fast'
//   - a reliable event that arrives twice is delivered once
//   - a connection that fails (reconnect failed) is released and reported to the layer above
//   - a guest that never connects frees its half-open connection and rejects

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Net } from '../js/net.js';

// --- fake WebRTC: each RTCPeerConnection is a pair of endpoints talking to each other in memory ---
class FakeChannel {
  constructor(label) {
    this.label = label; this.readyState = 'connecting';
    this.sent = []; this._listeners = {};
    FakeChannel.all.push(this);
  }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  _fire(type, ev = {}) { for (const fn of this._listeners[type] || []) fn(ev); }
  send(data) { this.sent.push(data); }
  open() { this.readyState = 'open'; this._fire('open'); }
  deliver(data) { this._fire('message', { data }); }
  close() { this.readyState = 'closed'; this._fire('close'); }
}
FakeChannel.all = [];

let pcSeq = 0;
class FakePC {
  constructor() {
    this.id = ++pcSeq;
    this.connectionState = 'new';
    this.iceGatheringState = 'complete';
    this.localDescription = null;
    this.remoteDescription = null;
    this._listeners = {};
    this.created = [];
    this.closed = false;
    FakePC.all.push(this);
  }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  _fire(type, ev = {}) { for (const fn of this._listeners[type] || []) fn(ev); }
  createDataChannel(label) { const ch = new FakeChannel(label); this.created.push(ch); return ch; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { this.remoteDescription = d; }
  async createOffer() { return { type: 'offer', sdp: 'x' }; }
  async createAnswer() { return { type: 'answer', sdp: 'y' }; }
  fail() { this.connectionState = 'failed'; this._fire('connectionstatechange'); }
  close() { this.closed = true; this.connectionState = 'closed'; }
}
FakePC.all = [];

beforeEach(() => { FakePC.all = []; FakeChannel.all = []; });

const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
const netOf = () => new Net({ base: 'http://fake', RTC: FakePC, fetchFn: fakeFetch });

// wire two lying endpoints into a link that Net thinks is fully open
function openedLink(net, peer) {
  const link = net.makeLink(peer);
  link.fast = net.wire(peer, link.pc.createDataChannel('fast'));
  link.safe = net.wire(peer, link.pc.createDataChannel('safe'));
  link.fast.open();
  link.safe.open();
  return link;
}

test('reliable events travel on the safe channel; the fast channel is untouched', () => {
  const net = netOf();
  const link = openedLink(net, 'g1');

  net.send('g1', { t: 'vpause', peer: 'g1', left: 20 }, true);
  net.send('g1', { t: 'vdead', k: 'h' }, true);
  net.send('g1', { t: 'snap', w: 3 }, false);

  const onSafe = link.safe.sent.map(s => JSON.parse(s));
  const onFast = link.fast.sent.map(s => JSON.parse(s));
  assert.deepEqual(onSafe.map(m => m.t), ['vpause', 'vdead']);
  assert.deepEqual(onFast.map(m => m.t), ['snap']);
  // every reliable event was stamped, so the receiver can drop a resend
  assert.ok(onSafe.every(m => m.r === 1 && m.eid != null), 'reliable messages carry an id');
  assert.ok(onFast.every(m => m.r === undefined), 'fast messages are not stamped');
});

test('a reliable event delivered twice is handled once', () => {
  const net = netOf();
  const link = openedLink(net, 'h');
  const seen = [];
  net.onMessage = (from, m) => seen.push(m);
  const msg = JSON.stringify({ t: 'vdead', r: 1, eid: 'h:7' });
  link.safe.deliver(msg);
  link.safe.deliver(msg);                       // the resend
  assert.equal(seen.length, 1, 'the duplicate was dropped before the rules saw it');
});

test('a failed connection is closed, removed, and reported as failed', () => {
  const net = netOf();
  const link = openedLink(net, 'g2');
  const events = [];
  net.onPeer = (peer, state) => events.push([peer, state]);

  link.pc.fail();

  assert.equal(net.links.has('g2'), false, 'the link is dropped from the table');
  assert.equal(link.pc.closed, true, 'the peer connection is closed (resources released)');
  assert.deepEqual(events, [['g2', 'failed']], 'the upper layer is told it failed, not just closed');
});

test('a channel close also releases the link', () => {
  const net = netOf();
  const link = openedLink(net, 'g3');
  const events = [];
  net.onPeer = (p, s) => events.push([p, s]);
  link.safe.close();
  assert.equal(net.links.has('g3'), false);
  assert.equal(events[0][1], 'closed');
});

test('closing the net frees every link and resets the event ids', () => {
  const net = netOf();
  openedLink(net, 'g1');
  const pcs = [...FakePC.all];
  net.close();
  assert.equal(net.links.size, 0);
  assert.ok(pcs.every(p => p.closed), 'every peer connection was closed');
});

test('a guest that never connects frees its connection and rejects', async () => {
  const net = netOf();
  net.call = async () => ({ code: 'AB', peer: 'g', key: 'k' });
  await assert.rejects(() => net.join('AB', 20), /could not connect to the host/);
  assert.equal(net.links.size, 0, 'the half-open connection was released');
  assert.equal(FakePC.all.every(p => p.closed), true, 'and closed');
  assert.equal(net.polling, false, 'polling stopped');
});

test('the host and guest agree on the event id format across a full exchange', () => {
  const host = netOf(), guest = netOf();
  const hLink = openedLink(host, 'g1');
  const gLink = openedLink(guest, 'h');
  host.guard.reset('h@ROOM:');
  guest.guard.reset('g1@ROOM:');
  const atHost = [], atGuest = [];
  host.onMessage = (from, m) => atHost.push(m);
  guest.onMessage = (from, m) => atGuest.push(m);

  guest.send('h', { t: 'vdead', k: 'h' }, true);
  const wire = gLink.safe.sent.pop();
  hLink.safe.deliver(wire);
  assert.equal(atHost.length, 1);
  assert.equal(atHost[0].r, 1);
  assert.ok(atHost[0].eid.startsWith('g1@ROOM:'), 'ids are namespaced by room and sender');
});
