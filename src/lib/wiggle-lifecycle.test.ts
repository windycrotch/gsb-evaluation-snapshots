import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  activateSuper,
  gobble,
  isSuper,
  resolveContacts,
  settleEnding,
  SUPER_DURATION,
  SUPER_RECHARGE,
  superState,
} from './wiggle-rules';
import { createSnake, RESPAWN_DELAY, START_MASS } from './wiggle-snake';
import { loadBest, recordBest } from './wiggle-skins';
import {
  BOT_COUNT,
  createWorld,
  FOOD_TARGET,
  resetRound,
  spawnPlayer,
  standings,
  stepWorld,
  type World,
} from './wiggle-world';

/** mulberry32: same seed, same game - keeps these timing tests deterministic. */
function seeded(seed = 11) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let nextId = 500;
const snake = (mass: number, x: number, y: number, angle = 0, isPlayer = false) =>
  createSnake({ id: nextId++, name: `R${nextId}`, skin: 0, isPlayer, mass, angle, x, y });

/** A world with no bots and no dots, so a test owns everything in it. */
function emptyWorld(): World {
  const world = createWorld(8, seeded());
  world.snakes = [];
  world.foods = [];
  world.respawnAt = [];
  return world;
}

/** A world with real bots, as the game itself creates it. */
const boardWorld = () => createWorld(8, seeded());

describe('starting a round', () => {
  it('wipes everything the previous round left behind', () => {
    const world = boardWorld();
    spawnPlayer(world, 1);
    const player = world.player!;
    // dirty the world the way a real round does: an unread event, a queued respawn,
    // a charged super button, a pending ending
    world.events.push({ type: 'gobble', eater: player, victim: world.snakes[0] });
    world.respawnAt.push(world.time + 1);
    activateSuper(world);
    world.ending = { by: 'Noodle', length: 42 };
    world.settledRound = -1;

    const fresh = spawnPlayer(world, 2);

    expect(world.events).toEqual([]);
    expect(world.respawnAt).toEqual([]);
    expect(world.ending).toBeNull();
    expect(superState(world)).toMatchObject({ active: false, ready: true, charge: 1 });
    expect(world.player).toBe(fresh);
    expect(fresh.mass).toBe(START_MASS);
    expect(fresh.skin).toBe(2);
  });

  it('never leaves two player snakes, however fast Play is tapped', () => {
    const world = boardWorld();
    for (let i = 0; i < 5; i++) spawnPlayer(world, i % 8);
    const players = world.snakes.filter((s) => s.isPlayer);
    expect(players).toHaveLength(1);
    expect(players[0]).toBe(world.player);
  });

  it('gives the fresh round a full bot roster and a full food field', () => {
    const world = boardWorld();
    spawnPlayer(world, 0);
    // eat half the arena and most of its dots, then start again
    world.snakes = world.snakes.filter((s) => s.isPlayer || Math.random() < 0.5);
    world.foods.length = 10;
    spawnPlayer(world, 0);
    expect(world.snakes.filter((s) => s.alive && !s.isPlayer)).toHaveLength(BOT_COUNT);
    expect(world.foods).toHaveLength(FOOD_TARGET);
    expect(world.snakes).toHaveLength(BOT_COUNT + 1);
  });

  it('bumps the round, so events tagged with the old one can be recognised', () => {
    const world = boardWorld();
    const before = world.round;
    spawnPlayer(world, 0);
    expect(world.round).toBe(before + 1);
    const afterOne = world.round;
    resetRound(world);
    expect(world.round).toBe(afterOne + 1);
  });

  it('clears a round in progress without spawning a player yet', () => {
    const world = boardWorld();
    spawnPlayer(world, 0);
    world.events.push({ type: 'munch', snake: world.player!, value: 3 });
    resetRound(world);
    expect(world.player).toBeNull();
    expect(world.events).toEqual([]);
    expect(world.snakes.filter((s) => s.isPlayer)).toHaveLength(0);
    expect(world.snakes).toHaveLength(BOT_COUNT);
  });
});

