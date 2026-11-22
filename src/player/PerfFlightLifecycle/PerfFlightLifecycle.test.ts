// Flight-lifecycle tests for the perf bhop-assist air-speed ceiling.
//
// The ceiling (AirMove.applyAirSpeedCeiling) may only squeeze a flight that
// never touched a surf ramp. The mark that remembers "this flight hit a ramp"
// (surfedSinceGrounded) must be scoped EXACTLY to one flight segment:
//
//   opened by any takeoff  — real jump (manual or autobhop) or ladder jump-off
//   closed by a real ground landing, respawn(), or an input reset
//
// A second, landing-scoped mark (landingFromSurf) feeds the perfect-bhop
// carry gate in Jump.ts: a landing that came off a ramp never qualifies as a
// perfect hop, however well timed it was. The landing bookkeeping
// (landingVelocity / groundTicksSinceLanding) likewise must never carry the
// previous flight's speed into a new one across respawns, multi-frame
// landings, or mid-flight perf toggles.

import { describe, expect, it } from 'vitest';
import { vec3 } from '../../math/vec3';
import { World } from '../../physics/World/World';
import { brushFromAABB, brushFromOrientedBox } from '../../physics/Collision/Collision';
import type { LadderVolume } from '../../physics/Collision/Collision.types';
import { PlayerController } from '../PlayerController';
import { DEFAULT_SETTINGS } from '../../settings/Settings';
import type { Settings } from '../../settings/Settings';
import { AIR_SPEED_CEILING_SOFTNESS } from '../../physics/PerfBonus/PerfBonus.config';

const DT = 1 / 128;

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...overrides };
}

/** Flat floor world, floor at y = 0. */
function floorWorld(): World {
  const world = new World();
  world.solids.push(brushFromAABB(vec3(-8192, -64, -8192), vec3(8192, 0, 8192)));
  return world;
}

/** Flat floor plus the 60° oriented ramp reused from the Jump surf tests. */
function surfWorld(): World {
  const world = floorWorld();
  const ax = vec3(1, 0, 0);
  const ay = vec3(0, 0.5, Math.sqrt(1 - 0.25));
  const az = vec3(0, -Math.sqrt(1 - 0.25), 0.5); // ax × ay
  world.solids.push(brushFromOrientedBox(vec3(0, 600, 0), vec3(400, 20, 400), ax, ay, az));
  return world;
}

/** Wall at x 100 with a west-facing ladder volume in front of it. */
function ladderWorld(): World {
  const world = floorWorld();
  world.solids.push(brushFromAABB(vec3(100, 0, -200), vec3(164, 600, 200))); // wall
  const volume: LadderVolume = {
    ...brushFromAABB(vec3(60, 0, -24), vec3(100, 600, 24)),
    facing: vec3(-1, 0, 0),
  };
  world.ladders.push(volume);
  return world;
}

function run(player: PlayerController, ticks: number, perTick?: () => void): void {
  for (let i = 0; i < ticks; i++) {
    perTick?.();
    player.tick(DT);
  }
}

function tickUntilGrounded(player: PlayerController, cap = 4096): void {
  let guard = 0;
  while (!player.onGround && guard++ < cap) player.tick(DT);
  expect(player.onGround).toBe(true);
}

/**
 * The soft ceiling asymptotically approaches maxAirSpeed + SOFTNESS, so any
 * genuinely capped flight must stay a little under that bound.
 */
function hardCeiling(settings: Settings): number {
  return settings.perf.maxAirSpeed + AIR_SPEED_CEILING_SOFTNESS;
}

