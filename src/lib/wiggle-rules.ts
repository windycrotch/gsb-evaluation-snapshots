import { pelletAt } from './wiggle-food';
import { radiusFor, RESPAWN_DELAY, SEGMENT_SPACING, type Snake, type Vec } from './wiggle-snake';
import type { RoundEnding, World } from './wiggle-world';

export const SUPER_DURATION = 7;
export const SUPER_RECHARGE = 12;

export const isSuper = (world: World, snake: Snake) =>
  snake.isPlayer && world.time < world.superUntil;

export function superState(world: World) {
  const active = world.time < world.superUntil;
  const waiting = Math.max(0, world.superReadyAt - world.time);
  return {
    active,
    ready: !active && waiting === 0,
    remaining: Math.max(0, world.superUntil - world.time),
    charge: active ? 1 : 1 - Math.min(1, waiting / SUPER_RECHARGE),
  };
}

/** The big button on top: for a few seconds the player can gobble every snake it touches. */
export function activateSuper(world: World) {
  if (!world.player?.alive || !superState(world).ready) return false;
  world.superUntil = world.time + SUPER_DURATION;
  world.superReadyAt = world.superUntil + SUPER_RECHARGE;
  return true;
}

/**
 * Hand the current round's ending to the caller exactly once.
 *
 * A frame can contain several contact checks against the same player; each one may push a
 * gobble event. The round number makes the ending a one-shot token: the second caller gets
 * `null`, so the length and the best score can never be written twice.
 */
export function settleEnding(world: World): RoundEnding | null {
  if (!world.ending || world.settledRound === world.round) return null;
  world.settledRound = world.round;
  return world.ending;
}

/** Alisa's rule: when two snakes touch, the smaller one is gobbled - unless super is on. */
export function loserOf(world: World, a: Snake, b: Snake) {
  if (isSuper(world, a)) return b;
  if (isSuper(world, b)) return a;
  return a.mass > b.mass ? b : a;
}

export function headTouches(head: Vec, headRadius: number, other: Snake) {
  const reach = (headRadius + radiusFor(other.mass)) * 0.8;
  const far = other.body.length * SEGMENT_SPACING + reach;
  if (Math.hypot(other.body[0].x - head.x, other.body[0].y - head.y) > far) return false;
  for (let i = 0; i < other.body.length; i += 2) {
    const dx = other.body[i].x - head.x;
    const dy = other.body[i].y - head.y;
    if (dx * dx + dy * dy < reach * reach) return true;
  }
  return false;
}

export function resolveContacts(world: World) {
  const { snakes } = world;
  for (let i = 0; i < snakes.length; i++) {
    const a = snakes[i];
    if (!a.alive) continue;
    for (let j = 0; j < snakes.length; j++) {
      if (i === j) continue;
      const b = snakes[j];
      if (!b.alive) continue;
      if (!headTouches(a.body[0], radiusFor(a.mass), b)) continue;
      const loser = loserOf(world, a, b);
      gobble(world, loser === a ? b : a, loser);
      // `a` may have just been eaten by `b`; nothing else can touch it this frame
      if (!a.alive) break;
    }
  }
}

/**
 * The gobbled snake bursts into big glowing dots along its whole body.
 * Returns false when the victim was already swallowed, which keeps a frame with several
 * contact checks against the same snake from double-counting it.
 */
export function gobble(world: World, eater: Snake, victim: Snake) {
  if (!victim.alive) return false;
  const { rand } = world;
  victim.alive = false;
  const r = radiusFor(victim.mass);
  const count = Math.max(6, Math.min(120, Math.round(victim.body.length / 3)));
  const value = (victim.mass * 0.8 + 4) / count;
  for (let k = 0; k < count; k++) {
    const p = victim.body[Math.floor((k * victim.body.length) / count)];
    world.foods.push(pelletAt(rand, p.x + (rand() - 0.5) * r, p.y + (rand() - 0.5) * r, value));
  }
  if (victim.isPlayer) {
    // written once: later gobble events for the same round cannot move the score
    world.ending ??= { by: eater.name, length: Math.round(victim.mass) };
  } else {
    world.respawnAt.push(world.time + RESPAWN_DELAY);
  }
  world.events.push({ type: 'gobble', eater, victim });
  return true;
}
