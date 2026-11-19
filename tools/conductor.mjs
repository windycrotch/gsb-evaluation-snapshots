/* Does the audio conductor actually conduct?
 *
 * The companion to tools/audio.mjs, and the same method: render the real
 * graph offline, faster than real time, and assert on the samples. Where
 * audio.mjs asks whether each LAYER sounds right, this asks whether the
 * STATE MACHINE on top of them behaves — the pause duck, the finish mask,
 * the gearchange gate, the reset, and the same-frame cases:
 *
 *   rpm sweep      the engine still tracks revs (the conductor changes
 *                  nothing about normal driving)
 *   pause          the whole mix converges to silence and comes back to
 *                  exactly its previous level
 *   finish         after the flag, rank tones and shift barks are masked
 *                  and the flag chord is not
 *   shift gate     a gearchange at low load is silent; the same change
 *                  under load barks
 *   reset          one-shots in flight are released, the graph does not
 *                  grow across repeated resets, and a chord cut mid-flight
 *                  does not ring into the next race
 *   same frame     pause and finish landing on one frame give the same
 *                  samples whichever order the calls arrive in
 *
 *   node tools/conductor.mjs
 */
import { chromium } from 'playwright';
import { serve, run } from './harness.mjs';
import { finish, guard } from './tame.mjs';

const SR = 44100;

