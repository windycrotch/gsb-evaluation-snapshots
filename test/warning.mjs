// Checks the stall warning and the air-data it depends on, end to end through the
// FlightModel and Systems interfaces (no DOM, no three.js).
//   node test/warning.mjs
//
// The warning is a physical member with memory. It must combine the vane, the actual
// separated area and the ice load; latch through a stall and release only once the
// flow has reattached; and it must not be driven by an airspeed the pitot can no
// longer be believed. The pitot-static system has its own states — clean, blocked,
// recovering — and every transition is checked here.
import { FlightModel, Autopilot, KT, stillAir } from '../js/fdm.js';
import { Systems } from '../js/systems.js';

const DT = 1 / 240;
const rows = [];
const check = (name, pass, note = '') => rows.push({ name, got: pass ? 1 : 0, want: 1, unit: note, ok: !!pass });
const row = (name, got, want, unit, tol) => rows.push({ name, got, want, unit, ok: Math.abs(got - want) <= tol });

const clear = { oat: 15, lwc: 0, precip: 0, humidity: 0.5, lat: 46, variation: 0 };
const icing = { ...clear, oat: -7, lwc: 1 };         // thick supercooled cloud, near the worst band
const warm = { ...clear, oat: 12, lwc: 0 };

function flying({ ias = 90, alt = 1500, throttle = 0.65 } = {}) {
  const fm = new FlightModel(stillAir);
  fm.reset({ alt, heading: 0, speed: ias * KT, pitch: 0.03, throttle });
  const sys = new Systems(fm), ap = new Autopilot(fm);
  ap.engage('alt');
  const run = (sec, wx = clear, each) => {
    for (let i = 0; i < sec / DT; i++) {
      ap.update(DT); fm.step(DT); sys.update(DT, wx);
      if (each && each(i * DT) === false) return;
    }
  };
  return { fm, sys, ap, run };
}

// Decelerate in level flight at low power until the horn sounds, and on until the
// wing stalls. Returns the indicated airspeed at each event.
function warningAndStallSpeed({ ice = 0, throttle = 0.45, ias = 100 } = {}) {
  const { fm, ap, run } = flying({ ias, throttle });
  fm.fx.ice = ice;
  run(30);
  const out = { warn: null, stall: null };
  for (let i = 0; i < 90 / DT; i++) {
    ap.update(DT); fm.ctl.throttle = 0.05; fm.step(DT); fm.fx.ice = ice;
    const o = fm.out;
    if (out.warn === null && o.stallWarn > 0.3) out.warn = o.ias / KT;
    if (out.stall === null && o.stalled > 0.3) { out.stall = o.ias / KT; break; }
  }
  return out;
}

// ---- 1. clean flight must not cry wolf
{
  const { fm, run } = flying({ ias: 80 });
  let peak = 0, latching = false;
  run(240, clear, () => { peak = Math.max(peak, fm.out.stallWarn); latching = latching || fm.out.warnLatched; });
  check('Clean cruise: the horn never sounds', peak < 0.02, `peak ${peak.toFixed(3)}`);
  check('Clean cruise: the warning never latches', !latching);

  // a 30 degree banked turn at 1.2 Vs is still not a stall
  const t = flying({ ias: 68 });
  t.run(10);
  t.ap.heading = t.fm.out.heading + 2.0;
  let turnPeak = 0;
  t.run(40, clear, () => { turnPeak = Math.max(turnPeak, t.fm.out.stallWarn); });
  check('A steep-ish turn in clean air does not trigger the horn', turnPeak < 0.2, `peak ${turnPeak.toFixed(2)}`);

  // a wing carrying a full load of ice in level flight is slow, but still flying
  const i = flying({ ias: 100 });
  let icedPeak = 0;
  i.run(120, clear, () => { i.fm.fx.ice = 1; icedPeak = Math.max(icedPeak, i.fm.out.stallWarn); });
  check('Level flight with a full load of ice does not trigger the horn', icedPeak < 0.2, `peak ${icedPeak.toFixed(2)}`);
}

// ---- 2. ice makes the warning come earlier
{
  const clean = warningAndStallSpeed({ ice: 0 });
  const iced = warningAndStallSpeed({ ice: 1 });
  check('Clean wing: the horn precedes the stall', clean.warn !== null && clean.stall !== null && clean.warn > clean.stall,
    `warn ${clean.warn?.toFixed(0)} kt, stall ${clean.stall?.toFixed(0)} kt`);
  check('Iced wing: the horn precedes the stall', iced.warn !== null && iced.stall !== null && iced.warn > iced.stall,
    `warn ${iced.warn?.toFixed(0)} kt, stall ${iced.stall?.toFixed(0)} kt`);
  row('Ice raises the speed at which the horn first sounds', iced.warn - clean.warn, 11, 'kt', 6);
}

