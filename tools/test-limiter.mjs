/* Local tests for the lookahead true-peak limiter and its shared parameter parser.
   No browser is needed: the AudioWorklet globals are mocked and the real js/limiter-worklet.js is
   loaded in a VM, so these run against the exact processor the live graph and the WAV export use.

     node tools/test-limiter.mjs

   Signals are synthesized here (near-full-scale sine, square wave, silence, burst impulses), and
   checked for: output peak under the configured ceiling, unity gain through silence, delay equal
   to the lookahead in samples, finite non-NaN output on illegal release, and identical left/right
   gain (stereo link). */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {
  LIMITER_DEFAULTS, MIN_LOOKAHEAD_SAMPLES, parseLimiterParams, lookaheadSamples,
} from '../js/limiter-config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKLET = join(HERE, '..', 'js', 'limiter-worklet.js');
const TINY = 1e-12;

// ---------- run the real worklet without a browser ----------

// Instantiates the worklet's processor class with a mocked sampleRate and processorOptions.
function makeProcessor(sampleRate, processorOptions = {}) {
  let registered = null;
  const sandbox = {
    sampleRate,
    Float32Array, Float64Array, Math,
    AudioWorkletProcessor: class { constructor() {} },
    registerProcessor: (_name, cls) => { registered = cls; },
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(WORKLET, 'utf8'), sandbox, { filename: 'limiter-worklet.js' });
  assert.ok(registered, 'the worklet must register its processor');
  return new registered({ processorOptions });
}

// Feeds stereo arrays through the processor in `blockSize`-sample blocks (128 on a real audio
// thread), then flushes its delay line with `latency` more samples, so every input sample comes
// back out. Output length is N + latency; out[latency + i] is the response to in[i].
function runProcessor(proc, in0, in1, blockSize = 128) {
  const n = in0.length;
  const total = n + proc.latency;
  const o0 = new Float32Array(total), o1 = new Float32Array(total);
  const step = (from, count) => {
    if (count <= 0) return;
    const inputs = [[in0.subarray(from, from + count), in1.subarray(from, from + count)]];
    const outputs = [[o0.subarray(from, from + count), o1.subarray(from, from + count)]];
    proc.process(inputs, outputs);
  };
  for (let from = 0; from < n; from += blockSize) step(from, Math.min(blockSize, n - from));
  step(n, proc.latency); // flush the lookahead delay
  return [o0, o1];
}

// ---------- synthesized signals ----------

// One second of stereo: near-full-scale sine, square wave, a long silence, and isolated impulses.
// Left and right differ (phase and frequency) so a stereo-link bug would show as a pan shift.
function makeSignal(sr) {
  const n = sr;
  const x0 = new Float32Array(n), x1 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    if (t < 0.22) {
      x0[i] = 0.99 * Math.sin(2 * Math.PI * 440 * t);
      x1[i] = 0.95 * Math.sin(2 * Math.PI * 440 * t + Math.PI / 3);
    } else if (t < 0.32) {
      const s = Math.sin(2 * Math.PI * 220 * t);
      x0[i] = 0.97 * (s >= 0 ? 1 : -1);
      x1[i] = 0.9 * (Math.sin(2 * Math.PI * 330 * t + 0.7) >= 0 ? 1 : -1);
    } else if (t < 0.72) {
      x0[i] = 0; x1[i] = 0; // silence: gain must return to and stay at 1
    } else {
      x0[i] = 0; x1[i] = 0;
    }
  }
  // Burst impulses in the last part (far enough apart for the release to recover between them).
  for (const at of [0.78, 0.86, 0.94]) {
    const i = Math.round(at * sr);
    x0[i] = 1; x1[i] = -1;
    x0[i + 1] = 0.9; x1[i + 1] = -0.85;
  }
  return [x0, x1];
}