/* The same no-game page as tools/audio.mjs, for the same reason: the
   conductor lives in src/audio, which needs nothing from the renderer. */
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
    await page.route(origin + '/__conductor', route => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><meta charset=utf-8><title>conductor</title>',
    }));
    console.log(`→ ${origin}/__conductor  (no game, Web Audio only)`);
    await page.goto(origin + '/__conductor', { waitUntil: 'domcontentloaded' });
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
      shoreDistance: 70, shoreDrop: 40, oceanSide: -1,
    };
    const at = (o) => Object.assign({}, base, o);
    const ramp = (t, t0, t1, a, b) => a + (b - a) * Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));

    /* ---- analysis ----------------------------------------------------- */
    function fft(re, im) {
      const n = re.length;
      for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
          let cr = 1, ci = 0;
          for (let j = 0; j < len / 2; j++) {
            const a = i + j, b = a + len / 2;
            const ur = re[a], ui = im[a];
            const vr = re[b] * cr - im[b] * ci;
            const vi = re[b] * ci + im[b] * cr;
            re[a] = ur + vr; im[a] = ui - vi;
            re[b] = ur - vr; im[b] = ui + vi;
            const nr = cr * wr - ci * wi;
            ci = cr * wi + ci * wr; cr = nr;
          }
        }
      }
    }

    const N = 2048;
    const hann = new Float32Array(N);
    for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

    function measure(L, R, t0, t1) {
      const a = Math.max(0, Math.floor(t0 * sr));
      const b = Math.min(L.length, Math.floor(t1 * sr));
      let peak = 0, sq = 0, step = 0;
      for (let i = a; i < b; i++) {
        const v = (L[i] + R[i]) * 0.5;
        sq += v * v;
        const m = Math.max(Math.abs(L[i]), Math.abs(R[i]));
        if (m > peak) peak = m;
        const j = i - 1 >= a ? i - 1 : a;
        const d = Math.max(Math.abs(L[i] - L[j]), Math.abs(R[i] - R[j]));
        if (d > step) step = d;
      }
      const n = Math.max(1, b - a);
      const mag = new Float32Array(N / 2);
      const re = new Float32Array(N), im = new Float32Array(N);
      let frames = 0;
      for (let s = a; s + N <= b; s += N / 2) {
        for (let i = 0; i < N; i++) { re[i] = (L[s + i] + R[s + i]) * 0.5 * hann[i]; im[i] = 0; }
        fft(re, im);
        for (let k = 0; k < N / 2; k++) mag[k] += Math.hypot(re[k], im[k]);
        frames++;
      }
      let num = 0, den = 0;
      for (let k = 1; frames && k < N / 2; k++) {
        const m = mag[k] / frames;
        num += ((k * sr) / N) * m; den += m;
      }
      return {
        peak: +peak.toFixed(4),
        rms: +Math.sqrt(sq / n).toFixed(5),
        step: +step.toFixed(4),
        centroid: den ? Math.round(num / den) : 0,
      };
    }

    /* ---- render --------------------------------------------------------
     *
     * One scenario is a state function plus an event list. Events are
     * [time, fn(audio)] and fire inside the frame loop, which is how the
     * same-frame cases are made exact: two events with the same time run
     * on the same audio clock tick, in list order. */
    async function render(sc, solo) {
      const ctx = new OfflineAudioContext(2, Math.ceil(sc.dur * sr), sr);
      const audio = new Audio({ context: ctx });
      await audio.start();
      audio.setMasterVolume(0.5);
      if (solo) {
        const buses = audio.buses();
        for (const [name, node] of Object.entries(buses)) {
          node.disconnect();
          if (name === solo) node.connect(audio.bus);
        }
      }
      const H = 1 / 60;
      const events = (sc.events || []).slice();
      for (let i = 0; i * H < sc.dur; i++) {
        const t = i * H;
        audio.update(H, sc.state(t));
        while (events.length && events[0][0] <= t) events.shift()[1](audio);
      }
      const buf = await ctx.startRendering();
      const data = [buf.getChannelData(0), buf.getChannelData(1)];
      const counts = audio.nodeCount();
      const conductor = audio.conductor();
      audio.dispose();
      return { data, counts, conductor };
    }

    const results = {};

    /* 1 — normal driving: the engine tracks rpm ------------------------ */
    {
      const sc = {
        dur: 5,
        state: t => at({
          throttle: 0.8, speed: ramp(t, 0.3, 4.6, 0, 52),
          rpm: ramp(t, 0.3, 4.6, IDLE, 0.95), gear: Math.min(5, Math.floor(t)),
        }),
      };
      const d = await render(sc, 'engine');
      results.rpmLow = measure(d.data[0], d.data[1], 0.6, 1.6);
      results.rpmHigh = measure(d.data[0], d.data[1], 3.6, 4.6);
    }

    /* 2 — pause: the mix converges down and comes back ----------------- */
    {
      const sc = {
        dur: 5,
        state: () => at({ rpm: 0.7, speed: 40, throttle: 0.8, gear: 3 }),
        events: [
          [1.5, a => a.setPaused(true)],
          [3.0, a => a.setPaused(false)],
        ],
      };
      const d = await render(sc, null);
      results.pauseBefore = measure(d.data[0], d.data[1], 1.0, 1.4);
      /* The fader's travel is ~3 time constants to 95%; a second after the
         pause lands, whatever is left is the floor, not the ramp. */
      results.pauseHeld = measure(d.data[0], d.data[1], 2.2, 2.9);
      results.pauseResume = measure(d.data[0], d.data[1], 3.8, 4.6);
      /* The transition itself must not be a click. */
      results.pauseDip = measure(d.data[0], d.data[1], 1.45, 1.75);
      results.pauseBack = measure(d.data[0], d.data[1], 2.95, 3.25);
    }

    /* 3 — finish: rank tones and barks masked, the flag is not --------- */
    {
      const mk = (finish) => ({
        dur: 4.5,
        state: t => at({
          rpm: 0.75, speed: 38, throttle: 0.9,
          gear: t < 2.0 ? 2 : 3,
        }),
        events: [
          [1.0, a => { if (finish) a.setFinished(true); a.finishTone('flag', true); }],
          [1.5, a => a.positionTone('gained')],
          [2.5, a => a.positionTone('lost')],
        ],
      });
      const maskedPos = await render(mk(true), 'position');
      const maskedShift = await render(mk(true), 'shift');
      const flag = await render(mk(true), 'finish');
      const freePos = await render(mk(false), 'position');
      const freeShift = await render(mk(false), 'shift');
      results.maskedPosition = measure(maskedPos.data[0], maskedPos.data[1], 1.4, 3.0);
      results.maskedBark = measure(maskedShift.data[0], maskedShift.data[1], 2.0, 2.4);
      results.flagChord = measure(flag.data[0], flag.data[1], 1.0, 2.2);
      /* The controls: without the latch, the same events are audible. */
      results.freePosition = measure(freePos.data[0], freePos.data[1], 1.4, 2.0);
      results.freeBark = measure(freeShift.data[0], freeShift.data[1], 2.0, 2.4);
    }

    /* 4 — the shift gate: silent at low load, barking under it --------- */
    {
      const mk = (throttle) => ({
        dur: 3,
        state: t => at({
          rpm: 0.55, speed: 30, throttle, gear: t < 1.0 ? 2 : 3,
        }),
      });
      const coast = await render(mk(0), 'shift');
      const loud = await render(mk(1), 'shift');
      results.coastShift = measure(coast.data[0], coast.data[1], 1.0, 1.5);
      results.loudShift = measure(loud.data[0], loud.data[1], 1.0, 1.5);
    }

    /* 5 — reset: one-shots released, nothing stacks -------------------- */
    {
      /* A chord cut mid-flight must not ring into the next race. The flag
         is the longest one-shot in the game — 1.75 s — so a reset one
         second in leaves most of it in the air. */
      const mk = (reset) => ({
        dur: 3.5,
        state: () => at({ rpm: 0.5, speed: 20, throttle: 0.5, gear: 2 }),
        events: [
          [0.7, a => a.finishTone('flag', true)],
          ...(reset ? [[1.7, a => a.resetRace()]] : []),
        ],
      });
      const cut = await render(mk(true), 'finish');
      const ring = await render(mk(false), 'finish');
      /* The window is the chord's remaining life after the reset: uncut it
         is still sounding there, cut it is nothing. */
      results.cutChord = measure(cut.data[0], cut.data[1], 1.75, 2.45);
      results.ringChord = measure(ring.data[0], ring.data[1], 1.75, 2.45);

      /* Node bookkeeping across repeated resets, on a context of its own
         so no render is needed. Everything the race can leave in flight is
         fired at once, released, and the graph counted — five times. */
      const ctx = new OfflineAudioContext(2, sr, sr);
      const audio = new Audio({ context: ctx });
      await audio.start();
      const before = audio.nodeCount();
      const H = 1 / 60;
      const sizes = [];
      for (let round = 0; round < 5; round++) {
        for (let i = 0; i < 30; i++) {
          audio.update(H, at({ rpm: 0.8, speed: 40, throttle: 1, gear: i < 15 ? 2 : 3 }));
        }
        audio.impact(0.8);
        audio.startTone(true);
        audio.finishTone('flag', true);
        audio.positionTone('gained');
        audio.boostTone(0.8);
        audio.resetRace();
        sizes.push(audio.nodeCount());
      }
      results.resetSizes = sizes.map(s => `${s.persistent}+${s.oneShots}`);
      results.resetBefore = before;
      results.resetAfter = sizes[sizes.length - 1];
      /* The conductor's latches come back cleared. */
      results.resetConductor = audio.conductor();
      audio.dispose();
    }

    /* 6 — one frame, two events: pause and the flag together ------------ */
    {
      const mk = (order) => ({
        dur: 2.5,
        state: () => at({ rpm: 0.7, speed: 38, throttle: 0.8, gear: 3 }),
        events: order === 'pause-first'
          ? [[1.0, a => { a.setPaused(true); a.setFinished(true); a.finishTone('flag', true); }]]
          : [[1.0, a => { a.finishTone('flag', true); a.setFinished(true); a.setPaused(true); }]],
      });
      const A = await render(mk('pause-first'), null);
      const B = await render(mk('finish-first'), null);
      let maxDiff = 0;
      for (let ch = 0; ch < 2; ch++) {
        const x = A.data[ch], y = B.data[ch];
        for (let i = 0; i < x.length; i++) {
          const d = Math.abs(x[i] - y[i]);
          if (d > maxDiff) maxDiff = d;
        }
      }
      results.sameFrameDiff = maxDiff;
      results.sameFrameState = [A.conductor, B.conductor];
      /* The level each order settles into, which is the comparison that
         means something: see the note at the assertion for why the samples
         themselves are not the contract. */
      results.sameFrameLevel = [
        measure(A.data[0], A.data[1], 1.8, 2.4).rms,
        measure(B.data[0], B.data[1], 1.8, 2.4).rms,
      ];
    }

    return results;
  }, SR));

  /* ---- the verdict ---------------------------------------------------- */
  const fails = [];
  const check = (ok, msg) => { if (!ok) fails.push(msg); };
  const pad = (s, n) => String(s).padEnd(n);
  const row = (label, value) => console.log('  ' + pad(label, 44) + value);

  console.log('\n  1 · normal driving — engine tracks rpm');
  row('low revs', `rms ${out.rpmLow.rms}  centroid ${out.rpmLow.centroid} Hz`);
  row('high revs', `rms ${out.rpmHigh.rms}  centroid ${out.rpmHigh.centroid} Hz`);
  check(out.rpmHigh.centroid > out.rpmLow.centroid * 1.3,
    `engine does not brighten with rpm: ${out.rpmLow.centroid} → ${out.rpmHigh.centroid} Hz`);
  check(out.rpmHigh.rms > out.rpmLow.rms * 1.1,
    `engine does not fill out with rpm: rms ${out.rpmLow.rms} → ${out.rpmHigh.rms}`);

  console.log('\n  2 · pause and resume — the level converges');
  row('racing', `rms ${out.pauseBefore.rms}`);
  row('paused (1 s in)', `rms ${out.pauseHeld.rms}`);
  row('resumed', `rms ${out.pauseResume.rms}`);
  row('largest step, pause / resume', `${out.pauseDip.step} / ${out.pauseBack.step}`);
  check(out.pauseHeld.rms < Math.max(0.001, out.pauseBefore.rms * 0.02),
    `pause does not converge to silence: ${out.pauseBefore.rms} → ${out.pauseHeld.rms}`);
  check(out.pauseResume.rms > out.pauseBefore.rms * 0.8
    && out.pauseResume.rms < out.pauseBefore.rms * 1.25,
  `resume does not return to the racing level: ${out.pauseBefore.rms} → ${out.pauseResume.rms}`);
  check(out.pauseDip.step < 0.45 && out.pauseBack.step < 0.45,
    `click at the pause transition: ${out.pauseDip.step} / ${out.pauseBack.step}`);

  console.log('\n  3 · after the flag — events masked, the chord is not');
  row('rank tones after the flag', `rms ${out.maskedPosition.rms} (control ${out.freePosition.rms})`);
  row('shift bark after the flag', `rms ${out.maskedBark.rms} (control ${out.freeBark.rms})`);
  row('the flag chord itself', `peak ${out.flagChord.peak}`);
  check(out.freePosition.rms > 0.004,
    `control broken: rank tones inaudible even without the mask (${out.freePosition.rms})`);
  check(out.freeBark.peak > 0.2,
    `control broken: no bark even without the mask (peak ${out.freeBark.peak})`);
  check(out.maskedPosition.rms < 0.001,
    `rank tones still sound after the flag: rms ${out.maskedPosition.rms}`);
  check(out.maskedBark.rms < 0.002,
    `gearchange still barks after the flag: rms ${out.maskedBark.rms}`);
  check(out.flagChord.peak > 0.1,
    `the flag chord was masked with everything else: peak ${out.flagChord.peak}`);

  console.log('\n  4 · the shift gate — load decides');
  row('coasting gearchange', `rms ${out.coastShift.rms}  peak ${out.coastShift.peak}`);
  row('full-throttle gearchange', `peak ${out.loudShift.peak}`);
  check(out.coastShift.rms < 0.002,
    `bark audible at low load: rms ${out.coastShift.rms}`);
  check(out.loudShift.peak > 0.2,
    `no bark under load: peak ${out.loudShift.peak}`);

  console.log('\n  5 · reset — one-shots released, nothing stacks');
  row('chord after a mid-flight reset', `rms ${out.cutChord.rms} (rings to ${out.ringChord.rms} uncut)`);
  row('graph size across 5 resets', out.resetSizes.join('  '));
  row('conductor state after reset', JSON.stringify(out.resetConductor));
  check(out.ringChord.rms > 0.0008,
    `control broken: the flag chord does not ring (${out.ringChord.rms})`);
  check(out.cutChord.rms < out.ringChord.rms * 0.2,
    `the old race's chord rings into the new one: ${out.cutChord.rms} vs uncut ${out.ringChord.rms}`);
  check(out.resetAfter.oneShots === 0,
    `one-shots still in flight after reset: ${out.resetAfter.oneShots}`);
  check(out.resetAfter.persistent === out.resetBefore.persistent,
    `graph grew across resets: ${out.resetBefore.persistent} → ${out.resetAfter.persistent} nodes`);
  check(out.resetSizes.every(s => s === out.resetSizes[0]),
    `graph size not stable across resets: ${out.resetSizes.join(', ')}`);
  check(!out.resetConductor.paused && !out.resetConductor.finished,
    `conductor latches not cleared by reset: ${JSON.stringify(out.resetConductor)}`);

  console.log('\n  6 · one frame, pause and flag together');
  row('largest sample difference between orders', String(out.sameFrameDiff));
  row('settled level, both orders', out.sameFrameLevel.join(' / '));
  row('state, both orders', JSON.stringify(out.sameFrameState));
  /* Not bit-exact, and not claimed to be: two renders of the SAME event
     list already differ by ~5e-5 in this Chromium (the offline renderer's
     summation is not bit-deterministic run to run), so a zero-diff assert
     would be asserting on the platform, not on the conductor. The contract
     is that the ORDER of the two calls moves the render by no more than
     that noise floor, that both orders settle to the same level, and that
     the latched state is identical — which is what "deterministic and
     repeatable" can honestly mean here. */
  check(out.sameFrameDiff < 0.001,
    `pause+finish order changes the render: max diff ${out.sameFrameDiff}`);
  check(Math.abs(out.sameFrameLevel[0] - out.sameFrameLevel[1])
    <= Math.max(...out.sameFrameLevel, 1e-6) * 0.01,
  `orders settle to different levels: ${out.sameFrameLevel.join(' vs ')}`);
  check(out.sameFrameState.every(s => s.paused && s.finished),
    `conductor state not deterministic: ${JSON.stringify(out.sameFrameState)}`);

  console.log('');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    bad = fails.length;
  } else {
    console.log('  ✓ engine tracks rpm; pause converges and restores; the flag masks rank\n' +
      '    tones and barks but not itself; low-load shifts are silent; resets release\n' +
      '    everything and stack nothing; same-frame pause+finish is deterministic');
  }
})();