// ---- 3. a stall latches, then clears with a lag once the flow reattaches
{
  const { fm, run } = flying({ ias: 80 });
  run(30);
  // pull to the break
  let tBreak = null;
  for (let i = 0; i < 6 / DT; i++) {
    fm.ctl.pitch = 1; fm.step(DT);
    if (tBreak === null && fm.out.stalled > 0.3) tBreak = i * DT;
  }
  check('The wing breaks and the horn is sounding', tBreak !== null && fm.out.stallWarn > 0.9 && fm.out.warnLatched);
  // release the back pressure and recover
  let tReattach = null, tSilent = null;
  for (let i = 0; i < 10 / DT; i++) {
    fm.ctl.pitch = 0.1; fm.step(DT);
    if (tReattach === null && fm.out.stalled < 0.025) tReattach = i * DT;
    if (tSilent === null && fm.out.stallWarn < 0.2) tSilent = i * DT;
  }
  check('The horn outlasts the angle of attack, waiting for the actual separation to clear',
    tReattach !== null && tSilent !== null && tSilent > tReattach, `reattached ${tReattach?.toFixed(2)} s, silent ${tSilent?.toFixed(2)} s`);
  check('...but it never stays locked on after the wing is flying again', tSilent !== null && tSilent < 3, `${tSilent?.toFixed(2)} s`);
  check('After recovery the latch is released', !fm.out.warnLatched);
}

// ---- 4. no chattering when the angle of attack sits on the threshold
{
  const { fm, run } = flying({ ias: 58 });
  run(20);
  let toggles = 0, prev = 0;
  for (let i = 0; i < 30 / DT; i++) {
    // dither the stick so the angle of attack crosses the threshold repeatedly
    fm.ctl.pitch = 0.25 + 0.06 * Math.sin(i * DT * 2.3) + 0.03 * Math.sin(i * DT * 7.7);
    fm.step(DT);
    const on = fm.out.stallWarn > 0.3 ? 1 : 0;
    if (on !== prev) toggles++; prev = on;
  }
  check('Dithering on the threshold does not make the horn chatter', toggles <= 4, `${toggles} changes in 30 s`);
}

// ---- 5. a blocked pitot: the horn ignores the false airspeed but still fires on a real stall
{
  const { fm, sys, ap, run } = flying({ ias: 95 });
  run(20);
  const ias0 = sys.ind.ias / KT;
  sys.fail('pitot');
  fm.ctl.throttle = 0.9; ap.engage('vs'); ap.vs = 3;       // climb: the trapped pressure makes the needle rise
  let peakWarn = 0, fakeMax = 0;
  run(120, clear, () => {
    const o = fm.out;
    peakWarn = Math.max(peakWarn, o.stallWarn);
    fakeMax = Math.max(fakeMax, sys.ind.ias / KT);
  });
  check('Blocked pitot shows a climbing, false airspeed', fakeMax > ias0 + 30, `${ias0.toFixed(0)} -> ${fakeMax.toFixed(0)} kt indicated`);
  check('...while the horn stays quiet below the stall', peakWarn < 0.2, `peak ${peakWarn.toFixed(2)}`);
  check('...and the air-data trust has fallen', sys.pitotTrust < 0.1 && fm.out.airdataTrust < 0.1);

  // now actually stall: the horn must still work off the held, last-good airspeed
  const s = flying({ ias: 70, throttle: 0.12 });
  s.run(20);
  s.sys.fail('pitot');
  s.fm.ctl.throttle = 0.02;
  let warned = false, fake = 0;
  for (let i = 0; i < 120 / DT; i++) {
    s.ap.update(DT); s.fm.step(DT); s.sys.update(DT, clear);
    fake = Math.max(fake, s.sys.ind.ias / KT);
    if (s.fm.out.stallWarn > 0.2) warned = true;
    if (s.fm.out.stalled > 0.35) break;
  }
  check('A blocked pitot does not silence a real stall', warned, `indicated up to ${fake.toFixed(0)} kt, stall reached`);
}

