import test from 'node:test';
import assert from 'node:assert/strict';
import { AVPlayback, RETAIN_SECONDS, SAFETY_BUFFER } from '../av-playback.js';

function fixture() {
  let head = 40, start = 0, removed;
  const video = { currentTime: 9.25, readyState: 4, paused: false,
    addEventListener() {}, removeEventListener() {}, pause() { this.paused = true; },
    async play() { this.paused = false; }, removeAttribute() {}, load() {} };
  let status, error;
  const player = new AVPlayback(video, { onStatus: s => { status = s; }, onError: e => { error = e; } });
  player.mediaSource = { readyState: 'open' };
  player.buffer = { updating: false, buffered: { length: 1, start: () => start, end: () => head },
    remove: (a, b) => { removed = [a, b]; }, appendBuffer() {} };
  player.started = true;
  return { player, video, head: h => { head = h; }, start: s => { start = s; },
    status: () => status, error: () => error, removed: () => removed };
}

test('MSE startup registers sourceopen before explicitly loading the extension video', async () => {
  const original = { MediaSource: globalThis.MediaSource, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  let loads = 0;
  globalThis.MediaSource = class extends EventTarget {
    static isTypeSupported() { return true; }
    addSourceBuffer() { return new EventTarget(); }
  };
  URL.createObjectURL = () => 'blob:extension-test';
  URL.revokeObjectURL = () => {};
  const video = { addEventListener() {}, removeEventListener() {}, pause() {}, removeAttribute() {},
    load() { loads++; player.mediaSource.dispatchEvent(new Event('sourceopen')); } };
  const player = new AVPlayback(video);
  try {
    await player.configure('video/mp4', 30);
    assert.equal(loads, 1);
    assert.equal(video.src, 'blob:extension-test');
    assert.ok(player.buffer);
  } finally {
    player.close();
    globalThis.MediaSource = original.MediaSource;
    URL.createObjectURL = original.create;
    URL.revokeObjectURL = original.revoke;
  }
});

test('A/V increase holds both tracks; further changes recalculate remaining wait', async () => {
  const f = fixture();
  f.player.setDelay(35);
  assert.equal(f.video.paused, true);
  assert.equal(f.video.currentTime, 9.25);
  assert.equal(f.status().pauseRemaining, 5);
  f.head(42); f.player.tick();
  assert.equal(f.status().pauseRemaining, 3);
  f.player.setDelay(36);
  assert.equal(f.status().pauseRemaining, 4);
  f.head(46); f.player.tick();
  await Promise.resolve();
  assert.equal(f.video.paused, false);
  assert.equal(f.status().pauseRemaining, 0);
  assert.equal(f.video.currentTime, 9.25);
  f.player.close();
});

test('A/V decrease cancels wait and seeks only the extension output, including zero delay', () => {
  const f = fixture();
  f.player.setDelay(35); f.head(42);
  f.player.setDelay(30);
  assert.equal(f.video.currentTime, 42 - 30 - SAFETY_BUFFER);
  assert.equal(f.player.adjusting, false);
  f.player.setDelay(0);
  assert.equal(f.video.currentTime, 42 - SAFETY_BUFFER);
  f.player.close();
});

test('old buffered data is trimmed; sequence gaps fail closed and silence output', () => {
  const f = fixture();
  f.head(160); f.video.currentTime = 129.25;
  f.player.pump();
  assert.deepEqual(f.removed(), [0, 160 - (30 + SAFETY_BUFFER + 6)]);
  f.player.append(new ArrayBuffer(1), 2);
  assert.match(f.error(), /不连续/);
  assert.equal(f.player.closed, true);
  assert.equal(f.video.paused, true);
});

test('adjustments use the live clock even when encoded chunks arrive late', () => {
  const f = fixture();
  let time = 41;
  f.player.liveTime = () => time;
  f.video.currentTime = 10.25;
  f.player.setDelay(35);
  assert.equal(f.status().pauseRemaining, 5);
  time += 2; f.player.tick(); // No new encoded chunk arrived.
  assert.equal(f.status().pauseRemaining, 3);
  f.player.setDelay(30);
  assert.equal(f.video.currentTime, 12.25);
  f.player.close();
});

test('high bitrate fragments retain bounded queues; quota recovery retries the same chunk after reclaiming played history', () => {
  const f = fixture();
  const bytes = new ArrayBuffer(20 * 1024 * 1024);
  f.player.maxQueuedBytes = 32 * 1024 * 1024;
  f.player.buffer.updating = true;
  f.player.append(bytes, 0);
  assert.equal(f.player.closed, false);
  f.player.buffer.updating = false;
  f.head(35); f.video.currentTime = 20;
  let attempts = 0;
  f.player.buffer.appendBuffer = data => {
    assert.equal(data, bytes);
    if (!attempts++) throw new DOMException('full', 'QuotaExceededError');
  };
  f.player.pump();
  assert.deepEqual(f.removed(), [0, 18.5]);
  assert.equal(f.player.queue[0], bytes);
  f.player.pump();
  assert.equal(f.player.queue.length, 0);
  assert.equal(f.player.queuedBytes, 0);
  f.player.close();
  const limited = fixture();
  limited.player.buffer.updating = true;
  limited.player.append(bytes, 0); // Default lower-bitrate budget remains bounded.
  assert.equal(limited.player.closed, true);
  const full = fixture();
  full.head(35); full.video.currentTime = 0;
  full.player.buffer.appendBuffer = () => { throw new DOMException('full', 'QuotaExceededError'); };
  full.player.append(new ArrayBuffer(1), 0);
  assert.equal(full.player.closed, true);
  assert.match(full.error(), /缓存已达到内存上限/);
});
