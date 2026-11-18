import test from 'node:test';
import assert from 'node:assert/strict';
import { VIDEO_PRESETS, videoOptions, captureSize, cropPixels, outputSize, queueBudget } from '../video-options.js';
import { locatePlayer } from '../player-locator.js';
import { VideoCropper } from '../video-cropper.js';

test('crop coordinates map to native pixels; quality stays bounded and never initially upscales', () => {
  const geometry = { viewport: { width: 1600, height: 1000 }, rect: { x: 0.05, y: 0.1, width: 0.8, height: 0.72 } };
  assert.deepEqual(captureSize(VIDEO_PRESETS['1080p60'], geometry), { width: 2400, height: 1500 });
  assert.deepEqual(cropPixels({ visibleRect: { x: 0, y: 0, width: 2400, height: 1500 } }, geometry), { x: 120, y: 150, width: 1920, height: 1080 });
  assert.deepEqual(captureSize(VIDEO_PRESETS['1080p60'], { ...geometry, viewport: { ...geometry.viewport, devicePixelRatio: 2 } }), { width: 3200, height: 2000 });
  assert.deepEqual(outputSize({ width: 640, height: 360 }, VIDEO_PRESETS['1080p60']), { width: 640, height: 360 });
  assert.deepEqual(outputSize({ width: 1988, height: 1118 }, VIDEO_PRESETS['1080p60'], 16 / 9), { width: 1920, height: 1080 });
  assert.equal(VIDEO_PRESETS['1080p60'].level, '2a');
  assert.deepEqual(videoOptions({ quality: 'bad', region: 'bad' }), { quality: '720p30', region: 'player' });
  assert.ok(queueBudget(4_000_000).pending >= 8_000_000 * 12 / 8);
  assert.ok(queueBudget(VIDEO_PRESETS['1080p60'].bitrate).pending >= 20_000_000 * 12 / 8);
  assert.ok(queueBudget(20_000_000).playback <= 32 * 1024 * 1024);
});

test('locator reads video bounds without mutations; clipped or stale manual regions fail clearly', () => {
  const names = ['document', 'innerWidth', 'innerHeight', 'scrollX', 'scrollY', 'devicePixelRatio', 'getComputedStyle'];
  const originals = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let top = 100;
  const video = Object.freeze({ videoWidth: 1920, videoHeight: 1080,
    getBoundingClientRect: () => ({ left: 80, top, width: 1280, height: 720, right: 1360, bottom: top + 720 }) });
  const root = { querySelectorAll: () => [video] };
  Object.assign(globalThis, { document: { querySelector: () => root }, innerWidth: 1600, innerHeight: 1000,
    scrollX: 0, scrollY: 0, devicePixelRatio: 2, getComputedStyle: () => ({ visibility: 'visible' }) });
  try {
    const region = locatePlayer(null);
    assert.deepEqual(region.rect, { x: 0.05, y: 0.1, width: 0.8, height: 0.72 });
    assert.equal(region.sourceWidth, 1920);
    top = -10;
    assert.match(locatePlayer(null).error, /未完整显示/);
    assert.match(locatePlayer(null, 'manual', { viewport: { width: 1600, height: 900 } }).error, /重新框选/);
  } finally {
    for (const name of names) { if (originals[name]) Object.defineProperty(globalThis, name, originals[name]); else delete globalThis[name]; }
  }
});

test('native crop physically scales capture frames, declares canvas FPS, releases frames and cancels pending reads on Stop', async () => {
  const names = ['VideoFrame', 'MediaStreamTrackProcessor', 'HTMLCanvasElement', 'document'];
  const originals = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let inputCloses = 0, outputCloses = 0, stopped = 0, requests = 0, canvas, format, drawn;
  const frame = { timestamp: 1234567, visibleRect: { x: 0, y: 0, width: 1920, height: 1080 }, close: () => { inputCloses++; } };
  globalThis.MediaStreamTrackProcessor = class { constructor() { this.readable = new ReadableStream({ start(controller) { controller.enqueue(frame); } }); } };
  globalThis.VideoFrame = class { constructor(input, init) { this.timestamp = init.timestamp ?? input.timestamp; this.input = input; this.init = init; } close() { if (!this.closed) { this.closed = true; outputCloses++; } } };
  globalThis.HTMLCanvasElement = class {
    getContext() { return { drawImage(...args) { drawn = args; } }; }
    captureStream(fps) {
      assert.equal(fps, 30);
      return { getVideoTracks: () => [{ requestFrame() { requests++; }, stop() { stopped++; } }] };
    }
  };
  globalThis.document = { createElement(name) { assert.equal(name, 'canvas'); canvas = new HTMLCanvasElement(); return canvas; } };
  const cropper = new VideoCropper({ geometry: { rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }, preset: VIDEO_PRESETS['720p30'],
    onFormat: value => { format = value; }, onError: error => assert.fail(error) });
  try {
    await cropper.start({});
    assert.deepEqual(drawn[0].init.visibleRect, { x: 480, y: 270, width: 960, height: 540 });
    assert.equal(canvas.width, 960); assert.equal(canvas.height, 540); assert.equal(requests, 1);
    assert.equal(format.width, 960); assert.equal(format.height, 540);
    await cropper.close();
    assert.equal(inputCloses, 1); assert.equal(outputCloses, 1); assert.equal(stopped, 1);
    assert.equal(canvas.width, 0); assert.equal(canvas.height, 0);
  } finally {
    await cropper.close();
    for (const name of names) { if (originals[name]) Object.defineProperty(globalThis, name, originals[name]); else delete globalThis[name]; }
  }
});
