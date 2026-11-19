import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackCoordinator, CoordinatorScene, CoordinatorAudioPort } from '../src/utils/playbackCoordinator.ts';

function makeScene(overrides: Partial<CoordinatorScene> = {}): CoordinatorScene {
  return {
    id: 'scene-1',
    narration: 'alpha beta gamma delta epsilon',
    durationSeconds: 5,
    ...overrides,
  };
}

interface FakeAudio extends CoordinatorAudioPort {
  ttsStarts: number;
  customStarts: number;
  stopCalls: number;
  ducking: boolean;
  duckHistory: boolean[];
  seeks: number[];
  lastTtsWordHandler: ((idx: number) => void) | null;
  lastTtsEndHandler: (() => void) | null;
  lastCustomEndHandler: (() => void) | null;
  /** Fire the word callback of the most recent TTS session. */
  emitWord: (idx: number) => void;
  emitTtsEnd: () => void;
  emitCustomEnd: () => void;
}

function makeFakeAudio(): FakeAudio {
  const fake: FakeAudio = {
    ttsStarts: 0,
    customStarts: 0,
    stopCalls: 0,
    ducking: false,
    duckHistory: [],
    seeks: [],
    lastTtsWordHandler: null,
    lastTtsEndHandler: null,
    lastCustomEndHandler: null,
    startTts(text, onWord, onEnd) {
      fake.ttsStarts += 1;
      fake.lastTtsWordHandler = onWord;
      fake.lastTtsEndHandler = onEnd;
      return fake.ttsStarts;
    },
    startCustomAudio(_url, onEnd) {
      fake.customStarts += 1;
      fake.lastCustomEndHandler = onEnd;
      return fake.customStarts;
    },
    seekCustomAudio(t) {
      fake.seeks.push(t);
    },
    pauseCustomAudio() {},
    resumeCustomAudio() {},
    stopVoice() {
      fake.stopCalls += 1;
    },
    setDucking(active) {
      fake.ducking = active;
      fake.duckHistory.push(active);
    },
    emitWord(idx) {
      fake.lastTtsWordHandler?.(idx);
    },
    emitTtsEnd() {
      fake.lastTtsEndHandler?.();
    },
    emitCustomEnd() {
      fake.lastCustomEndHandler?.();
    },
  };
  return fake;
}

/** Manual rAF harness: each scheduled callback is queued and advanced explicitly. */
function makeRafHarness() {
  let queue = new Map<number, (ts: number) => void>();
  let idSeq = 1;
  let clockMs = 0;
  const raf = (cb: (ts: number) => void) => {
    const id = idSeq++;
    queue.set(id, cb);
    return id;
  };
  const cancelRaf = (id: number) => {
    queue.delete(id);
  };
  return {
    raf,
    cancelRaf,
    /**
     * Advance one frame by deltaSeconds. The first queued callback after a
     * (re)start primes the clock baseline at the current time; subsequent
     * callbacks receive the advanced timestamp, matching real rAF behavior.
     */
    tick(deltaSeconds: number) {
      const prime = [...queue.values()];
      queue.clear();
      prime.forEach((cb) => cb(clockMs));
      if (deltaSeconds <= 0) return;
      clockMs += deltaSeconds * 1000;
      const pending = [...queue.values()];
      queue.clear();
      pending.forEach((cb) => cb(clockMs));
    },
    pendingCount: () => queue.size,
    get clockMs() {
      return clockMs;
    },
  };
}

function makeCoordinator(scene = makeScene(), isLastScene = false) {
  const audio = makeFakeAudio();
  const harness = makeRafHarness();
  const times: number[] = [];
  const subtitles: Array<{ wordIndex: number; fromCallback: boolean }> = [];
  const playingChanges: boolean[] = [];
  const counters = { nextSceneRequests: 0, sceneEnds: 0 };

  const coordinator = new PlaybackCoordinator(scene, {
    audio,
    raf: harness.raf,
    cancelRaf: harness.cancelRaf,
    now: () => harness.clockMs,
    callbacks: {
      onTime: (t) => times.push(t),
      onSubtitle: (s) => subtitles.push({ ...s }),
      onPlayingChange: (p) => playingChanges.push(p),
      onRequestNextScene: () => {
        counters.nextSceneRequests += 1;
      },
      onSceneEnd: () => {
        counters.sceneEnds += 1;
      },
    },
  }, isLastScene);

  return {
    coordinator,
    audio,
    harness,
    times,
    subtitles,
    playingChanges,
    counters,
  };
}

