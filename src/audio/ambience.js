/* The world the car is driving through, as opposed to the car.
 *
 * Everything else in src/audio is attached to the vehicle and stops when the
 * vehicle stops. This layer is the place: a coast road at golden hour, ocean
 * below on one side, open air, gulls. It runs whether or not anything is
 * moving, and it is the only part of the mix that carries a sense of where the
 * car is rather than what it is doing.
 *
 * Three ideas do most of the work here.
 *
 * Surf is not one sound. Standing above a shoreline you hear three separate
 * things with different distances and different time constants: a low boom
 * that arrives when a wave closes out, a mid wash that never stops, and a
 * bright hiss of foam draining off shingle that lags the boom by a second or
 * two. Synthesised as one filtered noise band it reads as a fan. Split into
 * three bands on decorrelated swell envelopes it reads as water.
 *
 * The swell is driven by oscillators, not by the frame loop. Sub-hertz sines
 * at incommensurate rates sum to something that never quite repeats, and
 * because they are audio-rate nodes writing an AudioParam they stay smooth at
 * any frame rate — a swell stepped once per frame is a staircase, and on a
 * signal this quiet and this slow the staircase is exactly what the ear finds.
 *
 * Distance is modelled as a filter, not just as a fader. Air absorbs treble
 * over hundreds of metres, so surf heard from a road forty metres up is dull
 * as well as quiet, and opening the low-pass as the road drops toward the
 * water is most of what sells the descent.
 *
 * Two things are deliberately unlike the rest of the mix. The side the water
 * is on is only as trustworthy as the bearing it arrived with, so the caller
 * supplies a sideConfidence alongside oceanSide: when the road is mid-hairpin
 * and the projected bearing is noise, the surf is pulled toward the centre of
 * the image rather than committed to whichever side the lagging scalar was
 * passing through. It re-expands when the bearing settles again. And a jump
 * is a change of medium for the ear, not just for the tyres: the surf and the
 * sea air step back while the car is off the ground — audibly, but nowhere
 * near silence — and gulls stop entirely, because a gull call from a car that
 * is not in contact with the world is the thing that makes a jump sound
 * canned. Both are smoothed here, with the same setTargetAtTime discipline as
 * every other parameter.
 */
import { clamp, lerp, approach, smoothstep } from '../core/util.js';
import { rng, rand } from '../core/rng.js';
import { noiseSource } from './noise.js';

const TAU = 0.30;          // ambience is slow; nothing here should snap
const GULL_MIN = 7;        // seconds between calls, at best
const GULL_MAX = 23;