describe('perf air-speed ceiling: ordinary bhop chains stay capped', () => {
  it('autobhop chain never exceeds maxAirSpeed plus the soft tolerance, and carries no surf mark', () => {
    const settings = makeSettings({ autobhop: true, perf: { enabled: true, maxAirSpeed: 390 } });
    const player = new PlayerController(floorWorld(), settings, vec3(0, 5, 0));
    player.input.forward = true;
    run(player, 128);
    player.input.forward = false;
    player.input.right = true;
    player.input.jump = true;

    let peak = 0;
    run(player, 1024, () => {
      player.yaw -= 0.8; // steady air-strafe turn, exactly like the vanilla chain test
      peak = Math.max(peak, player.horizontalSpeed);
      // No ramp exists in this world at all — the flight mark must never arm.
      expect(player.surfedSinceGrounded).toBe(false);
      expect(player.landingFromSurf).toBe(false);
    });
    expect(peak).toBeGreaterThan(DEFAULT_SETTINGS.runSpeed); // sanity: a real chain happened
    expect(peak).toBeLessThan(hardCeiling(settings));
  });

  it('a long chain of manual instant-rejump hops stays under the ceiling every airborne tick', () => {
    const settings = makeSettings({ autobhop: false, perf: { enabled: true, maxAirSpeed: 390 } });
    const player = new PlayerController(floorWorld(), settings, vec3(0, 5, 0));

    // One ordinary jump first, purely so hasJumpedBefore becomes true.
    while (!player.onGround) player.tick(DT);
    player.input.jump = true;
    player.tick(DT);
    player.input.jump = false;
    tickUntilGrounded(player);

    let maxSpeedEver = 0;
    for (let cycle = 0; cycle < 40; cycle++) {
      player.input.right = true;
      player.input.jump = true;
      player.tick(DT); // instant rejump from the previous landing
      player.input.jump = false;
      while (!player.onGround) {
        player.yaw -= 3;
        player.tick(DT);
        maxSpeedEver = Math.max(maxSpeedEver, player.horizontalSpeed);
        expect(player.surfedSinceGrounded).toBe(false);
      }
      player.input.right = false;
    }
    expect(maxSpeedEver).toBeGreaterThan(DEFAULT_SETTINGS.runSpeed * 1.2);
    expect(maxSpeedEver).toBeLessThan(hardCeiling(settings));
  });
});

describe('perf air-speed ceiling: a surf ramp exempts the rest of that flight', () => {
  it('the flight mark arms on the ramp, stays armed after leaving it, and closes on landing', () => {
    const settings = makeSettings({ autobhop: true, perf: { enabled: true, maxAirSpeed: 390 } });
    const player = new PlayerController(surfWorld(), settings, vec3(0, 2000, 0));
    player.input.right = true;

    let sawSurf = false;
    let peakDuringFlight = 0;
    let guard = 0;
    while (guard++ < 4096) {
      player.yaw -= 3;
      player.tick(DT);
      if (player.surfing) sawSurf = true;
      if (player.onGround) break; // touchdown ends the flight on this very tick
      if (sawSurf) {
        // From the first ramp touch until touchdown the flight is exempt —
        // including airborne ticks after the ramp is already behind us.
        expect(player.surfedSinceGrounded).toBe(true);
        peakDuringFlight = Math.max(peakDuringFlight, player.horizontalSpeed);
      }
    }
    expect(sawSurf).toBe(true); // sanity: this really rode the ramp
    expect(player.onGround).toBe(true);
    expect(peakDuringFlight).toBeGreaterThan(settings.perf.maxAirSpeed * 1.3); // uncapped

    // The flight ends exactly at touchdown: flight mark closed, landing fact
    // captured for the perfect-bhop gate.
    expect(player.surfedSinceGrounded).toBe(false);
    expect(player.landingFromSurf).toBe(true);
  });

  it('the next flight after a surf landing is capped again — a real jump re-arms a clean flight', () => {
    const settings = makeSettings({ autobhop: true, perf: { enabled: true, maxAirSpeed: 390 } });
    const player = new PlayerController(surfWorld(), settings, vec3(0, 2000, 0));
    player.input.right = true;
    while (!player.onGround) {
      player.yaw -= 3;
      player.tick(DT);
    }
    expect(player.landingFromSurf).toBe(true);

    // One grounded settle tick (friction/nopre bleed the surf speed down on
    // the ground — the landing-scoped fact intentionally survives it), then
    // launch the next flight with jump held.
    player.tick(DT);
    expect(player.onGround).toBe(true);
    expect(player.landingFromSurf).toBe(true);
    player.input.jump = true;
    player.tick(DT);
    expect(player.onGround).toBe(false);
    expect(player.surfedSinceGrounded).toBe(false);
    expect(player.landingFromSurf).toBe(false);

    // Drop into open air far from any ramp and keep strafing — this flight
    // never touches a slope, so the ceiling must squeeze it back down.
    player.input.right = true;
    player.origin = vec3(3000, 2000, 3000);
    player.onGround = false;
    let peak = 0;
    for (let i = 0; i < 600; i++) {
      player.yaw -= 3;
      player.tick(DT);
      expect(player.surfedSinceGrounded).toBe(false);
      peak = Math.max(peak, player.horizontalSpeed);
    }
    expect(peak).toBeLessThan(hardCeiling(settings));
  });

  it('walking off into open air (no jump) after a surf landing is also capped — no residual exemption', () => {
    const settings = makeSettings({ autobhop: true, perf: { enabled: true, maxAirSpeed: 390 } });
    const player = new PlayerController(surfWorld(), settings, vec3(0, 2000, 0));
    player.input.right = true;
    while (!player.onGround) {
      player.yaw -= 3;
      player.tick(DT);
    }
    expect(player.landingFromSurf).toBe(true);
    player.input.right = false;
    player.input.jump = false; // deliberately NOT jumping

    // Begin a new flight without checkJump ever firing — a walk-off takeoff.
    player.origin = vec3(-3000, 2000, 3000);
    player.onGround = false;
    for (let i = 0; i < 600; i++) {
      player.tick(DT);
      // This is a new, ramp-free flight: no exemption may survive the landing.
      expect(player.surfedSinceGrounded).toBe(false);
      expect(player.horizontalSpeed).toBeLessThan(hardCeiling(settings));
    }
  });
});

