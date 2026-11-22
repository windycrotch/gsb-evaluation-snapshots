import { BOT_NAMES, thinkBot } from './wiggle-bots';
import { eatFood, pelletAt, randomFood, type Food } from './wiggle-food';
import { isSuper, resolveContacts } from './wiggle-rules';
import { canBoost, createSnake, moveSnake, START_MASS, type Snake, type Vec } from './wiggle-snake';

export const ARENA_RADIUS = 3000;
export const FOOD_TARGET = 900;
export const BOT_COUNT = 14;
/** Physics never takes a bigger step than this, however long the real frame was. */
export const MAX_STEP = 0.05;
/** A stall or a hidden tab may skip physics, but only this much of it is caught up. */
const MAX_CATCH_UP = 0.25;
const BOOST_COST = 8;
const DROP_EVERY = 0.12;
const SAFE_SPAWN = 700;

export type WorldEvent =
  { type: 'gobble'; eater: Snake; victim: Snake } | { type: 'munch'; snake: Snake; value: number };

/** How a round ended; written once, when the player is gobbled. */
export type RoundEnding = { by: string; length: number };

export type World = {
  /** Real seconds played. Advances by the true frame time, not by the clamped physics step. */
  time: number;
  arenaRadius: number;
  snakes: Snake[];
  foods: Food[];
  player: Snake | null;
  superUntil: number;
  superReadyAt: number;
  respawnAt: number[];
  nextId: number;
  skinCount: number;
  rand: () => number;
  events: WorldEvent[];
  /** Bumped whenever a player is spawned: every ending belongs to exactly one round. */
  round: number;
  /** Set the first time this round's player is gobbled. */
  ending: RoundEnding | null;
  /** The round whose ending was already handed to the scoreboard. */
  settledRound: number;
};

export function createWorld(skinCount: number, rand: () => number = Math.random): World {
  const world: World = {
    time: 0,
    arenaRadius: ARENA_RADIUS,
    snakes: [],
    foods: [],
    player: null,
    superUntil: 0,
    superReadyAt: 0,
    respawnAt: [],
    nextId: 1,
    skinCount,
    rand,
    events: [],
    round: 0,
    ending: null,
    settledRound: -1,
  };
  refill(world);
  replenishBots(world);
  return world;
}

/** A spot no living head is close to, so nobody spawns inside a hungry mouth. */
function safeSpot(world: World, spread: number): Vec {
  const heads = world.snakes.filter((s) => s.alive).map((s) => s.body[0]);
  let spot: Vec = { x: 0, y: 0 };
  for (let tries = 0; tries < 25; tries++) {
    const dist = Math.sqrt(world.rand()) * world.arenaRadius * spread;
    const angle = world.rand() * Math.PI * 2;
    spot = { x: Math.cos(angle) * dist, y: Math.sin(angle) * dist };
    if (heads.every((h) => Math.hypot(h.x - spot.x, h.y - spot.y) > SAFE_SPAWN)) break;
  }
  return spot;
}

function freeName(world: World) {
  const taken = new Set(world.snakes.filter((s) => s.alive).map((s) => s.name));
  const free = BOT_NAMES.filter((name) => !taken.has(name));
  const pool = free.length > 0 ? free : BOT_NAMES;
  return pool[Math.floor(world.rand() * pool.length)];
}

export function spawnBot(world: World) {
  const { rand } = world;
  const bot = createSnake({
    id: world.nextId++,
    name: freeName(world),
    skin: Math.floor(rand() * world.skinCount),
    isPlayer: false,
    // mostly little snakes to chase, a few big ones to steer clear of
    mass: 10 + rand() ** 2.2 * 500,
    angle: rand() * Math.PI * 2,
    ...safeSpot(world, 0.85),
  });
  bot.bold = rand() < 0.35;
  world.snakes.push(bot);
  return bot;
}

/** Spawn a fresh batch so the arena has exactly BOT_COUNT bots again. */
function replenishBots(world: World) {
  while (world.snakes.filter((s) => s.alive && !s.isPlayer).length < BOT_COUNT) spawnBot(world);
}

/**
 * Drop everything left over from the previous round so a new one starts from a clean slate:
 * no stale snakes, no queued respawns, no unread events, no old super charge, no ending.
 * The round counter goes up, which makes every round-scoped one-shot (the ending, the score)
 * unreachable from the round that just finished.
 */