export class Ambience {
  constructor(ctx, dest, buffers, seed = 8123) {
    this.ctx = ctx;
    this.buf = buffers.white;
    this.rand = rand(rng(seed));
    this.nodes = [];
    this.sources = [];
    const node = (n) => { this.nodes.push(n); return n; };

    this.surf = node(ctx.createGain());
    this.surf.gain.value = 0.0001;
    this.surf.connect(dest);

    /* Swell. Five sines below a quarter of a hertz, deliberately not in any
       simple ratio: the sum has a period measured in minutes, which is longer
       than anyone will hold still and listen. */
    /* Every OscillatorNode starts at phase zero, so a bank of them all peaks
       together on the first breath. That is audible for the first half minute
       and then never again — the rates below are mutually irrational enough
       that they scatter and stay scattered — but the first half minute is when
       anyone is listening, so the depths are staggered rather than equal and
       no band is driven by fewer than two of them. */
    const lfo = (hz) => {
      const o = ctx.createOscillator();
      o.frequency.value = hz;
      o.start(0);
      this.sources.push(o);
      const g = node(ctx.createGain());
      o.connect(g);
      return { osc: o, g };
    };

    const swellA = lfo(0.071);
    const swellB = lfo(0.113);
    const swellC = lfo(0.043);
    const swellD = lfo(0.167);
    const swellE = lfo(0.029);

    const bq = (type, freq, q = 0.7) => {
      const f = node(ctx.createBiquadFilter());
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      return f;
    };

    /* One band per distance, and each band is a stereo pair.
     *
     * The pair is the point. Panning one mono source is a level difference
     * between two otherwise identical channels, and identical channels are
     * what a listener hears as "inside my head" no matter where the pan pot
     * is — the correlation between the ears is what carries width, not the
     * balance. Real surf is a line source hundreds of metres long and the two
     * ears never receive the same waveform from it, so each band here runs two
     * independent slices of noise at slightly different playback rates, placed
     * at different points around the band's nominal direction.
     *
     * `am` is the swell-modulated stage — its intrinsic value is the floor and
     * the LFOs sum on top of it, so the band breathes between roughly a third
     * and full without ever gating shut. `lvl` is what update() writes, so
     * proximity scales the whole breathing band rather than fighting the
     * modulation for the same parameter.
     */
    const band = (src, spec, floor, rates, offsets) => {
      /* Both stages are downstream of the panners and therefore stereo, which
         is what keeps the two AudioParams that have to agree down to zero: one
         gain scales the pair. */
      const am = node(ctx.createGain());
      am.gain.value = floor;
      const lvl = node(ctx.createGain());
      lvl.gain.value = 0.0001;
      am.connect(lvl);
      lvl.connect(this.surf);

      const pans = [], filters = [];
      for (let side = 0; side < 2; side++) {
        const p = node(ctx.createStereoPanner());
        p.connect(am);
        pans.push(p);
        const chain = spec.map(([type, freq, q]) => bq(type, freq, q));
        for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
        const trim = node(ctx.createGain());
        trim.gain.value = 0.6;
        chain[chain.length - 1].connect(trim);
        trim.connect(p);
        this.sources.push(noiseSource(ctx, src, chain[0],
          { rate: rates[side], offset: offsets[side] }));
        filters.push(chain);
      }
      /** Write the same frequency to both sides of the pair. */
      const tune = (i, hz, t, tau) => {
        filters[0][i].frequency.setTargetAtTime(hz, t, tau);
        filters[1][i].frequency.setTargetAtTime(hz, t, tau);
      };
      return { am, lvl, pans, tune };
    };

    /* Boom — the close-out. Almost all below 200 Hz, on the slowest swells.
       Kept near the centre: low frequencies localise poorly and hard-panning
       them only makes the mix lopsided. Still two sources, because two
       decorrelated low bands is what makes the water feel like it surrounds
       the road rather than sitting at a point on it. */
    this.boom = band(buffers.pink, [['highpass', 42, 0.7], ['lowpass', 190, 0.9]],
      0.30, [0.83, 0.97], [0.07, 1.53]);

    /* Wash — the body of the sound and the part that never stops. */
    this.wash = band(buffers.pink, [['highpass', 160, 0.7], ['lowpass', 900, 0.8]],
      0.52, [1.0, 1.13], [0.61, 1.71]);

    /* Foam — the bright drain-off. Widest of the three, because that is where
       the ear takes its directional information from. */
    this.foam = band(buffers.white, [['highpass', 900, 0.7], ['lowpass', 5200, 0.7]],
      0.34, [1.19, 1.31], [1.31, 0.29]);

    /* Which swell drives which band, and how deep. The foam is peakier than
       the wash because foam is what a breaking wave leaves behind, and the
       boom is the slowest because sets are slow. Depths sum to less than the
       floor plus one so nothing inverts. */
    const drive = (target, pairs) => {
      for (const [sw, amt] of pairs) {
        const g = node(this.ctx.createGain());
        g.gain.value = amt;
        sw.g.connect(g);
        g.connect(target.am.gain);
      }
    };
    drive(this.boom, [[swellC, 0.34], [swellE, 0.26], [swellA, 0.10]]);
    drive(this.wash, [[swellA, 0.22], [swellB, 0.14], [swellC, 0.12]]);
    drive(this.foam, [[swellB, 0.30], [swellD, 0.22], [swellC, 0.14]]);

    /* Sea air ----------------------------------------------------------
     *
     * Not the same thing as the wind roar in surface.js, which is the car
     * pushing a hole through the atmosphere and scales with v². This is the
     * onshore breeze, present at a standstill, and it is what stops a parked
     * car sounding like it is in a vacuum. Two decorrelated sources panned
     * apart rather than one in the middle: a mono hiss reads as a fault in the
     * speakers, the same hiss decorrelated across the pair reads as air. */
    this.seaWind = node(ctx.createGain());
    this.seaWind.gain.value = 0.0001;
    this.seaWind.connect(dest);

    const gustA = lfo(0.089);
    const gustB = lfo(0.211);
    const gustC = lfo(0.037);

    const airSide = (pan, rate, offset, pairs) => {
      const hi = bq('highpass', 220, 0.7);
      const lo = bq('lowpass', 1100, 0.6);
      const am = node(ctx.createGain());
      am.gain.value = 0.55;
      const p = node(ctx.createStereoPanner());
      p.pan.value = pan;
      this.sources.push(noiseSource(ctx, buffers.pink, hi, { rate, offset }));
      hi.connect(lo); lo.connect(am); am.connect(p); p.connect(this.seaWind);
      for (const [sw, amt] of pairs) {
        const g = node(ctx.createGain());
        g.gain.value = amt;
        sw.g.connect(g);
        g.connect(am.gain);
      }
      return { hi, lo, am, pan: p };
    };
    this.airL = airSide(-0.72, 0.91, 0.23, [[gustA, 0.26], [gustC, 0.18]]);
    this.airR = airSide(0.72, 1.07, 1.47, [[gustB, 0.24], [gustC, 0.16]]);

    /* Gulls -------------------------------------------------------------
     *
     * The one layer here that is a discrete event, and the one that is most
     * easily overdone: a call every few seconds stops being life and starts
     * being a ringtone. Sparse, quiet, never twice from the same place, and
     * silenced entirely at speed where the wind would drown it anyway. */
    this.gull = node(ctx.createGain());
    this.gull.gain.value = 0.9;
    this.gull.connect(dest);
    this.gullTimer = this.rand.f(3, 9);

    this.swell = 0;
    this.near = 0;
    this.side = 0;
    /* How much the side estimate is trusted, and how far into a jump the car
       is. Both are smoothed here rather than read straight off the state
       struct: a bearing that is ambiguous for a single frame must not snap the
       image, and `airborne` can chatter when the car skims a crest. */
    this.conf = 1;
    this.air = 0;
    this.gullGate = 1;
    /* Last known shore geometry, for callers that hand this class a partial
       state struct rather than going through Audio's own latch. A missing
       field must never turn into NaN — a NaN AudioParam is silence at best
       and a throw at worst. */
    this.shore = { distance: 70, drop: 40, side: 0 };
  }