// The worklet's windowed-sinc taps, rebuilt once (identical formula, unity gain at DC).
const phases = 4, half = 6;
const INTERP_TAPS = [1, 2, 3].map((p) => {
  const f = p / phases, taps = new Float64Array(2 * half);
  for (let k = 0; k < 2 * half; k++) {
    const tt = f - (k - half + 1);
    const sinc = tt === 0 ? 1 : Math.sin(Math.PI * tt) / (Math.PI * tt);
    taps[k] = sinc * (0.5 + 0.5 * Math.cos(Math.PI * tt / half));
  }
  const sum = taps.reduce((a, v) => a + v, 0);
  return taps.map((v) => v / sum);
});

// 4x-oversampled true peak, using the same windowed-sinc interpolator as the worklet.
function truePeak(x) {
  const span = 2 * half;
  let peak = 0;
  for (let i = 0; i < x.length; i++) {
    peak = Math.max(peak, Math.abs(x[i])); // phase 0: the samples themselves
    for (let p = 1; p < phases; p++) {
      let v = 0;
      for (let k = 0; k < span; k++) {
        const j = i - half + 1 + k; // samples around the in-between point
        const s = j < 0 || j >= x.length ? 0 : x[j];
        v += s * INTERP_TAPS[p - 1][k];
      }
      peak = Math.max(peak, Math.abs(v));
    }
  }
  return peak;
}
const lin = (dbtp) => Math.pow(10, dbtp / 20);
const maxAbs = (x) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

let passed = 0;
const pending = [];
function test(name, fn) {
  pending.push((async () => {
    try { await fn(); passed++; console.log(`  ok - ${name}`); }
    catch (err) { console.error(`FAIL - ${name}\n      ${err.message}`); process.exitCode = 1; }
  })());
}

// ================= parser: the single parse point both chains use =================

console.log('parseLimiterParams (shared by live and export)');

test('defaults: -1 dBTP, 5 ms lookahead, 120 ms release', () => {
  const p = parseLimiterParams({}, 44100);
  assert.equal(p.ceiling, -1);
  assert.equal(p.release, 0.12);
  assert.equal(p.lookahead, Math.round(0.005 * 44100)); // 221 samples
});

test('lookahead is rounded to whole samples and clamped at HALF+1 = 7', () => {
  assert.equal(lookaheadSamples(0.005, 44100), 221);
  assert.equal(lookaheadSamples(0, 44100), MIN_LOOKAHEAD_SAMPLES);
  assert.equal(lookaheadSamples(0.00001, 48000), MIN_LOOKAHEAD_SAMPLES); // 0.48 samples -> clamp
  assert.equal(lookaheadSamples(-1, 44100), MIN_LOOKAHEAD_SAMPLES);
  assert.equal(lookaheadSamples(Number.NaN, 44100), 221); // bad value -> default, then clamp
  assert.equal(MIN_LOOKAHEAD_SAMPLES, 7);
});

test('release must be positive finite; 0, negatives and NaN fall back to 120 ms', () => {
  for (const bad of [0, -0.12, Number.NaN, Number.NEGATIVE_INFINITY]) {
    assert.equal(parseLimiterParams({ release: bad }, 44100).release, 0.12);
  }
  assert.equal(parseLimiterParams({ release: 0.25 }, 44100).release, 0.25);
});

test('non-finite ceiling falls back to -1 dBTP', () => {
  assert.equal(parseLimiterParams({ ceiling: Number.NaN }, 44100).ceiling, -1);
  assert.equal(parseLimiterParams({ ceiling: -6 }, 44100).ceiling, -6);
});

// ================= worklet: signal-level behaviour =================

console.log('TruePeakLimiter worklet (the same processor on both paths)');

test('default parameters reproduce the original settings', () => {
  const p = makeProcessor(44100, parseLimiterParams({}, 44100));
  assert.equal(p.latency, 221); // 5 ms rounded
  assert.ok(Math.abs(p.ceiling - lin(-1 - 0.05)) < TINY); // ceiling with the 0.05 dB margin
  assert.ok(Math.abs(p.decay - Math.exp(-1 / (0.12 * 44100))) < TINY); // 120 ms release
});

