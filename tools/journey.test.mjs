// Unit tests for the deterministic portal journey state machine. No DOM,
// no renderer: the whole lifecycle is plain state transitions and tickets.
//
//   node --test tools/journey.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJourneyState, JOURNEY_IDLE, JOURNEY_ACTIVE, RESTORE_HISTORY, RESTORE_FAILURE } from '../engine/journey.js';

test('begins in IDLE and accepts exactly one journey', () => {
  const j = createJourneyState();
  assert.equal(j.state, JOURNEY_IDLE);
  assert.equal(j.active, false);
  const ticket = j.begin();
  assert.equal(typeof ticket, 'number');
  assert.equal(j.active, true);
  assert.equal(j.state, JOURNEY_ACTIVE);
  assert.equal(j.current(ticket), true);
});

test('concurrent begins are ignored, never queued', () => {
  const j = createJourneyState();
  const first = j.begin();
  const second = j.begin();
  const third = j.begin();
  assert.equal(second, null);
  assert.equal(third, null);
  // Only the first ticket is current.
  assert.equal(j.current(first), true);
  assert.equal(j.current(first + 1), false);
  // Stale and bogus tickets are rejected.
  assert.equal(j.current(first - 1), false);
  assert.equal(j.current(9999), false);
});

test('a failed journey ends the slot and allows a fresh begin', () => {
  const j = createJourneyState();
  const first = j.begin();
  assert.equal(j.end(first), true);
  assert.equal(j.active, false);
  // Ending twice, or ending a stale ticket, does nothing.
  assert.equal(j.end(first), false);
  assert.equal(j.end(first + 1), false);
  const second = j.begin();
  assert.notEqual(second, null);
  assert.equal(second, first + 2, 'end() bumps the epoch so old callbacks stay stale');
  assert.equal(j.current(first), false);
  assert.equal(j.current(second), true);
});

test('history restore invalidates an in-flight journey and fires onRestore', () => {
  const reasons = [];
  const j = createJourneyState({ onRestore: reason => reasons.push(reason) });
  const ticket = j.begin();
  const nextEpoch = j.restore(RESTORE_HISTORY);
  assert.equal(j.active, false);
  assert.deepEqual(reasons, [RESTORE_HISTORY]);
  assert.equal(j.current(ticket), false, 'the old journey ticket is dead after restore');
  assert.ok(nextEpoch > ticket);
  // A new journey can start on the restored page.
  const fresh = j.begin();
  assert.notEqual(fresh, null);
  assert.equal(j.current(fresh), true);
});

test('restore while IDLE still bumps the epoch (no stale callback survives)', () => {
  const reasons = [];
  const j = createJourneyState({ onRestore: reason => reasons.push(reason) });
  const ticket = j.begin();
  j.end(ticket);
  const restoredEpoch = j.restore(RESTORE_HISTORY);
  assert.equal(j.active, false);
  assert.deepEqual(reasons, [RESTORE_HISTORY]);
  assert.ok(restoredEpoch > ticket);
});

test('failure and history restore are distinguishable reasons', () => {
  const seen = [];
  const j = createJourneyState({ onRestore: r => seen.push(r) });
  j.begin();
  j.restore(RESTORE_FAILURE);
  j.begin();
  j.restore(RESTORE_HISTORY);
  assert.deepEqual(seen, [RESTORE_FAILURE, RESTORE_HISTORY]);
});

test('repeated failure-retry cycles each get a unique ticket', () => {
  const j = createJourneyState();
  const tickets = [];
  for (let i = 0; i < 5; i++) {
    const ticket = j.begin();
    assert.notEqual(ticket, null);
    tickets.push(ticket);
    assert.equal(j.end(ticket), true);
  }
  assert.equal(new Set(tickets).size, 5, 'every attempt has a distinct epoch ticket');
  assert.equal(j.active, false);
});