  /**
   * @param {number} dt
   * @param {object} s  shoreDistance / shoreDrop / oceanSide / sideConfidence /
   *                    speed / openness / airborne
   * @param {number} t  when, on the engine's clock
   */
  update(dt, s, t) {
    const set = (p, v, tau = TAU) => p.setTargetAtTime(v, t, tau);
    const r = this.rand;

    /* Distance to the water as the sound travels: along the ground and down
       the cliff. The drop counts for less than the horizontal run because the
       road is looking straight at the water rather than past it — the cliff
       does not shadow what is directly below.
     *
     * Latched. Audio.update() latches the three shore fields before they get
     * here, but this class is also driven directly by the offline harness and
     * has to survive a partial struct on its own: an absent field means "no
     * news", not "zero", and only a finite value is accepted so a NaN out of a
     * track query in the middle of a tunnel bounces off instead of poisoning
     * every filter downstream. */
    const sh = this.shore;
    if (Number.isFinite(s.shoreDistance)) sh.distance = Math.max(0, s.shoreDistance);
    if (Number.isFinite(s.shoreDrop)) sh.drop = Math.max(0, s.shoreDrop);
    if (Number.isFinite(s.oceanSide)) sh.side = clamp(s.oceanSide, -1, 1);

    const flat = sh.distance;
    const drop = sh.drop;
    const dist = Math.hypot(flat, drop * 0.62);

    /* Inverse-square would fade the surf to nothing within a hundred metres
       and a coastline is a line source, not a point — it falls off closer to
       inverse-distance, which is why you can hear it from the top of a cliff.
       The exponent splits the difference and the +1 keeps it finite at zero. */
    const near = clamp(1 / (1 + Math.pow(dist / 46, 1.35)), 0, 1);
    this.near = approach(this.near, near, 1.6, dt);
    const n = this.near;

    /* Irregularity the oscillator bank cannot supply. Slow, shallow, and
       bounded — the swells carry the shape, this only stops the sum from
       being exactly periodic. */
    this.swell = approach(this.swell, r.f(-1, 1), 0.55, dt);

    /* Wind noise past the shell rises with v² and buries everything quiet
       long before it buries the engine. Pulling the ambience down as the car
       gets fast is not realism, it is the mix staying legible: at 200 km/h
       there is no headroom left for a distant ocean and holding it up only
       adds mud in the same band as the tyres. */
    const fast = smoothstep(18, 62, s.speed);
    const duck = lerp(1, 0.45, fast);

    /* Off the ground, the world gets quieter for the ear as well as for the
       tyres — but not silent, and not the same hard gate the tyres get.
       Airborne, there is nothing between the car and the coast, so the surf is
       arguably closer; what actually changes is that the whole bed is no
       longer masked by road noise, and a surf layer held at full level through
       a jump reads as a backing track that forgot the car left the ground.
       The dip is deliberately shallow — about 3.5 dB, measured on the layer
       and unchanged by the master chain — arrives quickly, and comes back over
       the best part of a second so the landing does not slam the ocean back
       in. Gulls are the exception and get a real gate: see below. */
    this.air = approach(this.air, s.airborne ? 1 : 0, s.airborne ? 6.5 : 2.4, dt);
    const airDuck = lerp(1, 0.66, this.air);

    /* Air absorption. Forty metres up and a hundred out, surf is a rumble;
       from the roadside at ten metres it hisses. */
    this.boom.tune(1, 150 + n * 110, t, 0.5);
    this.wash.tune(0, 190 - n * 70, t, 0.5);
    this.wash.tune(1, 420 + n * 1500, t, 0.5);
    this.foam.tune(0, 1500 - n * 700, t, 0.5);
    this.foam.tune(1, 2200 + n * 4200, t, 0.5);

    const swell = 1 + this.swell * 0.14;
    set(this.surf.gain, 1, 0.1);
    set(this.boom.lvl.gain, 0.0001 + 0.34 * Math.pow(n, 0.75) * swell * duck * airDuck);
    set(this.wash.lvl.gain, 0.0001 + 0.26 * n * swell * duck * airDuck);
    /* Foam is the first thing distance takes away, so it is squared: audible
       from the roadside, gone from the top of the cliff. */
    set(this.foam.lvl.gain, 0.0001 + 0.17 * n * n * swell * duck * airDuck);

    /* Which side the water is on, and how wide each band is allowed to be.
     *
     * The higher the frequency the better the ear localises it, so the bright
     * band is placed hardest and the boom stays near the middle. The two
     * sources inside each band are not placed at the same point — they
     * straddle the nominal direction — which is what keeps the water a body of
     * sound off to one side rather than a hard-panned loop.
     *
     * The bearing is only trusted as far as the caller says it should be.
     * `oceanSide` is a scalar that follows the car's heading, and on a
     * switchback it is briefly pointing at the wrong side while the projection
     * catches up — the pan sweeping through the whole stereo field and out the
     * other side, which is the one artefact that makes a wide surf bed read as
     * a pan effect rather than as a place. So the bearing is scaled by a
     * smoothed confidence: at 1 the bands sit fully to the side, at 0 they
     * collapse to the centre with their width intact (the two halves of each
     * pair stay apart from each other, which is what keeps the correlation
     * low), and in between they open and close continuously. Losing
     * confidence is faster than regaining it, because the reason to collapse
     * is a wrong image now and the reason to re-expand is a right one that
     * should not flicker.
     */
    const confIn = clamp(Number.isFinite(s.sideConfidence) ? s.sideConfidence : 1, 0, 1);
    this.conf = approach(this.conf, confIn, confIn < this.conf ? 8 : 1.8, dt);
    this.side = approach(this.side, sh.side, 2.2, dt);
    /* Unknown side is not "left" — it is the centre. `oceanSide: 0` therefore
       feeds the same collapse as a low confidence, which is what makes the
       hairpin case continuous instead of a hard cut to one channel. */
    const side = this.side * this.conf;
    const place = (b, centre, spread) => {
      set(b.pans[0].pan, clamp(side * centre - spread, -1, 1), 0.4);
      set(b.pans[1].pan, clamp(side * centre + spread, -1, 1), 0.4);
    };
    place(this.boom, 0.18, 0.52);
    place(this.wash, 0.50, 0.46);
    place(this.foam, 0.72, 0.34);

    /* Sea air. Onshore, so it is stronger when the ocean is close and when
       the road is exposed; the low-pass opens a little with the car's own
       speed because the relative airflow does rise, but the level does not —
       that is surface.js's job and doubling it up is how you get mud. It
       shares the airborne dip with the surf, because a jump changes what the
       ear is in, not just where the water is. */
    const exposure = lerp(0.55, 1, clamp(s.openness ?? lerp(0.4, 1, n), 0, 1));
    const air = 0.052 * exposure * lerp(1, 0.5, fast) * airDuck;
    set(this.seaWind.gain, 0.0001 + air);
    for (const vent of [this.airL, this.airR]) {
      set(vent.lo.frequency, 900 + s.speed * 9, 0.4);
      set(vent.hi.frequency, 200 + n * 60, 0.4);
    }

    /* Gulls. Gated on being near the water, on not going fast enough to drown
       them, and on the clock — and the interval is redrawn every time, so the
       calls never fall into a rhythm.
     *
     * Airborne is a hard gate rather than a closed door: refusing to schedule
     * a call is not enough, because a call placed a moment before take-off
     * would still be ringing a second into the jump. The gull bus itself is
     * pulled to zero while the car is off the ground, fast enough that the
     * silence arrives with the wheels leaving and slowly enough not to click,
     * and it comes back on the same ramp the surf does. This is the one layer
     * that is *completely* silent in the air, and it is the right one: a call
     * implies a bird near the car, and the car is not where it was. */
    this.gullGate = approach(this.gullGate, s.airborne ? 0 : 1,
      s.airborne ? 40 : 4, dt);
    set(this.gull.gain, 0.9 * this.gullGate, 0.02);
    this.gullTimer -= dt;
    const canCall = n > 0.22 && s.speed < 46 && !s.airborne;
    if (this.gullTimer <= 0) {
      this.gullTimer = r.f(GULL_MIN, GULL_MAX) * lerp(1.8, 1.0, n);
      if (canCall) {
        this.cry(t, clamp(side * r.f(0.2, 0.9) + r.f(-0.25, 0.25), -1, 1),
          0.16 * n * (1 - smoothstep(20, 46, s.speed)));
      }
    }
  }

