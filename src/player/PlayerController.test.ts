// Headless integration tests: run the full PlayerController pipeline against
// a tiny brush world and assert emergent CS:GO behaviors (landing, ground
// speed cap, autobhop air-strafe gain, the vanilla no-pogo rule), plus the
// ramp-base regression that doesn't map to a single behavior folder.

import { describe, expect, it } from 'vitest';
import { vec3 } from '../math/vec3';
import { World } from '../physics/World/World';
import { brushFromAABB, brushFromOrientedBox } from '../physics/Collision/Collision';
import { PlayerController } from './PlayerController';
import { DEFAULT_SETTINGS } from '../settings/Settings';
import type { Settings } from '../settings/Settings';

const DT = 1 / 128;

function makeWorld(): World {
  const world = new World();
  world.solids.push(brushFromAABB(vec3(-8192, -64, -8192), vec3(8192, 0, 8192)));
  return world;
}

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...overrides };
}

function run(player: PlayerController, ticks: number, perTick?: () => void): void {
  for (let i = 0; i < ticks; i++) {
    perTick?.();
    player.tick(DT);
  }
}

describe('PlayerController', () => {
  it('falls, lands, and comes to rest on the floor', () => {
    const player = new PlayerController(makeWorld(), makeSettings(), vec3(0, 100, 0));
    run(player, 256);
    expect(player.onGround).toBe(true);
    expect(player.origin.y).toBeLessThan(0.1);
    expect(player.horizontalSpeed).toBe(0);
  });

  it('caps ground speed at runSpeed', () => {
    const player = new PlayerController(makeWorld(), makeSettings(), vec3(0, 5, 0));
    player.input.forward = true;
    run(player, 512); // 4 seconds
    expect(player.horizontalSpeed).toBeGreaterThan(245);
    expect(player.horizontalSpeed).toBeLessThanOrEqual(250.001);
  });

  it('walk and crouch use their flat speed values', () => {
    const walker = new PlayerController(makeWorld(), makeSettings(), vec3(0, 5, 0));
    walker.input.forward = true;
    walker.input.walk = true;
    run(walker, 512);
    expect(walker.horizontalSpeed).toBeCloseTo(130, 0);

    const croucher = new PlayerController(makeWorld(), makeSettings(), vec3(0, 5, 0));
    croucher.input.forward = true;
    croucher.input.duck = true;
    run(croucher, 512);
    expect(croucher.ducked).toBe(true);
    expect(croucher.horizontalSpeed).toBeCloseTo(85, 0);
  });

  it('bhop speed clamp holds autobhop cruising speed near 1.1 × maxspeed', () => {
    // noPrestrafe is exercised separately (AirMove.test.ts); disabled here so
    // this test isolates bhopSpeedClamp's own takeoff-clamp + air-strafe
    // interaction, same as before that setting existed.
    const player = new PlayerController(makeWorld(), makeSettings({ noPrestrafe: false }), vec3(0, 5, 0));
    player.input.forward = true;
    run(player, 128);
    player.input.forward = false;
    player.input.right = true;
    player.input.jump = true;
    let peak = 0;
    run(player, 1024, () => {
      player.yaw -= 0.8; // steady air-strafe turn
      peak = Math.max(peak, player.horizontalSpeed);
    });
    // Takeoffs clamp to 275; only modest in-air gain on top of that is
    // possible before the next landing re-clamps.
    expect(peak).toBeGreaterThan(250);
    expect(peak).toBeLessThan(340);
  });

  it('gains speed without bound when the clamp is disabled', () => {
    const player = new PlayerController(
      makeWorld(),
      makeSettings({ bhopSpeedClamp: false, noPrestrafe: false }),
      vec3(0, 5, 0),
    );
    player.input.forward = true;
    run(player, 128);
    player.input.forward = false;
    player.input.right = true;
    player.input.jump = true;
    run(player, 512, () => {
      player.yaw -= 0.8;
    });
    expect(player.horizontalSpeed).toBeGreaterThan(300);
  });

  it('does not pogo when autobhop is off and jump is held', () => {
    const player = new PlayerController(makeWorld(), makeSettings({ autobhop: false }), vec3(0, 5, 0));
    run(player, 64); // settle on the ground
    player.input.jump = true;
    run(player, 128); // first press jumps...
    run(player, 256); // ...but by now we've landed again, still holding jump
    expect(player.onGround).toBe(true);
    expect(player.velocity.y).toBe(0);
  });

  it('jump reaches ~57 units above the floor', () => {
    const player = new PlayerController(makeWorld(), makeSettings(), vec3(0, 5, 0));
    run(player, 64);
    player.input.jump = true;
    let apex = 0;
    run(player, 200, () => {
      apex = Math.max(apex, player.origin.y);
    });
    expect(apex).toBeGreaterThan(55.5);
    expect(apex).toBeLessThan(58);
  });
});

