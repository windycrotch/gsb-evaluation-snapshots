// Dev-only: render every preset offline and report what it actually does.
//
// There is no way to hear 48 presets while iterating on them, and a preset that
// throws or clips only shows up as a silence or a crunch you might not notice.
// This builds each one in an OfflineAudioContext at six pitches, applies its bus
// gain, and prints the peak and RMS so balance problems and exceptions both
// become numbers.
//
//   DESKSYNTH_SHOT_DELAY=25000 node tools/shots.mjs audit
//
// Output goes through console.warn because main.js only forwards warnings and
// errors from the renderer to the terminal.

import { PACKS } from './presets.js';
import { midiToFreq } from './scales.js';

const RATE = 44100;
// Long enough that a pad with a one-second attack has actually arrived before
// the key comes back up.
const SECONDS = 3.4;
const RELEASE_AT = 2.3;
const HOLD_WINDOW = [1.6, 2.2];
// Spread across the range and across pitch classes, so the drum kits get their
// kick, snare, hat and tom measured rather than whichever piece note 40 lands on.
const NOTES = [36, 43, 50, 57, 64, 71];

async function render(preset, midi) {
  const ctx = new OfflineAudioContext(1, Math.ceil(RATE * SECONDS), RATE);
  const bus = ctx.createGain();
  bus.gain.value = preset.gain;
  bus.connect(ctx.destination);

  const voice = preset.build(ctx, {
    midi,
    freq: midiToFreq(midi),
    vel: 0.9,
    t0: 0.01,
    out: bus,
  });
  if (!voice.ring) voice.release(RELEASE_AT);

  const buf = await ctx.startRendering();
  const d = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < d.length; i++) {
    const v = Math.abs(d[i]);
    if (v > peak) peak = v;
  }
  // RMS while the key is still down. For a held preset this is the level you
  // actually hear; for a ringing one it's the tail.
  const from = Math.floor(HOLD_WINDOW[0] * RATE);
  const to = Math.min(d.length, Math.floor(HOLD_WINDOW[1] * RATE));
  let sum = 0;
  for (let i = from; i < to; i++) sum += d[i] * d[i];
  return { peak, hold: Math.sqrt(sum / Math.max(1, to - from)) };
}

export async function auditPresets() {
  const problems = [];
  for (const pack of PACKS) {
    for (const preset of pack.presets) {
      const where = `${pack.name}/${preset.name}`;
      let peak = 0;
      let hold = 0;
      try {
        for (const midi of NOTES) {
          const r = await render(preset, midi);
          peak = Math.max(peak, r.peak);
          hold = Math.max(hold, r.hold);
        }
      } catch (err) {
        problems.push(`${where} threw ${err}`);
        console.error(`[audit] ${where} threw`, err);
        continue;
      }
      // CLASSIC/PLUCK peaks at 1.21 and has always been the loudest thing here,
      // so that is the ceiling. Nothing should need to be louder than the pluck.
      const flag = peak > 1.25 ? 'HOT' : peak < 0.15 ? 'QUIET' : 'ok';
      if (flag !== 'ok') problems.push(`${where} ${flag} peak ${peak.toFixed(2)}`);
      console.warn(`[audit] ${where.padEnd(22)} peak ${peak.toFixed(2)}  hold ${hold.toFixed(3)}  ${flag}`);
    }
  }
  console.warn(
    problems.length
      ? `[audit] ${problems.length} to look at:\n  ${problems.join('\n  ')}`
      : '[audit] all presets built and sat in range',
  );
  return problems;
}
