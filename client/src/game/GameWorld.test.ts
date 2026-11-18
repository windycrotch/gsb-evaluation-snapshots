import { describe, expect, it } from "vitest";
import { GameWorld } from "./GameWorld";
import { STAGES, cloneStage, type StageData } from "./levelData";
import type { Checkpoint, Platform, Rect, Shard } from "./types";

const noop = () => {};

function makeContext(): CanvasRenderingContext2D {
  const gradient = { addColorStop: noop };
  return {
    imageSmoothingEnabled: false,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    globalAlpha: 1,
    clearRect: noop,
    fillRect: noop,
    strokeRect: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    closePath: noop,
    fill: noop,
    save: noop,
    restore: noop,
    translate: noop,
    scale: noop,
    createLinearGradient: () => gradient,
  } as unknown as CanvasRenderingContext2D;
}

const platform = (x: number, y: number, w: number, vx: number, minX: number, maxX: number): Platform => ({ x, y, w, h: 20, vx, minX, maxX });
const shard = (x: number, y: number): Shard => ({ x, y, w: 12, h: 16, collected: false, bob: 0 });
const checkpoint = (x: number, y: number): Checkpoint => ({ x, y, w: 16, h: 40, active: false });
const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

type StageOptions = {
  width?: number;
  spawn?: { x: number; y: number };
  solids?: Rect[];
  hazards?: Rect[];
  shards?: Shard[];
  checkpoints?: Checkpoint[];
  platforms?: Platform[];
  portal?: Rect;
};

function makeStage(options: StageOptions = {}): StageData {
  return {
    id: 1,
    name: "TEST RELAY",
    width: options.width ?? 1000,
    spawn: options.spawn ?? { x: 40, y: 274 },
    solids: options.solids ?? [rect(0, 300, options.width ?? 1000, 60)],
    hazards: options.hazards ?? [],
    shards: options.shards ?? [],
    enemies: [],
    checkpoints: options.checkpoints ?? [],
    platforms: options.platforms ?? [],
    portal: options.portal ?? rect((options.width ?? 1000) - 40, 238, 28, 62),
  };
}

function makeWorld(stages: StageData[]): GameWorld {
  const world = new GameWorld(makeContext(), { onHud: noop }, stages);
  world.start();
  return world;
}

/** Run fixed 60Hz frames; each tick advances exactly one simulation step. */
function frames(world: GameWorld, count: number) {
  for (let i = 0; i < count; i += 1) world.tick(1 / 60);
}

/** Spawn slightly above the platform so the first frames exercise a real landing. */
function spawnOnPlatform(platformY: number, platformX: number): { x: number; y: number } {
  return { x: platformX + 20, y: platformY - 26 - 1 };
}

