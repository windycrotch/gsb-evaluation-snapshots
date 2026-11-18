import { beforeEach, describe, expect, test, vi } from 'vitest';
import state from './state';
import updateInterface from './updateInterface';
import { setSail, updateWorldStatus } from './actionsWorld';
import { getCurrent, getWind } from '../game/world/windCurrent';
import { positionAdjacentToPort } from './selectors';

vi.mock('./updateInterface', () => ({
  default: {
    general: vi.fn(),
    dayAtSea: vi.fn(),
    provisions: vi.fn(),
    indicators: vi.fn(),
    playerFleetDirection: vi.fn(),
    playerFleetSpeed: vi.fn(),
    fade: vi.fn(),
  },
}));

vi.mock('./actionsPort', () => ({
  updateGeneral: vi.fn(),
}));

vi.mock('../input', () => ({
  default: { reset: vi.fn() },
  directionMap: {},
}));

vi.mock('../game/world/windCurrent', () => ({
  getSeaArea: vi.fn(() => 0),
  getWind: vi.fn(),
  getCurrent: vi.fn(),
  getIsSummer: vi.fn(() => true),
}));

vi.mock('./selectors', () => ({
  getTimeOfDay: vi.fn(() => 0),
  shouldUpdateWorldStatus: vi.fn(() => true),
  positionAdjacentToPort: vi.fn(() => ({ x: 10, y: 12 })),
}));

vi.mock('../game/port/portUtils', () => ({
  portAdjacentAt: vi.fn(),
}));

vi.mock('../game/port/port', () => ({
  default: vi.fn(),
}));

const freshWind = { direction: 1, speed: 4 };
const freshCurrent = { direction: 2, speed: 1 };

describe('setSail', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    state.portId = '1';
    state.buildingId = '0';
    state.dayAtSea = 5;
    state.timePassed = 0;
    state.wind = { direction: 7, speed: 7 };
    state.current = { direction: 7, speed: 7 };

    state.fleets[1].position = { x: 100, y: 100 };
    state.fleets[1].ships = [
      {
        id: '1',
        name: 'Flagship',
        crew: 10,
        durability: 10,
        cargo: [
          { type: 'water', quantity: 30 },
          { type: 'food', quantity: 20 },
        ],
      },
      {
        id: '2',
        name: 'Consort',
        crew: 5,
        durability: 10,
        cargo: [
          { type: 'water', quantity: 10 },
          { type: 'lumber', quantity: 4 },
          { type: 'shot', quantity: 2 },
        ],
      },
    ];

    vi.mocked(getWind).mockReturnValue(freshWind);
    vi.mocked(getCurrent).mockReturnValue(freshCurrent);
  });

  test('leaves port and the building', () => {
    setSail();

    expect(state.portId).toBeNull();
    expect(state.buildingId).toBeNull();
  });

  test('recalculates wind and current for the current sea area and updates the indicators', () => {
    setSail();

    expect(getWind).toHaveBeenCalled();
    expect(getCurrent).toHaveBeenCalled();

    expect(state.wind).toEqual(freshWind);
    expect(state.current).toEqual(freshCurrent);

    expect(updateInterface.indicators).toHaveBeenCalledWith({
      wind: freshWind,
      current: freshCurrent,
    });
  });

  test('refreshes the provisions panel from the fleet’s cargo', () => {
    setSail();

    expect(updateInterface.provisions).toHaveBeenCalledWith({
      water: 40,
      food: 20,
      lumber: 4,
      shot: 2,
    });
  });

  test('resets dayAtSea and pushes it to the interface', () => {
    setSail();

    expect(state.dayAtSea).toBe(0);
    expect(updateInterface.dayAtSea).toHaveBeenCalledWith(0);
  });

  test('derives a position adjacent to the port when a docked fleet has none', () => {
    state.fleets[1].position = undefined;

    setSail();

    expect(positionAdjacentToPort).toHaveBeenCalledWith('1');
    expect(state.fleets[1].position).toEqual({ x: 10, y: 12 });
    expect(state.wind).toEqual(freshWind);
  });

  test('throws a clear error when the fleet has no position and is not in port', () => {
    state.fleets[1].position = undefined;
    state.portId = null;

    expect(() => setSail()).toThrow(/position/i);

    // stale wind, current and dayAtSea must not be pushed to the interface
    expect(updateInterface.indicators).not.toHaveBeenCalled();
    expect(updateInterface.dayAtSea).not.toHaveBeenCalled();
  });
});

describe('updateWorldStatus', () => {
  test('throws a clear error when the player fleet has no position', () => {
    state.fleets[1].position = undefined;

    expect(() => updateWorldStatus()).toThrow(
      'Player fleet position is not set',
    );
  });
});
