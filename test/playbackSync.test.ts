import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitNarrationWords,
  estimateWordIndex,
  resolveSubtitleState,
  clampToSceneTime,
  effectiveTriggerTime,
  elementEntranceProgress,
  isElementFullyEntered,
  SessionTokenSource,
  isSceneEndReached,
  sceneProgress,
} from '../src/utils/playbackSync.ts';

test('splitNarrationWords handles empty / whitespace narration', () => {
  assert.deepEqual(splitNarrationWords(undefined), []);
  assert.deepEqual(splitNarrationWords(''), []);
  assert.deepEqual(splitNarrationWords('   '), []);
  assert.deepEqual(splitNarrationWords('  one   two  '), ['one', 'two']);
});

test('estimateWordIndex follows playhead progress and never runs past the last word', () => {
  const narration = 'a b c d e';
  assert.equal(estimateWordIndex(narration, 0, 5), 0);
  assert.equal(estimateWordIndex(narration, 2.5, 5), 2);
  // At the very end the estimate stays on the final word instead of overflowing.
  assert.equal(estimateWordIndex(narration, 5, 5), 4);
  assert.equal(estimateWordIndex(narration, 99, 5), 4);
  assert.equal(estimateWordIndex('', 1, 5), -1);
});

test('resolveSubtitleState: callback wins while valid', () => {
  const state = resolveSubtitleState({
    narration: 'a b c d',
    currentTime: 0.1,
    duration: 4,
    isPlaying: true,
    callbackWordIndex: 2,
    callbackValid: true,
  });
  assert.deepEqual(state, { wordIndex: 2, fromCallback: true });
});

test('resolveSubtitleState: falls back to playhead estimate when callback invalidated', () => {
  const state = resolveSubtitleState({
    narration: 'a b c d',
    currentTime: 3,
    duration: 4,
    isPlaying: true,
    callbackWordIndex: 0,
    callbackValid: false, // e.g. after a seek or scene change
  });
  assert.equal(state.fromCallback, false);
  assert.equal(state.wordIndex, 3);
});

test('resolveSubtitleState: pause holds the word at the frozen playhead', () => {
  const state = resolveSubtitleState({
    narration: 'a b c d e f',
    currentTime: 2,
    duration: 6,
    isPlaying: false,
    callbackWordIndex: -1,
    callbackValid: false,
  });
  // progress 2/6 -> floor(0.333 * 6) = word 2
  assert.equal(state.wordIndex, 2);
  assert.equal(state.fromCallback, false);
});

test('resolveSubtitleState: out-of-range callback index is ignored', () => {
  const state = resolveSubtitleState({
    narration: 'a b',
    currentTime: 0.1,
    duration: 2,
    isPlaying: true,
    callbackWordIndex: 99, // stale index from an older, longer scene
    callbackValid: true,
  });
  assert.equal(state.fromCallback, false);
});

test('resolveSubtitleState: no narration means no highlighted word', () => {
  const state = resolveSubtitleState({
    narration: '',
    currentTime: 1,
    duration: 5,
    isPlaying: true,
    callbackWordIndex: 3,
    callbackValid: true,
  });
  assert.equal(state.wordIndex, -1);
});

test('clampToSceneTime keeps the playhead inside [0, duration]', () => {
  assert.equal(clampToSceneTime(-3, 7), 0);
  assert.equal(clampToSceneTime(3, 7), 3);
  assert.equal(clampToSceneTime(99, 7), 7);
  assert.equal(clampToSceneTime(NaN, 7), 0);
  assert.equal(clampToSceneTime(2, 0), 0);
});

test('effectiveTriggerTime clamps out-of-range element triggers to scene bounds', () => {
  // Trigger beyond the scene: appears at the final frame, never "never".
  assert.equal(effectiveTriggerTime(12, 7), 7);
  // Negative trigger: enters at scene start.
  assert.equal(effectiveTriggerTime(-1, 7), 0);
  // Normal trigger is preserved.
  assert.equal(effectiveTriggerTime(2.5, 7), 2.5);
  // Missing/invalid trigger defaults to scene start.
  assert.equal(effectiveTriggerTime(undefined, 7), 0);
  assert.equal(effectiveTriggerTime(NaN, 7), 0);
});

test('elementEntranceProgress: 0 before trigger, ramps to 1, clamps at scene end', () => {
  // Normal 0.5s entrance
  assert.equal(elementEntranceProgress(2, 1.9, 0.5, 7), 0);
  assert.ok(Math.abs(elementEntranceProgress(2, 2.25, 0.5, 7) - 0.5) < 1e-9);
  assert.equal(elementEntranceProgress(2, 3, 0.5, 7), 1);

  // A trigger clamped to the scene end renders at the final frame. Its
  // entrance progress is 0 at that instant (it only just became visible),
  // but the element is no longer stuck "never appearing".
  const clamped = effectiveTriggerTime(12, 7);
  assert.equal(clamped, 7);
  const endProgress = elementEntranceProgress(12, 7, 0.5, 7);
  assert.ok(endProgress >= 0 && endProgress <= 1);
  // With an instant (zero-length) entrance it is fully present at the end.
  assert.equal(isElementFullyEntered(12, 7, 0, 7), true);
});

test('isElementFullyEntered supports the "seek past trigger" acceptance check', () => {
  // Seeking to any time after trigger + entrance means fully entered.
  assert.equal(isElementFullyEntered(1, 2, 0.5, 7), true);
  assert.equal(isElementFullyEntered(1, 1.1, 0.5, 7), false);
  assert.equal(isElementFullyEntered(1, 0.9, 0.5, 7), false);
});

test('SessionTokenSource is monotonic and staleness checks work', () => {
  const tokens = new SessionTokenSource();
  const t1 = tokens.next();
  const t2 = tokens.next();
  assert.ok(t2 > t1);
  assert.equal(tokens.isCurrent(t2), true);
  assert.equal(tokens.isCurrent(t1), false); // old scene's token is stale
});

test('isSceneEndReached and sceneProgress', () => {
  assert.equal(isSceneEndReached(7, 7), true);
  assert.equal(isSceneEndReached(6.99, 7), false);
  assert.equal(sceneProgress(3.5, 7), 0.5);
  assert.equal(sceneProgress(100, 7), 1);
  assert.equal(sceneProgress(-5, 7), 0);
});
