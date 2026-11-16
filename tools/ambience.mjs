/* Does the coast still know where it is?
 *
 * The full sound suite (tools/audio.mjs) proves the surf tracks distance and
 * sides, but it only ever feeds `oceanSide` a constant. Three things about the
 * ambience are invisible to a constant input and are exactly the ones that go
 * wrong in play:
 *
 *   - the bearing is not always trustworthy, so a confidence has to be able to
 *     take the surf to the centre and bring it back;
 *   - a jump changes what the ear is in, so the surf and the sea air have to
 *     step back and the gulls have to stop;
 *   - the road doubles back, so the pan has to sweep through the middle rather
 *     than hard-cut across it.
 *
 * Everything here is rendered through the real Audio engine on an
 * OfflineAudioContext, with all layers muted except the one under test. The
 * surviving layer is tapped at its own output rather than into the master bus;
 * see the comment above render() for why that distinction is load-bearing.
 * Renders are seeded and virtual-time, so the same run gives the same numbers.
 *
 * The airborne dip is measured as an A/B against an identical render with the
 * car grounded. Identical, not merely similar: at 47 m/s the gull layer never
 * schedules a call, so both renders consume the same random stream in the same
 * order and the swell envelope is sample-for-sample the same. The only
 * difference between the two is the airborne flag, and the ratio of their
 * levels in the same window is therefore the dip itself rather than the dip
 * plus whatever the ocean happened to be doing.
 *
 * Exit status is the gate: zero when every assertion holds, non-zero with one
 * line per failure otherwise. The verification runs used to prove the gate can
 * fail — dropping the confidence scaling, the airborne duck, or the gull gate
 * — each turned specific lines here red, which is the standard the rest of
 * tools/ is held to.
 *
 *   node tools/ambience.mjs
 */
import { chromium } from 'playwright';
import { serve } from './harness.mjs';
import { finish, guard } from './tame.mjs';

const SR = 44100;

async function inPage(body) {
  const srv = serve();
  await new Promise(r => srv.listen(0, r));
  const origin = `http://localhost:${srv.address().port}`;

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--renderer-process-limit=1',
    ],
  });
  guard(browser, srv);

  const errs = [];
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
    page.on('pageerror', e => errs.push('[pageerror] ' + (e.stack || e.message || e)));
    page.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
    await page.route(origin + '/__amb', route => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><meta charset=utf-8><title>ambience</title>',
    }));
    console.log(`→ ${origin}/__amb  (no game, Web Audio only)`);
    await page.goto(origin + '/__amb', { waitUntil: 'domcontentloaded' });
    return await body(page);
  } finally {
    await browser.close().catch(() => {});
    srv.close();
    if (errs.length) {
      console.log('\n─── page errors ───');
      [...new Set(errs)].slice(0, 15).forEach(e => console.log(' ', e));
    }
  }
}

let bad = 0;

