import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addStain, clearStains, createStains, decodeWetness, encodeWetness, MAX_STAIN_RADIUS,
  orderedStains, restoreStains, wetnessSnapshot,
} from '../public/src/wetness.js';
import { deserializeLook, serializeLook } from '../public/src/ui.js';

const point = (x, y, z) => ({ x, y, z });

test('dry clears every coordinate, not just the weight', () => {
  const marks = createStains(4);
  let cursor = 0;
  cursor = addStain(marks, cursor, point(.1, .5, .05), .04).cursor;
  cursor = addStain(marks, cursor, point(-.2, .3, .07), .03).cursor;
  assert.equal(wetnessSnapshot(marks, cursor).length, 2);
  clearStains(marks);
  assert.deepEqual(marks, [
    { x: 0, y: 0, z: 0, w: 0 }, { x: 0, y: 0, z: 0, w: 0 },
    { x: 0, y: 0, z: 0, w: 0 }, { x: 0, y: 0, z: 0, w: 0 },
  ]);
  assert.deepEqual(wetnessSnapshot(marks, cursor), []);
  // Drying also rewinds the ring, so a splash afterwards starts a fresh shape.
  cursor = 0;
  const after = addStain(marks, cursor, point(.3, .6, .02), .05);
  assert.deepEqual(
    { x: marks[0].x, y: marks[0].y, z: marks[0].z, w: marks[0].w },
    { x: .3, y: .6, z: .02, w: .05 },
  );
  assert.equal(after.cursor, 1);
});

test('dry resets the ring cursor so the next splashes refill from the start', () => {
  const marks = createStains(3);
  let cursor = 0;
  for (const x of [.1, .2, .3, .4]) cursor = addStain(marks, cursor, point(x, .5, .1), .04).cursor;
  assert.equal(cursor, 1);
  clearStains(marks);
  cursor = 0;
  const first = addStain(marks, cursor, point(.5, .5, .1), .04);
  assert.equal(first.cursor, 1);
  assert.equal(first.mark.x, .5);
});

test('a full ring buffer overwrites the oldest mark instead of dropping the new one', () => {
  const marks = createStains(3);
  let cursor = 0;
  for (const x of [.10, .20, .30]) cursor = addStain(marks, cursor, point(x, .5, .1), .04).cursor;
  assert.deepEqual(orderedStains(marks, cursor).map(m => m.x), [.10, .20, .30]);
  cursor = addStain(marks, cursor, point(.40, .5, .1), .04).cursor;
  assert.deepEqual(orderedStains(marks, cursor).map(m => m.x), [.20, .30, .40]);
  cursor = addStain(marks, cursor, point(.50, .5, .1), .04).cursor;
  assert.deepEqual(orderedStains(marks, cursor).map(m => m.x), [.30, .40, .50]);
  // The newest splash is always present.
  assert.equal(orderedStains(marks, cursor).at(-1).x, .50);
});

test('nearby splashes grow the same mark instead of consuming a slot', () => {
  const marks = createStains(4);
  let cursor = 0;
  cursor = addStain(marks, cursor, point(.10, .50, .10), .04).cursor;
  cursor = addStain(marks, cursor, point(.105, .50, .10), .05).cursor;
  assert.equal(cursor, 1);
  assert.equal(orderedStains(marks, cursor).length, 1);
  assert.ok(Math.abs(marks[0].w - .0565) < 1e-9);
  for (let i = 0; i < 40; i++) cursor = addStain(marks, cursor, point(.10, .50, .10), .05).cursor;
  assert.equal(marks[0].w, MAX_STAIN_RADIUS);
});

test('a splash after every slot is reused still lands on top of the visual stack', () => {
  const marks = createStains(2);
  let cursor = 0;
  for (const x of [.10, .20, .30, .40]) cursor = addStain(marks, cursor, point(x, .5, .1), .04).cursor;
  const snapshot = wetnessSnapshot(marks, cursor);
  assert.deepEqual(snapshot.map(m => m.x), [.30, .40]);
});