describe("moving platform riding", () => {
  it("carries the player by exactly the platform delta each frame", () => {
    const moving = platform(200, 200, 80, 1, 150, 260);
    const world = makeWorld([makeStage({ platforms: [moving], spawn: spawnOnPlatform(200, 200) })]);
    frames(world, 2); // settle onto the platform
    expect(world.inspect().player.onGround).toBe(true);

    for (let i = 0; i < 10; i += 1) {
      const live = world.inspect();
      const platformX = live.stage.platforms[0].x;
      const playerX = live.player.x;
      frames(world, 1);
      expect(world.inspect().player.x).toBeCloseTo(playerX + (world.inspect().stage.platforms[0].x - platformX), 6);
    }
    // Positional carry must not fabricate horizontal velocity or drift.
    expect(world.inspect().player.vx).toBeCloseTo(0, 6);
    expect(world.inspect().player.onGround).toBe(true);
    expect(world.inspect().riding).not.toBeNull();
  });

  it("follows consecutive-frame reversals and leaves no residual drift", () => {
    const moving = platform(200, 200, 60, 1, 198, 202);
    const world = makeWorld([makeStage({ platforms: [moving], spawn: spawnOnPlatform(200, 200) })]);
    frames(world, 2);

    let travelledRight = false;
    let travelledLeft = false;
    for (let i = 0; i < 40; i += 1) {
      const live = world.inspect();
      const platformX = live.stage.platforms[0].x;
      const playerX = live.player.x;
      frames(world, 1);
      const dx = world.inspect().stage.platforms[0].x - platformX;
      if (dx > 0) travelledRight = true;
      if (dx < 0) travelledLeft = true;
      expect(world.inspect().player.x).toBeCloseTo(playerX + dx, 6);
    }
    expect(travelledRight).toBe(true);
    expect(travelledLeft).toBe(true);
    expect(world.inspect().player.vx).toBeCloseTo(0, 6);

    // The rider keeps a fixed offset from the platform across further reversals: no drift.
    const offset = world.inspect().player.x - world.inspect().stage.platforms[0].x;
    for (let i = 0; i < 20; i += 1) {
      frames(world, 1);
      const live = world.inspect();
      expect(live.player.x - live.stage.platforms[0].x).toBeCloseTo(offset, 6);
      expect(live.player.vx).toBeCloseTo(0, 6);
    }
  });

  it("does not squeeze the player through a solid block when carried", () => {
    // Platform travels right toward a wall that overlaps the player's vertical band.
    const wall = rect(300, 150, 40, 150);
    const moving = platform(240, 200, 80, 1, 200, 400);
    const world = makeWorld([
      makeStage({ platforms: [moving], solids: [rect(0, 300, 1000, 60), wall], spawn: { x: wall.x - 16 - 0.5, y: 174 } }),
    ]);
    frames(world, 30);

    const after = world.inspect();
    expect(after.player.x + after.player.w).toBeLessThanOrEqual(wall.x + 0.001);
    const embedded = after.player.x < wall.x + wall.w && after.player.x + after.player.w > wall.x && after.player.y < wall.y + wall.h && after.player.y + after.player.h > wall.y;
    expect(embedded).toBe(false);
    expect(after.player.y + after.player.h).toBeCloseTo(after.stage.platforms[0].y, 6);
  });

  it("clamps a carried player to the level bounds instead of dropping out of the world", () => {
    // The platform travels past the left edge; the rider must stop at x=0, not leave the level.
    const moving = platform(5, 200, 80, -1, -50, 10);
    const world = makeWorld([makeStage({ platforms: [moving], spawn: { x: 1, y: 174 } })]);
    frames(world, 20);
    const after = world.inspect();
    expect(after.player.x).toBeGreaterThanOrEqual(0);
    expect(after.player.x + after.player.w).toBeLessThanOrEqual(world.width + 0.001);
    expect(after.player.y + after.player.h).toBeCloseTo(after.stage.platforms[0].y, 6);
    expect(after.player.onGround).toBe(true);
  });

  it("keeps platform horizontal inertia after an edge jump and lands back on the platform", () => {
    const moving = platform(400, 200, 160, 1.4, 380, 540);
    // Spawn 2px inside the platform's right edge so this is a genuine edge jump.
    const world = makeWorld([makeStage({ platforms: [moving], width: 900, spawn: { x: 400 + 160 - 16 - 2, y: 174 } })]);
    frames(world, 2);
    expect(world.inspect().riding).not.toBeNull();

    const platformVx = world.inspect().stage.platforms[0].vx;
    world.setInput({ jump: true });
    frames(world, 1);
    const launched = world.inspect();
    expect(launched.player.onGround).toBe(false);
    expect(launched.player.vy).toBeLessThan(0);
    expect(launched.player.vx).toBeCloseTo(platformVx, 6);
    world.setInput({ jump: false });

    // Inertia must persist across the airborne arc (within the airborne speed cap).
    frames(world, 10);
    expect(world.inspect().player.vx).toBeGreaterThan(platformVx - 0.001);

    // The player should come back down onto the moving platform, not pass through it.
    let landed = false;
    for (let i = 0; i < 90; i += 1) {
      frames(world, 1);
      const current = world.inspect();
      if (current.player.onGround) {
        landed = true;
        expect(current.player.y + current.player.h).toBeCloseTo(current.stage.platforms[0].y, 6);
        break;
      }
    }
    expect(landed).toBe(true);
  });

  it("does not drag an airborne player when the platform reverses beneath them", () => {
    const moving = platform(200, 200, 80, 1, 198, 202);
    const world = makeWorld([makeStage({ platforms: [moving], spawn: spawnOnPlatform(200, 200) })]);
    frames(world, 2);
    world.setInput({ jump: true });
    frames(world, 1);
    world.setInput({ jump: false });

    const airborne = world.inspect();
    expect(airborne.player.onGround).toBe(false);
    const vxAtLaunch = airborne.player.vx;
    const xAtLaunch = airborne.player.x;

    // Let the platform bounce back and forth several times while the player is in the air.
    frames(world, 12);
    const later = world.inspect();
    expect(later.riding).toBeNull();
    // Horizontal motion is only the launched momentum, not the platform's deltas.
    expect(later.player.vx).toBeCloseTo(vxAtLaunch, 6);
    expect(later.player.x).toBeCloseTo(xAtLaunch + vxAtLaunch * 12, 6);
  });

  it("does not pass through a platform during a fast fall", () => {
    const moving = platform(200, 200, 80, 0, 200, 200);
    // Dropping ~600px reaches a per-frame displacement greater than the platform's height.
    const world = makeWorld([makeStage({ platforms: [moving], spawn: { x: 230, y: -400 } })]);
    frames(world, 90);
    const settled = world.inspect();
    expect(settled.player.y + settled.player.h).toBeCloseTo(settled.stage.platforms[0].y, 6);
    expect(settled.player.onGround).toBe(true);
  });
});