await (async () => {
  const out = await inPage(page => page.evaluate(async (sr) => {
    const { Audio } = await import('/src/audio/index.js');

    const IDLE = 1050 / 7400;
    const base = {
      speed: 0, rpm: IDLE, gear: 0, throttle: 0, brake: 0, handbrake: 0,
      slipAngle: 0, wheelSlip: 0, offRoad: 0, airborne: false,
      shoreDistance: 12, shoreDrop: 8, oceanSide: -1, sideConfidence: 1,
    };
    const at = (o) => Object.assign({}, base, o);

    /* ---- measurement ---------------------------------------------------
     *
     * Balance and correlation only, plus the largest sample-to-sample jump.
     * Level is deliberately absent except where a ratio is the question: the
     * swell moves the bed by several dB on its own and comparing absolute
     * levels across windows is how a working layer gets reported as a broken
     * one. The A/B renders below are the exception, because they share a
     * swell sample for sample. */
    function stats(L, R, t0, t1) {
      const a = Math.max(0, Math.floor(t0 * sr));
      const b = Math.min(L.length, Math.floor(t1 * sr));
      let sqL = 0, sqR = 0, cross = 0, step = 0;
      for (let i = a; i < b; i++) {
        const l = L[i], r = R[i];
        sqL += l * l; sqR += r * r; cross += l * r;
        if (i > a) step = Math.max(step, Math.abs(l - L[i - 1]), Math.abs(r - R[i - 1]));
      }
      const n = Math.max(1, b - a);
      const rmsL = Math.sqrt(sqL / n), rmsR = Math.sqrt(sqR / n);
      return {
        rmsL: +rmsL.toFixed(6),
        rmsR: +rmsR.toFixed(6),
        rms: +Math.sqrt((sqL + sqR) / (2 * n)).toFixed(6),
        bal: +(20 * Math.log10((rmsR + 1e-9) / (rmsL + 1e-9))).toFixed(2),
        corr: +(cross / (Math.sqrt(sqL * sqR) + 1e-12)).toFixed(3),
        step: +step.toFixed(4),
      };
    }

    /* Balance in 0.3 s slices, and the largest step between neighbouring
       slices. A pan that is smoothed moves a fraction of a decibel per slice;
       a hard cut moves the whole image in one. */
    function slices(L, R, t0, t1, w = 0.3) {
      const out = [];
      for (let t = t0; t + w <= t1 + 1e-9; t += w) {
        out.push({ t: +t.toFixed(2), bal: stats(L, R, t, t + w).bal });
      }
      let jump = 0, at = 0;
      for (let i = 1; i < out.length; i++) {
        const d = Math.abs(out[i].bal - out[i - 1].bal);
        if (d > jump) { jump = d; at = out[i].t; }
      }
      return { points: out, jump: +jump.toFixed(2), at };
    }

    /* ---- render --------------------------------------------------------
     *
     * Each layer is tapped at its own output rather than through the master
     * bus, and that is a deliberate choice about what is being measured.
     *
     * The master chain is not neutral. Its compressor is level-dependent on
     * the whole mix, and the landing thump fires the impact sidechain, which
     * schedules a dip on the bus. Both are the mix's business and both ride on
     * top of any level change the ambience makes, so a window that spans a
     * landing measures the duck and the sidechain's recovery together and
     * cannot say which contributed what. Tapping the layer answers the
     * question actually being asked: did the surf and the sea air get quieter,
     * and by how much. Panning and correlation are unaffected by the tap. */
    async function render(sc, tap) {
      const ctx = new OfflineAudioContext(2, Math.ceil(sc.dur * sr), sr);
      const audio = new Audio({ context: ctx });
      await audio.start();
      if (tap) {
        const buses = audio.buses();
        for (const [name, node] of Object.entries(buses)) node.disconnect();
        audio.buses()[tap].connect(ctx.destination);
      }
      const H = 1 / 60;
      /* Scheduled by time, so sort: the loop below consumes from the front and
         an out-of-order list would hold a call until something later than it
         had fired. */
      const cries = (sc.cries || []).slice().sort((a, b) => a[0] - b[0]);
      for (let i = 0; i * H < sc.dur; i++) {
        const t = i * H;
        audio.update(H, sc.state(t));
        /* Manual calls, so gull silence can be measured at a known instant
           rather than waiting for the seeded timer to produce one. */
        while (cries.length && cries[0][0] <= t) {
          const [, pan, level] = cries.shift();
          audio.ambience.cry(audio.now, pan, level);
        }
      }
      const buf = await ctx.startRendering();
      audio.dispose();
      return [buf.getChannelData(0), buf.getChannelData(1)];
    }

    const results = {};

    /* ---- 1. confidence 1 → 0 → 1 -------------------------------------- */
    {
      const sc = {
        dur: 16,
        state: t => at({
          sideConfidence: t < 4 ? 1 : t < 9 ? 0 : 1,
        }),
      };
      const [L, R] = await render(sc, 'surf');
      const w = {
        left: stats(L, R, 2.5, 3.8),
        collapsing: stats(L, R, 4.15, 4.65),
        centre: stats(L, R, 7.0, 8.9),
        recovering: stats(L, R, 9.3, 9.8),
        leftAgain: stats(L, R, 13.5, 15.8),
      };
      results.conf = {
        windows: w,
        drop: slices(L, R, 3.5, 6.5),
        rise: slices(L, R, 9.0, 12.5),
      };
    }

    /* ---- 2. airborne and landing ---------------------------------------
     *
     * Surf and sea air separately, each against a grounded twin. 47 m/s keeps
     * the gull scheduler out of both renders so the two share a random
     * stream; the water is close, so the surf sits well above the floor and a
     * 4 dB dip is a ratio and not a rounding error. */
    {
      const sc = (air) => ({
        dur: 8,
        state: t => at({
          speed: 47, rpm: 0.8, throttle: 0.6, gear: 5,
          openness: 0.7,
          airborne: air && t >= 2 && t < 5,
        }),
      });
      const air = [], ground = [];
      for (const layer of ['surf', 'seaWind']) {
        air.push(await render(sc(true), layer));
        ground.push(await render(sc(false), layer));
      }
      const ratio = (a, b, t0, t1) => {
        const x = stats(a[0], a[1], t0, t1), y = stats(b[0], b[1], t0, t1);
        return +(x.rms / (y.rms + 1e-12)).toFixed(3);
      };
      results.air = {
        windows: { air: [3.0, 4.9], landed: [6.3, 7.9] },
        surf: {
          dip: ratio(air[0], ground[0], 3.0, 4.9),
          recovered: ratio(air[0], ground[0], 6.3, 7.9),
          airborne: stats(air[0][0], air[0][1], 3.0, 4.9),
          grounded: stats(ground[0][0], ground[0][1], 3.0, 4.9),
        },
        seaWind: {
          dip: ratio(air[1], ground[1], 3.0, 4.9),
          recovered: ratio(air[1], ground[1], 6.3, 7.9),
        },
      };
    }

    /* ---- 3. oceanSide 0, and flips -------------------------------------
     *
     * `oceanSide: 0` means "the caller does not know", and it has to behave
     * like the middle rather than like a side: the game sends 0 when the
     * projection through a hairpin passes through zero, so it is the same
     * event as a confidence dip seen from the other end. Then the flip, which
     * is the case the smoothing exists for: the bearing goes from one side to
     * the other and the image has to sweep rather than cut. */
    {
      const sc = {
        dur: 12,
        state: t => at({ oceanSide: t < 4 ? -1 : 1 }),
      };
      const [L, R] = await render(sc, 'surf');
      results.flip = {
        left: stats(L, R, 1.5, 3.8),
        right: stats(L, R, 7.5, 11.8),
        through: slices(L, R, 3.5, 6.5),
      };
    }
    {
      const sc = {
        dur: 14,
        state: t => at({ oceanSide: t < 3 ? -1 : t < 8 ? 0 : -1 }),
      };
      const [L, R] = await render(sc, 'surf');
      results.unknown = {
        left: stats(L, R, 1.5, 2.8),
        centre: stats(L, R, 5.5, 7.7),
        leftAgain: stats(L, R, 11.5, 13.8),
      };
    }

    /* ---- 4. gulls silent in the air ------------------------------------
     *
     * The same calls are placed at the same instants in two renders; the only
     * difference is whether the car is in the air at the second one. The first
     * is the control, and proves the call is audible at all.
     *
     * The third call is the one the gate actually exists for: it is placed a
     * tenth of a second *before* take-off and is still ringing through the
     * early part of the jump. Refusing to schedule a new call is not enough on
     * its own — a call that started on the ground would otherwise carry on
     * across the transition and a jump would sometimes have a gull in it and
     * sometimes not, depending on where the seeded timer happened to land. */
    {
      const sc = (air) => ({
        dur: 8,
        state: t => at({ airborne: air && t >= 2 && t < 5 }),
        cries: [[1.2, 0, 0.6], [3.4, 0, 0.6], [1.9, 0, 0.6]],
      });
      const [La, Ra] = await render(sc(true), 'gull');
      const [Lb, Rb] = await render(sc(false), 'gull');
      results.gull = {
        control: stats(Lb, Rb, 1.2, 1.9),
        grounded: stats(Lb, Rb, 3.4, 4.2),
        airborne: stats(La, Ra, 3.4, 4.2),
        /* The body of a call placed before take-off, past the gate's own
           fade — to ask "is the gull silent in the air", not "is the fade
           instant", which the click check below covers separately. */
        straddleGround: stats(Lb, Rb, 2.2, 2.5),
        straddleAir: stats(La, Ra, 2.2, 2.5),
        gateStep: stats(La, Ra, 1.9, 2.15),
      };
    }

    return results;
  }, SR));

  /* ---- report and assert ------------------------------------------------ */
  const { conf, air, flip, unknown, gull } = out;
  const pad = (s, n) => String(s).padEnd(n);
  const num = (v, n) => String(v).padStart(n);
  console.log('\n  surf balance, dB (+ is starboard)');
  console.log('  ' + pad('case', 22) + pad('window', 14) + num('bal', 8) +
    num('corr', 7) + num('maxstep', 9));
  console.log('  ' + '─'.repeat(60));
  const row = (name, win, r) => console.log('  ' + pad(name, 22) + pad(win, 14) +
    num(r.bal.toFixed(2), 8) + num(r.corr.toFixed(2), 7) + num(r.step.toFixed(4), 9));
  row('confidence 1→0→1', 'trusted, left', conf.windows.left);
  row('', 'collapsing', conf.windows.collapsing);
  row('', 'blind, centred', conf.windows.centre);
  row('', 'recovering', conf.windows.recovering);
  row('', 'trusted again', conf.windows.leftAgain);
  row('side flip', 'left', flip.left);
  row('', 'right', flip.right);
  row('unknown side', 'known, left', unknown.left);
  row('', 'oceanSide 0', unknown.centre);
  row('', 'known again', unknown.leftAgain);
  row('gulls', 'control (grounded)', gull.control);
  row('', 'airborne', gull.airborne);
  console.log(`\n  largest balance step between 0.3 s slices: ` +
    `collapse ${conf.drop.jump} dB @ ${conf.drop.at}s, ` +
    `recovery ${conf.rise.jump} dB @ ${conf.rise.at}s, ` +
    `flip ${flip.through.jump} dB @ ${flip.through.at}s`);

  console.log('\n  airborne dip, ratio to an identical grounded render');
  console.log('  ' + pad('layer', 10) + num('airborne', 11) + num('landed', 10));
  console.log('  ' + '─'.repeat(33));
  console.log('  ' + pad('surf', 10) + num(air.surf.dip.toFixed(3), 11) +
    num(air.surf.recovered.toFixed(3), 10));
  console.log('  ' + pad('seaWind', 10) + num(air.seaWind.dip.toFixed(3), 11) +
    num(air.seaWind.recovered.toFixed(3), 10));

  console.log('\n  gull level, rms');
  console.log('  ' + pad('grounded call', 18) + num(gull.grounded.rms.toFixed(5), 10));
  console.log('  ' + pad('airborne call', 18) + num(gull.airborne.rms.toFixed(7), 10));
  console.log('  ' + pad('pre-takeoff, GND', 18) + num(gull.straddleGround.rms.toFixed(5), 10));
  console.log('  ' + pad('pre-takeoff, AIR', 18) + num(gull.straddleAir.rms.toFixed(7), 10));

  const fails = [];
  const check = (ok, msg) => { if (!ok) fails.push(msg); };

  /* Confidence. Trusted is the left image the old code produced; blind has to
     be at the middle, and it has to have got there through the middle. */
  check(conf.windows.left.bal < -1.2,
    `trusted surf is not on the water's side: ${conf.windows.left.bal} dB, water left`);
  check(Math.abs(conf.windows.centre.bal) < 0.6,
    `low confidence does not centre the surf: ${conf.windows.centre.bal} dB`);
  check(conf.windows.centre.corr < 0.75,
    `centred surf collapsed to mono: correlation ${conf.windows.centre.corr}`);
  check(conf.windows.leftAgain.bal < -1.2,
    `surf does not re-expand after confidence returns: ${conf.windows.leftAgain.bal} dB`);
  /* Between the two it must be somewhere in between: a value that is already
     centred 0.15 s after the drop, or still fully sided, means a hard cut. */
  check(conf.windows.collapsing.bal < -0.15 && conf.windows.collapsing.bal > -2.6,
    `confidence drop is a hard cut, not a collapse: ${conf.windows.collapsing.bal} dB`);
  check(conf.windows.recovering.bal < -0.15 && conf.windows.recovering.bal > -2.6,
    `confidence recovery snaps rather than opening: ${conf.windows.recovering.bal} dB`);
  /* And no single slice may carry the image across the field. */
  check(conf.drop.jump < 3.0,
    `image jumps ${conf.drop.jump} dB in 0.3 s while losing confidence`);
  check(conf.rise.jump < 3.0,
    `image jumps ${conf.rise.jump} dB in 0.3 s while regaining confidence`);

  /* Side flip: both sides, through the middle, image intact at each end. */
  check(flip.left.bal < -1.2, `surf not left of a left-hand coast: ${flip.left.bal} dB`);
  check(flip.right.bal > 1.2, `surf not right of a right-hand coast: ${flip.right.bal} dB`);
  check(flip.left.corr < 0.75 && flip.right.corr < 0.75,
    `surf is mono on one side: correlation ${flip.left.corr} / ${flip.right.corr}`);
  check(flip.through.jump < 3.0,
    `side flip hard-cuts across the image: ${flip.through.jump} dB in 0.3 s`);
  /* A sweep, not a teleport: the middle of the transition has to be near the
     centre rather than already at the far side. */
  {
    const mid = flip.through.points.find(p => p.t >= 4.5 && p.t <= 4.8);
    check(mid && Math.abs(mid.bal) < 1.5,
      `flip does not pass through the centre: ${mid ? mid.bal + ' dB at ' + mid.t + 's' : 'no sample'}`);
  }

  /* An explicit unknown is the same collapse as a confidence dip, from the
     other input: `oceanSide: 0` must centre the water rather than pick a side,
     and must recover when a bearing arrives again. */
  check(unknown.left.bal < -1.2, `known-left water not left: ${unknown.left.bal} dB`);
  check(Math.abs(unknown.centre.bal) < 0.6,
    `oceanSide 0 does not centre the surf: ${unknown.centre.bal} dB`);
  check(unknown.centre.corr < 0.75,
    `centred surf on oceanSide 0 collapsed to mono: correlation ${unknown.centre.corr}`);
  check(unknown.leftAgain.bal < -1.2,
    `surf does not return to its side after oceanSide 0: ${unknown.leftAgain.bal} dB`);

  /* Airborne. A dip that is present on both continuous layers, shallow enough
     not to be a mute, and gone again on landing. */
  check(air.surf.dip < 0.80 && air.surf.dip > 0.35,
    `surf airborne dip is not perceptible-but-gentle: ×${air.surf.dip}`);
  check(air.seaWind.dip < 0.80 && air.seaWind.dip > 0.35,
    `sea air airborne dip is not perceptible-but-gentle: ×${air.seaWind.dip}`);
  check(air.surf.recovered > 0.85 && air.surf.recovered < 1.15,
    `surf does not recover after landing: ×${air.surf.recovered} of grounded`);
  check(air.seaWind.recovered > 0.85 && air.seaWind.recovered < 1.15,
    `sea air does not recover after landing: ×${air.seaWind.recovered} of grounded`);

  /* Gulls. The control call is audible; the same call in the air is not. The
     comparison is a ratio so the absolute level of the layer can change
     without the assertion going stale. */
  check(gull.control.rms > 0.002,
    `control gull call is inaudible, so the silence test proves nothing: ${gull.control.rms}`);
  check(gull.grounded.rms > 0.002,
    `grounded gull call is inaudible: ${gull.grounded.rms}`);
  check(gull.airborne.rms < Math.max(1e-6, gull.grounded.rms * 0.01),
    `gulls are audible in the air: ${gull.airborne.rms} vs ${gull.grounded.rms} grounded`);
  /* And a call that began just before take-off is cut off with the wheels,
     not left ringing through the jump. */
  check(gull.straddleGround.rms > 0.001,
    `pre-take-off gull call is inaudible grounded, so its silence proves nothing: ` +
    `${gull.straddleGround.rms}`);
  check(gull.straddleAir.rms < gull.straddleGround.rms * 0.05,
    `a gull call placed before take-off rings on into the jump: ` +
    `${gull.straddleAir.rms} airborne vs ${gull.straddleGround.rms} grounded`);
  /* The gate closes fast, but not as a cut: it must not leave a step in the
     output while a call is still sounding under it. */
  check(gull.gateStep.step < 0.35,
    `gull gate clicks shut: ${gull.gateStep.step} sample-to-sample jump`);

  /* The smoothing itself: no layer here may produce a click. This is the
     observable form of "setTargetAtTime or equivalent" — a parameter assigned
     once per frame leaves a step much larger than the band-limited signal. */
  for (const [name, r] of [
    ['confidence', conf.windows.leftAgain], ['flip', flip.right],
    ['airborne gull', gull.airborne],
  ]) {
    check(r.step < 0.35, `${name}: ${r.step} sample-to-sample jump — a parameter was stepped`);
  }

  console.log('');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    bad = fails.length;
  } else {
    console.log('  ✓ confidence collapses the surf to the centre and re-expands it,');
    console.log('    a side flip sweeps through the middle, airborne dips surf and sea air');
    console.log('    by a few dB and restores them on landing, gulls go silent in the air');
  }
})();

finish(bad ? 1 : (process.exitCode || 0));
