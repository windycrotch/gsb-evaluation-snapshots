// The fault lifecycle, end to end: inject, degrade, repair, converge.
//   node test/faults.mjs
import { FlightModel, Autopilot, KT, FT, D2R, stillAir } from '../js/fdm.js';
import { Systems, FAILURES } from '../js/systems.js';

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

// ---- no faults: the panel agrees with the truth
{
  const { fm, sys, run } = flying();
  run(90);
  row('Airspeed indicator matches the truth when healthy', (sys.ind.ias - fm.out.ias) / KT, 0, 'kt', 1);
  row('Altimeter matches the truth when healthy', sys.ind.altInd - fm.out.altInd, 0, 'm', 2);
  row('Attitude matches the truth when healthy', (sys.ind.roll - fm.out.roll) / D2R, 0, 'deg', 0.5);
  row('Vertical speed matches the truth when healthy', sys.ind.vsInd - fm.out.vsInd, 0, 'm/s', 0.2);
  row('Heading gyro matches the truth when healthy', dAng(deg(sys.ind.heading), deg(fm.out.heading)), 0, 'deg', 1);
}

// ---- vacuum pump: inject, watch it topple, repair, watch it re-erect
{
  const { fm, sys, run } = flying();
  run(20);
  check('Injecting a fault reports it as new', sys.fail('vacuum') === true);
  run(240);
  const err = Math.abs(sys.ind.roll - fm.out.roll) / D2R;
  check('Vacuum failure: the attitude indicator drifts off over minutes', err > 10, `${err.toFixed(0)} deg after 4 min`);
  sys.repair('vacuum');
  run(5);
  const errEarly = Math.abs(sys.ind.roll - fm.out.roll) / D2R;
  check('Repair does not snap the gyro back instantly', errEarly > err * 0.5, `${errEarly.toFixed(0)} deg just after repair`);
  run(360);
  const errLate = Math.abs(sys.ind.roll - fm.out.roll) / D2R;
  check('...it re-erects to the truth within a few minutes', errLate < 1 && sys.gyro > 0.9, `${errLate.toFixed(2)} deg, gyro ${sys.gyro.toFixed(2)}`);
  // and the repaired system can fail again
  check('A repaired fault can be injected again', sys.fail('vacuum') === true);
  run(150);
  check('...and degrades again', sys.gyro < 0.6 && Math.abs(sys.ind.roll - fm.out.roll) / D2R > 2, `gyro ${sys.gyro.toFixed(2)}`);
  sys.repair('vacuum');
}

// ---- pitot blockage: frozen airspeed, then a leaky recovery
{
  const { fm, sys, run } = flying();
  run(60);
  const v0 = fm.out.ias / KT, i0 = sys.ind.ias / KT;
  sys.fail('pitot');
  run(2);
  check('Pitot blockage traps the ram pressure', sys.trapPitot !== null);
  fm.ctl.throttle = 1;
  run(90);
  check('Indicated airspeed is frozen while the real one rises', Math.abs(sys.ind.ias / KT - i0) < 3 && fm.out.ias / KT - v0 > 12,
    `indicated ${(sys.ind.ias / KT).toFixed(0)} kt (was ${i0.toFixed(0)}), true ${(fm.out.ias / KT).toFixed(0)} kt (was ${v0.toFixed(0)})`);
  sys.repair('pitot');
  run(0.5);
  check('Repair lets the trapped pressure leak out, not jump', sys.trapPitot !== null && Math.abs(sys.ind.ias / KT - i0) < 8, `${(sys.ind.ias / KT).toFixed(0)} kt just after repair`);
  run(60);
  check('...and the airspeed indicator settles back on the truth', sys.trapPitot === null && Math.abs(sys.ind.ias - fm.out.ias) / KT < 1);
  // re-injection works again after a full recovery
  sys.fail('pitot');
  run(2);
  check('Pitot blockage can be injected again after repair', sys.trapPitot !== null);
  sys.repair('pitot');
}

// ---- static port blockage: frozen altimeter, then convergence
{
  const { fm, sys, ap, run } = flying();
  run(60);
  const alt0 = sys.ind.altInd;
  sys.fail('static');
  ap.alt -= 400; fm.ctl.throttle = 0.3;
  run(120);
  check('Blocked static port freezes the altimeter and the VSI', Math.abs(sys.ind.altInd - alt0) < 15 && sys.ind.vsInd === 0 && alt0 - fm.out.altInd > 150,
    `indicated ${sys.ind.altInd.toFixed(0)} m, true ${fm.out.altInd.toFixed(0)} m`);
  sys.repair('static');
  run(60);
  check('Repair converges the altimeter back to the truth', sys.trapStatic === null && Math.abs(sys.ind.altInd - fm.out.altInd) < 2,
    `${(sys.ind.altInd - fm.out.altInd).toFixed(1)} m off`);
}