describe('super timing', () => {
  it('ends after the real seconds elapsed, not after the simulated ones', () => {
    const world = emptyWorld();
    const player = snake(20, 0, 0, 0, true);
    world.player = player;
    world.snakes = [player];
    expect(activateSuper(world)).toBe(true);
    // one giant frame: a backgrounded tab that comes back after a long stall
    stepWorld(world, 3);
    expect(world.time).toBeGreaterThanOrEqual(3);
    expect(isSuper(world, player)).toBe(true);
    stepWorld(world, SUPER_DURATION);
    expect(isSuper(world, player)).toBe(false);
    expect(superState(world).active).toBe(false);
  });

  it('enters recharge the moment it ends, then becomes usable again', () => {
    const world = emptyWorld();
    const player = snake(20, 0, 0, 0, true);
    world.player = player;
    world.snakes = [player];
    activateSuper(world);

    stepWorld(world, SUPER_DURATION + 0.5);
    const charging = superState(world);
    expect(charging.active).toBe(false);
    expect(charging.ready).toBe(false);
    expect(charging.charge).toBeGreaterThan(0);
    expect(charging.charge).toBeLessThan(1);

    // tapping during recharge is a no-op - it neither fires nor extends the charge
    const readyAt = world.superReadyAt;
    expect(activateSuper(world)).toBe(false);
    expect(world.superReadyAt).toBe(readyAt);
    expect(world.superUntil).toBe(readyAt - SUPER_RECHARGE);

    stepWorld(world, SUPER_RECHARGE);
    expect(superState(world)).toMatchObject({ active: false, ready: true, charge: 1 });
    expect(activateSuper(world)).toBe(true);
  });

  it('never stacks extra duration when the button is tapped mid-super', () => {
    const world = emptyWorld();
    const player = snake(20, 0, 0, 0, true);
    world.player = player;
    world.snakes = [player];
    activateSuper(world);
    const until = world.superUntil;
    stepWorld(world, 1);
    expect(activateSuper(world)).toBe(false);
    expect(world.superUntil).toBe(until);
    expect(world.superReadyAt).toBe(until + SUPER_RECHARGE);
  });

  it('does not carry a charge across a restart', () => {
    const world = boardWorld();
    spawnPlayer(world, 0);
    world.superUntil = world.time + SUPER_DURATION;
    world.superReadyAt = world.superUntil + SUPER_RECHARGE;
    spawnPlayer(world, 0);
    expect(world.superUntil).toBe(0);
    expect(superState(world)).toMatchObject({ active: false, ready: true, charge: 1 });
  });
});

describe('being gobbled', () => {
  function duel() {
    const world = emptyWorld();
    const player = snake(60, 0, 0, 0, true);
    const giant = snake(900, 0, 0, Math.PI / 2);
    world.snakes = [player, giant];
    world.player = player;
    return { world, player, giant };
  }

  it('records the ending once, with the length at the moment of the bite', () => {
    const { world, player, giant } = duel();
    gobble(world, giant, player);
    expect(world.ending).toEqual({ by: giant.name, length: Math.round(60) });
    player.mass = 999; // further mutations must not move the recorded score
    expect(world.ending).toEqual({ by: giant.name, length: 60 });
  });

  it('settles a round exactly once even if several contacts land in one frame', () => {
    const { world, player, giant } = duel();
    gobble(world, giant, player);
    expect(settleEnding(world)).toEqual({ by: giant.name, length: 60 });
    // repeated gobble calls on a dead victim do nothing at all
    expect(gobble(world, giant, player)).toBe(false);
    expect(world.events.filter((e) => e.type === 'gobble' && e.victim === player)).toHaveLength(1);
    // a second consumer of the same round gets nothing
    expect(settleEnding(world)).toBeNull();
  });

  it('a frame where three big heads touch the player settles once', () => {
    const { world } = duel();
    // surround the player with three giants, all overlapping its body
    const giants = [0, 1, 2].map((i) => snake(900, 0, 0, (i * Math.PI) / 3));
    giants.push(world.player!);
    world.snakes = giants;
    const player = world.player!;
    resolveContacts(world);
    expect(player.alive).toBe(false);
    const endings = world.events.filter((e) => e.type === 'gobble' && e.victim === player);
    expect(endings).toHaveLength(1);
    expect(settleEnding(world)).not.toBeNull();
    expect(settleEnding(world)).toBeNull();
  });

  it('a new round gets a new ending slot; the old ending cannot leak in', () => {
    const { world, player, giant } = duel();
    gobble(world, giant, player);
    expect(settleEnding(world)).not.toBeNull();
    const oldRound = world.round;
    spawnPlayer(world, 0);
    expect(world.ending).toBeNull();
    expect(world.round).not.toBe(oldRound);
    expect(settleEnding(world)).toBeNull();
    expect(standings(world).find((s) => s.isPlayer)?.length).toBe(START_MASS);
  });

  describe('the best score', () => {
    const store = new Map<string, string>();
    let writes = 0;

    beforeEach(() => {
      store.clear();
      writes = 0;
      vi.stubGlobal('window', {
        localStorage: {
          getItem: (key: string) => store.get(key) ?? null,
          setItem: (key: string, value: string) => {
            writes++;
            store.set(key, value);
          },
        },
      });
    });

    afterEach(() => vi.unstubAllGlobals());

    /** Exactly what the game-over handler does, once per gobble event it hears. */
    const score = (world: World) => {
      const settled = settleEnding(world);
      return settled ? recordBest(settled.length) : null;
    };

    it('is written once even when several gobble events arrive for one death', () => {
      const { world, player } = duel();
      // three giants all touching the player in the same frame
      world.snakes = [0, 1, 2].map((i) => snake(900, 0, 0, (i * Math.PI) / 3));
      world.snakes.push(player);
      resolveContacts(world);
      const deaths = world.events.filter((e) => e.type === 'gobble' && e.victim === player);
      expect(deaths).toHaveLength(1);
      // the old code settled every event it heard; replay them all the same way
      for (const event of world.events) {
        if (event.type === 'gobble' && event.victim === player) score(world);
      }
      expect(loadBest()).toBe(60);
      expect(writes).toBe(1);
    });

    it('is not written again when a new round starts after a settled one', () => {
      const { world, player, giant } = duel();
      gobble(world, giant, player);
      expect(score(world)).toBe(60);
      expect(writes).toBe(1);
      spawnPlayer(world, 0);
      // the new round has no ending, so nothing gets scored behind the menu
      expect(score(world)).toBeNull();
      expect(writes).toBe(1);
      expect(loadBest()).toBe(60);
    });
  });
});