  /**
   * One gull call, two or three syllables.
   *
   * A herring gull's cry is a harsh nasal thing with a hard attack and a
   * falling glide, and the harshness is the point: a sine glide reads as a
   * theremin. So it is a sawtooth — plenty of harmonics — pushed through a
   * narrow band-pass that tracks the glide, which is a formant, and a formant
   * on a buzzy source is what makes a synthesised animal sound like an animal
   * rather than like a synthesiser.
   *
   * @param {number} t
   * @param {number} pan -1..1
   * @param {number} level 0..1
   */
  cry(t, pan, level) {
    if (level < 0.005) return;
    const ctx = this.ctx;
    const r = this.rand;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 3.4;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 700;
    const g = ctx.createGain();
    /* See impact.js: a GainNode is born at 1 and the oscillator below starts
       sample-accurately, so the envelope has to be zeroed before it is
       scheduled or the call opens with a click. */
    g.gain.value = 0;
    g.gain.setValueAtTime(0.0001, t);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;

    osc.connect(band); band.connect(hp); hp.connect(g); g.connect(p); p.connect(this.gull);

    const syllables = r.i(2, 3);
    const f0 = r.f(760, 1180);
    let at = t;
    for (let i = 0; i < syllables; i++) {
      /* Each syllable starts a little lower and a little shorter than the
         last — a gull runs out of breath down the call, and a set of
         identical syllables reads as a loop. */
      const fall = Math.pow(0.87, i);
      const dur = r.f(0.11, 0.19) * Math.pow(0.9, i);
      const top = f0 * fall * r.f(0.96, 1.05);
      const bot = top * r.f(0.55, 0.7);
      osc.frequency.setValueAtTime(top * 0.82, at);
      osc.frequency.exponentialRampToValueAtTime(top, at + dur * 0.18);
      osc.frequency.exponentialRampToValueAtTime(bot, at + dur);
      band.frequency.setValueAtTime(top * 1.9, at);
      band.frequency.exponentialRampToValueAtTime(bot * 2.4, at + dur);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(level * lerpAmp(i, syllables), at + 0.014);
      g.gain.setTargetAtTime(0.0001, at + dur * 0.55, dur * 0.22);
      at += dur + r.f(0.05, 0.13);
    }

    const end = at + 0.25;
    osc.start(t);
    osc.stop(end);
    osc.onended = () => {
      osc.disconnect(); band.disconnect(); hp.disconnect(); g.disconnect(); p.disconnect();
    };
  }

  dispose() {
    for (const s of this.sources) { try { s.stop(); } catch (_) {} }
    for (const n of this.nodes) n.disconnect();
    for (const s of this.sources) s.disconnect();
  }
}

/* Loudest on the second syllable. Calls that decay monotonically sound like a
   fade-out rather than like an animal. */
function lerpAmp(i, n) {
  if (n < 2) return 1;
  return i === 1 ? 1 : i === 0 ? 0.82 : 0.6;
}