describe('perf flight state: respawn and input reset restore the initial state', () => {
  function surfedPlayer(settings: Settings): PlayerController {
    const player = new PlayerController(surfWorld(), settings, vec3(0, 2000, 0));
    player.input.right = true;
    while (!player.onGround) {
      player.yaw -= 3;
      player.tick(DT);
    }
    expect(player.landingFromSurf).toBe(true);
    return player;
  }

  function expectCleanState(player: PlayerController): void {
    expect(player.surfing).toBe(false);
    expect(player.surfedSinceGrounded).toBe(false);
    expect(player.landingFromSurf).toBe(false);
    expect(player.landingVelocity.x).toBe(0);
    expect(player.landingVelocity.y).toBe(0);
    expect(player.landingVelocity.z).toBe(0);
    expect(player.groundTicksSinceLanding).toBe(0);
    expect(player.hasJumpedBefore).toBe(false);
    expect(player.lastHopQuality).toBeNull();
  }

  it('respawn() clears every surf/landing mark and the landing velocity snapshot', () => {
    const settings = makeSettings({ perf: { enabled: true, maxAirSpeed: 390 } });
    const player = surfedPlayer(settings);
    player.respawn();
    expectCleanState(player);
  });

  it('an input reset routed through tick() reaches the same clean initial state', () => {
    const settings = makeSettings({ perf: { enabled: true, maxAirSpeed: 390 } });
    const player = surfedPlayer(settings);
    player.input.reset = true;
    player.tick(DT);
    expect(player.input.reset).toBe(false);
    expectCleanState(player);
  });

  it('a jump immediately after respawn starts a capped flight — no carried-over surf exemption', () => {
    const settings = makeSettings({ autobhop: false, perf: { enabled: true, maxAirSpeed: 390 } });
    const player = surfedPlayer(settings);
    player.respawn();

    // Settle onto the floor below the spawn point, then take a normal jump.
    tickUntilGrounded(player);
    player.input.right = true;
    player.input.jump = true;
    player.tick(DT);
    expect(player.onGround).toBe(false);
    expect(player.surfedSinceGrounded).toBe(false);

    // A long ramp-free flight is squeezed under the ceiling the whole way.
    player.input.right = true;
    player.origin = vec3(3000, 2000, -3000);
    player.onGround = false;
    let peak = 0;
    for (let i = 0; i < 600; i++) {
      player.yaw -= 3;
      player.tick(DT);
      peak = Math.max(peak, player.horizontalSpeed);
      expect(player.surfedSinceGrounded).toBe(false);
    }
    expect(peak).toBeLessThan(hardCeiling(settings));
  });
});