test('share payload round-trips coordinates and radii', () => {
  const marks = createStains(6);
  let cursor = 0;
  for (const [x, y, z, r] of [[.0123, .4567, -.0345, .046], [-.1, .29, .08, .031]]) {
    cursor = addStain(marks, cursor, point(x, y, z), r).cursor;
  }
  const text = encodeWetness(wetnessSnapshot(marks, cursor));
  const decoded = decodeWetness(text);
  assert.equal(decoded.length, 2);
  assert.deepEqual(decoded[0].x, .0123);
  assert.deepEqual(decoded[1].z, .08);
  const restored = createStains(6);
  const next = restoreStains(restored, decoded);
  assert.deepEqual(wetnessSnapshot(restored, next), decoded);
  assert.equal(next, 2);
});

test('share payload keeps the order of the ring from oldest to newest', () => {
  const marks = createStains(3);
  let cursor = 0;
  for (const x of [.1, .2, .3, .4]) cursor = addStain(marks, cursor, point(x, .5, .1), .04).cursor;
  assert.deepEqual(decodeWetness(encodeWetness(wetnessSnapshot(marks, cursor))).map(m => m.x), [.2, .3, .4]);
});

test('encoding an empty set produces no marks and decodes to none', () => {
  const marks = createStains(4);
  assert.equal(encodeWetness(wetnessSnapshot(marks, 0)), '');
  assert.deepEqual(decodeWetness(''), []);
  assert.deepEqual(decodeWetness('-'), []);
  assert.deepEqual(decodeWetness(undefined), []);
});

test('malformed wetness is rejected rather than guessed at', () => {
  for (const bad of [
    'oops', '1,2,3', '1,2,3,4,5', '1,2,3,NaN', '1,2,3,0', '1,2,3,-.4',
    '1,2,3,.05;4,5', '1,2,3,.05;;', '1e400,2,3,.05', '99,2,3,.05',
  ]) {
    assert.equal(decodeWetness(bad), null, `expected ${bad} to be rejected`);
  }
});

test('the share link carries wetness per leg and restores it', () => {
  const state = {
    pose: 'step', scene: 'studio', backdrop: 'lilac',
    legs: [
      { length: 'thigh', cuff: 'lace', garter: false, material: 'sheer', denier: 40,
        pattern: 'none', color: 'ink', secret: 'none', wetColor: null },
      { length: 'thigh', cuff: 'lace', garter: false, material: 'sheer', denier: 40,
        pattern: 'none', color: 'ink', secret: 'none', wetColor: null },
    ],
  };
  const wetness = [
    [{ x: .012345, y: .456789, z: .07, r: .046 }],
    [],
  ];
  const hash = '#look=' + serializeLook(state, wetness);
  const look = deserializeLook(hash);
  assert.equal(look.pose, 'step');
  assert.deepEqual(look.wetness[0], wetness[0]);
  assert.deepEqual(look.wetness[1], []);
});

test('a link without the wetness fields is a normal dry look', () => {
  const legacy = '#look=1~step~studio~lilac~thigh.lace.0.sheer.40.none.ink.none.-~thigh.lace.0.sheer.40.none.ink.none.-';
  const look = deserializeLook(legacy);
  assert.ok(look);
  assert.deepEqual(look.wetness, [[], []]);
});

test('a malformed wetness field falls back to a dry look instead of throwing', () => {
  for (const tail of ['~garbage', '~1,2,3~-', '~1,2,3,.05;oops~-', '~~']) {
    const hash = '#look=1~step~studio~lilac~thigh.lace.0.sheer.40.none.ink.none.-~thigh.lace.0.sheer.40.none.ink.none.-' + tail;
    const look = deserializeLook(hash);
    assert.ok(look, `expected ${tail} to still parse`);
    assert.deepEqual(look.wetness, [[], []]);
  }
});

test('a legacy link can be upgraded in place with wetness', () => {
  const legacy = '#look=1~step~studio~lilac~thigh.lace.0.sheer.40.none.ink.none.-~thigh.lace.0.sheer.40.none.ink.none.-';
  const look = deserializeLook(legacy);
  const upgraded = deserializeLook('#look=' + serializeLook(state(look), [[{ x: .1, y: .5, z: .1, r: .04 }], []]));
  assert.equal(upgraded.wetness[0].length, 1);
  assert.deepEqual(upgraded.legs, look.legs);
});

function state(look) {
  return { pose: look.pose, scene: look.scene, backdrop: look.backdrop, legs: look.legs };
}