test('output sample peak and 4x true peak stay under the configured ceiling', () => {
  for (const sr of [44100, 48000]) {
    const [x0, x1] = makeSignal(sr);
    for (const ceilingDb of [-1, -3, -6]) {
      const proc = makeProcessor(sr, parseLimiterParams({ ceiling: ceilingDb }, sr));
      const [o0, o1] = runProcessor(proc, x0, x1);
      const cap = lin(ceilingDb); // dBTP is an oversampled limit; the 0.05 dB margin is headroom
      for (const [label, o] of [['L', o0], ['R', o1]]) {
        assert.ok(maxAbs(o) <= cap + TINY,
          `${sr}Hz ceiling ${ceilingDb} dBTP ${label} sample peak ${maxAbs(o)} > ${cap}`);
        assert.ok(truePeak(o) <= cap + TINY,
          `${sr}Hz ceiling ${ceilingDb} dBTP ${label} true peak ${truePeak(o)} > ${cap}`);
      }
    }
  }
});

test('a ceiling that needs no limiting leaves the signal untouched (below ceiling)', () => {
  const sr = 44100;
  const quiet = new Float32Array(sr).fill(0.2); // well under any ceiling here
  const proc = makeProcessor(sr, parseLimiterParams({ ceiling: -1 }, sr));
  const [o0] = runProcessor(proc, quiet, quiet);
  // After the lookahead delay every quiet sample passes at unity (float32 round-trip tolerance).
  for (let i = proc.latency; i < sr + proc.latency; i++) {
    assert.ok(Math.abs(o0[i] - 0.2) < 1e-6, `gain drifted on quiet input: ${o0[i]}`);
  }
});

test('silence keeps gain at 1 (a probe after a long silent stretch is passed unchanged)', () => {
  const sr = 44100, n = sr;
  const x = new Float32Array(n);
  x.fill(0.0005); // far below the limiter's quiet threshold
  const proc = makeProcessor(sr, parseLimiterParams({}, sr));
  const [o0, o1] = runProcessor(proc, x, x);
  // Well past every window's settling time, gain must be unity (within float32 rounding), not drifting.
  const probeFrom = Math.round(0.6 * sr) + proc.latency;
  for (let i = probeFrom; i < n + proc.latency; i++) {
    assert.ok(Math.abs(o0[i] - 0.0005) < 1e-9, `silence gain != 1 at ${i}: ${o0[i]}`);
    assert.ok(Math.abs(o1[i] - 0.0005) < 1e-9);
  }
});

test('a full-silence input renders full silence, never NaN', () => {
  const sr = 44100;
  const x = new Float32Array(sr);
  const proc = makeProcessor(sr, parseLimiterParams({}, sr));
  const [o0, o1] = runProcessor(proc, x, x);
  for (const o of [o0, o1]) for (const v of o) assert.equal(v, 0);
});

test('latency is exactly the lookahead in samples (impulse arrives that many samples late)', () => {
  const sr = 44100;
  const n = 2048;
  const x0 = new Float32Array(n), x1 = new Float32Array(n);
  x0[0] = 0.8; x1[0] = -0.8; // impulse at sample 0
  for (const lookahead of [0.005, 0.01, 0.00001]) {
    const params = parseLimiterParams({ lookahead }, sr);
    const proc = makeProcessor(sr, params);
    assert.equal(proc.latency, params.lookahead);
    const [o0] = runProcessor(proc, x0, x1);
    const first = o0.findIndex((v) => v !== 0);
    assert.equal(first, proc.latency, `lookahead ${lookahead}s: impulse at ${first}, want ${proc.latency}`);
  }
});

