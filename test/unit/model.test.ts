// The pure helpers the views rely on: preview windowing and reel order.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isBeforePreview, isPastPreview, nextIndex, previewRemaining } from '../../src/discover/model.js';

describe('preview window', () => {
  const w = { startSec: 30, durationSec: 60 };

  it('counts down to the end of the window, never below zero or above its length', () => {
    assert.equal(previewRemaining(w, 30), 60);
    assert.equal(previewRemaining(w, 75), 15);
    assert.equal(previewRemaining(w, 200), 0);
    assert.equal(previewRemaining(w, 0), 60, 'a seek back before the window must not show 1:30 left');
  });

  it('decreases linearly while inside the window', () => {
    const at = (t: number) => previewRemaining(w, t);
    assert.equal(at(30), 60);
    assert.equal(at(45), 45);
    assert.equal(at(60), 30);
    assert.equal(at(89.5), 0.5);
    // equal steps in playback time subtract equal seconds
    assert.equal(at(40) - at(50), 10);
    assert.equal(at(50) - at(60), 10);
  });

  it('reports the full window length for any position before it, never more', () => {
    for (const t of [-20, 0, 10, 29, 29.999]) {
      assert.equal(previewRemaining(w, t), 60, `at ${t} the remaining time must be the window length`);
    }
  });

  it('is exactly zero from the end of the window onwards', () => {
    for (const t of [90, 90.001, 120, 400]) {
      assert.equal(previewRemaining(w, t), 0, `at ${t} nothing of the window remains`);
    }
  });

  it('treats a seek back before the window as outside it, allowing a second of slack', () => {
    assert.equal(isBeforePreview(w, 0), true);
    assert.equal(isBeforePreview(w, 28.9), true);
    assert.equal(isBeforePreview(w, 29.5), false);
    assert.equal(isBeforePreview(w, 60), false);
  });

  it('allows exactly one second of keyframe-alignment slack at the window boundary', () => {
    // startSec (30) minus the 1s slack = 29: strictly below is "before", at/above is inside.
    assert.equal(isBeforePreview(w, 28.999), true);
    assert.equal(isBeforePreview(w, 29), false, '29s is exactly one second before the start');
    assert.equal(isBeforePreview(w, 30), false);
    // At startSec zero the slack threshold is -1: inside the slack counts as in,
    // an earlier position is genuinely before the (zero-based) window.
    assert.equal(isBeforePreview({ startSec: 0 }, 0), false);
    assert.equal(isBeforePreview({ startSec: 0 }, -0.5), false);
    assert.equal(isBeforePreview({ startSec: 0 }, -5), true);
  });

  it('ends exactly at start + duration, including after a seek past it', () => {
    assert.equal(isPastPreview(w, 89.9), false);
    assert.equal(isPastPreview(w, 90), true);
    assert.equal(isPastPreview(w, 400), true);
  });

  it('keeps the countdown and the end judgement consistent at the boundary', () => {
    // The first position isPastPreview accepts is the same position where the
    // countdown reaches zero, so the chip and the end card never disagree.
    const end = w.startSec + w.durationSec;
    assert.equal(isPastPreview(w, end), true);
    assert.equal(previewRemaining(w, end), 0);
    assert.equal(isPastPreview(w, end - 0.001), false);
    assert.ok(previewRemaining(w, end - 0.001) > 0);
  });
});

describe('nextIndex', () => {
  it('wraps forwards and backwards, and handles an empty list', () => {
    assert.equal(nextIndex(0, 3), 1);
    assert.equal(nextIndex(2, 3), 0);
    assert.equal(nextIndex(0, 3, -1), 2);
    assert.equal(nextIndex(5, 3, 0), 2);
    assert.equal(nextIndex(0, 0), 0);
  });
});