// Ramp-base regression, from a live bug report: standing at (-1680, 10, -783)
// — the base of the west wall-ride — the player froze on the ramp's
// hull-expanded face with velocity climbing (the femto-fraction trace bug).
// With that fixed, the base must behave like authentic Source: at worst a
// brief ungrounded slide off the expanded face, resolving to rest on the
// floor — never a runaway.
describe('ramp base', () => {
  /** West wall-ride: ramp(-1663, 0, 270, 52, 2800, 300), sink 32 — no curb. */
  function westRingWorld(): World {
    const world = new World();
    world.solids.push(brushFromAABB(vec3(-2048, -64, -2048), vec3(2048, 0, 2048))); // ground
    world.solids.push(brushFromAABB(vec3(-2112, 0, -2048), vec3(-2048, 512, 2048))); // wall

    const tilt = (52 * Math.PI) / 180;
    const ax = vec3(0, 0, 1);
    const ay = vec3(Math.sin(tilt), Math.cos(tilt), 0);
    const az = vec3(-Math.cos(tilt), Math.sin(tilt), 0);
    const L = 300;
    const foot = vec3(-1663, -32, 0);
    const center = vec3(
      foot.x + az.x * (L / 2) - ay.x * 8,
      foot.y + az.y * (L / 2) - ay.y * 8,
      foot.z + az.z * (L / 2) - ay.z * 8,
    );
    world.solids.push(brushFromOrientedBox(center, vec3(1400, 8, L / 2), ax, ay, az));
    return world;
  }

  it('resolves the reported phantom-hover spot to grounded control', () => {
    const world = westRingWorld();
    const player = new PlayerController(world, structuredClone(DEFAULT_SETTINGS), vec3(-1680, 10, -783));

    let peak = 0;
    for (let i = 0; i < 512; i++) {
      player.tick(DT);
      peak = Math.max(peak, Math.hypot(player.velocity.x, player.velocity.y, player.velocity.z));
    }
    // No runaway: with no input, the player comes to rest on solid ground.
    expect(peak).toBeLessThan(300);
    expect(player.onGround).toBe(true);
    expect(player.horizontalSpeed).toBeLessThan(5);
    expect(world.isPositionFree(player.origin, player.mins, player.maxs)).toBe(true);
  });

  it('pressing into the base surfs the face with bounded speed, then settles', () => {
    const world = westRingWorld();
    const player = new PlayerController(world, structuredClone(DEFAULT_SETTINGS), vec3(-1600, 2, -783));
    player.yaw = 90; // face -x, toward the ramp
    player.input.forward = true;

    // Holding into a surf face pins you on it (that's how surfing works) —
    // the invariant is that speed stays bounded, never a runaway.
    for (let i = 0; i < 256; i++) {
      player.tick(DT);
      expect(Math.hypot(player.velocity.x, player.velocity.y, player.velocity.z)).toBeLessThan(500);
    }

    // Release: slide off, land, and come to rest under friction.
    player.input.forward = false;
    for (let i = 0; i < 384; i++) player.tick(DT);
    expect(player.onGround).toBe(true);
    expect(player.horizontalSpeed).toBeLessThan(100);
  });
});

