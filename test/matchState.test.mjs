// test/matchState.test.mjs: acceptance tests for the online match state machine.
//
// Run with:  node --test test/
//
// These drive the real rules (js/matchState.js + js/matchSession.js + js/reliable.js) through fake connections and a
// fake clock — no browser, no three.js, no wall-clock timers. Each `test()` maps to one acceptance path:
//   - a normal pause that resumes on time
//   - away past the limit = a loss (last place)
//   - total pause over the budget = a loss, even with short breaks
//   - the host leaving ends the match for everyone
//   - a duplicate reliable message scores once
//   - a dropped connection frees its resources and leaves the present list
//   - a result only counts when two pilots still present agree

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MatchState, Phase, EndReason, LeaveReason, ResultConsensus } from '../js/matchState.js';
import { MatchSession } from '../js/matchSession.js';
import { FakeClock, FakeHub } from './fakeNet.mjs';
import { ReliableGuard } from '../js/reliable.js';

const PLAYERS = [
  { peer: 'h', name: 'Host', lbId: 1 },
  { peer: 'g1', name: 'Red', lbId: 2 },
  { peer: 'g2', name: 'Blue', lbId: 3 },
];

// a 3-player room: host + two guests. Nothing ticks the match clock unless a test asks for it: MatchSession.advance
// is called by versus.tick, and the fake clock here only measures quiet time.
function room(t, opts = {}) {
  const clock = new FakeClock(0.1);
  const hub = new FakeHub(clock);
  const info = { match: 'm1', ranked: true, why: '' };
  const host = hub.add('h', { isHost: true, players: PLAYERS, info, killsToWin: opts.killsToWin ?? 5 });
  const g1 = hub.add('g1', { isHost: false, players: PLAYERS, info, killsToWin: opts.killsToWin ?? 5 });
  const g2 = hub.add('g2', { isHost: false, players: PLAYERS, info, killsToWin: opts.killsToWin ?? 5 });
  // the host measures every guest's quiet and applies the rules exactly as coop.hostTick does
  host._tick = (quiet = new Map()) => {
    clock.step();
    host.advance(clock.dt);            // the match clock (versus.tick does this for a live, unpaused match)
    host.observe(clock.dt, quiet);
    return host;
  };
  // the guest measures only the host
  g1._tick = (quiet = new Map()) => { clock.step(); g1.advance(clock.dt); g1.observe(clock.dt, quiet); };
  g2._tick = (quiet = new Map()) => { clock.step(); g2.advance(clock.dt); g2.observe(clock.dt, quiet); };
  return { clock, hub, host, g1, g2 };
}

// the quiet map the host builds in coop.hostTick: everyone who has not reported in for q seconds
const quietFor = (peers, q) => new Map(peers.map(p => [p, q]));

/* ------------------------------------------------------------------ */
test('a normal pause freezes the clock for everyone, then resumes', () => {
  const { clock, hub, host, g1, g2 } = room();

  // 1 s in, nothing is paused and the clock is running
  for (let i = 0; i < 10; i++) host._tick(quietFor(['g1', 'g2'], 0));
  assert.equal(host.phase, Phase.LIVE);
  const before = host.timeLeft;
  assert.ok(before < 300, 'clock advanced while live');

  // g1 backgrounded: after quietAfter, the host pauses the match and tells everyone
  for (let i = 0; i < 30; i++) host._tick(new Map([['g1', i * 0.1], ['g2', 0]]));
  assert.ok(host.paused, 'host paused for the quiet guest');
  assert.equal(host.paused.peer, 'g1');
  assert.equal(host.paused.name, 'Red');

  // the pause reached both guests as a reliable message
  assert.equal(g1.paused && g1.paused.peer, 'g1');
  assert.equal(g2.paused && g2.paused.peer, 'g1');

  // while paused the match clock does not move
  const frozen = host.timeLeft;
  for (let i = 0; i < 20; i++) host._tick(new Map([['g1', 3 + i * 0.1], ['g2', 0]]));
  assert.equal(host.timeLeft, frozen, 'clock frozen during pause');

  // g1 comes back: the host lifts the pause and everything resumes
  host._tick(quietFor(['g1', 'g2'], 0));
  assert.equal(host.paused, null);
  assert.equal(g1.paused, null);
  assert.equal(g2.paused, null);
  host._tick(quietFor(['g1', 'g2'], 0));
  assert.ok(host.timeLeft < frozen, 'clock ticked again after resume');
});