describe("checkpoint respawn", () => {
  it("returns to the activated checkpoint with reset velocity and facing", () => {
    const hazard = rect(170, 284, 30, 16);
    const start = checkpoint(85, 260);
    const world = makeWorld([makeStage({ checkpoints: [start], hazards: [hazard], spawn: { x: 80, y: 274 } })]);

    frames(world, 2);
    expect(world.inspect().stage.checkpoints[0].active).toBe(true);
    const activatedSpawn = world.inspect().spawn;
    expect(activatedSpawn.x).toBe(85 + 24);

    // Build leftward facing first, then run right into the hazard.
    world.setInput({ left: true });
    frames(world, 3);
    expect(world.inspect().player.facing).toBe(-1);
    world.setInput({ left: false, right: true });
    let hurt = false;
    for (let i = 0; i < 160; i += 1) {
      frames(world, 1);
      if (world.inspect().player.hurt > 0) { hurt = true; break; }
    }
    expect(hurt).toBe(true);
    const after = world.inspect();
    expect(after.lives).toBe(2);
    expect(after.player.x).toBe(activatedSpawn.x);
    expect(after.player.y).toBe(activatedSpawn.y);
    expect(after.player.vx).toBe(0);
    expect(after.player.vy).toBe(0);
    expect(after.player.facing).toBe(1);
    expect(after.player.onGround).toBe(false);
    expect(after.riding).toBeNull();
  });

  it("returns to the stage spawn when no checkpoint is active", () => {
    const hazard = rect(170, 284, 30, 16);
    const stage = makeStage({ hazards: [hazard], spawn: { x: 80, y: 274 } });
    const world = makeWorld([stage]);

    world.setInput({ right: true });
    let hurt = false;
    for (let i = 0; i < 160; i += 1) {
      frames(world, 1);
      if (world.inspect().player.hurt > 0) { hurt = true; break; }
    }
    expect(hurt).toBe(true);
    expect(world.inspect().player.x).toBe(80);
    expect(world.inspect().player.y).toBe(274);
    expect(world.inspect().player.vx).toBe(0);
    expect(world.inspect().player.vy).toBe(0);
  });

  it("does not re-trigger damage during the invulnerability window", () => {
    // The hazard sits on the respawn point; repeated frames must not drain all lives at once.
    const world = makeWorld([makeStage({ hazards: [rect(70, 284, 60, 16)], spawn: { x: 80, y: 274 } })]);
    frames(world, 3);
    expect(world.inspect().lives).toBe(2);
    frames(world, 30);
    expect(world.inspect().lives).toBe(2);
  });
});