// "Build speed in the air, cash it in on the ground": AirMove is free to
// accumulate speed (prestrafe / air-strafe / bhop chains), and the ground
// clamp in WalkMove is what brings it back to the posture's ceiling. These
// tests pin that contract for the three flight/landing shapes — ordinary
// air-strafe, duck-walking, and surf — and verify the externally observable
// speedBreakdown() / airSpeedCapActive seams.
describe('air speed cap and speedBreakdown', () => {
  it('ordinary air-strafe gain is cashed down to runSpeed with cappedBy ground', () => {
    const player = new PlayerController(makeWorld(), makeSettings(), vec3(0, 3000, 0));
    player.input.right = true;
    let peakAirborne = 0;
    for (let i = 0; i < 2048 && !player.onGround; i++) {
      player.yaw -= 3; // steady air-strafe turn
      player.tick(DT);
      peakAirborne = Math.max(peakAirborne, player.horizontalSpeed);
    }
    expect(peakAirborne).toBeGreaterThan(DEFAULT_SETTINGS.runSpeed * 1.5); // sanity: real air gain happened
    expect(player.onGround).toBe(true);
    player.input.right = false;

    // The landing tick only categorizes; WalkMove runs on the next one. Watch
    // a few ticks so the clamp is observed rather than assumed.
    let sawGroundCap = false;
    for (let i = 0; i < 8 && !sawGroundCap; i++) {
      player.tick(DT);
      const b = player.speedBreakdown();
      if (b.cappedBy === 'ground') {
        sawGroundCap = true;
        expect(b.maxGround).toBeCloseTo(DEFAULT_SETTINGS.runSpeed, 6);
        expect(b.horizontal).toBeCloseTo(DEFAULT_SETTINGS.runSpeed, 3);
      }
    }
    expect(sawGroundCap).toBe(true);
    expect(player.horizontalSpeed).toBeLessThanOrEqual(DEFAULT_SETTINGS.runSpeed + 0.01);
    expect(player.speedBreakdown().maxGround).toBeCloseTo(DEFAULT_SETTINGS.runSpeed, 6);
  });

  it('a duck-walk caps at crouchSpeed (85) and speedBreakdown().maxGround follows', () => {
    const player = new PlayerController(makeWorld(), makeSettings(), vec3(0, 5, 0));
    player.input.forward = true;
    player.input.duck = true;
    run(player, 256);
    expect(player.ducked).toBe(true);
    expect(player.duckFrac).toBe(1);

    // Arrive with carried speed above the crouch ceiling.
    player.velocity.x = 400;
    player.velocity.z = 0;
    player.tick(DT);

    const b = player.speedBreakdown();
    expect(b.maxGround).toBeCloseTo(DEFAULT_SETTINGS.crouchSpeed, 6);
    expect(b.maxGround).toBeCloseTo(85, 6);
    expect(b.cappedBy).toBe('ground');
    expect(b.horizontal).toBeCloseTo(DEFAULT_SETTINGS.crouchSpeed, 3);
    // The report agrees with the existing HUD field it mirrors.
    expect(b.horizontal).toBeCloseTo(player.horizontalSpeed, 6);
  });

  it('the ceiling and maxGround come from settings for every posture, not constants', () => {
    // stand / walk / duck, with values deliberately different from the
    // library defaults so this can only pass by reading `settings`.
    const cases: Array<{
      overrides: Partial<Settings>;
      input: Partial<PlayerController['input']>;
      carried: number;
    }> = [
      // The walk crop only applies while within WALK_CAP_LEEWAY (25 u/s) of
      // walk speed — that's existing currentMaxSpeed semantics, so the walk
      // case carries just above walkSpeed rather than a wild speed.
      { overrides: { runSpeed: 300 }, input: {}, carried: 500 },
      { overrides: { walkSpeed: 140 }, input: { walk: true }, carried: 150 },
      { overrides: { crouchSpeed: 95 }, input: { duck: true }, carried: 500 },
    ];
    for (const { overrides, input, carried } of cases) {
      const player = new PlayerController(makeWorld(), makeSettings(overrides), vec3(0, 5, 0));
      player.input.forward = true;
      Object.assign(player.input, input);
      run(player, 256);
      const expected = input.duck
        ? (overrides.crouchSpeed as number)
        : input.walk
          ? (overrides.walkSpeed as number)
          : (overrides.runSpeed as number);

      player.velocity.x = carried;
      player.velocity.z = 0;
      player.tick(DT);

      const b = player.speedBreakdown();
      expect(b.maxGround).toBeCloseTo(expected, 6);
      expect(b.cappedBy).toBe('ground');
      expect(b.horizontal).toBeCloseTo(expected, 3);
    }
  });

  it('while airborne with perf enabled the air ceiling reports cappedBy air', () => {
    const airborne = new PlayerController(
      new World(),
      makeSettings({ perf: { enabled: true, maxAirSpeed: 390 } }),
      vec3(0, 100, 0),
    );
    airborne.velocity.x = 800;
    airborne.tick(DT);
    const capped = airborne.speedBreakdown();
    expect(airborne.onGround).toBe(false);
    expect(airborne.airSpeedCapActive).toBe(true);
    expect(capped.cappedBy).toBe('air');
    expect(capped.horizontal).toBeGreaterThan(390); // soft ceiling, not a hard clamp...
    expect(capped.horizontal).toBeLessThan(800); // ...but it really bit

    const uncapped = new PlayerController(
      new World(),
      makeSettings({ perf: { enabled: false, maxAirSpeed: 390 } }),
      vec3(0, 100, 0),
    );
    uncapped.velocity.x = 800;
    uncapped.tick(DT);
    expect(uncapped.airSpeedCapActive).toBe(false);
    expect(uncapped.speedBreakdown().cappedBy).toBe('none');
    expect(uncapped.horizontalSpeed).toBeCloseTo(800, 6);
  });

  it('after a surf touch, air speed exceeds perf.maxAirSpeed and airSpeedCapActive is false', () => {
    const ax = vec3(1, 0, 0);
    const ay = vec3(0, 0.5, Math.sqrt(1 - 0.25));
    const az = vec3(0, -Math.sqrt(1 - 0.25), 0.5); // ax × ay
    const world = makeWorld();
    world.solids.push(brushFromOrientedBox(vec3(0, 600, 0), vec3(400, 20, 400), ax, ay, az));

    const settings = makeSettings({ perf: { enabled: true, maxAirSpeed: 390 } });
    const player = new PlayerController(world, settings, vec3(0, 2000, 0));
    player.input.right = true;

    let sawSurf = false;
    let capActiveBeforeSurf = false;
    let capActiveAfterSurf = false;
    let maxPostSurfAir = 0;
    for (let i = 0; i < 3000 && !player.onGround; i++) {
      player.yaw -= 3;
      player.tick(DT);
      if (player.surfing) sawSurf = true;
      if (player.onGround) break;
      if (player.surfedSinceGrounded) {
        if (player.airSpeedCapActive) capActiveAfterSurf = true;
        maxPostSurfAir = Math.max(maxPostSurfAir, player.horizontalSpeed);
      } else if (player.airSpeedCapActive) {
        capActiveBeforeSurf = true;
      }
    }
    expect(sawSurf).toBe(true); // sanity: this genuinely touched the surf ramp
    expect(capActiveBeforeSurf).toBe(true); // the ceiling really was live before the ramp
    expect(capActiveAfterSurf).toBe(false);
    expect(maxPostSurfAir).toBeGreaterThan(settings.perf.maxAirSpeed);

    // "Until the next real takeoff": a fresh jump ends that flight, so the
    // ceiling is live again on the very next airborne tick.
    expect(player.onGround).toBe(true);
    player.input.jump = true;
    player.tick(DT);
    expect(player.surfedSinceGrounded).toBe(false);
    expect(player.airSpeedCapActive).toBe(true);
  });
});