export function resetRound(world: World) {
  world.snakes = [];
  world.foods = [];
  world.player = null;
  world.respawnAt = [];
  world.events = [];
  world.superUntil = 0;
  world.superReadyAt = 0;
  world.ending = null;
  world.settledRound = -1;
  world.round += 1;
  refill(world);
  replenishBots(world);
}

export function spawnPlayer(world: World, skin: number) {
  resetRound(world);
  const player = createSnake({
    id: world.nextId++,
    name: 'You',
    skin,
    isPlayer: true,
    mass: START_MASS,
    angle: world.rand() * Math.PI * 2,
    ...safeSpot(world, 0.5),
  });
  world.snakes.push(player);
  world.player = player;
  // the button is ready the moment a round begins, and is charging for nobody before that
  world.superUntil = 0;
  world.superReadyAt = world.time;
  return player;
}

/**
 * Advance the arena by `dt` real seconds.
 *
 * The world clock follows the real clock exactly, so the super timer, the recharge timer
 * and bot respawn delays all end when they really should - even after a slow frame or a
 * hidden tab. Physics is only simulated for the part of the frame worth simulating, capped
 * at MAX_CATCH_UP, and in MAX_STEP slices so a long frame cannot tunnel a snake through
 * another one.
 */
export function stepWorld(world: World, dt: number) {
  const real = Number.isFinite(dt) && dt > 0 ? dt : 0;
  world.time += real;
  let left = Math.min(real, MAX_CATCH_UP);
  while (left > 0) {
    const slice = Math.min(MAX_STEP, left);
    left -= slice;
    stepPhysics(world, slice);
  }
  refill(world);
}

function stepPhysics(world: World, dt: number) {
  const { player } = world;
  const superSnake = player?.alive && isSuper(world, player) ? player : null;
  const surroundings = { ...world, superSnake };
  for (const snake of world.snakes) {
    if (!snake.alive) continue;
    if (!snake.isPlayer) thinkBot(snake, surroundings, dt);
    moveSnake(snake, dt, world.arenaRadius);
    dropBoostTrail(world, snake, dt);
    const value = eatFood(snake, world.foods, dt);
    if (value > 0) world.events.push({ type: 'munch', snake, value });
  }
  resolveContacts(world);
}

function dropBoostTrail(world: World, snake: Snake, dt: number) {
  if (!canBoost(snake)) {
    snake.dropTimer = 0;
    return;
  }
  snake.mass -= BOOST_COST * dt;
  snake.dropTimer += dt;
  if (snake.dropTimer < DROP_EVERY) return;
  snake.dropTimer -= DROP_EVERY;
  const tail = snake.body[snake.body.length - 1];
  world.foods.push(pelletAt(world.rand, tail.x, tail.y, BOOST_COST * DROP_EVERY * 0.75));
}

function refill(world: World) {
  // one pass: drop the dead (the player corpse stays until the next round resets it),
  // count live bots and split the respawn queue, then let at most `room` bots back in.
  const snakes: Snake[] = [];
  let aliveBots = 0;
  for (const snake of world.snakes) {
    if (!snake.alive && !snake.isPlayer) continue;
    snakes.push(snake);
    if (snake.alive && !snake.isPlayer) aliveBots++;
  }
  world.snakes = snakes;

  let due = 0;
  let pending = 0;
  for (const at of world.respawnAt) {
    if (at <= world.time) due++;
    else world.respawnAt[pending++] = at;
  }
  world.respawnAt.length = pending;

  // a bot must not reappear on top of a live head: when the arena is already full, the due
  // timer is dropped instead of stacking another snake on top of the roster
  const room = Math.max(0, BOT_COUNT - aliveBots);
  for (let i = 0; i < Math.min(due, room); i++) spawnBot(world);
  while (world.foods.length < FOOD_TARGET)
    world.foods.push(randomFood(world.rand, world.arenaRadius));
}

export type Standing = { name: string; length: number; isPlayer: boolean; rank: number };

export function standings(world: World): Standing[] {
  return world.snakes
    .filter((s) => s.alive)
    .sort((a, b) => b.mass - a.mass)
    .map((s, i) => ({
      name: s.name,
      length: Math.round(s.mass),
      isPlayer: s.isPlayer,
      rank: i + 1,
    }));
}