/* ---- part 2: the wiring, in the real game ------------------------------
 *
 * Part 1 proves the conductor works; this proves main.js actually calls it.
 * Booted through the shared harness with the pause menu explicitly enabled
 * (manual mode, which every tool uses, leaves it off), driven by a bot
 * input, and read back through the conductor's own state accessor. */
await run({ hash: 'manual&pausemenu=1', width: 640, height: 360 }, async ({ page, errs }) => {
  const g = await page.evaluate(async () => {
    const g = window.__game;
    const out = {};
    await g.audio.start();
    /* Two seconds of bot driving, so the engine is genuinely running and
       there is smoothed state worth forgetting. */
    g.botInput = { steer: 0, throttle: 1, brake: 0, handbrake: 0 };
    for (let i = 0; i < 120; i++) g.step(1 / 60);
    out.racing = g.audio.conductor();

    g.openPause();
    out.paused = g.audio.conductor();
    g.closePause();
    out.resumed = g.audio.conductor();

    /* The flag. Latched by Game.step off the car's own finished flag, the
       way it lands in a real race. */
    g.player.finished = true;
    g.step(1 / 60);
    out.finished = g.audio.conductor();
    out.shiftsMuted = g.audio.engine.shiftsMuted;
    const inFlight = g.audio.feedback.oneShots.size;
    g.audio.positionTone('gained');
    out.positionMasked = g.audio.feedback.oneShots.size === inFlight;

    /* And the reset, from the results card's own key path. */
    g.restart();
    out.afterRestart = g.audio.conductor();
    out.oneShotsInFlight = g.audio.nodeCount().oneShots;
    out.gearForgotten = g.audio.engine.gear === null;
    g.botInput = null;
    return out;
  });

  const gfails = [];
  const gcheck = (ok, msg) => { if (!ok) gfails.push(msg); };
  console.log('\n  7 · in the game — the wiring, not just the conductor');
  const grow = (label, value) => console.log('  ' + String(label).padEnd(44) + value);
  grow('racing', JSON.stringify(g.racing));
  grow('pause menu open / closed', `${JSON.stringify(g.paused)} → ${JSON.stringify(g.resumed)}`);
  grow('crossed the line', `${JSON.stringify(g.finished)}  shiftsMuted=${g.shiftsMuted}`);
  grow('rank tone after the flag', g.positionMasked ? 'masked' : 'SOUNDED');
  grow('after restart', `${JSON.stringify(g.afterRestart)}  one-shots=${g.oneShotsInFlight}  gear=${g.gearForgotten ? 'forgotten' : 'REMEMBERED'}`);

  gcheck(g.racing.paused === false && g.racing.finished === false,
    `not racing at the start: ${JSON.stringify(g.racing)}`);
  gcheck(g.paused.paused === true, 'pause menu does not duck the audio');
  gcheck(g.resumed.paused === false, 'resume does not release the duck');
  gcheck(g.finished.finished === true, 'crossing the line does not latch the finish');
  gcheck(g.shiftsMuted === true, 'gearchange bark not muted after the flag');
  gcheck(g.positionMasked === true, 'rank tone still fires after the flag');
  gcheck(g.afterRestart.paused === false && g.afterRestart.finished === false,
    `restart does not clear the conductor: ${JSON.stringify(g.afterRestart)}`);
  gcheck(g.oneShotsInFlight === 0, `one-shots in flight after restart: ${g.oneShotsInFlight}`);
  gcheck(g.gearForgotten === true, 'engine still remembers the old race’s gear');

  if (errs.length) gfails.push(...errs.slice(0, 3).map(e => 'page: ' + e));
  if (gfails.length) {
    for (const f of gfails) console.log('  ✗ ' + f);
    bad += gfails.length;
  } else {
    console.log('  ✓ pause ducks and restores in the real loop; the flag latches and masks;\n' +
      '    restart clears the conductor and releases every one-shot');
  }
});

finish(bad ? 1 : (process.exitCode || 0));
