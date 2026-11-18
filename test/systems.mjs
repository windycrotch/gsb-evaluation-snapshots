// Checks the aircraft systems against what a pilot is taught to expect.
//   node test/systems.mjs
import { FlightModel, Autopilot, KT, FT, D2R, stillAir } from '../js/fdm.js';
import { Systems } from '../js/systems.js';

const DT = 1 / 240, rows = [];
const row = (name, got, want, unit, tol) => rows.push({ name, got, want, unit, ok: Math.abs(got - want) <= tol });
const check = (name, pass, note = '') => rows.push({ name, got: pass ? 1 : 0, want: 1, unit: note, ok: !!pass });
const clear = { oat: 15, lwc: 0, precip: 0, humidity: 0.5, lat: 46, variation: 0 };
const deg = (a) => ((a / D2R) % 360 + 360) % 360;
const dAng = (a, b) => { let d = (a - b) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };

function flying({ ias = 95, alt = 1500, heading = 0, throttle = 0.65 } = {}) {
  const fm = new FlightModel(stillAir);
  fm.reset({ alt, heading: heading * D2R, speed: ias * KT, pitch: 0.03, throttle });
  const sys = new Systems(fm), ap = new Autopilot(fm);
  ap.engage('alt');
  const run = (sec, wx = clear, each) => { for (let i = 0; i < sec / DT; i++) { ap.update(DT); fm.step(DT); sys.update(DT, wx); if (each && each(i * DT) === false) break; } };
  return { fm, sys, ap, run };
}

// ---- icing: fly level through freezing cloud and watch the aircraft degrade
{
  const { fm, sys, ap, run } = flying({ ias: 100 });
  run(40);
  fm.ctl.throttle = 0.8; run(60);
  const v0 = fm.out.ias / KT;
  run(480, { ...clear, oat: -7, lwc: 1 });
  check('Ice builds in freezing cloud', sys.ice > 0.8, `ice ${sys.ice.toFixed(2)} after 8 min`);
  row('Speed lost to severe ice at the same power', v0 - fm.out.ias / KT, 24, 'kt', 14);
  check('Still holding altitude at 80 % power with a full load of ice', fm.out.alt > 1450);
  check('Unheated pitot freezes over', sys.trapPitot !== null);
  // blocked pitot: indicated airspeed now rises in a climb, like an altimeter
  const i0 = sys.ind.ias / KT; ap.alt += 300; fm.ctl.throttle = 1;
  run(60, { ...clear, oat: -7, lwc: 0 });
  check('Blocked airspeed indicator reads higher as you climb', sys.ind.ias / KT > i0 + 5 || fm.out.alt < ap.alt - 250, `${i0.toFixed(0)} -> ${(sys.ind.ias / KT).toFixed(0)} kt indicated, true ${(fm.out.ias / KT).toFixed(0)}`);
}
{
  // stall speed with a full load of ice, measured the same way as the handbook check
  const stall = (ice) => { const { fm, sys, run } = flying({ ias: 70, alt: 1000, throttle: 0.12 }); let v = 0; fm.fx.ice = ice;
    run(200, clear, (t) => { fm.fx.ice = ice; if (t > 6 && fm.out.stalled > 0.3) { v = fm.out.tas / KT; return false; } }); return v; };
  const clean = stall(0), iced = stall(1);
  row('Stall speed rise with severe ice', iced - clean, 9, 'kt', 5);
}
{
  const { fm, sys, run } = flying();
  sys.sw.pitotHeat = true;
  run(240, { ...clear, oat: -7, lwc: 1 });
  check('Pitot heat keeps the airspeed alive', sys.trapPitot === null);
  run(900, { ...clear, oat: 12, lwc: 0 });
  check('Ice melts in warm air', sys.ice < 0.05, `ice ${sys.ice.toFixed(2)} after 15 min at +12 C`);
}