test('play starts a TTS voice session, ducks, and advances the playhead', () => {
  const { coordinator, audio, harness } = makeCoordinator();
  coordinator.play();
  assert.equal(coordinator.isPlaying(), true);
  assert.equal(audio.ttsStarts, 1);
  assert.equal(audio.ducking, true);

  harness.tick(0.5);
  assert.ok(Math.abs(coordinator.getTime() - 0.5) < 1e-6);
  harness.tick(0.5);
  assert.ok(Math.abs(coordinator.getTime() - 1.0) < 1e-6);
});

test('pause stops the voice, restores music volume, and holds the current word', () => {
  const { coordinator, audio, harness } = makeCoordinator();
  coordinator.play();
  harness.tick(1.0);
  const timeAtPause = coordinator.getTime();
  assert.ok(timeAtPause > 0);

  coordinator.pause();
  assert.equal(coordinator.isPlaying(), false);
  assert.equal(audio.stopCalls >= 1, true); // interrupted narration stopped
  assert.equal(audio.ducking, false); // music restored
  assert.equal(harness.pendingCount(), 0); // clock stopped

  // Subtitle is still derived from the frozen playhead (a valid word index).
  const held = coordinator.getActiveWordIndex();
  assert.ok(held >= 0);

  // Resume: a fresh voice session starts from the same playhead.
  coordinator.play();
  assert.equal(audio.ttsStarts, 2);
  assert.equal(audio.ducking, true);
});

test('resume after pause does not overlap audio (old session stopped first)', () => {
  const { coordinator, audio } = makeCoordinator();
  coordinator.play();
  coordinator.pause();
  coordinator.play();
  coordinator.pause();
  coordinator.play();
  // Three play sessions, each preceded by a stop of the previous voice.
  assert.equal(audio.ttsStarts, 3);
  assert.ok(audio.stopCalls >= 3);
});

test('pause holds the current word and resume releases the hold', () => {
  const { coordinator, audio, harness } = makeCoordinator(makeScene({ narration: 'a b c d e f', durationSeconds: 6 }));
  coordinator.play();
  harness.tick(0);
  harness.tick(2); // playhead at 2s
  const wordAtPause = coordinator.getActiveWordIndex();
  assert.ok(wordAtPause >= 0);

  coordinator.pause();
  // The held word stays fixed regardless of any further (no) clock updates.
  assert.equal(coordinator.getActiveWordIndex(), wordAtPause);
  assert.equal(audio.ducking, false);

  coordinator.play();
  // After resume the hold is released and estimation resumes from the head.
  harness.tick(0);
  harness.tick(1);
  assert.equal(coordinator.getSubtitleState().fromCallback, false);
});

test('seek while playing re-anchors the voice and clamps to scene bounds', () => {
  const { coordinator, audio, harness } = makeCoordinator();
  coordinator.play();
  harness.tick(0.2);

  coordinator.seek(3.5);
  assert.ok(Math.abs(coordinator.getTime() - 3.5) < 1e-6);
  assert.equal(audio.ttsStarts, 2); // voice restarted at the new position
  // TTS receives the seek offset so early word events are suppressed.
  // (Verified via offset argument in the audio engine tests.)

  // Seeking past the end clamps instead of overflowing the progress bar.
  coordinator.seek(99);
  assert.equal(coordinator.getTime(), 5);
  // Seeking before the start clamps to zero.
  coordinator.seek(-5);
  assert.equal(coordinator.getTime(), 0);
});

