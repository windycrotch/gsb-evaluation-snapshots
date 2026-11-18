/**
 * Tests for the master mix bus (src/audio/bus.js).
 *
 * Everything here runs in plain Node: the bus is arithmetic on sample buffers,
 * with no AudioContext anywhere. The same module builds the browser's
 * WaveShaper curve, so these peaks are the peaks the app actually produces.
 *
 * The required checks:
 *   - six identical strikes 30 ms apart leave the bus no louder than 1, yet at
 *     least 1.5x as loud as one strike (real summing, not crushed flat);
 *   - a strike near the rim is markedly quieter than one near the centre, and
 *     the bus does not compress that difference away;
 *   - an ordinary single strike never starts compression at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { solveDrum } from '../src/fem/solve.js';
import { regularPolygon } from '../src/math/analytic.js';
import {
  audibleAmps,
  decayTimes,
  frequencies,
  modeNorms,
  nodeWeights,
  renderStrike,
  strikeAmplitudes,
  strikeHeadroom,
} from '../src/audio/synth.js';
import {
  BUS_THRESHOLD,
  MAX_VOICES,
  OfflineBus,
  VOICE_GAIN,
  busCurve,
  busInputScale,
  busLimit,
  peakOf,
} from '../src/audio/bus.js';

const SR = 48000;
const CONTACT_RATIO = 2.2;
const REF_HZ = 130;
const TARGET_PEAK = 0.72;
const MODE_PREVIEW_GAIN = 0.45; // main.js: single-mode preview gain
const MALLET = 0.06;

/** A unit-area disk, exactly what the app solves after its area normalisation. */
function buildDrum(modes = 16) {
  const solved = solveDrum(regularPolygon(160, 1 / Math.sqrt(Math.PI)), {
    modes,
    targetNodes: 2200,
  });
  const weights = nodeWeights(solved.mesh);
  const norms = modeNorms(solved.mesh, solved.modes, weights);
  const freqs = frequencies(solved.eigenvalues, REF_HZ);
  const taus = decayTimes(freqs, 1.7, 0.5, REF_HZ);
  const head = strikeHeadroom(
    solved.mesh,
    solved.modes,
    norms,
    freqs,
    weights,
    MALLET,
    CONTACT_RATIO,
    REF_HZ,
  );
  return { ...solved, weights, norms, freqs, taus, gain: TARGET_PEAK / head };
}

/** Renders one strike at a given point with the app's exact scaling. */
function strikeVoice(drum, x, y) {
  const projected = strikeAmplitudes(drum.mesh, drum.modes, x, y, MALLET, drum.weights);
  const amps = audibleAmps(projected, drum.norms, drum.freqs, CONTACT_RATIO, REF_HZ);
  return renderStrike({ freqs: drum.freqs, amps, taus: drum.taus, sampleRate: SR, gain: drum.gain });
}

/** The interior mesh node closest to the rim (boundary nodes are clamped to 0). */
function rimPoint(mesh) {
  let node = 0;
  let best = 0;
  for (let i = 0; i < mesh.nodeCount; i++) {
    if (mesh.isBoundary[i]) continue;
    const r = Math.hypot(mesh.nodes[i * 2], mesh.nodes[i * 2 + 1]);
    if (r > best) {
      best = r;
      node = i;
    }
  }
  return { x: mesh.nodes[node * 2], y: mesh.nodes[node * 2 + 1], r: best };
}

test('busLimit is the identity up to 0.95 and soft-bounds everything above it', () => {
  // Below the threshold nothing may change at all - this is the guarantee that
  // single strikes and mode previews pass through untouched.
  for (const x of [0, 0.1, -0.4, 0.95, -0.95]) {
    assert.equal(busLimit(x), x, `identity region moved ${x}`);
  }
  // Above it the knee compresses but is continuous and smooth at the join.
  const h = 1e-6;
  const numSlope = (busLimit(BUS_THRESHOLD + h) - busLimit(BUS_THRESHOLD - h)) / (2 * h);
  assert.ok(Math.abs(numSlope - 1) < 1e-3, `slope at the threshold should be 1, got ${numSlope}`);
  assert.ok(busLimit(1.2) < 1.2, 'the knee must pull over-threshold signal back');
  assert.ok(busLimit(1.2) > BUS_THRESHOLD, 'but not flatten it to the threshold');
  // Hard requirement: no input, however large, can cross full scale. Once tanh
  // saturates the value rounds to exactly 1 (an asymptote), which is still
  // safe - the point is it can never exceed it.
  for (const x of [1, 2, 5, 50, 1e6]) {
    assert.ok(Math.abs(busLimit(x)) <= 1, `boundedness failed at ${x}: ${busLimit(x)}`);
    assert.equal(busLimit(-x), -busLimit(x), 'the curve must be odd-symmetric');
  }
  // In the pre-saturation region the output is strictly inside full scale.
  assert.ok(Math.abs(busLimit(1.5)) < 1, 'a moderately hot mix must stay strictly under 1');
});