// ---- stall warning horn: it must track the wing's real stall margin, not a fixed speed.
// Free-flight entries use the same trim and power for clean and iced aircraft; the
// pinned harnesses hold the aircraft in a steady wind-tunnel airflow so sideslip and
// ground-effect thresholds can be read off without a pilot compensating them away.
{
  // (1) severe ice: identical trim, identical throttle, slow pull -> the horn leads
  // the clean-aircraft one by a comfortable margin, yet stays silent in iced cruise
  const hornEntry = (ice) => {
    const { fm, ap, run } = flying({ ias: 85, alt: 1500, throttle: 0.55 });
    fm.fx.ice = ice;
    run(30, clear, () => { fm.fx.ice = ice; });
    const stick0 = fm.ctl.pitch, thr0 = fm.ctl.throttle, trim0 = fm.ctl.trim;
    ap.on = false;
    let warnKt = 0, stallKt = 0;
    run(40, clear, (t) => {
      fm.fx.ice = ice;
      fm.ctl.pitch = Math.min(1, stick0 + t / 14);
      fm.ctl.throttle = thr0; fm.ctl.trim = trim0;
      fm.ctl.yaw = Math.max(-1, Math.min(1, 3 * fm.out.beta));
      if (!warnKt && fm.out.stallWarn > 0.3) warnKt = fm.out.ias / KT;
      if (!stallKt && fm.out.stalled > 0.3) { stallKt = fm.out.ias / KT; return false; }
    });
    return { warnKt, stallKt };
  };
  const c = hornEntry(0), i = hornEntry(1);
  row('Severe ice sounds the horn earlier than the clean wing', i.warnKt - c.warnKt, 12, 'kt', 6);
  row('...and still before the iced wing actually stalls', i.warnKt - i.stallKt, 1.5, 'kt', 1.2);
  {
    const { fm, run } = flying({ ias: 85, alt: 1500, throttle: 0.8 });
    let loudest = 0;
    run(60, clear, () => { fm.fx.ice = 1; loudest = Math.max(loudest, fm.out.stallWarn); });
    check('No nuisance horn in trimmed, severely iced cruise', loudest < 0.1, `peak stallWarn ${loudest.toFixed(2)} at ${(fm.out.ias / KT).toFixed(0)} kt`);
  }
}
{
  // (2) sideslip bends the local angle of attack: at one alpha near the clean
  // threshold, a steady slip pushes the harder-working wing over it
  const pin = new FlightModel(stillAir);
  const V = 60 * KT, agl = 2000;
  pin.reset({ alt: agl, speed: V, pitch: 0, throttle: 0 });
  pin.ctl.mixture = 1;
  const hold = (alpha, beta) => {
    const ca = Math.cos(alpha / 2), sa = Math.sin(alpha / 2);
    pin.q[0] = ca; pin.q[1] = 0; pin.q[2] = sa; pin.q[3] = 0;
    const u = V * Math.cos(beta) * Math.cos(alpha), w = V * Math.cos(beta) * Math.sin(alpha), v = V * Math.sin(beta);
    pin.vel[0] = (ca * ca - sa * sa) * u + 2 * ca * sa * w; pin.vel[1] = v; pin.vel[2] = 2 * ca * sa * u + (ca * ca - sa * sa) * w;
    pin.w[0] = pin.w[1] = pin.w[2] = 0; pin.pos[2] = -agl;
  };
  const hornAt = (betaDeg) => {
    const b = betaDeg * D2R;
    for (let deg = 0; deg <= 12; deg += 0.1) {
      const a = deg * D2R;
      for (let k = 0; k < 240; k++) { hold(a, b); pin.step(DT); }
      hold(a, b); pin.step(DT);
      if (pin.out.stallWarn > 0.3) return deg;
    }
    return 99;
  };
  const aZero = hornAt(0), aSlip = hornAt(12);
  row('Sideslip lowers the horn angle of attack', aZero - aSlip, 0.2, 'deg', 0.15);
  check('Horn threshold depends on which way the aircraft is slipping', aSlip < aZero, `${aZero.toFixed(1)} deg wings level vs ${aSlip.toFixed(1)} deg in a 12 deg slip`);
}
{
  // (3) ground effect cushions the wing: on an equal-lift deceleration the horn
  // moves to a lower speed near the runway and never cries wolf above the flare
  const geHorn = (agl, cushionKt) => {
    const fm = new FlightModel(stillAir);
    const G0 = 9.80665;
    fm.reset({ alt: agl, speed: 60 * KT, pitch: 0.05, throttle: 0.2 });
    fm.ctl.flaps = 1; fm.flapPos = 1; fm.ctl.mixture = 1;
    const m = fm.mass, S = fm.S, rho = 1.225;
    let onset = 0, nuisance = 0;
    for (let kt = 60; kt >= 40; kt -= 0.25) {
      const V = kt * KT, clTrim = m * G0 / (0.5 * rho * V * V * S);
      let elev = 0.2;
      for (let k = 0; k < 360; k++) {
        const qS = 0.5 * fm.out.rho * V * V * S;
        const cl = -fm.out.az * fm.out.mass / qS * Math.cos(fm.out.alpha) + (fm.out.ax * fm.out.mass / qS) * Math.sin(fm.out.alpha);
        elev = Math.max(-1, Math.min(1, elev + 0.02 * (clTrim - cl)));
        fm.ctl.pitch = elev;
        const a = 2 * Math.asin(Math.max(-1, Math.min(1, fm.q[2])));
        const ca = Math.cos(a / 2), sa = Math.sin(a / 2);
        fm.vel[0] = (ca * ca - sa * sa) * V; fm.vel[1] = 0; fm.vel[2] = 2 * ca * sa * V;
        fm.w[0] = fm.w[1] = fm.w[2] = 0; fm.pos[0] = 0; fm.pos[1] = 0; fm.pos[2] = -agl;
        fm.step(DT);
      }
      // the comfortable cushion: faster than the speed that sounds the horn up high
      if (cushionKt !== null && kt >= cushionKt) nuisance = Math.max(nuisance, fm.out.stallWarn);
      if (!onset && fm.out.stallWarn > 0.3) onset = kt;
      if (fm.out.onGround) break;
    }
    return { onset, nuisance };
  };
  const high = geHorn(14, null), low = geHorn(2.2, high.onset);
  row('Ground effect delays the horn to a lower speed', high.onset - low.onset, 0.6, 'kt', 0.4);
  check('No horn while still flying comfortably in low-speed ground effect', low.nuisance < 0.1, `peak stallWarn above the cushion: ${low.nuisance.toFixed(2)}`);
}
{
  // (4) once the angle of attack comes back off, the horn clears immediately
  const { fm, ap, run } = flying({ ias: 70, alt: 2000, throttle: 0.12 });
  run(20); ap.on = false;
  const stick0 = fm.ctl.pitch;
  let loudest = 0, releasedAt = 0, clearedAfter = null;
  run(30, clear, (t) => {
    if (t < 12) fm.ctl.pitch = Math.min(1, stick0 + t / 12);
    else {
      if (!releasedAt) releasedAt = t;
      fm.ctl.pitch = 0;
    }
    fm.ctl.yaw = Math.max(-1, Math.min(1, 3 * fm.out.beta));
    loudest = Math.max(loudest, fm.out.stallWarn);
    if (releasedAt && clearedAfter === null && fm.out.stallWarn < 0.1) { clearedAfter = t - releasedAt; return false; }
  });
  check('The horn genuinely sounds before the release', loudest > 0.8, `peak stallWarn ${loudest.toFixed(2)}`);
  row('The horn silences within a second of easing back pressure', clearedAfter ?? 99, 0.1, 's', 0.8);
}