test('away past the limit = a loss, placed last, and the clock keeps going', () => {
  const { host, g1, g2 } = room();

  // g2 goes quiet and never comes back: past awayLimit the host gives up on them
  let secs = 0;
  while (!host.state.row('g2').left && secs < 60) { secs += 0.1; host._tick(new Map([['g1', 0], ['g2', secs]])); }

  const left = host.state.row('g2');
  assert.ok(left.left, 'g2 is marked as left');
  assert.equal(left.leftWhy, LeaveReason.AWAY);
  // g2 is last, behind the two pilots who stayed
  const order = host.standings();
  assert.equal(order[order.length - 1].peer, 'g2');
  assert.ok(order.find(r => r.peer === 'h').place < order[order.length - 1].place);

  // the guests saw the same verdict through the reliable score message
  assert.ok(g1.state.row('g2').left, 'guest saw g2 leave');
  assert.equal(host.phase, Phase.LIVE, 'two pilots remain, so the match goes on');
});

test('total pause over the budget = a loss, even across several short breaks', () => {
  const { host, g1 } = room();
  const budget = host.state.cfg.pauseBudget;       // 60 s
  const away = host.state.cfg.awayLimit;           // 30 s

  // many short breaks, each well under awayLimit, but adding up past pauseBudget
  let spent = 0;
  for (let round = 0; round < 20 && !host.state.row('g1').left; round++) {
    // g1 quiet for 8 s, then back: about 8 s of pause each round (g2 keeps reporting)
    for (let i = 0; i < 80; i++) host._tick(new Map([['g1', 2 + i * 0.1], ['g2', 0]]));
    spent += 8;
    if (host.state.row('g1').left) break;
    host._tick(quietFor(['g1', 'g2'], 0));          // g1 is back
    for (let i = 0; i < 20; i++) host._tick(quietFor(['g1', 'g2'], 0));
  }
  assert.ok(host.state.row('g1').left, 'the repeat pauser was given up on');
  assert.equal(host.state.row('g1').leftWhy, LeaveReason.BUDGET);
  assert.ok(spent >= budget - away, 'it took at least most of the budget');
  assert.equal(host.phase, Phase.LIVE, 'two pilots still in: the match goes on');
});

test('the host leaving ends the match for everyone, with a reason', () => {
  const { host, g1, g2 } = room();

  // a few seconds of normal play, then the host's game is gone (its snapshots stop)
  for (let i = 0; i < 20; i++) host._tick(quietFor(['g1', 'g2'], 0));

  // each guest measures the host; after awayLimit it counts as the host leaving and ends the match
  let q = 0;
  while (!g1.overInfo && q < 60) { q += 0.1; g1._tick(new Map([['h', q]])); }
  assert.ok(g1.overInfo, 'guest 1 ended the match');
  assert.equal(g1.overInfo.reason, EndReason.HOST_LEFT);

  // the second guest reaches the same verdict
  q = 0;
  while (!g2.overInfo && q < 60) { q += 0.1; g2._tick(new Map([['h', q]])); }
  assert.ok(g2.overInfo);
  assert.equal(g2.overInfo.reason, EndReason.HOST_LEFT);
  // the host is last: nobody can continue without the host
  const rows = g1.overInfo.rows;
  assert.equal(rows[rows.length - 1].peer, 'h');
});