test('a sub-minimum lookahead is clamped to 7 samples and still produces audio', () => {
  const sr = 48000;
  const [x0, x1] = makeSignal(sr);
  const params = parseLimiterParams({ lookahead: 0.00005 }, sr); // 2.4 samples -> 7
  assert.equal(params.lookahead, 7);
  const proc = makeProcessor(sr, params);
  assert.equal(proc.latency, 7);
  const [o0, o1] = runProcessor(proc, x0, x1);
  assert.ok(o0.some((v) => v !== 0) && o1.some((v) => v !== 0), 'clamped limiter emitted silence');
  for (const o of [o0, o1]) for (const v of o) assert.ok(Number.isFinite(v), 'non-finite output after clamp');
  assert.ok(maxAbs(o0) <= lin(-1) + TINY && maxAbs(o1) <= lin(-1) + TINY);
});

test('illegal release (0, negative, NaN) falls back to 120 ms with finite, non-silent output', () => {
  const sr = 44100;
  const [x0, x1] = makeSignal(sr);
  const defaultDecay = Math.exp(-1 / (0.12 * sr));
  for (const release of [0, -0.5, Number.NaN]) {
    const proc = makeProcessor(sr, { ...parseLimiterParams({}, sr), release });
    assert.ok(Math.abs(proc.decay - defaultDecay) < TINY, `release ${release} did not take the default`);
    const [o0, o1] = runProcessor(proc, x0, x1);
    for (const o of [o0, o1]) {
      for (const v of o) assert.ok(Number.isFinite(v), `NaN/Inf output for release=${release}`);
      assert.ok(o.some((v) => v !== 0), `whole render went silent for release=${release}`);
    }
  }
});

test('stereo link: both channels share one gain, the image never shifts', () => {
  const sr = 44100;
  const [x0, x1] = makeSignal(sr); // deliberately asymmetric channels
  const proc = makeProcessor(sr, parseLimiterParams({ ceiling: -3 }, sr));
  const [o0, o1] = runProcessor(proc, x0, x1);
  // Wherever both inputs are non-zero, o0/x0 and o1/x1 must be the same gain sample by sample.
  let checked = 0;
  for (let i = proc.latency; i < sr; i++) {
    const a = x0[i - proc.latency], b = x1[i - proc.latency];
    if (Math.abs(a) > 0.05 && Math.abs(b) > 0.05) {
      const g0 = o0[i] / a, g1 = o1[i] / b;
      // One shared gain computed in float64 and applied through float32 channels: only round-off differs.
      assert.ok(Math.abs(g0 - g1) <= 1e-6, `gain split at ${i}: L ${g0} vs R ${g1}`);
      checked++;
    }
  }
  assert.ok(checked > 1000, 'test did not exercise enough shared-gain samples');
});

test('custom ceiling/lookahead/release are honored end to end', () => {
  const sr = 44100;
  const [x0, x1] = makeSignal(sr);
  const params = parseLimiterParams({ ceiling: -4.5, lookahead: 0.008, release: 0.25 }, sr);
  assert.equal(params.lookahead, Math.round(0.008 * sr));
  const proc = makeProcessor(sr, params);
  assert.equal(proc.latency, params.lookahead);
  assert.ok(Math.abs(proc.decay - Math.exp(-1 / (0.25 * sr))) < TINY);
  assert.ok(Math.abs(proc.ceiling - lin(-4.5 - 0.05)) < TINY);
  const [o0, o1] = runProcessor(proc, x0, x1);
  for (const o of [o0, o1]) {
    assert.ok(maxAbs(o) <= lin(-4.5) + TINY);
    assert.ok(truePeak(o) <= lin(-4.5) + TINY);
  }
});

test('odd block sizes do not change the result (state crosses blocks cleanly)', () => {
  const sr = 44100;
  const [x0, x1] = makeSignal(sr);
  const params = parseLimiterParams({ ceiling: -2 }, sr);
  const a = runProcessor(makeProcessor(sr, params), x0, x1, 128);
  const b = runProcessor(makeProcessor(sr, params), x0, x1, 37);
  for (let i = 0; i < a[0].length; i++) {
    assert.equal(a[0][i], b[0][i]);
    assert.equal(a[1][i], b[1][i]);
  }
});

await Promise.all(pending);
console.log(`\n${passed} test group(s) passed${process.exitCode ? ' with FAILURES' : ''}`);
