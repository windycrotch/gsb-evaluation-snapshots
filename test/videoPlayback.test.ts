import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  VideoPlaybackProgress,
  formatPlaybackSnapshot,
  supportsVideoFrameCallback,
  trackPresentedVideoFrames,
  type VideoPlaybackProbe,
} from '../src/sources/videoPlayback.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Test doubles — a fabricated clock and a minimal video element probe, so the
// accounting rules run entirely offline (no DOM, no browser, no network).
// ─────────────────────────────────────────────────────────────────────────────

interface FakeVideo extends VideoPlaybackProbe {
  currentTime: number;
  duration:    number;
  paused:      boolean;
}

function fakeVideo(init: Partial<FakeVideo> = {}): FakeVideo {
  return {
    currentTime: 0,
    duration:    45,
    paused:      true,
    ...init,
  };
}

function fakeClock(start = 0) {
  let t = start;
  return {
    now:  () => t,
    tick: (ms: number) => { t += ms; },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// requestVideoFrameCallback path
// ─────────────────────────────────────────────────────────────────────────────

test('rVFC: counts presented frames, freezes while paused, resumes after play', () => {
  const clock = fakeClock(0);
  const video = fakeVideo({ paused: false, currentTime: 0 });
  const progress = new VideoPlaybackProgress('file', video, 'video-frame-callback', {
    now: clock.now,
  });

  // Present three distinct media frames.
  assert.equal(progress.noteVideoFrame(0.0), true);
  assert.equal(progress.noteVideoFrame(0.04), true);
  assert.equal(progress.noteVideoFrame(0.08), true);

  // A duplicate callback for the same presented frame must not count twice.
  assert.equal(progress.noteVideoFrame(0.08), false);

  assert.equal(progress.snapshot().frameCount, 3);

  // Pause: the element stops presenting frames.  Even if a spurious callback
  // arrives, the count must not grow.
  video.paused = true;
  progress.markPaused();
  clock.tick(5_000);
  assert.equal(progress.noteVideoFrame(0.12), false);
  assert.equal(progress.snapshot().frameCount, 3);

  // Resume: accounting continues from the retained count.
  video.paused = false;
  progress.markPlaying();
  assert.equal(progress.noteVideoFrame(0.16), true);
  assert.equal(progress.snapshot().frameCount, 4);

  // The rVFC path must ignore render-loop ticks entirely.
  assert.equal(progress.noteRenderTick(), false);
  assert.equal(progress.snapshot().frameCount, 4);
});

test('rVFC: snapshot reports kind, current time, duration and paused state', () => {
  const clock = fakeClock(0);
  const video = fakeVideo({ paused: false, currentTime: 0 });
  const progress = new VideoPlaybackProgress('file', video, 'video-frame-callback', {
    now: clock.now,
  });

  progress.noteVideoFrame(0.0);
  video.currentTime = 12.3;

  const snap = progress.snapshot();
  assert.equal(snap.kind, 'file');
  assert.equal(snap.currentTime, 12.3);
  assert.equal(snap.duration, 45);
  assert.equal(snap.paused, false);
  assert.equal(snap.disposed, false);

  video.paused = true;
  progress.markPaused();
  const paused = progress.snapshot();
  assert.equal(paused.paused, true);
  assert.equal(paused.currentTime, 12.3, 'pausing retains the progress position');
});

test('dispose: snapshot becomes released, freezes counts, and never throws', () => {
  const clock = fakeClock(0);
  const video = fakeVideo({ paused: false, currentTime: 7 });
  const progress = new VideoPlaybackProgress('file', video, 'video-frame-callback', {
    now: clock.now,
  });

  progress.noteVideoFrame(0);
  progress.noteVideoFrame(0.04);

  progress.dispose();
  video.currentTime = 30; // the element may be detached/recycled afterwards

  const after = progress.snapshot();
  assert.equal(after.disposed, true);
  assert.equal(after.frameCount, 2);
  assert.equal(after.paused, true);
  assert.equal(after.currentTime, 7, 'final position is captured at dispose time');

  // Repeat reads are stable and safe.
  assert.deepEqual(progress.snapshot(), after);

  // No further frame or tick accounting after dispose.
  assert.equal(progress.noteVideoFrame(0.08), false);
  assert.equal(progress.noteRenderTick(), false);

  // dispose() is idempotent.
  progress.dispose();
  assert.deepEqual(progress.snapshot(), after);
});

// ─────────────────────────────────────────────────────────────────────────────
// Render-tick fallback (no requestVideoFrameCallback)
// ─────────────────────────────────────────────────────────────────────────────

test('tick fallback: counts ticks only while playing and never double-counts frames', () => {
  const clock = fakeClock(0);
  const video = fakeVideo({ paused: false });
  const progress = new VideoPlaybackProgress('webcam', video, 'render-tick', {
    now: clock.now,
  });

  assert.equal(supportsVideoFrameCallback(video), false);

  clock.tick(16);
  assert.equal(progress.noteRenderTick(), true);
  clock.tick(16);
  assert.equal(progress.noteRenderTick(), true);
  clock.tick(16);
  assert.equal(progress.noteRenderTick(), true);

  // Even though the element has no rVFC support, a discovered callback must
  // never add to the count in tick mode.
  assert.equal(progress.noteVideoFrame(0.0), false);
  assert.equal(progress.noteVideoFrame(0.04), false);

  assert.equal(progress.snapshot().frameCount, 3);

  // Paused: ticks keep firing for other reasons but must not count.
  video.paused = true;
  progress.markPaused();
  for (let i = 0; i < 10; i++) {
    clock.tick(16);
    assert.equal(progress.noteRenderTick(), false);
  }
  assert.equal(progress.snapshot().frameCount, 3);

  // Resuming continues accumulating.
  video.paused = false;
  progress.markPlaying();
  clock.tick(16);
  assert.equal(progress.noteRenderTick(), true);
  assert.equal(progress.snapshot().frameCount, 4);
});

test('tick fallback: webcam reports elapsed time and no fabricated duration', () => {
  const clock = fakeClock(0);
  const video = fakeVideo({ paused: false, duration: Number.POSITIVE_INFINITY });
  const progress = new VideoPlaybackProgress('webcam', video, 'render-tick', {
    now: clock.now,
  });

  clock.tick(12_300);
  progress.noteRenderTick();

  const snap = progress.snapshot();
  assert.equal(snap.kind, 'webcam');
  assert.equal(snap.duration, null);
  assert.equal(snap.currentTime, 12.3);
  assert.equal(snap.frameCount, 1);

  // While paused the elapsed play time stops advancing.
  video.paused = true;
  progress.markPaused();
  clock.tick(5_000);
  assert.equal(progress.snapshot().currentTime, 12.3);
});

test('dispose in tick mode marks the snapshot disposed and stops counting', () => {
  const clock = fakeClock(0);
  const video = fakeVideo({ paused: false });
  const progress = new VideoPlaybackProgress('webcam', video, 'render-tick', {
    now: clock.now,
  });

  clock.tick(16);
  progress.noteRenderTick();
  progress.dispose();

  assert.equal(progress.snapshot().disposed, true);
  assert.equal(progress.noteRenderTick(), false);
  assert.equal(progress.snapshot().frameCount, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Display formatting
// ─────────────────────────────────────────────────────────────────────────────

test('formatPlaybackSnapshot: file video shows position / duration / state', () => {
  const clock = fakeClock(0);
  const video = fakeVideo({ paused: true, currentTime: 12.3 });
  const progress = new VideoPlaybackProgress('file', video, 'render-tick', {
    now: clock.now,
  });
  progress.noteRenderTick(); // paused → not counted
  // Pretend frames were presented earlier.
  video.paused = false;
  progress.markPlaying();
  progress.noteRenderTick();
  video.paused = true;
  progress.markPaused();

  assert.equal(
    formatPlaybackSnapshot(progress.snapshot()),
    'video 12.3s / 45.0s · 1 frame · paused',
  );
});

test('formatPlaybackSnapshot: webcam omits the total and shows frames', () => {
  const clock = fakeClock(0);
  const video = fakeVideo({ paused: false, duration: Number.POSITIVE_INFINITY });
  const progress = new VideoPlaybackProgress('webcam', video, 'render-tick', {
    now: clock.now,
  });
  clock.tick(1_000);
  progress.noteRenderTick();

  assert.equal(
    formatPlaybackSnapshot(progress.snapshot()),
    'webcam 1.0s · 1 frame · playing',
  );
});

test('formatPlaybackSnapshot: accepts localized state and count labels', () => {
  const clock = fakeClock(0);
  const video = fakeVideo({ paused: true, currentTime: 12.3 });
  const progress = new VideoPlaybackProgress('file', video, 'render-tick', {
    now: clock.now,
  });

  assert.equal(
    formatPlaybackSnapshot(progress.snapshot(), {
      playing:  '播放中',
      paused:   '已暂停',
      released: '已释放',
      frames:   (n) => `${n} 帧`,
    }),
    'video 12.3s / 45.0s · 0 帧 · 已暂停',
  );

  progress.dispose();
  assert.equal(
    formatPlaybackSnapshot(progress.snapshot(), { released: '已释放' }),
    'video 12.3s / 45.0s · 0 frames · 已释放',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// requestVideoFrameCallback plumbing (no browser required)
// ─────────────────────────────────────────────────────────────────────────────

interface FakeFrameHost {
  requestVideoFrameCallback(
    cb: (now: number, metadata: { mediaTime: number }) => void,
  ): number;
  cancelVideoFrameCallback(handle: number): void;
  /** Deliver one presented frame to the pending callback, if any. */
  present(mediaTime: number): boolean;
  readonly pending: number;
}

function fakeFrameHost(): FakeFrameHost {
  let nextHandle = 1;
  let pending: { handle: number; cb: (now: number, m: { mediaTime: number }) => void } | null = null;

  return {
    requestVideoFrameCallback(cb) {
      const handle = nextHandle++;
      pending = { handle, cb };
      return handle;
    },
    cancelVideoFrameCallback(handle) {
      if (pending?.handle === handle) pending = null;
    },
    present(mediaTime) {
      const cur = pending;
      if (!cur) return false;
      pending = null;
      cur.cb(0, { mediaTime });
      return true;
    },
    get pending() {
      return pending === null ? 0 : 1;
    },
  };
}

test('trackPresentedVideoFrames: re-arms per frame and counts each once', () => {
  const clock = fakeClock(0);
  const video = fakeVideo({ paused: false });
  const progress = new VideoPlaybackProgress('file', video, 'video-frame-callback', {
    now: clock.now,
  });
  const host = fakeFrameHost();

  const unsubscribe = trackPresentedVideoFrames(host, progress);

  assert.equal(host.pending, 1, 'requests the first frame on subscribe');
  assert.equal(host.present(0.0), true);
  assert.equal(host.pending, 1, 're-arms after each presented frame');
  host.present(0.04);
  host.present(0.08);

  assert.equal(progress.snapshot().frameCount, 3);

  // Pausing stops frames from being presented; a frame delivered in the gap
  // after pause must not be counted.
  video.paused = true;
  progress.markPaused();
  host.present(0.12);
  assert.equal(progress.snapshot().frameCount, 3);

  // Resuming counts again.
  video.paused = false;
  progress.markPlaying();
  host.present(0.16);
  assert.equal(progress.snapshot().frameCount, 4);

  unsubscribe();
  assert.equal(host.present(0.20), false, 'no request pending after unsubscribe');
  assert.equal(progress.snapshot().frameCount, 4);
});

test('trackPresentedVideoFrames: no-op in tick mode or without host support', () => {
  const progress = new VideoPlaybackProgress(
    'webcam',
    fakeVideo({ paused: false }),
    'render-tick',
    { now: fakeClock(0).now },
  );
  const host = fakeFrameHost();

  const unsubscribe = trackPresentedVideoFrames(host, progress);
  assert.equal(host.pending, 0, 'tick mode never subscribes to rVFC');
  host.present(0.0);
  assert.equal(progress.snapshot().frameCount, 0);
  unsubscribe();

  // rVFC mode with a host that lacks the API must also be a safe no-op.
  const rvfcProgress = new VideoPlaybackProgress(
    'file',
    fakeVideo({ paused: false }),
    'video-frame-callback',
    { now: fakeClock(0).now },
  );
  const noopUnsubscribe = trackPresentedVideoFrames({}, rvfcProgress);
  noopUnsubscribe();
  assert.equal(rvfcProgress.snapshot().frameCount, 0);
});

test('supportsVideoFrameCallback detects capability without throwing', () => {
  assert.equal(supportsVideoFrameCallback(fakeFrameHost()), true);
  assert.equal(supportsVideoFrameCallback({}), false);
  assert.equal(
    supportsVideoFrameCallback({ requestVideoFrameCallback: 'nope' }),
    false,
  );
});