// ---- trim runaway: winds up while failed, winds back down after repair
{
  const { fm, sys, run } = flying();
  run(20);
  sys.fail('trim');
  run(30);
  check('Trim runaway drives the trim offset up', fm.fx.trimOffset > 0.5, `offset ${fm.fx.trimOffset.toFixed(2)}`);
  sys.repair('trim');
  run(1);
  check('Repair stops the runaway without snapping the trim back', fm.fx.trimOffset > 0.3, `offset ${fm.fx.trimOffset.toFixed(2)}`);
  run(30);
  check('...and the trim is re-centred within half a minute', Math.abs(fm.fx.trimOffset) < 0.001, `offset ${fm.fx.trimOffset.toFixed(3)}`);
}

// ---- re-injecting an active fault is idempotent: no stacking, no reset
{
  const { sys, run } = flying();
  run(20);
  sys.fail('vacuum');
  run(120);
  const gyro = sys.gyro, attErr = sys.attErr.slice(), events = sys.events.length;
  check('Re-injection is rejected', sys.fail('vacuum') === false && sys.fail('vacuum', 'random') === false);
  check('...leaves the accumulated damage untouched', sys.gyro === gyro && sys.attErr[0] === attErr[0] && sys.attErr[1] === attErr[1]);
  check('...does not duplicate the fault or its event', Object.keys(sys.failed).length === 1 && sys.events.length === events && sys.failed.vacuum.src === 'manual');
  run(60);
  check('...and the degradation keeps growing from where it was', sys.gyro < gyro, `gyro ${gyro.toFixed(2)} -> ${sys.gyro.toFixed(2)}`);
}

// ---- random and manual injection share one table and never conflict
{
  const { sys, run } = flying();
  run(10);
  sys.fail('vacuum');                                            // manual first
  sys.randomRate = 1e12;                                         // everything fails on the next tick
  run(5);
  const keys = Object.keys(sys.failed);
  check('Random failures fill the same table as manual ones', keys.length === Object.keys(FAILURES).length, keys.join(','));
  check('A manually injected fault is not overwritten by the random draw', sys.failed.vacuum.src === 'manual');
  check('No fault is injected twice', sys.events.filter((e) => e === 'vacuum').length === 1 && new Set(sys.events).size === sys.events.length);
  check('Random faults are tagged as random', keys.filter((k) => k !== 'vacuum').every((k) => sys.failed[k].src === 'random'));
  sys.repair();
  check('Repair-all empties the shared table', Object.keys(sys.failed).length === 0);
  run(5);                                                        // random rate still armed
  check('Faults come back after a repair while random failures are armed', Object.keys(sys.failed).length === Object.keys(FAILURES).length && sys.failed.vacuum.src === 'random');
  sys.randomRate = 0;
  sys.repair();
}

// ---- repairing one fault leaves the others alone
{
  const { fm, sys, run } = flying();
  run(20);
  sys.fail('pitot');
  sys.fail('trim');
  run(10);
  check('Single-fault repair clears only that fault', sys.repair('pitot') === true && !sys.failed.pitot && !!sys.failed.trim);
  const t0 = fm.fx.trimOffset;
  run(5);
  check('...the other fault keeps degrading', fm.fx.trimOffset > t0);
  check('Repairing a fault that is not active is a no-op', sys.repair('pitot') === false && sys.repair('nonsense') === false);
  sys.repair();
}

// ---- oil loss: repair clears the residual damage for good
{
  const { fm, sys, run } = flying();
  sys.fail('oil');
  run(60);
  check('Oil pressure falls while the fault is active', sys.ind.oilP < 5);
  run(160);
  check('...until the engine seizes', sys.seized && !fm.out.firing);
  sys.repair('oil');   // still airborne, the propeller windmilling
  check('Repair clears the oil fault residue', sys.oilLeft === 1 && !sys.seized && !sys.seizeT);
  run(20);
  check('...the engine runs again and oil pressure is back', fm.out.firing && sys.ind.oilP > 20, `oilP ${sys.ind.oilP.toFixed(0)}`);
}

// ---- alternator: bus sags while failed, recovers after repair
{
  const { sys, run } = flying();
  run(10);
  sys.fail('alternator');
  run(60);
  check('Alternator failure drops the bus to battery voltage', sys.volts < 25.5 && sys.ind.lowVolts, `${sys.volts.toFixed(1)} V`);
  sys.repair('alternator');
  run(30);
  check('Repair restores the charge bus', sys.volts > 27.5 && !sys.ind.lowVolts, `${sys.volts.toFixed(1)} V`);
}

const pad = (s, n) => String(s).padEnd(n);
let bad = 0;
for (const r of rows) { if (!r.ok) bad++; console.log(`${r.ok ? '  ok  ' : ' MISS '}${pad(r.name, 76)}${typeof r.want === 'number' && r.unit !== '' && !isNaN(r.got) && r.want !== 1 ? pad(r.got.toFixed(1), 8) + pad(r.want, 6) : ''}${r.unit}`); }
console.log(`\n${rows.length - bad}/${rows.length}\n`);
process.exit(bad ? 1 : 0);