// ---- vacuum failure: the attitude indicator leans over slowly, and no flag drops
{
  const { fm, sys, run } = flying();
  run(20);
  check('Gyros agree with the horizon when healthy', Math.abs(sys.ind.roll - fm.out.roll) < 0.01);
  sys.fail('vacuum');
  run(60);
  const e1 = Math.abs(sys.ind.roll - fm.out.roll) / D2R;
  run(240);
  const e2 = Math.abs(sys.ind.roll - fm.out.roll) / D2R;
  check('After a vacuum failure the attitude indicator is still nearly right a minute later', e1 < 4, `${e1.toFixed(1)} deg`);
  check('...and badly wrong five minutes later', e2 > 15, `${e2.toFixed(0)} deg`);
  check('Low-vacuum warning shows', sys.ind.lowVac);
}
// ---- heading gyro drift: about a degree every few minutes, needs resetting
{
  const { fm, sys, run } = flying({ heading: 90 });
  sys.syncHeading(); run(900);
  const drift = Math.abs(dAng(deg(sys.ind.heading), deg(fm.out.heading)));
  row('Heading gyro drift in 15 minutes', drift, 3.5, 'deg', 2.5);
}

// ---- compass errors (northern hemisphere)
{
  // accelerate on an east heading: the compass swings toward north ("accelerate north, decelerate south")
  const { fm, sys, run } = flying({ heading: 90, ias: 80, throttle: 0.5 });
  run(40);
  const c0 = deg(sys.ind.compass);
  fm.ctl.throttle = 1; let minC = c0;
  run(8, clear, () => { minC = Math.min(minC, deg(sys.ind.compass)); });
  check('Accelerating eastbound, the compass swings toward north', c0 - minC > 3, `${c0.toFixed(0)} -> ${minC.toFixed(0)}`);
}
{
  // roll into a turn from north: the compass first shows a turn the other way ("undershoot north")
  const { fm, sys, ap, run } = flying({ heading: 0 });
  run(40);
  ap.heading = 60 * D2R; let worst = 0;
  run(6, clear, () => { worst = Math.min(worst, dAng(deg(sys.ind.compass), deg(fm.out.heading))); });
  check('Turning east from north, the compass lags behind the turn', worst < -8, `${worst.toFixed(0)} deg behind`);
}
{
  const { fm, sys, ap, run } = flying({ heading: 180 });
  run(40);
  ap.heading = 240 * D2R; let lead = 0;
  run(6, clear, () => { lead = Math.max(lead, dAng(deg(sys.ind.compass), deg(fm.out.heading))); });
  check('Turning west from south, the compass leads the turn', lead > 8, `${lead.toFixed(0)} deg ahead`);
}
{
  const { fm, sys, run } = flying({ heading: 270 });
  run(60);
  row('In steady level flight the compass reads the heading', dAng(deg(sys.ind.compass), 270), 0, 'deg', 2);
}