test('seek while paused updates subtitle via playhead estimate, no voice started', () => {
  const { coordinator, audio } = makeCoordinator();
  // starts paused
  assert.equal(coordinator.isPlaying(), false);
  coordinator.seek(2.5);
  assert.equal(audio.ttsStarts, 0);
  assert.equal(audio.ducking, false);
  const idx = coordinator.getActiveWordIndex();
  // 2.5/5 progress over 5 words -> word 2
  assert.equal(idx, 2);
});

test('a word-boundary callback overrides the estimate until invalidated', () => {
  const { coordinator, audio } = makeCoordinator();
  coordinator.play();
  // Before any callback, estimate from playhead (time 0 -> word 0).
  assert.equal(coordinator.getSubtitleState().fromCallback, false);

  audio.emitWord(3);
  assert.equal(coordinator.getActiveWordIndex(), 3);
  assert.equal(coordinator.getSubtitleState().fromCallback, true);

  // A seek invalidates the callback and falls back to estimation.
  coordinator.seek(1);
  assert.equal(coordinator.getSubtitleState().fromCallback, false);
});

test('callbacks from a previous scene cannot affect the new scene subtitles', () => {
  const sceneA = makeScene({ id: 'A' });
  const { coordinator, audio } = makeCoordinator(sceneA, false);
  coordinator.play();
  audio.emitWord(4); // scene A highlights word 4
  assert.equal(coordinator.getActiveWordIndex(), 4);

  // Switch to scene B while "playing". The old token must be invalidated.
  const sceneB = makeScene({ id: 'B', narration: 'one two three', durationSeconds: 4 });
  coordinator.setScene(sceneB, true, true);
  assert.equal(coordinator.getTime(), 0);
  assert.equal(audio.ttsStarts, 2); // new scene started its own voice

  // Replaying an old callback through the OLD handler must be ignored because
  // the coordinator's voice token changed.
  audio.emitWord(4); // this now routes to scene B's handler but token is stale
  // Scene B only has 3 words; an out-of-range/staleness result must not stick.
  const state = coordinator.getSubtitleState();
  assert.ok(state.wordIndex >= 0 && state.wordIndex < 3);
});

test('rapid consecutive scene switches only reflect the latest scene', () => {
  const { coordinator, audio } = makeCoordinator(makeScene({ id: 'A' }), false);
  coordinator.play();
  for (let i = 0; i < 5; i++) {
    coordinator.setScene(makeScene({ id: `B-${i}`, narration: `w${i} x${i}`, durationSeconds: 3 }), false, true);
  }
  // Every switch tears down the prior voice before starting another; no overlap.
  assert.ok(audio.stopCalls >= 5);
  assert.equal(coordinator.getTime(), 0);
  // Subtitle always maps into the current (2-word) scene.
  assert.ok(coordinator.getActiveWordIndex() < 2);
});

test('auto-advance: parent swap followed by setScene(playing=true) resumes seamlessly', () => {
  const ctx = makeCoordinator(makeScene({ id: 'A', durationSeconds: 4 }), false);
  ctx.coordinator.play();
  ctx.harness.tick(0);
  ctx.harness.tick(4.1); // scene A ends -> requests next
  assert.equal(ctx.counters.nextSceneRequests, 1);
  assert.equal(ctx.coordinator.isPlaying(), false);

  // Simulate the React parent swapping in scene B and resuming.
  ctx.coordinator.setScene(makeScene({ id: 'B', durationSeconds: 4 }), true, true);
  assert.equal(ctx.coordinator.isPlaying(), true);
  assert.equal(ctx.coordinator.getTime(), 0);
  assert.equal(ctx.audio.ttsStarts, 2); // scene B voice started, no overlap with A

  // The clock runs again on scene B.
  ctx.harness.tick(0);
  ctx.harness.tick(1);
  assert.ok(Math.abs(ctx.coordinator.getTime() - 1) < 1e-6);
});

test('reaching the end of a non-final scene requests the next scene once', () => {
  const ctx = makeCoordinator(makeScene({ durationSeconds: 5 }), false);
  ctx.coordinator.play();
  ctx.harness.tick(0); // prime baseline
  ctx.harness.tick(4.9);
  assert.equal(ctx.coordinator.isPlaying(), true);
  assert.equal(ctx.counters.nextSceneRequests, 0);
  ctx.harness.tick(0.2); // crosses 5.0
  assert.equal(ctx.counters.nextSceneRequests, 1);
  assert.equal(ctx.coordinator.isPlaying(), false);
  assert.equal(ctx.audio.ducking, false);
});