test('a duplicate reliable message scores once', () => {
  const clock = new FakeClock(0.1);
  const hub = new FakeHub(clock);
  const info = { match: 'm2', ranked: true, why: '' };
  const host = hub.add('h', { isHost: true, players: PLAYERS, info });
  const g1 = hub.add('g1', { isHost: false, players: PLAYERS, info });
  hub.add('g2', { isHost: false, players: PLAYERS, info });

  // g1 sends "I went down, Red killed me"
  g1.send({ t: 'vdead', k: 'h', c: 'ENEMY FIRE' });
  const death = host.state.row('g1');
  assert.equal(death.deaths, 1);
  assert.equal(host.state.row('h').kills, 1);
  const sent = hub.log.filter(l => l.to === 'h' && l.t === 'vdead').map(l => l.msg).pop();
  assert.ok(sent && sent.eid != null, 'the reliable event carries an id');

  // the same reliable message arrives again (a resend): the receiver's guard drops it before the rules see it
  hub.duplicateTo('h', 'g1', sent);
  assert.equal(host.state.row('g1').deaths, 1, 'still one death');
  assert.equal(host.state.row('h').kills, 1, 'still one kill');

  // even if the guard is bypassed, the state machine itself is idempotent on the same eid
  host.state.score('g1', 'h', 'ENEMY FIRE', sent.eid);
  assert.equal(host.state.row('g1').deaths, 1, 'score() ignores the duplicate eid');
  // a genuinely new death still counts
  host.state.score('g1', 'h', 'ENEMY FIRE', 'fresh-eid');
  assert.equal(host.state.row('g1').deaths, 2);
});

test('a dropped connection frees its resources and leaves the present list', () => {
  const clock = new FakeClock(0.1);
  const hub = new FakeHub(clock);
  const info = { match: 'm3', ranked: true, why: '' };
  const host = hub.add('h', { isHost: true, players: PLAYERS, info });
  hub.add('g1', { isHost: false, players: PLAYERS, info });
  hub.add('g2', { isHost: false, players: PLAYERS, info });

  // a stand-in for coop.js's world: one remote plane per present guest. A leave of any kind queues the peer,
  // then releaseDropped (the end-of-frame step) frees their plane and link.
  const world = { planes: new Map([['g1', {}], ['g2', {}]]), links: new Set(['g1', 'g2']), dropped: new Set() };
  host.onLeave = peer => world.dropped.add(peer);
  const releaseDropped = () => {
    for (const peer of [...world.dropped]) { world.dropped.delete(peer); world.planes.delete(peer); world.links.delete(peer); }
  };

  // g1's link fails
  hub.disconnectGuest('g1', 'h');
  releaseDropped();

  assert.equal(world.planes.has('g1'), false, 'their plane is removed');
  assert.equal(world.links.has('g1'), false, 'their connection is released');
  assert.equal(host.present('g1'), false, 'they are no longer in the present list');
  assert.equal(host.present('g2'), true, 'the others are untouched');
  const row = host.state.row('g1');
  assert.ok(row.left, 'they are marked as having left (a loss)');
  assert.equal(host.phase, Phase.LIVE, 'two pilots remain and the match continues');
});

test('the match ends when the connection loss takes everyone else out', () => {
  const clock = new FakeClock(0.1);
  const hub = new FakeHub(clock);
  const info = { match: 'm4', ranked: true, why: '' };
  const host = hub.add('h', { isHost: true, players: PLAYERS, info });
  hub.add('g1', { isHost: false, players: PLAYERS, info });
  hub.add('g2', { isHost: false, players: PLAYERS, info });

  hub.disconnectGuest('g1', 'h');
  assert.equal(host.phase, Phase.LIVE);
  hub.disconnectGuest('g2', 'h');
  assert.ok(host.overInfo, 'host ended the match once alone');
  assert.equal(host.overInfo.reason, EndReason.LEFT);
  assert.equal(host.overInfo.rows.filter(r => !r.left).length, 1, 'one pilot still present');
});

