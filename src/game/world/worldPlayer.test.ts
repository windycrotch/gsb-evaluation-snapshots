import { beforeEach, describe, expect, test, vi } from 'vitest';
import createWorldPlayer from './worldPlayer';
import updateInterface from '../../state/updateInterface';
import state from '../../state/state';
import { Position } from '../../types';

vi.mock('../../state/updateInterface', () => ({
  default: {
    playerFleetDirection: vi.fn(),
    playerFleetSpeed: vi.fn(),
  },
}));

vi.mock('../../state/selectors');

vi.mock('./shipSpeed', () => ({ default: () => 40 }));

const collisionAt = (collisionTiles: Position[]) => (position: Position) =>
  collisionTiles.some(
    ({ x, y }) =>
      (position.x === x || position.x + 1 === x) &&
      (position.y === y || position.y + 1 === y),
  );

const expectPositionToBeCloseTo = (p1: Position, p2: Position) => {
  expect(p1.x).toBeCloseTo(p2.x);
  expect(p1.y).toBeCloseTo(p2.y);
};

describe('worldPlayer', () => {
  const byPosition = (position: Position) => {
    const player = createWorldPlayer(position, 0, 'n');

    player.setHeading('n');
    player.updateSpeed();
    return player;
  };

  test('right movement, with no alternative destination', () => {
    const collisionTiles: Position[] = [
      { x: 4, y: 0 },
      { x: 4, y: 1 },
      { x: 4, y: 2 },
      { x: 4, y: 3 },
    ];

    let player = byPosition({ x: 1, y: 1 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 2, y: 1 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 2, y: 1 });

    player = byPosition({ x: 0.9, y: 1 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1.9, y: 1 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 2, y: 1 });

    player = byPosition({ x: 0.1, y: 1 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1.1, y: 1 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 2, y: 1 });
  });

  test('right movement, with upper alternative destination', () => {
    const collisionTiles: Position[] = [
      { x: 4, y: 2 },
      { x: 4, y: 3 },
    ];

    let player = byPosition({ x: 1, y: 1 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 2, y: 1 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 2, y: 0 });

    player = byPosition({ x: 2, y: 0.9 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expectPositionToBeCloseTo(player.position(), { x: 2.1, y: 0 });

    player = byPosition({ x: 1.9, y: 1 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expectPositionToBeCloseTo(player.position(), { x: 2, y: 0.1 });

    player = byPosition({ x: 2, y: 1.1 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 2, y: 1.1 });
  });

  test('right movement, with lower alternative destination', () => {
    const collisionTiles: Position[] = [
      { x: 4, y: 2 },
      { x: 4, y: 3 },
    ];

    let player = byPosition({ x: 1, y: 3 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 2, y: 3 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 2, y: 4 });

    player = byPosition({ x: 2, y: 2.9 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 2, y: 2.9 });

    player = byPosition({ x: 1.9, y: 3.1 });
    player.move('e', collisionAt(collisionTiles));
    player.update();
    expectPositionToBeCloseTo(player.position(), { x: 2, y: 4 });
  });

  test('left movement, with no alternative destination', () => {
    const collisionTiles: Position[] = [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: 2 },
      { x: 0, y: 3 },
    ];

    let player = byPosition({ x: 2, y: 1 });
    player.move('w', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1, y: 1 });
    player.move('w', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1, y: 1 });

    player = byPosition({ x: 2.1, y: 1 });
    player.move('w', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1.1, y: 1 });
    player.move('w', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1, y: 1 });

    player = byPosition({ x: 2.9, y: 1 });
    player.move('w', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1.9, y: 1 });
    player.move('w', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1, y: 1 });
  });

  test('up movement, with right alternative destination', () => {
    const collisionTiles: Position[] = [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ];

    let player = byPosition({ x: 2, y: 2 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 2, y: 1 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 3, y: 1 });

    player = byPosition({ x: 1.9, y: 1 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1.9, y: 1 });

    player = byPosition({ x: 2.1, y: 1 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expectPositionToBeCloseTo(player.position(), { x: 3, y: 0.9 });
  });

  test('up movement, with no alternative destination', () => {
    const collisionTiles: Position[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ];

    let player = byPosition({ x: 1, y: 2 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1, y: 1 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1, y: 1 });

    player = byPosition({ x: 1, y: 1.1 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1, y: 1 });

    player = byPosition({ x: 1, y: 1.9 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1, y: 1 });
  });

  test('up movement, with left alternative destination', () => {
    const collisionTiles: Position[] = [
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ];

    let player = byPosition({ x: 1, y: 2 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1, y: 1 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 0, y: 1 });

    player = byPosition({ x: 0.9, y: 1 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 0, y: 0.9 });

    player = byPosition({ x: 1.1, y: 1 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1.1, y: 1 });
  });

  test('up movement, with right alternative destination', () => {
    const collisionTiles: Position[] = [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ];

    let player = byPosition({ x: 2, y: 2 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 2, y: 1 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 3, y: 1 });

    player = byPosition({ x: 1.9, y: 1 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expect(player.position()).toEqual({ x: 1.9, y: 1 });

    player = byPosition({ x: 2.1, y: 1 });
    player.move('n', collisionAt(collisionTiles));
    player.update();
    expectPositionToBeCloseTo(player.position(), { x: 3, y: 0.9 });
  });
});

describe('updateSpeed', () => {
  const playerFleetSpeed = vi.mocked(updateInterface.playerFleetSpeed);

  beforeEach(() => {
    playerFleetSpeed.mockClear();
    state.wind = { direction: 0, speed: 3 };
  });

  test('pushes the calculated speed once a heading is set', () => {
    const player = createWorldPlayer({ x: 0, y: 0 }, 0, 'n');

    player.setHeading('n');
    player.updateSpeed();

    expect(playerFleetSpeed).toHaveBeenCalledTimes(1);
    expect(playerFleetSpeed).toHaveBeenLastCalledWith(40);
  });

  test('speed is 0 when no heading is set', () => {
    const player = createWorldPlayer({ x: 0, y: 0 }, 0, 'n');

    player.updateSpeed();

    expect(playerFleetSpeed).toHaveBeenCalledTimes(1);
    expect(playerFleetSpeed).toHaveBeenLastCalledWith(0);
  });

  test('speed is recalculated as 0 when the heading is cleared', () => {
    const player = createWorldPlayer({ x: 0, y: 0 }, 0, 'n');

    player.setHeading('n');
    player.updateSpeed();
    player.setHeading('');
    player.updateSpeed();

    expect(playerFleetSpeed).toHaveBeenCalledTimes(2);
    expect(playerFleetSpeed).toHaveBeenLastCalledWith(0);
  });

  test('repeated calls do not push the same speed again', () => {
    const player = createWorldPlayer({ x: 0, y: 0 }, 0, 'n');

    player.setHeading('n');
    player.updateSpeed();
    player.updateSpeed();
    player.updateSpeed();

    expect(playerFleetSpeed).toHaveBeenCalledTimes(1);
  });

  test('a new wind object with identical values does not trigger a push', () => {
    const player = createWorldPlayer({ x: 0, y: 0 }, 0, 'n');

    player.setHeading('n');
    player.updateSpeed();

    state.wind = { direction: 0, speed: 3 };
    player.updateSpeed();

    expect(playerFleetSpeed).toHaveBeenCalledTimes(1);
  });

  test('pushes again when the wind changes', () => {
    const player = createWorldPlayer({ x: 0, y: 0 }, 0, 'n');

    player.setHeading('n');
    player.updateSpeed();

    state.wind = { direction: 1, speed: 3 };
    player.updateSpeed();

    state.wind = { direction: 1, speed: 5 };
    player.updateSpeed();

    expect(playerFleetSpeed).toHaveBeenCalledTimes(3);
  });

  test('detects wind mutated in place', () => {
    const player = createWorldPlayer({ x: 0, y: 0 }, 0, 'n');

    player.setHeading('n');
    player.updateSpeed();

    state.wind.speed = 6;
    player.updateSpeed();

    expect(playerFleetSpeed).toHaveBeenCalledTimes(2);
  });

  test('pushes again when the heading changes', () => {
    const player = createWorldPlayer({ x: 0, y: 0 }, 0, 'n');

    player.setHeading('n');
    player.updateSpeed();
    player.setHeading('e');
    player.updateSpeed();

    expect(playerFleetSpeed).toHaveBeenCalledTimes(2);
  });
});
