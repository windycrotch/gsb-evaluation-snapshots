// Unit tests for the pendulum physics core.
// Run locally with: npm test   (uses Node's built-in test runner, no deps)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  correctedPeriod,
  theoreticalFrequency,
  pendulumKE,
  pendulumPE,
  pendulumTotalEnergy,
  rk4Step,
  PeriodMeasurer,
} from "../src/experiments/pendulum-physics.ts";

const L = 10;
const G = 9.81;
const M = 2;

/** Simulate the damped pendulum, invoking `onStep` after every sub-step. */
function simulate(
  theta0: number,
  damping: number,
  duration: number,
  dt: number,
  onStep?: (theta: number, omega: number, time: number) => void
): { theta: number; omega: number; time: number } {
  let theta = theta0;
  let omega = 0;
  let time = 0;
  const steps = Math.round(duration / dt);
  for (let i = 0; i < steps; i++) {
    [theta, omega] = rk4Step(theta, omega, G, L, damping, dt);
    time += dt;
    onStep?.(theta, omega, time);
  }
  return { theta, omega, time };
}

// ============================================
// Large-angle period correction
// ============================================

test("correctedPeriod reduces to the small-angle period at theta0 = 0", () => {
  const T0 = 2 * Math.PI * Math.sqrt(L / G);
  assert.ok(Math.abs(correctedPeriod(L, G, 0) - T0) < 1e-12);
});

test("correctedPeriod applies the 1 + θ²/16 + 11θ⁴/3072 correction", () => {
  const theta0 = Math.PI / 4; // 45°
  const T0 = 2 * Math.PI * Math.sqrt(L / G);
  const expected =
    T0 * (1 + theta0 * theta0 / 16 + (11 * theta0 ** 4) / 3072);
  assert.ok(Math.abs(correctedPeriod(L, G, theta0) - expected) < 1e-12);
});

test("correctedPeriod grows with amplitude", () => {
  const small = correctedPeriod(L, G, 0.2);
  const large = correctedPeriod(L, G, 1.2);
  assert.ok(large > small);
});

test("theoreticalFrequency is the reciprocal of the corrected period", () => {
  const theta0 = 0.6;
  const T = correctedPeriod(L, G, theta0);
  assert.ok(Math.abs(theoreticalFrequency(L, G, theta0) - 1 / T) < 1e-12);
});

// ============================================
// Zero-crossing period measurement
// ============================================

test("PeriodMeasurer reports 0 until two same-direction crossings", () => {
  const m = new PeriodMeasurer();
  assert.equal(m.measuredPeriod, 0);
  // One crossing (negative -> non-negative)
  m.record(-0.1, 0.1, 0, 0.1);
  assert.equal(m.measuredPeriod, 0);
  // Second same-direction crossing one "period" later
  m.record(-0.1, 0.1, 2.0, 2.1);
  assert.ok(Math.abs(m.measuredPeriod - 2.0) < 1e-9);
});

test("PeriodMeasurer interpolates the crossing instant between samples", () => {
  const m = new PeriodMeasurer();
  // theta goes -0.05 -> +0.15 over t in [1.0, 1.1]: crossing at t = 1.025
  m.record(-0.05, 0.15, 1.0, 1.1);
  // same crossing shape one period (2.0 s) later
  m.record(-0.05, 0.15, 3.0, 3.1);
  assert.ok(Math.abs(m.measuredPeriod - 2.0) < 1e-9);
});

test("PeriodMeasurer ignores opposite-direction crossings", () => {
  const m = new PeriodMeasurer();
  m.record(-0.1, 0.1, 0, 0.1); // counts
  m.record(0.1, -0.1, 0.5, 0.6); // wrong direction: ignored
  assert.equal(m.crossings, 1);
});

test("PeriodMeasurer.reset() clears the stale measurement", () => {
  const m = new PeriodMeasurer();
  m.record(-0.1, 0.1, 0, 0.1);
  m.record(-0.1, 0.1, 2.0, 2.1);
  assert.ok(m.measuredPeriod > 0);
  m.reset();
  assert.equal(m.measuredPeriod, 0);
  assert.equal(m.crossings, 0);
});

test("measured period from simulation matches the corrected theory", () => {
  const theta0 = 0.5; // rad, large enough for the correction to matter
  const dt = 0.0005;
  const measurer = new PeriodMeasurer();
  let prevTheta = theta0;
  let prevTime = 0;
  simulate(theta0, 0, 6 * correctedPeriod(L, G, theta0), dt, (theta, _omega, time) => {
    measurer.record(prevTheta, theta, prevTime, time);
    prevTheta = theta;
    prevTime = time;
  });
  const theory = correctedPeriod(L, G, theta0);
  const relErr = Math.abs(measurer.measuredPeriod - theory) / theory;
  assert.ok(
    relErr < 0.005,
    `measured ${measurer.measuredPeriod}s vs theory ${theory}s (rel err ${relErr})`
  );
});

// ============================================
// Damped energy decay
// ============================================

test("undamped simulation conserves total energy", () => {
  const theta0 = 0.6;
  const dt = 0.001;
  const E0 = pendulumTotalEnergy(M, G, L, theta0, 0);
  let maxDrift = 0;
  simulate(theta0, 0, 10, dt, (theta, omega) => {
    const E = pendulumTotalEnergy(M, G, L, theta, omega);
    maxDrift = Math.max(maxDrift, Math.abs(E - E0) / E0);
  });
  assert.ok(maxDrift < 1e-4, `energy drift ${maxDrift}`);
});

test("damping > 0 makes total energy decrease monotonically toward zero", () => {
  const theta0 = 0.8;
  const damping = 0.05;
  const dt = 0.001;
  const E0 = pendulumTotalEnergy(M, G, L, theta0, 0);
  let prevE = E0;
  let maxIncrease = 0;
  const { theta, omega } = simulate(theta0, damping, 20, dt, (th, om) => {
    const E = pendulumTotalEnergy(M, G, L, th, om);
    maxIncrease = Math.max(maxIncrease, E - prevE);
    prevE = E;
  });
  const EEnd = pendulumTotalEnergy(M, G, L, theta, omega);

  // No step may increase the energy (beyond tiny numerical noise)
  assert.ok(maxIncrease < 1e-6 * E0, `energy increased by ${maxIncrease}`);
  // Energy must visibly decay (envelope ~ e^(-b·t): e^(-1) ≈ 0.37 here)
  assert.ok(EEnd < 0.5 * E0, `E went ${E0} -> ${EEnd}`);
  assert.ok(EEnd >= 0);
});

test("stronger damping drains energy faster", () => {
  const theta0 = 0.8;
  const dt = 0.001;
  const weak = simulate(theta0, 0.01, 10, dt);
  const strong = simulate(theta0, 0.08, 10, dt);
  const eWeak = pendulumTotalEnergy(M, G, L, weak.theta, weak.omega);
  const eStrong = pendulumTotalEnergy(M, G, L, strong.theta, strong.omega);
  assert.ok(eStrong < eWeak, `strong ${eStrong} should be < weak ${eWeak}`);
});

test("KE + PE add up to the total energy", () => {
  const theta = 0.7;
  const omega = 1.3;
  const sum = pendulumKE(M, L, omega) + pendulumPE(M, G, L, theta);
  assert.ok(Math.abs(pendulumTotalEnergy(M, G, L, theta, omega) - sum) < 1e-12);
});
