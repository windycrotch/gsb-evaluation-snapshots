// test/coop.test.mjs: the session lifecycle end to end — normal match, background pause, drop and
// reconnect, forfeit on timeout, host leaving, concurrent reconnects and late old messages.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coop } from '../js/coop.js';
import { CFG } from '../js/config.js';
import { versusRoom, run, Hub, fakeGame } from './helpers.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- baseline: an undisturbed match behaves exactly as before ----------

test('baseline: a normal versus match — state flows, kills are scored, nobody pauses', async (t) => {
  const room = await versusRoom(Coop, 2);
  t.after(room.restore);
  const { host, guests, tick } = room;

  run(2, 0.1, tick);
  assert.equal(host.coop.vs.paused, null);
  assert.ok(guests[0].coop.lastSeq > 0, 'guests apply the host snapshots');

  // p1 goes down, the host scores it and everyone sees the same table
  host.coop.onMessage('p1', { t: 'vdead', k: 'h', c: 'GUN' });
  assert.equal(host.coop.vs.row('p1').deaths, 1);
  assert.equal(host.coop.vs.row('h').kills, 1);
  for (const g of guests) {
    assert.equal(g.coop.vs.row('p1').deaths, 1);
    assert.equal(g.coop.vs.row('h').kills, 1);
  }
  assert.equal(host.coop.vs.over, null);
  assert.equal(host.coop.lobby.size, 2);
});

// ---------- hidden tab: pause for everyone, resume on return ----------

test('a hidden tab pauses the match for everyone with a countdown, returning resumes it', async (t) => {
  const room = await versusRoom(Coop, 2);
  t.after(room.restore);
  const { host, guests, tick } = room;
  const [g1, g2] = guests;

  // g1's tab goes to the background: its game loop stops, no more state updates
  run(1.5, 0.1, dt => { host.coop.hostTick(dt); g2.coop.guestTick(dt, 0); });

  assert.ok(host.coop.vs.paused, 'host paused the match');
  assert.equal(host.coop.vs.paused.peer, 'p1');
  assert.ok(host.coop.vs.paused.left > 0 && host.coop.vs.paused.left <= CFG.versus.awayLimit);
  assert.ok(g2.coop.vs.paused, 'the other guest sees the pause');
  assert.equal(g2.coop.vs.paused.peer, 'p1');

  // g1 comes back to the foreground: state updates flow again, the pause lifts everywhere
  run(1, 0.1, tick);
  assert.equal(host.coop.vs.paused, null);
  assert.equal(g2.coop.vs.paused, null);
  assert.equal(host.coop.vs.over, null);
});

// ---------- connection drop and reconnect within the limit ----------

test('a dropped player rejoins within the limit: snapshot, same seat, no double scoring', async (t) => {
  const room = await versusRoom(Coop, 2);
  t.after(room.restore);
  const { hub, host, guests, tick } = room;
  const [g1, g2] = guests;

  // some score on the table first: p1 shot the host down once
  host.coop.onMessage('h', { t: 'vdead', k: 'p1', c: 'GUN' });
  run(0.5, 0.1, tick);
  assert.equal(g1.coop.vs.row('p1').kills, 1);

  // p1's connection drops
  hub.drop('h', 'p1');
  assert.ok(host.coop.away.has('p1'), 'host keeps the seat while waiting');
  assert.ok(host.coop.net.polling, 'host listens for the reconnect offer');
  run(0.5, 0.1, dt => { host.coop.hostTick(dt); g2.coop.guestTick(dt, 0); });
  assert.ok(host.coop.vs.paused, 'the match pauses for everyone');

  await sleep(0);                                    // g1's reconnect attempt settles
  assert.equal(g1.coop.reconnecting, false, 'reconnect finished');
  assert.equal(g1.net.reconnects, 1);
  assert.ok(!host.coop.away.has('p1'), 'host cleared the away mark');
  assert.ok(!host.coop.net.polling, 'nobody away: mailbox polling stops again');

  // the rejoining player got the snapshot: same table, same clock, same members
  assert.equal(g1.coop.vs.row('p1').kills, 1, 'score survived the reconnect');
  assert.equal(g1.coop.vs.row('h').deaths, 1);
  assert.equal(g1.coop.vs.rows.length, 3, 'no duplicate row for the rejoining player');
  assert.equal(host.coop.lobby.size, 2, 'no duplicate lobby seat');
  assert.equal(host.coop.remotes.size, 2);
  assert.equal(g1.coop.remotes.size, 2, 'the rejoining guest still sees both opponents');
  assert.ok(Math.abs(g1.coop.vs.timeLeft - host.coop.vs.timeLeft) < 2, 'clock in sync');

  // and the match simply goes on
  run(1, 0.1, tick);
  assert.equal(host.coop.vs.paused, null);
  assert.equal(host.coop.vs.over, null);
  assert.equal(g1.coop.vs.row('p1').left, undefined);
});

// ---------- away too long: counted as a loss ----------