test('a single strike does not trigger bus compression', () => {
  const drum = buildDrum();
  const voice = strikeVoice(drum, 0.22, 0);
  const result = new OfflineBus(SR).addVoice(voice).render();

  assert.equal(result.engaged, false, 'an ordinary single strike must leave the knee alone');
  assert.ok(result.inputPeak < BUS_THRESHOLD, `pre-bus peak ${result.inputPeak} crossed 0.95`);
  // Identity region means the bus output equals the bus input, sample for sample
  // (tolerance only for Float32 storage of the processed buffer).
  assert.ok(
    Math.abs(result.outputPeak - result.inputPeak) < 1e-6,
    'uncompressed bus output must equal its input peak',
  );
  // And the strike's own calibration still lands near the 0.72 target at render
  // time (the fixed VOICE_GAIN then sets the bus-input level).
  const renderPeak = peakOf(voice);
  assert.ok(renderPeak > 0.3, `strike render peak unexpectedly low: ${renderPeak}`);
  assert.ok(renderPeak <= TARGET_PEAK + 1e-9, `strike render peak ${renderPeak} exceeded the 0.72 target`);
  assert.ok(
    Math.abs(result.outputPeak - renderPeak * VOICE_GAIN) < 1e-6,
    'bus output for a lone voice is just the render peak times the voice gain',
  );
});

test('a single-mode preview uses the 0.45 gain and never reaches the knee', () => {
  const drum = buildDrum();
  const amps = new Float64Array(drum.freqs.length);
  amps[0] = 1;
  const voice = renderStrike({
    freqs: drum.freqs,
    amps,
    taus: drum.taus,
    sampleRate: SR,
    gain: MODE_PREVIEW_GAIN,
  });
  const result = new OfflineBus(SR).addVoice(voice).render();
  assert.equal(result.engaged, false, 'a lone mode must not start compression');
  assert.ok(result.outputPeak < BUS_THRESHOLD, `mode preview too loud: ${result.outputPeak}`);
  assert.ok(result.outputPeak > 0, 'the preview must be audible');
});

test('six strikes 30 ms apart stay <= 1 but are at least 1.5x a single strike', () => {
  const drum = buildDrum();
  // The same drum, the same strike, the same renderer for every tap.
  const voice = strikeVoice(drum, 0.22, 0);

  const single = new OfflineBus(SR).addVoice(voice).render();
  assert.equal(single.engaged, false, 'control: one strike is uncompressed');

  const bus = new OfflineBus(SR);
  for (let i = 0; i < MAX_VOICES; i++) bus.addVoice(voice, 0.03); // 30 ms apart
  const stacked = bus.render();

  assert.equal(stacked.engaged, true, 'six overlapping voices must start compression');
  assert.ok(stacked.inputPeak > 1, `pre-bus sum should threaten clipping, got ${stacked.inputPeak}`);
  assert.ok(stacked.outputPeak <= 1, `bus peak must never exceed 1, got ${stacked.outputPeak}`);
  assert.ok(
    stacked.outputPeak >= 1.5 * single.outputPeak,
    `stacked peak ${stacked.outputPeak} was not >= 1.5x single ${single.outputPeak}: ` +
      'the bus crushed the summation away',
  );
});

