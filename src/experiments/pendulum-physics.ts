// ============================================
// PENDULUM PHYSICS (pure, framework-free)
// Shared by the 3D scene and the unit tests.
// ============================================

/**
 * Large-angle period correction:
 *   T = T₀ × (1 + θ₀²/16 + 11θ₀⁴/3072)
 * where T₀ = 2π√(L/g) is the small-angle period.
 */
export function correctedPeriod(L: number, g: number, theta0: number): number {
  const T0 = 2 * Math.PI * Math.sqrt(L / g);
  const t2 = theta0 * theta0;
  const correction = 1 + t2 / 16 + (11 * t2 * t2) / 3072;
  return T0 * correction;
}

/** Theoretical frequency: reciprocal of the corrected period. */
export function theoreticalFrequency(L: number, g: number, theta0: number): number {
  return 1 / correctedPeriod(L, g, theta0);
}

/** Potential energy relative to the equilibrium (hanging straight down). */
export function pendulumPE(m: number, g: number, L: number, theta: number): number {
  return m * g * L * (1 - Math.cos(theta));
}

/** Kinetic energy of the bob. */
export function pendulumKE(m: number, L: number, omega: number): number {
  return 0.5 * m * L * L * omega * omega;
}

/** Total mechanical energy. */
export function pendulumTotalEnergy(
  m: number, g: number, L: number, theta: number, omega: number
): number {
  return pendulumKE(m, L, omega) + pendulumPE(m, g, L, theta);
}

// ============================================
// RK4 INTEGRATOR
// ============================================

/**
 * One RK4 step of the damped pendulum:
 *   θ' = ω
 *   ω' = -(g/L)·sin(θ) - b·ω
 */
export function rk4Step(
  theta: number, omega: number,
  g: number, L: number, b: number, dt: number
): [number, number] {
  const f = (th: number, om: number): [number, number] => {
    const dTheta = om;
    const dOmega = -(g / L) * Math.sin(th) - b * om;
    return [dTheta, dOmega];
  };

  const [k1a, k1b] = f(theta, omega);
  const [k2a, k2b] = f(theta + k1a * dt * 0.5, omega + k1b * dt * 0.5);
  const [k3a, k3b] = f(theta + k2a * dt * 0.5, omega + k2b * dt * 0.5);
  const [k4a, k4b] = f(theta + k3a * dt, omega + k3b * dt);

  const newTheta = theta + (dt / 6) * (k1a + 2 * k2a + 2 * k3a + k4a);
  const newOmega = omega + (dt / 6) * (k1b + 2 * k2b + 2 * k3b + k4b);
  return [newTheta, newOmega];
}

// ============================================
// ZERO-CROSSING PERIOD MEASURER
// ============================================

/**
 * Measures the pendulum period from the simulation itself by timing
 * consecutive same-direction zero crossings (θ: negative → non-negative,
 * i.e. the bob sweeping through the bottom moving in the +θ direction).
 *
 * The crossing time is linearly interpolated between the two samples so the
 * measured period is not quantized to the integration step.
 *
 * `measuredPeriod` stays 0 until two crossings have been seen; callers should
 * fall back to the theoretical period in that case. Call `reset()` whenever
 * the measurement must be restarted (simulation reset, or a change of length,
 * gravity or initial angle) so stale values are never reused.
 */
export class PeriodMeasurer {
  private lastCrossTime: number | null = null;
  measuredPeriod = 0;
  crossings = 0;

  /**
   * Record one integration sub-step.
   * @returns true when this step contained a same-direction zero crossing.
   */
  record(prevTheta: number, theta: number, prevTime: number, time: number): boolean {
    if (prevTheta < 0 && theta >= 0) {
      // Linear interpolation of the exact crossing instant.
      const frac = prevTheta / (prevTheta - theta);
      const crossTime = prevTime + (time - prevTime) * frac;
      if (this.lastCrossTime !== null) {
        this.measuredPeriod = crossTime - this.lastCrossTime;
      }
      this.lastCrossTime = crossTime;
      this.crossings++;
      return true;
    }
    return false;
  }

  /** Forget all crossings; the next measurement starts from scratch. */
  reset(): void {
    this.lastCrossTime = null;
    this.measuredPeriod = 0;
    this.crossings = 0;
  }
}