test('away past the limit: marked left, placed last, the match goes on without them', async (t) => {
  const room = await versusRoom(Coop, 2, { awayLimit: 0.5, reconnectEvery: 0.05 });
  t.after(room.restore);
  const { hub, host, guests, tick } = room;
  const [g1, g2] = guests;
  g1.net.failReconnect = true;                       // they never make it back

  hub.drop('h', 'p1');
  run(2, 0.1, dt => { host.coop.hostTick(dt); g2.coop.guestTick(dt, 0); });

  const row = host.coop.vs.row('p1');
  assert.ok(row.left, 'host marked the missing player as left');
  assert.ok(!host.coop.remotes.has('p1'), 'their plane is gone from the host world');
  assert.ok(!host.coop.lobby.has('p1'), 'their seat is free');
  assert.ok(g2.coop.vs.row('p1').left, 'the remaining guest sees them as left');
  assert.ok(!g2.coop.remotes.has('p1'), 'their plane is gone from the other screens too');
  assert.equal(host.coop.vs.over, null, 'two pilots are still in: the match continues');

  // final order: the one who left is last
  host.coop.vs.finish('time');
  const places = host.coop.vs.over.rows;
  assert.equal(places[places.length - 1].peer, 'p1');
  assert.ok(g2.coop.vs.over, 'the guest got the final table');
});

// ---------- the host leaves: a clear end signal and cleanup ----------

test('the host says goodbye: guests get a clear end signal and the room closes', async (t) => {
  const room = await versusRoom(Coop, 2);
  t.after(room.restore);
  const { hub, host, guests } = room;

  host.coop.end();
  for (const g of guests) {
    assert.ok(g.coop.vs.over, 'guest got the end of the match');
    assert.equal(g.coop.vs.over.reason, 'left');
    assert.ok(g.coop.vs.row('h').left, 'the host counts as having left');
    assert.ok(g.g.toasts.some(x => /host/i.test(x)), 'the guest was told why');
  }
  await sleep(500);                                  // the goodbye goes out, then the host closes
  assert.ok(host.net.closed);
  assert.equal(hub.links.size, 0, 'every connection is cleaned up');
});

test('team mode: the host closing the room ends the game for the guest', async () => {
  const hub = new Hub();
  const hNet = hub.add('h'), gNet = hub.add('p1');
  const hg = fakeGame(hNet), gg = fakeGame(gNet);
  const host = new Coop(hg), guest = new Coop(gg);
  host.role = 'host'; host.mode = 'team'; host.me = { name: 'Host', parts: [] };
  guest.role = 'guest'; guest.mode = 'team'; guest.me = { name: 'G', parts: [] };
  hub.connect('h', 'p1');

  host.end();
  assert.equal(gg.leaves, 1, 'the guest is taken out of the game');
  assert.ok(gg.toasts.some(x => /host ended/i.test(x)));
  await sleep(500);
  assert.equal(hub.links.size, 0);
});

// ---------- two players drop and reconnect at the same time; old packets arrive late ----------

test('concurrent reconnects and late old messages: snapshots win, nobody is duplicated', async (t) => {
  const room = await versusRoom(Coop, 2);
  t.after(room.restore);
  const { hub, host, guests, tick } = room;
  const [g1, g2] = guests;

  host.coop.onMessage('h', { t: 'vdead', k: 'p1', c: 'GUN' });   // p1 has 1 kill
  run(0.5, 0.1, tick);
  const staleSeq = Math.floor(host.coop.seq / 2);              // a seq from before the reconnects
  const staleRows = [{ peer: 'h', name: 'Host', kills: 0, deaths: 0 }, { peer: 'p1', name: 'Guest1', kills: 0, deaths: 0 }, { peer: 'p2', name: 'Guest2', kills: 0, deaths: 0 }];

  // both guests lose their connection at the same time, both come back
  hub.drop('h', 'p1');
  hub.drop('h', 'p2');
  assert.equal(host.coop.away.size, 2);
  await sleep(0);
  await sleep(0);
  assert.equal(g1.coop.reconnecting, false);
  assert.equal(g2.coop.reconnecting, false);
  assert.equal(host.coop.away.size, 0, 'both seats reclaimed');

  // nobody was counted twice
  assert.equal(host.coop.vs.rows.length, 3);
  assert.equal(host.coop.lobby.size, 2);
  assert.equal(host.coop.remotes.size, 2);
  assert.equal(g1.coop.vs.rows.length, 3);
  assert.equal(g2.coop.vs.rows.length, 3);

  // both got the current snapshot
  assert.equal(g1.coop.vs.row('p1').kills, 1);
  assert.equal(g2.coop.vs.row('p1').kills, 1);

  // now packets queued BEFORE the disconnect arrive late: they must not overwrite the snapshot
  g1.coop.onMessage('h', { t: 'vscore', seq: staleSeq, rows: staleRows, tl: 999, f: 'old', v: null, k: null });
  g1.coop.onMessage('h', { t: 'snap', seq: staleSeq, w: 9, sc: 777, en: [], dr: [], pl: [] });
  assert.equal(g1.coop.vs.row('p1').kills, 1, 'stale vscore ignored');
  assert.notEqual(g1.coop.vs.timeLeft, 999);
  assert.equal(g1.coop.score, 0, 'stale snap ignored');
  assert.notEqual(g1.coop.wave, 9);

  // and the match goes on for everyone
  run(1, 0.1, tick);
  assert.equal(host.coop.vs.paused, null);
  assert.equal(host.coop.vs.over, null);
});

// ---------- a guest who never comes back, then the match simply ends ----------

test('after a forfeit the remaining players finish the match normally', async (t) => {
  const room = await versusRoom(Coop, 1, { awayLimit: 0.5 });
  t.after(room.restore);
  const { hub, host, guests, tick } = room;
  const [g1] = guests;
  g1.net.failReconnect = true;

  hub.drop('h', 'p1');
  run(2, 0.1, tick);

  assert.ok(host.coop.vs.row('p1').left);
  assert.ok(host.coop.vs.over, 'only the host remains: the match ends');
  assert.equal(host.coop.vs.over.reason, 'left');
  assert.equal(host.coop.vs.over.rows[0].peer, 'h', 'the pilot who stayed wins');
});