// ---- electrics
{
  const { fm, sys, run } = flying();
  run(10); const v0 = sys.volts;
  sys.fail('alternator'); run(60);
  check('Alternator failure: bus drops to battery voltage and the warning lights', v0 > 27.5 && sys.volts < 25.5 && sys.ind.lowVolts, `${v0.toFixed(1)} -> ${sys.volts.toFixed(1)} V`);
  let t = 60; while (sys.powered && t < 4 * 3600) { sys.update(1, clear); t += 1; }   // the aircraft need not move for the battery to run down
  row('Battery life with everything left on', t / 60, 95, 'min', 40);
  check('With the battery flat the turn coordinator flags and the flaps are dead', sys.ind.tcFlag && !fm.fx.flapPower);
  sys.repair();
}
// ---- magneto check on the ground at 1800 rpm
{
  const fm = new FlightModel(stillAir); fm.reset({});
  const sys = new Systems(fm);
  const run = (sec) => { for (let i = 0; i < sec / DT; i++) { fm.step(DT); sys.update(DT, clear); } };
  for (let k = 0; k < 40; k++) { run(1); fm.ctl.throttle += 0.004 * (1800 - fm.out.rpm) / 100; }
  const both = fm.out.rpm; sys.sw.magnetos = 1; run(6);
  row('Magneto check: RPM drop on one magneto', both - fm.out.rpm, 90, 'rpm', 60);
  sys.sw.magnetos = 0; run(4);
  check('Magnetos off stops the engine', !fm.out.firing);
}
// ---- fuel selector
{
  const { fm, sys, run } = flying();
  sys.sw.tank = 'left'; fm.fuel = 6; sys.tanks = [0.15, 5.85]; sys.lastFuel = 6;
  run(120);
  check('Running a tank dry stops the engine with fuel still aboard', !fm.out.firing && fm.fuel > 5, `${fm.fuel.toFixed(1)} kg left in the other tank`);
  sys.sw.tank = 'both'; run(8);
  check('Switching tanks brings it back (the propeller is still windmilling)', fm.out.firing);
}
// ---- oil loss ends in a seized engine
{
  const { fm, sys, run } = flying();
  sys.fail('oil'); run(60);
  check('Oil pressure falls first', sys.ind.oilP < 5 && fm.out.firing);
  run(400);
  check('...then the engine seizes', sys.seized && !fm.out.firing);
}

const pad = (s, n) => String(s).padEnd(n);
let bad = 0;
for (const r of rows) { if (!r.ok) bad++; console.log(`${r.ok ? '  ok  ' : ' MISS '}${pad(r.name, 76)}${typeof r.want === 'number' && r.unit !== '' && !isNaN(r.got) && r.want !== 1 ? pad(r.got.toFixed(1), 8) + pad(r.want, 6) : ''}${r.unit}`); }
console.log(`\n${rows.length - bad}/${rows.length}\n`);