// ---- 6. heat with power restores trust; the warning follows the real airflow again
{
  const { fm, sys, ap, run } = flying({ ias: 95 });
  run(20);
  sys.fail('pitot');
  run(6);
  check('Injected blockage: the probe is blocked and not believed', sys.pitotState === 'blocked' && sys.pitotTrust < 0.05);
  sys.sw.pitotHeat = true;
  sys.repair();
  let recovered = null;
  run(6, clear, (t) => { if (sys.pitotState === 'clean') recovered = t; });
  check('Heat and power return the probe to clean', sys.pitotState === 'clean' && sys.pitotTrust > 0.99, recovered !== null ? `${recovered.toFixed(1)} s` : '');
  check('...and the held airspeed is dropped once it is believed again', sys.pitotIas === null && fm.fx.airdataIas === null);
  // and a stall now sounds at the clean-wing speed
  fm.fx.ice = 0;
  let warned = false;
  for (let i = 0; i < 80 / DT; i++) { ap.update(DT); fm.ctl.throttle = 0.03; fm.step(DT); sys.update(DT, clear); if (fm.out.stallWarn > 0.3) { warned = true; break; } }
  check('With trustworthy air data the horn responds to the real airflow', warned);

  // and the same recovery happens from the heat alone, with no manual repair: the
  // probe thaws, the state walks blocked -> recovering -> clean, and trust returns
  const h = flying({ ias: 95 });
  h.run(20);
  h.sys.fail('pitot');
  h.run(6);
  h.sys.sw.pitotHeat = true;
  let sawRecovering = false, thawed = null;
  h.run(30, clear, (t) => {
    if (h.sys.pitotState === 'recovering') sawRecovering = true;
    if (h.sys.pitotState === 'clean') thawed = t;
  });
  check('Heat alone thaws an injected blockage without a repair', thawed !== null && sawRecovering && h.sys.pitotTrust > 0.99,
    thawed !== null ? `${thawed.toFixed(0)} s` : 'did not thaw');
}

// ---- 7. the pitot state machine: power loss, heat failure, repeated freeze and melt
{
  // heat selected but the bus is dead: the probe still ices and blocks
  const a = flying({ ias: 95 });
  a.sys.sw.pitotHeat = true;
  a.sys.sw.master = false; a.sys.sw.alternator = false;
  let blocked = false;
  a.run(160, icing, () => { blocked = blocked || a.sys.pitotBlocked; });
  check('Heat without power does not keep the probe clear', blocked && a.sys.pitotTrust < 0.1);

  // a failed heater: ice builds and blocks even with the switch on
  const b = flying({ ias: 95 });
  b.sys.sw.pitotHeat = true; b.sys.fail('pitotHeat');
  let blocked2 = false;
  b.run(160, icing, () => { blocked2 = blocked2 || b.sys.pitotBlocked; });
  check('A failed heater leaves the probe to ice over', blocked2 && b.sys.pitotIce > 1);

  // recover in warm air without heat: slow, but it does come back
  b.run(120, warm);
  check('Warm air clears the probe even with no heat', b.sys.pitotState === 'clean' && b.sys.pitotTrust > 0.99);

  // repeated freeze / melt cycles must finish at the clean baseline
  const c = flying({ ias: 95 });
  for (let k = 0; k < 3; k++) {
    c.run(110, icing);
    c.run(70, warm);
  }
  c.run(40, clear);
  check('After repeated icing cycles the probe is clean again', c.sys.pitotState === 'clean' && c.sys.pitotBlocked === false && c.sys.pitotIas === null,
    `state ${c.sys.pitotState}, trust ${c.sys.pitotTrust.toFixed(2)}`);
  check('...and the horn is silent at the clean baseline', c.fm.out.stallWarn < 0.02 && !c.fm.out.warnLatched);
}

// ---- 8. the warning fields are written where the panel and the sound read them
{
  const { fm, sys, run } = flying({ ias: 80 });
  run(5);
  check('The stall warning is in the flight-model output', typeof fm.out.stallWarn === 'number' && typeof fm.out.warnLevel === 'number');
  check('The air-data trust is in the flight-model output', typeof fm.out.airdataTrust === 'number' && typeof fm.out.airdataStale === 'boolean');
  check('The systems write the same trust to fx and ind', fm.fx.airdataTrust === sys.ind.pitotTrust && sys.ind.pitotTrust === 1);
  check('The pitot state is published for the panel', typeof sys.ind.pitotState === 'string' && typeof sys.ind.pitotBlocked === 'boolean');

  // headless: a FlightModel with no Systems still runs and warns
  const bare = new FlightModel(stillAir);
  bare.reset({ alt: 1500, speed: 80 * KT, throttle: 0.5 });
  const ap = new Autopilot(bare); ap.engage('alt');
  for (let i = 0; i < 30 / DT; i++) { ap.update(DT); bare.step(DT); }
  let warned = false;
  for (let i = 0; i < 10 / DT; i++) { bare.ctl.pitch = 1; bare.step(DT); if (bare.out.stallWarn > 0.3) warned = true; }
  check('Headless with no Systems, the flight model still warns and runs', warned && Number.isFinite(bare.out.airdataTrust));
}

const pad = (s, n) => String(s).padEnd(n);
let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  const value = typeof r.want === 'number' && r.unit !== '' && !isNaN(r.got) && r.want !== 1 ? pad(r.got.toFixed(1), 8) + pad(r.want, 6) : '';
  console.log(`${r.ok ? '  ok  ' : ' MISS '}${pad(r.name, 74)}${value}${r.unit}`);
}
console.log(`\n${rows.length - bad}/${rows.length}\n`);
process.exit(bad ? 1 : 0);
