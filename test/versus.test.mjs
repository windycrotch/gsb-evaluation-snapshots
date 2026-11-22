// test/versus.test.mjs: the versus rules — final order, the rejoin snapshot, and what a reconnecting
// player sees when the match already counted them out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Versus, standings } from '../js/versus.js';
import { fakePlane } from './helpers.mjs';

function fakeCoop(isHost, peer = 'h') {
  const coop = {
    isHost, sent: [], seq: 0,
    g: { plane: fakePlane(), weapons: { bullets: [], missiles: [], pvpMissiles: [] } },
    net: { me: { peer }, broadcast(m) { coop.sent.push(m); }, send(p, m) { coop.sent.push([p, m]); } },
    teammates: () => [], remotes: new Map(), active: true,
    stamp(m) { m.seq = ++coop.seq; return m; },
  };
  return coop;
}

const PLAYERS = [
  { peer: 'h', name: 'Host', lbId: 1 },
  { peer: 'p1', name: 'Anna', lbId: 2 },
  { peer: 'p2', name: 'Bo', lbId: 3 },
];

test('standings: left is last, then kills, then fewest deaths; ties share a place', () => {
  const rows = standings([
    { peer: 'a', kills: 2, deaths: 1 },
    { peer: 'b', kills: 2, deaths: 1 },
    { peer: 'c', kills: 3, deaths: 5 },
    { peer: 'd', kills: 9, deaths: 0, left: true },
  ]);
  assert.deepEqual(rows.map(r => r.peer), ['c', 'a', 'b', 'd']);
  assert.deepEqual(rows.map(r => r.place), [1, 2, 2, 4]);
});

test('snapshot -> applySnap restores members, score, clock and pause on the rejoining side', () => {
  const hc = fakeCoop(true, 'h');
  const host = new Versus(hc);
  host.begin(PLAYERS, { match: 'm1', ranked: true, why: '' });
  host.rows.find(r => r.peer === 'h').kills = 3;
  host.rows.find(r => r.peer === 'p1').deaths = 2;
  host.timeLeft = 123.4;
  host.setPaused({ peer: 'p2', name: 'Bo', left: 17 });

  const gc = fakeCoop(false, 'p1');
  const guest = new Versus(gc);
  guest.begin(PLAYERS, { match: 'm1', ranked: true, why: '' });
  guest.applySnap(host.c.stamp({ t: 'vsnap', ...host.snapshot() }));

  assert.deepEqual(guest.rows.map(r => [r.peer, r.kills, r.deaths]), [['h', 3, 0], ['p1', 0, 2], ['p2', 0, 0]]);
  assert.equal(guest.timeLeft, 123.4);
  assert.deepEqual(guest.paused, { peer: 'p2', name: 'Bo', left: 17 });
  assert.equal(guest.match, 'm1');
  assert.equal(guest.ranked, true);
  assert.equal(guest.over, null);
});

test('snapshot carries a finished match: the rejoining player gets the final table', () => {
  const hc = fakeCoop(true, 'h');
  const host = new Versus(hc);
  host.begin(PLAYERS, { match: 'm1' });
  host.rows.find(r => r.peer === 'h').kills = 5;
  host.finish('kills');
  assert.ok(host.over);

  const gc = fakeCoop(false, 'p2');
  const guest = new Versus(gc);
  guest.begin(PLAYERS, { match: 'm1' });
  let over = null;
  guest.onOver = m => { over = m; };
  guest.applySnap({ t: 'vsnap', ...host.snapshot() });
  assert.ok(over, 'the guest sees the match end');
  assert.equal(over.reason, 'kills');
  assert.equal(guest.rows.find(r => r.peer === 'h').place, 1);
});

test('a player marked away while offline learns the match is over for them from the snapshot', () => {
  const hc = fakeCoop(true, 'h');
  const host = new Versus(hc);
  host.begin(PLAYERS, { match: 'm1' });
  host.playerLeft('p1', 'away');                       // the host counted them out

  const gc = fakeCoop(false, 'p1');
  const guest = new Versus(gc);
  guest.begin(PLAYERS, { match: 'm1' });
  let over = null;
  guest.onOver = m => { over = m; };
  guest.applySnap({ t: 'vsnap', ...host.snapshot() });
  assert.ok(over);
  assert.equal(over.reason, 'away');
  assert.ok(guest.row('p1').left);
});

test('host messages are sequence-stamped so stale ones can be dropped by the receiver', () => {
  const hc = fakeCoop(true, 'h');
  const host = new Versus(hc);
  host.begin(PLAYERS, { match: 'm1' });
  host.onDeath('p1', 'h', 'GUN');
  host.playerLeft('p2', 'away');
  host.finish('left');
  const seqs = hc.sent.filter(m => ['vscore', 'vover'].includes(m.t)).map(m => m.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.ok(seqs.every(s => typeof s === 'number'));
});

test('playerLeft: the leaver keeps their row, marked; one pilot left standing ends the match', () => {
  const hc = fakeCoop(true, 'h');
  const host = new Versus(hc);
  host.begin(PLAYERS, { match: 'm1' });
  host.playerLeft('p1');
  assert.ok(host.row('p1').left);
  assert.equal(host.over, null);                        // h and p2 still in
  host.playerLeft('p2');
  assert.ok(host.over);
  assert.equal(host.over.reason, 'left');
  assert.equal(host.over.rows.find(r => r.peer === 'h').place, 1);
});