test('a result only counts when two pilots still present agree', () => {
  // disagreeing reports stay pending, never a win
  const c = new ResultConsensus(2);
  const table = [{ peer: 'h', kills: 3, deaths: 1, left: false }, { peer: 'g1', kills: 1, deaths: 3, left: false }];
  const changed = [{ peer: 'h', kills: 0, deaths: 0, left: false }, { peer: 'g1', kills: 0, deaths: 0, left: false }];
  assert.equal(c.report('h', table).status, 'pending');
  assert.equal(c.report('g1', changed).status, 'disputed');
  assert.equal(c.result, null, 'nothing decided on disagreement');

  // one more agreeing report settles it
  const c2 = new ResultConsensus(2);
  c2.report('h', table);
  assert.equal(c2.report('g1', table).status, 'agreed');
  assert.deepEqual(c2.result.map(r => r.peer), ['h', 'g1']);
});

test('the confirmation exchange runs end to end and stays pending alone', () => {
  const clock = new FakeClock(0.1);
  const hub = new FakeHub(clock);
  const info = { match: 'm5', ranked: true, why: '' };
  const players = [{ peer: 'h', name: 'Host', lbId: 1 }, { peer: 'g1', name: 'Red', lbId: 2 }];
  const host = hub.add('h', { isHost: true, players, info });
  const g1 = hub.add('g1', { isHost: false, players, info });

  const hostSeen = [], guestSeen = [];
  host.onConsensus = s => hostSeen.push(s.status);
  g1.onConsensus = s => guestSeen.push(s.status);

  // the clock runs out: both pilots report their (identical) final table
  host.finish(EndReason.TIME);
  assert.ok(host.overInfo && g1.overInfo);
  // each side passes through 'pending' before the other's report arrives, then reaches 'agreed'
  assert.equal(hostSeen[0], 'pending', 'one report is not enough');
  assert.equal(hostSeen[hostSeen.length - 1], 'agreed', 'the host heard the guest back');
  assert.equal(guestSeen[guestSeen.length - 1], 'agreed', 'the guest heard the host');
  assert.equal(host.consensus.snapshot().agree, 2);
});

test('a pilot who left is not asked to confirm and cannot confirm for others', () => {
  const clock = new FakeClock(0.1);
  const hub = new FakeHub(clock);
  const info = { match: 'm6', ranked: true, why: '' };
  const host = hub.add('h', { isHost: true, players: PLAYERS, info });
  hub.add('g1', { isHost: false, players: PLAYERS, info });
  hub.add('g2', { isHost: false, players: PLAYERS, info });

  // g2 leaves; the two pilots still present (h and g1) confirm the result and agree
  host.leave('g2', LeaveReason.LEFT);
  assert.equal(host.phase, Phase.LIVE);
  host.finish(EndReason.KILLS);
  assert.equal(host.consensus.snapshot().status, 'agreed', 'the two present pilots agreed');
  assert.equal(host.consensus.snapshot().reports, 2, 'the leaver did not report');
  // a report supposedly from the leaver changes nothing
  host.onResult('g2', host.standings());
  assert.equal(host.consensus.snapshot().reports, 2, 'a leaver\'s confirmation is ignored');
});

test('the host backgrounded pauses everyone, and the host coming back resumes', () => {
  const { host, g1, g2 } = room();
  // normal play for a moment
  for (let i = 0; i < 10; i++) host._tick(quietFor(['g1', 'g2'], 0));

  // the host's game is hidden: no snapshots leave it. Each guest sees the silence and pauses ITS view.
  for (let i = 0; i < 30; i++) {
    const q = i * 0.1;
    g1._tick(new Map([['h', q]]));
    g2._tick(new Map([['h', q]]));
  }
  assert.ok(g1.paused, 'guest 1 paused while the host is silent');
  assert.equal(g1.paused.peer, 'h');
  assert.ok(g2.paused, 'guest 2 paused too');
  const frozen = g1.timeLeft;
  g1._tick(new Map([['h', 3.5]]));
  g2._tick(new Map([['h', 3.5]]));
  assert.equal(g1.timeLeft, frozen, 'the guest clock is frozen while paused');

  // the host returns (snapshots flow again): both guests lift the pause
  g1._tick(new Map([['h', 0]]));
  g2._tick(new Map([['h', 0]]));
  assert.equal(g1.paused, null);
  assert.equal(g2.paused, null);
  g1._tick(new Map([['h', 0]]));
  assert.ok(g1.timeLeft < frozen, 'the guest clock runs again after the host is back');
});