describe('perf flight state: toggling perf.enabled mid-flight neither jumps speed nor leaks the exemption', () => {
  it('off -> on in a ramp-free flight never raises speed and re-applies the ceiling', () => {
    const settings = makeSettings({ autobhop: false, perf: { enabled: true, maxAirSpeed: 390 } });
    const player = new PlayerController(new World(), settings, vec3(0, 0, 0));
    // Well above the ceiling, perfectly horizontal so gravity alone can't
    // change the 2D speed being measured.
    player.velocity = vec3(600, 0, 0);

    // Cap active: the first tick squeezes the speed down.
    player.tick(DT);
    const speedWhileEnabled = player.horizontalSpeed;
    expect(speedWhileEnabled).toBeLessThan(600);

    // Disable mid-flight: no cap, no input — horizontal speed stays exactly
    // where it was (air accel only ever adds along wishdir; there is none).
    settings.perf.enabled = false;
    for (let i = 0; i < 32; i++) {
      player.tick(DT);
      expect(player.horizontalSpeed).toBeCloseTo(speedWhileEnabled, 9);
      expect(player.surfedSinceGrounded).toBe(false);
    }

    // Re-enable: the cap may only ever scale velocity DOWN, never up...
    settings.perf.enabled = true;
    const speedAtReenable = player.horizontalSpeed;
    for (let i = 0; i < 64; i++) {
      player.tick(DT);
      expect(player.horizontalSpeed).toBeLessThanOrEqual(speedAtReenable + 1e-9);
      expect(player.surfedSinceGrounded).toBe(false);
    }
    // ...and the flight ends up back under the soft ceiling.
    expect(player.horizontalSpeed).toBeLessThan(hardCeiling(settings));
  });

  it('off -> on while air-strafing never arms the surf mark in a ramp-free world', () => {
    const settings = makeSettings({ autobhop: false, perf: { enabled: true, maxAirSpeed: 390 } });
    const player = new PlayerController(new World(), settings, vec3(0, 0, 0));
    player.velocity = vec3(300, 0, 0);
    player.input.right = true;

    settings.perf.enabled = false;
    for (let i = 0; i < 64; i++) {
      player.yaw -= 3;
      player.tick(DT);
    }

    settings.perf.enabled = true;
    for (let i = 0; i < 256; i++) {
      player.yaw -= 3;
      player.tick(DT);
      expect(player.surfedSinceGrounded).toBe(false);
      expect(player.surfing).toBe(false);
    }
    // No exemption leaked in: with the cap active every airborne tick, even
    // ongoing air-strafe gain can't push the chain past the soft ceiling.
    expect(player.horizontalSpeed).toBeLessThan(hardCeiling(settings));
  });
});

describe('perf flight state: a ladder jump-off opens a fresh, capped flight', () => {
  it('clears a stale surf mark at the jump-off and caps the resulting ramp-free flight', () => {
    const settings = makeSettings({ perf: { enabled: true, maxAirSpeed: 390 } });
    const player = new PlayerController(ladderWorld(), settings, vec3(70, 5, 0));
    player.yaw = -90;
    player.input.forward = true;
    run(player, 64);
    expect(player.onLadder).not.toBeNull();

    // Simulate the residue a previous surf flight would leave behind (e.g.
    // the player reached the ladder after riding a ramp): the jump-off must
    // not inherit it.
    player.surfedSinceGrounded = true;
    player.landingFromSurf = true;

    player.input.forward = false;
    player.input.jump = true;
    player.tick(DT);
    expect(player.onLadder).toBeNull();
    expect(player.surfedSinceGrounded).toBe(false);
    expect(player.landingFromSurf).toBe(false);

    // Continue in open air, never touching a ramp: ceiling stays active.
    player.origin = vec3(-400, 500, 0);
    player.onGround = false;
    for (let i = 0; i < 600; i++) {
      player.tick(DT);
      expect(player.surfedSinceGrounded).toBe(false);
      expect(player.horizontalSpeed).toBeLessThan(hardCeiling(settings));
    }
  });
});

