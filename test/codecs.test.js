import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codecString, defaultBitrate, frameCount, splitFrames } from '../src/codecs.js';
import { pick } from '../src/probe.js';

test('splitFrames covers every frame once, in order', () => {
  for (const [n, w] of [[200, 1], [200, 3], [7, 4], [3, 8], [1, 1]]) {
    const r = splitFrames(n, w);
    assert.equal(r[0].start, 0); assert.equal(r.at(-1).end, n);
    r.forEach((x, i) => { assert.ok(x.end > x.start); if (i) assert.equal(x.start, r[i - 1].end); });
    assert.ok(r.length <= Math.min(n, w));
  }
});

test('frameCount rounds TOTAL * fps to the nearest frame', () => {
  assert.equal(frameCount(8, 25), 200); assert.equal(frameCount(8, 29.97), 240); assert.equal(frameCount(2.5, 24), 60);
});

test('codec strings pick a level that fits size, rate and bitrate', () => {
  assert.equal(codecString('h264', 1920, 1080, 25, 20e6), 'avc1.640028');
  assert.equal(codecString('h264', 1920, 1080, 60, 20e6), 'avc1.64002a');
  assert.equal(codecString('h264', 3840, 2160, 25, 60e6), 'avc1.640033');
  assert.equal(codecString('h264', 3840, 2160, 60, 60e6), 'avc1.640034');
  assert.equal(codecString('hevc', 1920, 1080, 25, 10e6), 'hvc1.1.6.L120.B0');
  assert.equal(codecString('hevc', 3840, 2160, 25, 36e6), 'hvc1.1.6.H150.B0');
  assert.ok(defaultBitrate('h264', 3840, 2160, 25) > defaultBitrate('h264', 1920, 1080, 25));
});

test('pick prefers constant QP in auto, speed in hw and sw, and keeps H.264 unless HEVC is clearly faster', () => {
  const results = [
    { codec: 'h264', hw: true, supported: true, rc: 'quantizer', fps: 70 },
    { codec: 'h264', hw: false, supported: true, rc: 'variable', fps: 150 },
    { codec: 'hevc', hw: true, supported: true, rc: 'quantizer', fps: 75 },
    { codec: 'hevc', hw: false, supported: false, fps: 0 },
  ];
  assert.deepEqual(pick(results), results[0]);
  assert.deepEqual(pick(results, { mode: 'sw' }), results[1]);
  assert.deepEqual(pick(results, { codec: 'hevc' }), results[2]);
  assert.equal(pick(results, { mode: 'sw', codec: 'hevc' }), null);
  assert.deepEqual(pick([results[1], results[3]]), results[1]);   // no constant-QP encoder: fastest overall
  assert.deepEqual(pick([{ ...results[0], fps: 40 }, results[2]]), results[2]);   // HEVC far ahead
});