describe('bot respawns', () => {
  it('fills the roster back up after the delay, not before', () => {
    const world = emptyWorld();
    const player = snake(60, 0, 0, 0, true);
    const snack = snake(20, 0, 400);
    world.snakes = [player, snack];
    world.player = player;
    gobble(world, player, snack);
    expect(world.respawnAt).toHaveLength(1);

    stepWorld(world, RESPAWN_DELAY - 0.2);
    expect(world.respawnAt.length + world.snakes.filter((s) => !s.isPlayer).length).toBe(1);

    stepWorld(world, 0.3);
    expect(world.respawnAt).toHaveLength(0);
    expect(world.snakes.filter((s) => !s.isPlayer && s.alive)).toHaveLength(1);
    // the player was not replaced by the respawn
    expect(world.snakes.filter((s) => s.isPlayer)).toEqual([player]);
    expect(player.alive).toBe(true);
  });

  it('never grows past the bot roster when many die at once', () => {
    const world = emptyWorld();
    const player = snake(2000, 0, 0, 0, true);
    world.player = player;
    world.snakes = [player];
    for (let i = 0; i < 40; i++) world.snakes.push(snake(20, 0, 900 + i * 40));
    // queue far more respawns than the arena holds
    for (const bot of world.snakes.filter((s) => !s.isPlayer)) gobble(world, player, bot);
    expect(world.respawnAt.length).toBe(40);

    stepWorld(world, RESPAWN_DELAY + 0.5);
    expect(world.snakes.filter((s) => s.alive && !s.isPlayer).length).toBeLessThanOrEqual(
      BOT_COUNT
    );
    expect(world.respawnAt).toHaveLength(0);
  });

  it('a gobbled bot is only queued once', () => {
    const world = emptyWorld();
    const player = snake(500, 0, 0, 0, true);
    const bot = snake(20, 0, 300);
    world.snakes = [player, bot];
    world.player = player;
    gobble(world, player, bot);
    gobble(world, player, bot);
    expect(world.respawnAt).toHaveLength(1);
    expect(world.events.filter((e) => e.type === 'gobble')).toHaveLength(1);
  });

  it('does not let a pending respawn from the old round show up in the new one', () => {
    const world = boardWorld();
    spawnPlayer(world, 0);
    const victim = world.snakes.find((s) => !s.isPlayer)!;
    gobble(world, world.player!, victim);
    const queued = world.respawnAt.length;
    expect(queued).toBe(1);
    spawnPlayer(world, 0);
    expect(world.respawnAt).toHaveLength(0);
    const before = world.snakes.length;
    stepWorld(world, RESPAWN_DELAY + 1);
    expect(world.snakes.length).toBe(before);
  });
});
