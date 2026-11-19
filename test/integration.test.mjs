// test/integration.test.mjs: the seam between the game objects and the match rules.
//
// versus.js is the 3D half and coop.js owns the room, so neither can be imported without three.js and the DOM.
// What this file checks is the glue that was extracted out of them: the same quiet-time map coop.hostTick builds,
// the same leave->release handshake, and the same standings/HUD data versus.js exposes. Anything that needs a real
// Plane is exercised in the browser; the rules themselves are covered by matchState.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Phase, EndReason, LeaveReason } from '../js/matchState.js';
import { FakeClock, FakeHub } from './fakeNet.mjs';

const PLAYERS = [
  { peer: 'h', name: 'Host', lbId: 1 },
  { peer: 'g1', name: 'Red', lbId: 2 },
  { peer: 'g2', name: 'Blue', lbId: 3 },
];

// a lookalike for coop.js's room bookkeeping (remotes / seen / dropped) without any three.js objects
function fakeCoop(hub, peers) {
  const coop = {
    remotes: new Map(peers.map(p => [p, { peer: p, name: PLAYERS.find(x => x.peer === p).name, alive: true, removed: false,
      remove() { this.removed = true; } }])),
    lobby: new Map(peers.map(p => [p, { name: PLAYERS.find(x => x.peer === p).name }])),
    seen: new Map(),
    clock: 0,
    dropped: new Set(),
    released: [],
    toast() {},
    releasePeer(peer) {
      const r = this.remotes.get(peer);
      if (r) { r.remove(); this.remotes.delete(peer); }
      this.lobby.delete(peer);
      this.seen.delete(peer);
      this.released.push(peer);
      return (r && r.name) || 'A pilot';
    },
    // exactly the quiet map coop.hostTick builds
    quiet() {
      const q = new Map();
      for (const peer of this.remotes.keys()) q.set(peer, this.clock - (this.seen.get(peer) ?? this.clock));
      return q;
    },
    releaseDropped() {
      for (const peer of [...this.dropped]) {
        this.dropped.delete(peer);
        if (!this.remotes.has(peer) && !this.lobby.has(peer)) continue;
        this.releasePeer(peer);
      }
    },
  };
  return coop;
}

test('a silent pilot pauses the room via coop.hostTick\'s quiet map, then is released with their link', () => {
  const clock = new FakeClock(0.1);
  const hub = new FakeHub(clock);
  const info = { match: 'i1', ranked: true, why: '' };
  const host = hub.add('h', { isHost: true, players: PLAYERS, info });
  hub.add('g1', { isHost: false, players: PLAYERS, info });
  hub.add('g2', { isHost: false, players: PLAYERS, info });

  const coop = fakeCoop(hub, ['g1', 'g2']);
  // home in on the same handshake versus.js wires: a leave of type away/budget queues the peer for release
  host.onLeave = (peer, why) => { if (why !== LeaveReason.LEFT) coop.dropped.add(peer); };

  let t = 0;
  for (const p of ['g1', 'g2']) coop.seen.set(p, t);
  // 1 s of normal reports
  for (let i = 0; i < 10; i++) { t += 0.1; coop.clock = t; coop.seen.set('g1', t); coop.seen.set('g2', t); host.advance(0.1); host.observe(0.1, coop.quiet()); coop.releaseDropped(); }
  assert.equal(host.phase, Phase.LIVE);

  // g2 goes silent
  while (!host.state.row('g2').left) {
    t += 0.1; coop.clock = t; coop.seen.set('g1', t);
    host.advance(0.1); host.observe(0.1, coop.quiet()); coop.releaseDropped();
    if (t > 80) break;
  }
  assert.ok(host.paused === null, 'the pause lifted when g2 was given up on');
  assert.equal(host.state.row('g2').left, true, 'g2 is on the table as having left');
  assert.deepEqual(coop.released, ['g2'], 'g2\'s plane, lobby row and link were released');
  assert.equal(coop.remotes.has('g2'), false, 'no ghost plane remains');
  assert.equal(coop.remotes.get('g2'), undefined);
  assert.ok(coop.remotes.get('g1').removed === false, 'g1 is untouched');
});

test('a connection failure hands the peer to the release path exactly once', () => {
  const clock = new FakeClock(0.1);
  const hub = new FakeHub(clock);
  const info = { match: 'i2', ranked: true, why: '' };
  const host = hub.add('h', { isHost: true, players: PLAYERS, info });
  hub.add('g1', { isHost: false, players: PLAYERS, info });
  hub.add('g2', { isHost: false, players: PLAYERS, info });
  const coop = fakeCoop(hub, ['g1', 'g2']);
  // the handshake versus.js wires: a leave queues the peer, and coop.releaseDropped frees it at the end of the frame
  host.onLeave = peer => coop.dropped.add(peer);

  hub.disconnectGuest('g1', 'h');           // the same call coop.onPeer makes for state 'failed'
  coop.releaseDropped();
  assert.deepEqual(coop.released, ['g1']);
  assert.equal(host.state.row('g1').left, true);
  assert.equal(host.phase, Phase.LIVE, 'g2 is still in');

  hub.disconnectGuest('g1', 'h');           // a duplicate closed event must not release twice
  coop.releaseDropped();
  assert.deepEqual(coop.released, ['g1'], 'no double release');
});

test('the final table has every pilot, with places, and the leaver last', () => {
  const clock = new FakeClock(0.1);
  const hub = new FakeHub(clock);
  const info = { match: 'i3', ranked: true, why: '' };
  const host = hub.add('h', { isHost: true, players: PLAYERS, info });
  hub.add('g1', { isHost: false, players: PLAYERS, info });
  hub.add('g2', { isHost: false, players: PLAYERS, info });

  // a couple of kills, then g1 leaves, then the clock runs out
  host.score('g2', 'h', 'ENEMY FIRE', 'e1');
  host.score('g2', 'h', 'ENEMY FIRE', 'e2');
  host.leave('g1', LeaveReason.LEFT);
  host.finish(EndReason.TIME);

  const rows = host.overInfo.rows;
  assert.equal(rows.length, 3, 'every pilot stays on the table');
  assert.equal(rows[0].peer, 'h');
  assert.equal(rows[0].kills, 2);
  const byPeer = Object.fromEntries(rows.map(r => [r.peer, r]));
  assert.equal(byPeer.g1.place, 3, 'the leaver is last, behind the pilot with 0 kills');
  assert.equal(byPeer.g1.left, true);
  assert.equal(byPeer.g2.place, 2);
});