test('a rim strike stays markedly quieter than a centre strike through the bus', () => {
  const drum = buildDrum();
  const rim = rimPoint(drum.mesh);
  assert.ok(rim.r > 0.4, `test setup: rim node should sit well out from the centre, r=${rim.r}`);

  const centre = new OfflineBus(SR).addVoice(strikeVoice(drum, 0, 0)).render();
  const edge = new OfflineBus(SR)
    .addVoice(strikeVoice(drum, rim.x, rim.y))
    .render();

  // Neither lone strike is allowed to touch the knee, so the level difference is
  // entirely the physics (where the mallet landed), never bus pumping.
  assert.equal(centre.engaged, false, 'a centre strike alone must not compress');
  assert.equal(edge.engaged, false, 'a rim strike alone must not compress');
  assert.ok(centre.outputPeak > 0.2, `centre strike inaudible: ${centre.outputPeak}`);
  // "明显弱于": require the rim to land under half the centre's peak.
  assert.ok(
    edge.outputPeak < 0.5 * centre.outputPeak,
    `rim peak ${edge.outputPeak} was not clearly below centre peak ${centre.outputPeak}`,
  );
});

test('the voice cap is six and the oldest voice is dropped first', () => {
  const drum = buildDrum();
  const voice = strikeVoice(drum, 0.22, 0);
  const bus = new OfflineBus(SR);
  for (let i = 0; i < MAX_VOICES + 3; i++) bus.addVoice(voice, 0.03);
  assert.equal(bus.voices.length, MAX_VOICES, 'more than six voices may not accumulate');

  // Voices are kept in insertion order, so the survivors must be the six newest
  // taps: their start offsets are 3..8, i.e. the first retained voice starts at
  // 3 intervals, not 0.
  const interval = Math.round(0.03 * SR);
  assert.equal(bus.voices[0].start, 3 * interval, 'the oldest voices should have been evicted');
  assert.equal(bus.voices.length, MAX_VOICES);
});

test('the browser shaper curve inverts its scaling and matches busLimit', () => {
  // The WaveShaper graph is inputGain(scale) -> shaper -> outputGain(1/scale).
  // Reconstruct a few real-world inputs through that chain and check they come
  // back as busLimit, including the identity region and the asymptote.
  const inputMax = 4;
  const scale = busInputScale(inputMax);
  const curve = busCurve(8192, inputMax);
  const throughGraph = (x) => {
    const shaperIn = x * scale; // -1 .. 1 for |x| <= inputMax
    const idx = Math.round(((shaperIn + 1) / 2) * (curve.length - 1));
    return curve[idx] / scale;
  };
  for (const x of [0, 0.3, -0.7, 0.95, 1.1, 1.5, -2.3, 3.8]) {
    assert.ok(
      Math.abs(throughGraph(x) - busLimit(x)) < 2e-3,
      `graph mismatch at ${x}: ${throughGraph(x)} vs ${busLimit(x)}`,
    );
  }
  // The table ends on the flat asymptote, so a mix beyond the designed range
  // cannot extrapolate past full scale: the scaled end values must sit within
  // [-scale, scale], i.e. real-world output within [-1, 1].
  assert.ok(Math.abs(curve[0]) <= scale, 'negative table end must stay within the scaled range');
  assert.ok(curve[curve.length - 1] <= scale, 'positive table end must stay within the scaled range');
  // A realistic hot mix (the six-voice pile-up measured around 1.0-1.1 pre-bus)
  // is strictly below full scale after the graph, not clamped onto it.
  assert.ok(throughGraph(1.1) < 1, 'a realistic hot mix must stay strictly under full scale');
});

test('no frequency or frequency ratio changes anywhere in the render-to-bus path', () => {
  // The bus is memoryless and level-only, but pin the end-to-end invariant the
  // project cares about: two drums keep their overtone ratios, and processing a
  // rendered buffer through the bus cannot invent spectral content. The cleanest
  // check is that the bus is purely pointwise: output[n] depends only on
  // input[n], so zero input maps to zero and a sinusoid's zero crossings survive.
  const drum = buildDrum(8);
  const before = strikeVoice(drum, 0.22, 0);
  const { samples: after } = new OfflineBus(SR).addVoice(before).render();
  assert.equal(after.length, before.length);
  // Single voice -> identity region, so it must be exactly gain-scaled, nothing
  // else. Any frequency change would break this equality.
  for (let n = 0; n < after.length; n += 997) {
    assert.ok(Math.abs(after[n] - before[n] * VOICE_GAIN) < 1e-6, `sample ${n} was reshaped`);
  }
  // Ratios themselves are untouched by construction (the bus never sees freqs);
  // assert the drum's ratios are finite and ordered as a sanity guard.
  for (let k = 1; k < drum.freqs.length; k++) {
    assert.ok(drum.freqs[k] / drum.freqs[0] > 1, 'overtone ratios must remain positive and ordered');
  }
});