describe('perf perfect-bhop: landing quantities stay self-consistent', () => {
  it('a multi-frame landing snapshots the landing velocity once and counts ground ticks from zero', () => {
    const settings = makeSettings({ autobhop: false, perf: { enabled: true, maxAirSpeed: 10000 } });
    const player = new PlayerController(floorWorld(), settings, vec3(0, 3000, 0));
    player.input.right = true;
    tickUntilGrounded(player);

    // First grounded tick: fresh landing bookkeeping.
    expect(player.groundTicksSinceLanding).toBe(0);
    const snap = vec3(player.landingVelocity.x, player.landingVelocity.y, player.landingVelocity.z);

    // Stay grounded for several more ticks — friction bleeds the live
    // velocity, but the snapshot and the "ticks since landing" counter must
    // advance coherently rather than re-snapshotting.
    player.input.right = false;
    for (let i = 1; i <= 5; i++) {
      player.tick(DT);
      expect(player.onGround).toBe(true);
      expect(player.groundTicksSinceLanding).toBe(i);
      expect(player.landingVelocity.x).toBe(snap.x);
      expect(player.landingVelocity.z).toBe(snap.z);
    }
  });

  it('a surf landing records landingFromSurf, and the instant rejump is normal (no perfect carry)', () => {
    const settings = makeSettings({ autobhop: false, perf: { enabled: true, maxAirSpeed: 10000 } });
    const player = new PlayerController(surfWorld(), settings, vec3(0, 5, 0));

    // Prime hasJumpedBefore with an ordinary jump on the floor.
    while (!player.onGround) player.tick(DT);
    player.input.jump = true;
    player.tick(DT);
    player.input.jump = false;
    tickUntilGrounded(player);
    run(player, 64);

    // Surf flight ending in a real landing on the floor.
    player.origin = vec3(0, 2000, 0);
    player.onGround = false;
    player.input.right = true;
    let sawSurf = false;
    while (!player.onGround) {
      player.yaw -= 3;
      player.tick(DT);
      if (player.surfing) sawSurf = true;
    }
    expect(sawSurf).toBe(true);
    expect(player.landingFromSurf).toBe(true);
    const landingSpeed = player.horizontalSpeed;

    // The tick-right-after-landing rejump would otherwise be perfect.
    player.input.right = false;
    player.input.jump = true;
    player.tick(DT);
    expect(player.lastHopQuality).toBe('normal');
    expect(player.horizontalSpeed).toBeLessThan(landingSpeed - 1);
    // Takeoff consumed the landing fact and opened a clean flight.
    expect(player.landingFromSurf).toBe(false);
    expect(player.surfedSinceGrounded).toBe(false);
  });

  it('respawn zeroes the landing snapshot, so no previous-flight speed can be carried into a new hop', () => {
    const settings = makeSettings({ autobhop: false, perf: { enabled: true, maxAirSpeed: 10000 } });
    const player = new PlayerController(floorWorld(), settings, vec3(0, 3000, 0));
    player.input.right = true;
    tickUntilGrounded(player);
    expect(player.landingVelocity.x).not.toBe(0); // a real snapshot exists

    player.respawn();
    expect(player.landingVelocity.x).toBe(0);
    expect(player.landingVelocity.z).toBe(0);
    expect(player.groundTicksSinceLanding).toBe(0);

    // The first jump of the new life can't chain anything: hasJumpedBefore
    // was reset and the landing snapshot was zeroed, so however fast the
    // previous (surf) flight was, this takeoff is an ordinary 'normal' hop —
    // never a 'perfect' carry of stale speed.
    tickUntilGrounded(player);
    player.input.jump = true;
    player.tick(DT);
    expect(player.onGround).toBe(false);
    expect(player.lastHopQuality).toBe('normal');
    expect(player.hasJumpedBefore).toBe(true);
    expect(player.horizontalSpeed).toBeLessThan(
      DEFAULT_SETTINGS.runSpeed * 1.1 + 1,
    ); // plain takeoff, no carried surf speed
  });

  it('toggling perf mid-flight does not corrupt the landing snapshot used by the next carry', () => {
    const settings = makeSettings({ autobhop: false, perf: { enabled: true, maxAirSpeed: 10000 } });
    const player = new PlayerController(floorWorld(), settings, vec3(0, 5, 0));

    // Prime with one ordinary jump.
    while (!player.onGround) player.tick(DT);
    player.input.jump = true;
    player.tick(DT);
    player.input.jump = false;
    tickUntilGrounded(player);
    run(player, 64);

    // Ramp-free drop; flip perf off, then back on, while still airborne.
    player.origin = vec3(0, 3000, 0);
    player.onGround = false;
    player.input.right = true;
    for (let i = 0; i < 64; i++) {
      player.yaw -= 3;
      if (i === 20) settings.perf.enabled = false;
      if (i === 44) settings.perf.enabled = true;
      player.tick(DT);
    }
    while (!player.onGround) {
      player.yaw -= 3;
      player.tick(DT);
    }
    expect(player.landingFromSurf).toBe(false);
    const landingSpeed = player.horizontalSpeed;

    // Instant rejump: ordinary landing, tick 0 — a genuine perfect carry,
    // restoring exactly the speed this flight landed with.
    player.input.right = false;
    player.input.jump = true;
    player.tick(DT);
    expect(player.lastHopQuality).toBe('perfect');
    expect(player.horizontalSpeed).toBeCloseTo(landingSpeed, 6);
  });
});