describe("stage lifecycle", () => {
  it("clears checkpoint and shard progress on restart while preserving existing score and life rules", () => {
    const world = makeWorld([
      makeStage({ shards: [shard(85, 270)], checkpoints: [checkpoint(85, 260)], spawn: { x: 80, y: 274 } }),
    ]);
    frames(world, 3);
    const collected = world.inspect();
    expect(collected.stage.checkpoints[0].active).toBe(true);
    expect(collected.stage.shards[0].collected).toBe(true);
    expect(collected.score).toBe(350);
    const livesBefore = collected.lives;

    world.press("restart");
    const after = world.inspect();
    expect(after.status).toBe("playing");
    expect(after.stage.checkpoints.every((item) => !item.active)).toBe(true);
    expect(after.stage.shards.every((item) => !item.collected)).toBe(true);
    expect(after.score).toBe(350);
    expect(after.lives).toBe(livesBefore);
    expect(after.spawn).toEqual({ x: 80, y: 274 });
    expect(after.player.x).toBe(80);
    expect(after.player.y).toBe(274);
  });

  it("does not leak checkpoint, shard, or position state into the next stage", () => {
    const first = makeStage({
      width: 400,
      shards: [shard(80, 270)],
      checkpoints: [checkpoint(85, 260)],
      spawn: { x: 80, y: 274 },
      portal: rect(300, 238, 28, 62),
    });
    const second = makeStage({ width: 800, shards: [shard(500, 270)], checkpoints: [checkpoint(520, 260)], spawn: { x: 60, y: 274 } });
    second.id = 2;
    const world = makeWorld([first, second]);

    frames(world, 3);
    expect(world.inspect().stage.checkpoints[0].active).toBe(true);
    expect(world.inspect().stage.shards[0].collected).toBe(true);

    world.setInput({ right: true });
    let advanced = false;
    for (let i = 0; i < 400; i += 1) {
      frames(world, 1);
      if (world.inspect().stageIndex === 1) { advanced = true; break; }
    }
    expect(advanced).toBe(true);
    const next = world.inspect();
    expect(next.stage.id).toBe(2);
    expect(next.spawn).toEqual({ x: 60, y: 274 });
    expect(next.player.x).toBe(60);
    expect(next.player.y).toBe(274);
    expect(next.player.vx).toBe(0);
    expect(next.player.vy).toBe(0);
    expect(next.player.facing).toBe(1);
    expect(next.stage.checkpoints.every((item) => !item.active)).toBe(true);
    expect(next.stage.shards.every((item) => !item.collected)).toBe(true);
    // Existing scoring rule: shard (100) + checkpoint (250) + portal (500 + 50 per shard) = 900.
    expect(next.score).toBe(900);
    expect(next.lives).toBe(3);
  });

  it("returns to stage one and resets score after losing the last life", () => {
    // A hazard covering the spawn point drains each life as soon as invulnerability ends.
    const world = makeWorld([makeStage({ hazards: [rect(70, 284, 60, 16)], spawn: { x: 80, y: 274 } })]);
    for (let i = 0; i < 2000 && world.inspect().status !== "dead"; i += 1) frames(world, 1);
    expect(world.inspect().status).toBe("dead");
    expect(world.inspect().lives).toBe(0);

    world.setInput({ jump: true });
    // Restart happens synchronously on the jump press; inspect before the next hazard tick.
    const after = world.inspect();
    world.setInput({ jump: false });
    expect(after.status).toBe("playing");
    expect(after.stageIndex).toBe(0);
    expect(after.lives).toBe(3);
    expect(after.score).toBe(0);
    expect(after.player.x).toBe(80);
    expect(after.player.y).toBe(274);
  });
});

describe("authored stages", () => {
  it("keeps every authored platform's travel range inside its stage", () => {
    const allPlatforms = STAGES.flatMap((stage) => stage.platforms.map((platform) => ({ stage, platform })));
    expect(allPlatforms.length).toBeGreaterThan(0);

    for (const { stage, platform } of allPlatforms) {
      expect(platform.w).toBeGreaterThan(0);
      expect(platform.minX).toBeLessThanOrEqual(platform.maxX);
      expect(platform.minX).toBeGreaterThanOrEqual(0);
      expect(platform.maxX + platform.w).toBeLessThanOrEqual(stage.width);
      expect(platform.vx).not.toBe(0);
      expect(platform.x).toBeGreaterThanOrEqual(platform.minX);
      expect(platform.x).toBeLessThanOrEqual(platform.maxX);
    }
  });

  it("carries a rider on a real authored platform and lands a real authored edge jump", () => {
    // Use the shipped "Copper Canopy" geometry, spawning the player on its first platform.
    const stage = cloneStage(STAGES[1]);
    const authoredPlatform = stage.platforms[0];
    stage.spawn = { x: authoredPlatform.x + 20, y: authoredPlatform.y - 27 };
    stage.portal = { x: stage.width - 40, y: 238, w: 28, h: 62 };
    const world = makeWorld([stage]);

    frames(world, 3);
    expect(world.inspect().player.onGround).toBe(true);
    expect(world.inspect().riding).not.toBeNull();

    const settledOffset = world.inspect().player.x - world.inspect().stage.platforms[0].x;
    for (let i = 0; i < 60; i += 1) {
      frames(world, 1);
      const live = world.inspect();
      if (live.riding) expect(live.player.x - live.stage.platforms[0].x).toBeCloseTo(settledOffset, 6);
    }

    world.setInput({ jump: true });
    frames(world, 1);
    world.setInput({ jump: false });
    let landed = false;
    for (let i = 0; i < 120; i += 1) {
      frames(world, 1);
      if (world.inspect().player.onGround) { landed = true; break; }
    }
    // It may land on the platform or on adjacent authored ground, but never fall out of the level.
    expect(landed).toBe(true);
    expect(world.inspect().player.y).toBeLessThan(360 + 80);
  });
});
