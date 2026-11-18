import { describe, expect, test } from 'vitest';
import getShipSpeed from './shipSpeed';
import { shipData } from '../../data/shipData';
import { hasOars } from './worldUtils';
import { Sailor } from '../../data/sailorData';

/*
  These tests run against the real ship data (no mocks) to guarantee
  invariants that must hold for every ship in the game.
 */

const sailor = { navigationLevel: 5, stats: { seamanship: 80 } } as Sailor;

const shipIds = Object.keys(shipData);

const speedOf = (id: string, windDirection: number, windSpeed: number) =>
  getShipSpeed(
    {
      id,
      cargo: [],
      crew: shipData[id].minimumCrew,
    },
    sailor,
    0,
    { direction: windDirection, speed: windSpeed },
  );

describe('getShipSpeed with real ship data', () => {
  test('a pure headwind is never faster than a side headwind, for any ship', () => {
    shipIds.forEach((id) => {
      [1, 3, 5, 7].forEach((windSpeed) => {
        expect(speedOf(id, 4, windSpeed)).toBeLessThanOrEqual(
          speedOf(id, 3, windSpeed),
        );
      });
    });
  });

  test('ships with oars keep moving without wind, ships without oars stall', () => {
    shipIds.forEach((id) => {
      if (hasOars(id)) {
        expect(speedOf(id, 0, 0)).toBeGreaterThan(0);
      } else {
        expect(speedOf(id, 0, 0)).toEqual(0);
      }
    });
  });

  test('ships with oars treat no wind as a wind speed of at least 3', () => {
    shipIds.filter(hasOars).forEach((id) => {
      expect(speedOf(id, 0, 0)).toEqual(speedOf(id, 0, 3));
    });
  });
});