test('a 4-player room: one silent pilot pauses all four, and only that pilot is out after the limit', () => {
  const players = [...PLAYERS, { peer: 'g3', name: 'Green', lbId: 4 }];
  const clock = new FakeClock(0.1);
  const hub = new FakeHub(clock);
  const info = { match: 'm7', ranked: true, why: '' };
  const host = hub.add('h', { isHost: true, players, info });
  const guests = ['g1', 'g2', 'g3'].map(p => hub.add(p, { isHost: false, players, info }));

  // g3 goes quiet; the other three keep reporting
  const quiet = new Map([['g1', 0], ['g2', 0], ['g3', 0]]);
  let q = 0;
  while (q < 5) { q += 0.1; clock.step(); quiet.set('g3', q); host.advance(0.1); host.observe(0.1, quiet); }
  assert.ok(host.paused && host.paused.peer === 'g3', 'the whole room paused for g3');
  for (const g of guests) assert.equal(g.paused && g.paused.peer, 'g3', `${g._hubPeer} paused too`);

  // past the limit, only g3 is marked as left; the other three are still playing
  while (!host.state.row('g3').left && q < 60) { q += 0.1; clock.step(); quiet.set('g3', q); host.advance(0.1); host.observe(0.1, quiet); }
  assert.equal(host.state.row('g3').left, true);
  assert.equal(host.phase, Phase.LIVE);
  assert.equal(host.state.activePlayers().length, 3);
  assert.deepEqual(host.standings().map(r => r.peer).slice(-1), ['g3'], 'g3 is last');
});

test('reliable ids are per sender and bounded', () => {
  const a = new ReliableGuard('a:');
  const b = new ReliableGuard('b:');
  const m1 = a.stamp({ t: 'x' });
  const m2 = b.stamp({ t: 'x' });
  assert.notEqual(m1.eid, m2.eid, 'ids do not collide across senders');
  const guard = new ReliableGuard();
  assert.equal(guard.accept(m1, 'a'), true);
  assert.equal(guard.accept(m1, 'a'), false, 'a resend from the same sender is dropped');
  assert.equal(guard.accept(m1, 'b'), true, 'the same id from another sender is a different event');
});

test('a paused pilot whose link closes lifts the pause and is placed last', () => {
  const clock = new FakeClock(0.1);
  const hub = new FakeHub(clock);
  const info = { match: 'm8', ranked: true, why: '' };
  const host = hub.add('h', { isHost: true, players: PLAYERS, info });
  hub.add('g1', { isHost: false, players: PLAYERS, info });
  hub.add('g2', { isHost: false, players: PLAYERS, info });

  // g2 goes quiet and the room pauses for them
  let q = 0;
  while (!host.paused && q < 10) { q += 0.1; host.advance(0.1); host.observe(0.1, new Map([['g1', 0], ['g2', q]])); }
  assert.ok(host.paused && host.paused.peer === 'g2');

  // before the away limit, g2's connection closes outright (a closed tab / lost network)
  hub.disconnectGuest('g2', 'h');
  assert.equal(host.paused, null, 'the freeze lifts with the pilot who caused it');
  assert.equal(host.phase, Phase.LIVE, 'the match goes on for the others');
  const rows = host.standings();
  assert.equal(rows[rows.length - 1].peer, 'g2', 'g2 is last');
});