test('reaching the end of the final scene fires onSceneEnd and restores music', () => {
  const ctx = makeCoordinator(makeScene({ durationSeconds: 5 }), true);
  ctx.coordinator.play();
  ctx.harness.tick(0); // prime the clock baseline
  ctx.harness.tick(5.1);
  assert.equal(ctx.coordinator.isPlaying(), false);
  assert.equal(ctx.counters.sceneEnds, 1);
  assert.equal(ctx.counters.nextSceneRequests, 0);
  assert.equal(ctx.audio.ducking, false); // music restored after narration ends
  // Playhead rests exactly at the duration (no overflow).
  assert.equal(ctx.coordinator.getTime(), 5);
  assert.equal(ctx.times[ctx.times.length - 1], 5);
});

test('play after reaching the end restarts from zero', () => {
  const { coordinator, audio, harness } = makeCoordinator(makeScene({ durationSeconds: 5 }), true);
  coordinator.play();
  harness.tick(0);
  harness.tick(5.1); // ends
  coordinator.play(); // should restart
  assert.equal(coordinator.getTime(), 0);
  assert.equal(audio.ttsStarts, 2);
});

test('rewind seeks to zero and keeps play state', () => {
  const { coordinator, harness, audio } = makeCoordinator();
  coordinator.play();
  harness.tick(2);
  coordinator.rewind();
  assert.equal(coordinator.getTime(), 0);
  assert.equal(coordinator.isPlaying(), true);
  assert.equal(audio.ttsStarts, 2); // restarted voice at offset 0
});

test('switching to custom audio starts an uploaded track and seeks it on seek', () => {
  const scene = makeScene({ customAudioUrl: 'blob:voice' });
  const { coordinator, audio, harness } = makeCoordinator(scene);
  coordinator.play();
  assert.equal(audio.customStarts, 1);
  assert.equal(audio.ttsStarts, 0);
  assert.equal(audio.ducking, true);

  coordinator.seek(2);
  assert.deepEqual(audio.seeks, [2]);

  harness.tick(1);
  // When the uploaded track ends, ducking is released by the audio port;
  // the coordinator just clears its voice state.
  audio.emitCustomEnd();
  assert.equal(coordinator.getVoiceKind(), 'none');
});

test('replacing the voice source while playing stops the old source first', () => {
  const { coordinator, audio } = makeCoordinator(makeScene());
  coordinator.play();
  assert.equal(audio.ttsStarts, 1);

  coordinator.setScene(makeScene({ id: 'new', customAudioUrl: 'blob:other' }), true, true);
  assert.ok(audio.stopCalls >= 1);
  assert.equal(audio.customStarts, 1);
  assert.equal(audio.ttsStarts, 1); // no extra TTS; replaced by custom audio
});

test('muting stops voice and un-ducks; unmuting restarts voice while playing', () => {
  const { coordinator, audio } = makeCoordinator();
  coordinator.play();
  assert.equal(audio.ducking, true);
  coordinator.setVoiceMuted(true);
  assert.equal(audio.ducking, false);
  assert.ok(audio.stopCalls >= 1);
  coordinator.setVoiceMuted(false);
  assert.equal(audio.ttsStarts, 2);
  assert.equal(audio.ducking, true);
});

test('speed change scales playhead advancement', () => {
  const { coordinator, harness } = makeCoordinator();
  coordinator.play();
  coordinator.setSpeed(1.25);
  harness.tick(1);
  assert.ok(Math.abs(coordinator.getTime() - 1.25) < 1e-6);
});

test('destroy stops the clock and voice and releases ducking', () => {
  const { coordinator, audio, harness } = makeCoordinator();
  coordinator.play();
  harness.tick(0.3);
  coordinator.destroy();
  assert.equal(harness.pendingCount(), 0);
  assert.ok(audio.stopCalls >= 1);
  assert.equal(audio.ducking, false);
});
