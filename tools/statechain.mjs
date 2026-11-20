/* Acceptance probe for the ground→air→land→scrape→reset state chain.
 *
 * Drives the real game page headless and checks, in order:
 *   1. a ramp pass produces exactly one airborne episode and a landing
 *   2. full lock held while airborne: slip is back in the recoverable band
 *      within one second of touchdown and the car is still moving
 *   3. a >90 km/h lateral berm/wall strike keeps the car on the ground,
 *      with no airborne flicker
 *   4. the R reset clears height, vertical speed, yaw rate, suspension
 *      travel and the launch record, and puts the car on the road
 *   5. after the reset, the same ramp fires slow motion exactly once
 *   6. a finished car reset keeps its finish and its clock stays stopped
 *
 *   node tools/statechain.mjs [--seed 22]
 */
import { run } from './harness.mjs';
import { finish } from './tame.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const SEED = +flag('seed', 22);

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
};

await run({
  width: 640, height: 360,
  hash: `manual&tier=low&seed=${SEED}&cap=0&hud=0`,
}, async ({ page }) => {

  /* ---- 1 & 2: ramp jump, full lock held through the flight ------------- */
  const jump = await page.evaluate(() => {
    const g = window.__game, p = g.player, track = g.track, L = track.length;
    g.setPaused(true);
    if (g.race?.entries) g.race.entries.length = 0;
    const r = track.ramps[0];
    g.autopilot(true, 0.85);
    g.driveTo(r.pad0 / L, { runUp: 300, maxSec: 40 });

    let episodes = 0, wasAir = false, apex = 0, landingForce = 0;
    let landT = 0, landS = 0, recoverT = -1, maxSlip07 = 0, kmhAt1s = 0, movedAt1s = 0;
    for (let i = 0; i < 60 * 14; i++) {
      /* The bot flies the approach and catches the landing; the player input
         under test is full lock for exactly the time the wheels are off the
         ground. */
      g.botInput = p.airborne
        ? { steer: 1, throttle: 0, brake: 0, handbrake: 0 } : null;
      g.step(1 / 60);
      if (p.airborne) {
        apex = Math.max(apex, p.height);
        if (!wasAir) episodes++;
      } else if (wasAir) {
        landingForce = p.landingForce; landT = p.raceTime; landS = p.s;
      }
      wasAir = p.airborne;
      /* The landing's own recovery, measured over its own window. What the
         road does afterwards — the next corner is its own event, at the grip
         ceiling even with no jump at all — is not the landing's business, so
         the worst slip is taken over the first 0.7 s and the recovery time is
         the first return inside the band the tyres can work at. */
      if (landT) {
        const since = p.raceTime - landT;
        if (since <= 0.7) maxSlip07 = Math.max(maxSlip07, Math.abs(p.slipAngle));
        if (recoverT < 0 && Math.abs(p.slipAngle) < 0.2) recoverT = since;
        if (since > 1.0) {
          kmhAt1s = p.kmh; movedAt1s = p.s - landS;
          break;
        }
      }
    }
    g.botInput = null;
    g.autopilot(false);
    return {
      episodes, apex: +apex.toFixed(2), landingForce: +landingForce.toFixed(2),
      recoverT: +recoverT.toFixed(2), maxSlip07: +maxSlip07.toFixed(3),
      kmhAt1s: +kmhAt1s.toFixed(1), movedAt1s: +movedAt1s.toFixed(1),
    };
  });
  console.log('\n  ramp pass with full lock held airborne:', JSON.stringify(jump));
  check('ramp: exactly one airborne episode', jump.episodes === 1, `episodes=${jump.episodes}`);
  check('ramp: left the ground', jump.apex > 0.3, `apex=${jump.apex} m`);
  check('ramp: landing impact registered', jump.landingForce > 0.05, `landingForce=${jump.landingForce}`);
  check('airborne steer: touchdown slip stays recoverable',
    jump.maxSlip07 < 0.25, `worst slip in 0.7 s=${jump.maxSlip07} rad (peak grip at 0.14)`);
  check('airborne steer: slip back in the recoverable band within 1 s',
    jump.recoverT >= 0 && jump.recoverT < 1.0,
    `recovered after ${jump.recoverT} s (band 0.20 rad)`);
  check('airborne steer: car still going after 1 s',
    jump.kmhAt1s > 20 && jump.movedAt1s > 10, `kmh=${jump.kmhAt1s} moved=${jump.movedAt1s} m`);

  /* ---- 1b: airborne steering cannot bend the trajectory ------------------
     The same approach flown twice, full lock against no input. Nothing in
     the air may change where the car goes — only which way it points — so
     the two flights must land in the same place after the same time. */
  const traj = await page.evaluate(() => {
    const g = window.__game, p = g.player, track = g.track, L = track.length;
    const r = track.ramps[0];
    const fly = (lock) => {
      g.autopilot(true, 0.85);
      g.driveTo(r.pad0 / L, { runUp: 300, maxSec: 40 });
      let airT = 0, landS = 0, landLat = 0, apex = 0, wasAir = false;
      for (let i = 0; i < 60 * 10; i++) {
        g.botInput = p.airborne && lock
          ? { steer: 1, throttle: 0, brake: 0, handbrake: 0 } : null;
        g.step(1 / 60);
        if (p.airborne) { airT += 1 / 60; apex = Math.max(apex, p.height); wasAir = true; }
        else if (wasAir) { landS = p.s; landLat = p.lat; break; }
      }
      g.botInput = null; g.autopilot(false);
      return { airT: +airT.toFixed(2), landS: +landS.toFixed(1), landLat: +landLat.toFixed(2), apex: +apex.toFixed(2) };
    };
    return { straight: fly(0), locked: fly(1) };
  });
  console.log('  flight trajectory, straight vs full lock:', JSON.stringify(traj));
  check('airborne steer: flight path unchanged by the wheel',
    Math.abs(traj.straight.landS - traj.locked.landS) < 2
    && Math.abs(traj.straight.landLat - traj.locked.landLat) < 2
    && Math.abs(traj.straight.airT - traj.locked.airT) < 0.15
    && Math.abs(traj.straight.apex - traj.locked.apex) < 0.4,
    `straight=${JSON.stringify(traj.straight)} locked=${JSON.stringify(traj.locked)}`);

  /* ---- 3: lateral berm/wall strike above 90 km/h ------------------------ */
  const scrape = await page.evaluate(() => {
    const g = window.__game, p = g.player, track = g.track, L = track.length;
    /* The tallest berm on the stage. */
    let spot = { s: 200, berm: 0, side: 1 };
    for (let s = 200; s < L - 200; s += 20) {
      const f = track.frameAt(s);
      const b = Math.max(f.bermL, f.bermR);
      if (b > spot.berm) spot = { s, berm: b, side: f.bermR >= f.bermL ? 1 : -1 };
    }
    g.goTo(Math.max(20, spot.s - 160) / L);
    g.botInput = { steer: 0, throttle: 1, brake: 0, handbrake: 0 };
    let guard = 0;
    while (p.kmh < 100 && guard++ < 60 * 30) g.step(1 / 60);
    const entry = p.kmh;
    /* Hard over into the berm and hold it there — three seconds of grinding. */
    let maxH = 0, airFrames = 0, airEpisodes = 0, wasAir = false, maxLat = 0;
    for (let i = 0; i < 180; i++) {
      g.botInput = { steer: spot.side, throttle: 0.6, brake: 0, handbrake: 0 };
      g.step(1 / 60);
      maxH = Math.max(maxH, p.height);
      maxLat = Math.max(maxLat, Math.abs(p.lat));
      if (p.airborne) {
        airFrames++;
        if (!wasAir) airEpisodes++;
      }
      wasAir = p.airborne;
    }
    g.botInput = null;
    return {
      s: spot.s, berm: +spot.berm.toFixed(2), entry: +entry.toFixed(0),
      maxH: +maxH.toFixed(3), airFrames, airEpisodes, maxLat: +maxLat.toFixed(1),
    };
  });
  console.log('  berm/wall grind:', JSON.stringify(scrape));
  check('berm: entry speed above 90 km/h', scrape.entry >= 90, `entry=${scrape.entry} km/h`);
  check('berm: car stays on the ground', scrape.maxH < 0.35, `maxH=${scrape.maxH} m`);
  check('berm: no airborne flicker', scrape.airFrames <= 2 && scrape.airEpisodes <= 1,
    `airFrames=${scrape.airFrames} episodes=${scrape.airEpisodes}`);

  /* ---- 4: the R reset, from a dirty airborne state ---------------------- */
  const reset = await page.evaluate(() => {
    const g = window.__game, p = g.player, track = g.track, L = track.length;
    const r = track.ramps[0];
    g.autopilot(true, 0.85);
    g.driveTo(r.pad0 / L, { runUp: 300, maxSec: 40 });
    let guard = 0;
    while (!p.airborne && guard++ < 60 * 20) g.step(1 / 60);
    g.autopilot(false);
    /* Dirty state, mid-flight: height, vertical speed, yaw rate, loaded
       springs and a launch record all live at once. */
    const before = {
      airborne: p.airborne, height: +p.height.toFixed(2),
      vertVel: +p.vertVel.toFixed(1), r: +p.r.toFixed(2),
      launched: !!p.launched, lips: p._lips.size,
    };
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
    g.step(1 / 60);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR' }));
    const f = track.frameAt(p.s);
    const after = {
      height: +p.height.toFixed(3), vertVel: p.vertVel, r: p.r,
      susp: p.susp.map(v => +v.toFixed(3)), suspVel: p.suspVel.map(v => +v.toFixed(3)),
      airborne: p.airborne, launched: p.launched, lips: p._lips.size,
      airTime: p.airTime, squash: +p.squash.toFixed(3),
      lat: +p.lat.toFixed(2), hw: +(f.width / 2).toFixed(1),
      kmh: +p.kmh.toFixed(1), s: +p.s.toFixed(1), finishS: +track.finishS.toFixed(1),
      steer: +p.steer.toFixed(3),
    };
    /* And it drives away cleanly: two seconds of throttle from the reset
       point. Where that point is right before a ramp lip — as here, twelve
       metres back from a flight over the ramp — re-launching off that lip is
       the ramp working, not the reset leaking air. */
    g.botInput = { steer: 0, throttle: 1, brake: 0, handbrake: 0 };
    const sMark = p.s;
    for (let i = 0; i < 120; i++) g.step(1 / 60);
    g.botInput = null;
    after.droveAway = +(p.s - sMark).toFixed(1);
    after.kmhAfter = +p.kmh.toFixed(1);
    return { before, after };
  });
  console.log('  R reset:', JSON.stringify(reset));
  check('reset: test started airborne with a launch record',
    reset.before.airborne && reset.before.launched, JSON.stringify(reset.before));
  check('reset: height and vertical speed cleared',
    reset.after.height <= 0.01 && reset.after.vertVel === 0,
    `height=${reset.after.height} vertVel=${reset.after.vertVel}`);
  check('reset: yaw rate and steering cleared',
    Math.abs(reset.after.r) < 0.05 && Math.abs(reset.after.steer) < 0.05,
    `r=${reset.after.r} steer=${reset.after.steer}`);
  check('reset: suspension travel cleared',
    reset.after.susp.every(v => Math.abs(v) < 0.03)
    && reset.after.suspVel.every(v => Math.abs(v) < 0.5),
    `susp=${reset.after.susp}`);
  check('reset: launch record cleared',
    !reset.after.launched && reset.after.lips === 0 && reset.after.airTime === 0,
    `launched=${reset.after.launched} lips=${reset.after.lips}`);
  check('reset: car on the road surface',
    Math.abs(reset.after.lat) <= reset.after.hw && !reset.after.airborne
    && reset.after.height <= 0.01,
    `lat=${reset.after.lat} hw=${reset.after.hw} height=${reset.after.height}`);
  check('reset: car drives away afterwards',
    reset.after.droveAway > 20 && reset.after.kmhAfter > reset.after.kmh,
    `drove ${reset.after.droveAway} m, ${reset.after.kmh} -> ${reset.after.kmhAfter} km/h`);
  check('reset: keeps a reasonable residual speed',
    reset.after.kmh > 20, `kmh=${reset.after.kmh}`);
  check('reset: not placed past the finish',
    reset.after.s <= reset.after.finishS, `s=${reset.after.s} finishS=${reset.after.finishS}`);

  /* ---- 5: slow motion fires exactly once across a reset ------------------ */
  const slowmo = await page.evaluate(() => {
    const g = window.__game, p = g.player, track = g.track, L = track.length;
    const r = track.ramps[0];
    const pass = () => {
      g.driveTo(r.pad0 / L, { runUp: 300, maxSec: 40 });
      g.autopilot(false);
      g.botInput = { steer: 0, throttle: 1, brake: 0, handbrake: 0 };
      let episodes = 0, slow = false, dips = [];
      for (let i = 0; i < 60 * 10; i++) {
        g.step(1 / 60);
        const ts = g.timeScale();
        if (ts < 0.99 && !slow) { episodes++; slow = true; }
        if (ts >= 0.99 && slow) slow = false;
        if (ts < 0.99) dips.push(+ts.toFixed(2));
        if (p.s > r.land + 60) break;
      }
      g.botInput = null;
      return { episodes, minScale: dips.length ? Math.min(...dips) : 1 };
    };
    const first = pass();
    /* Back before the ramp and through the R entry itself, so the second
       pass depends on the reset having cleared the launch record. */
    g.goTo(Math.max(6, r.pad0 - 320) / L);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
    g.step(1 / 60);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR' }));
    const second = pass();
    return { first, second };
  });
  console.log('  slow motion:', JSON.stringify(slowmo));
  check('slowmo: fires on the first pass', slowmo.first.episodes === 1,
    `episodes=${slowmo.first.episodes} min=${slowmo.first.minScale}`);
  check('slowmo: fires exactly once again after reset', slowmo.second.episodes === 1,
    `episodes=${slowmo.second.episodes} min=${slowmo.second.minScale}`);

  /* ---- 6: a finished car stays finished ---------------------------------- */
  const fin = await page.evaluate(() => {
    const g = window.__game, p = g.player, track = g.track, L = track.length;
    g.goTo((track.finishS - 160) / L);
    g.botInput = { steer: 0, throttle: 1, brake: 0, handbrake: 0 };
    let guard = 0;
    while (!p.finished && guard++ < 60 * 30) g.step(1 / 60);
    g.botInput = null;
    const t0 = p.raceTime, s0 = p.s, finished0 = p.finished;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
    g.step(1 / 60);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR' }));
    for (let i = 0; i < 120; i++) g.step(1 / 60);
    return {
      finished0, t0: +t0.toFixed(2), s0: +s0.toFixed(1),
      finished: p.finished, raceTime: +p.raceTime.toFixed(2),
      s: +p.s.toFixed(1), finishS: +track.finishS.toFixed(1),
      sPastLine: +(p.s - track.finishS).toFixed(1),
    };
  });
  console.log('  finished car reset:', JSON.stringify(fin));
  check('finish: car reached the flag', fin.finished0 === true, `s0=${fin.s0} finishS=${fin.finishS}`);
  check('finish: reset keeps the finish', fin.finished === true, `finished=${fin.finished}`);
  check('finish: clock does not grow after reset',
    fin.raceTime <= fin.t0 + 0.01, `t0=${fin.t0} now=${fin.raceTime}`);
  check('finish: not dragged back across the line to re-run it',
    fin.sPastLine > -40, `sPastLine=${fin.sPastLine} m`);
});

console.log(failures ? `\n  ${failures} check(s) FAILED` : '\n  all checks passed');
if (failures) process.exitCode = 1;
finish(process.exitCode || 0);
