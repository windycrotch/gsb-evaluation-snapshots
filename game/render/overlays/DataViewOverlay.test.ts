/**
 * DataViewOverlay unit tests.
 *
 * Pixi 8 Graphics/Container work headless in node (geometry commands need no
 * renderer), so these tests drive the real overlay against a real World and
 * assert on the live container tree. Two spies do the bookkeeping:
 *   - Graphics.prototype.clear   — called exactly once per diamond (re)draw,
 *     so it counts redraws (a no-change frame must produce zero).
 *   - Graphics.prototype.destroy — called when a diamond is evicted.
 *
 * Congestion is injected via TrafficMap.getRaw() AFTER one getTrafficMap()
 * drain: nothing in these tests re-marks traffic dirty, so the raw writes
 * survive every subsequent render() call.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Container, Graphics } from 'pixi.js';
import { DataViewOverlay } from './DataViewOverlay';
import { World } from '../../core/World';
import { TileType, createTile } from '../../core/Tile';
import { ELEVATION_HEIGHT } from '@/game/core';
import type { VisibleTileBounds } from '../viewportCulling';

// Render-only private caches, peeked at to assert destroy/mount/clear behavior.
interface OverlayInternals {
  diamonds: Map<number, Graphics>;
  colorByKey: Map<number, number>;
  lastFlows: unknown;
  cachedShares: unknown;
}

function internalsOf(overlay: DataViewOverlay): OverlayInternals {
  return overlay as unknown as OverlayInternals;
}

function bounds(minX: number, maxX: number, minY: number, maxY: number): VisibleTileBounds {
  return {
    terrain: { minX, maxX, minY, maxY },
    buildings: { minX, maxX, minY, maxY },
  };
}

function fullBounds(w: number, h: number): VisibleTileBounds {
  return bounds(0, w, 0, h);
}

/** Writes congestion directly into the traffic snapshot (after a drain). */
function setCongestion(
  world: World,
  cells: ReadonlyArray<{ x: number; y: number; v: number }>,
): void {
  const width = world.getMap().getWidth();
  const raw = world.getTrafficMap().getRaw(); // drains any pending recompute first
  for (const { x, y, v } of cells) raw[y * width + x] = v;
}

function makeWorldWithRoads(
  w: number,
  h: number,
  roads: ReadonlyArray<{ x: number; y: number }>,
): World {
  const world = new World(w, h, { regenerate: false });
  const map = world.getMap();
  for (const { x, y } of roads) map.setTile(x, y, createTile(x, y, TileType.ROAD));
  return world;
}

let clearSpy: ReturnType<typeof vi.spyOn>;
let destroySpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearSpy = vi.spyOn(Graphics.prototype, 'clear');
  destroySpy = vi.spyOn(Graphics.prototype, 'destroy');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DataViewOverlay — steady state', () => {
  it('produces no redundant redraws when nothing changes between frames', () => {
    const world = makeWorldWithRoads(4, 4, [{ x: 0, y: 0 }, { x: 1, y: 0 }]);
    setCongestion(world, [{ x: 0, y: 0, v: 120 }, { x: 1, y: 0, v: 120 }]);

    const container = new Container();
    const overlay = new DataViewOverlay(container);
    overlay.setActiveView('traffic');

    overlay.render(world, fullBounds(4, 4));
    expect(container.children).toHaveLength(2);
    expect(clearSpy).toHaveBeenCalledTimes(2); // one draw per mounted diamond

    clearSpy.mockClear();
    destroySpy.mockClear();

    // Two more frames, same world, same bounds — must be pure no-ops.
    overlay.render(world, fullBounds(4, 4));
    overlay.render(world, fullBounds(4, 4));

    expect(clearSpy).not.toHaveBeenCalled();
    expect(destroySpy).not.toHaveBeenCalled();
    expect(container.children).toHaveLength(2);

    overlay.destroy();
  });
});

describe('DataViewOverlay — visible-range signature change', () => {
  it('destroys out-of-range keys and mounts in-range keys when the bounds pan', () => {
    const world = makeWorldWithRoads(4, 4, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]);
    setCongestion(world, [
      { x: 0, y: 0, v: 120 },
      { x: 1, y: 0, v: 120 },
      { x: 2, y: 0, v: 120 },
    ]);

    const container = new Container();
    const overlay = new DataViewOverlay(container);
    const internals = internalsOf(overlay);
    overlay.setActiveView('traffic');

    // Frame 1: viewport covers tiles x ∈ {0, 1} → keys 0 and 1 (width 4, y = 0).
    overlay.render(world, bounds(0, 2, 0, 1));
    expect([...internals.diamonds.keys()].sort((a, b) => a - b)).toEqual([0, 1]);
    const evictedGfx = internals.diamonds.get(0)!;

    clearSpy.mockClear();
    destroySpy.mockClear();

    // Frame 2: camera panned — viewport now covers x ∈ {1, 2}. Colors are
    // unchanged; only the visible-range signature changed.
    overlay.render(world, bounds(1, 3, 0, 1));

    // Old key 0 destroyed (and its color-cache entry dropped), new key 2 mounted.
    expect([...internals.diamonds.keys()].sort((a, b) => a - b)).toEqual([1, 2]);
    expect([...internals.colorByKey.keys()].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(destroySpy.mock.instances[0]).toBe(evictedGfx);
    // Exactly one diamond drawn: the newly mounted key 2. Key 1 was already
    // cached and must NOT be redrawn just because the camera moved.
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(container.children).toHaveLength(2);

    overlay.destroy();
  });
});

describe('DataViewOverlay — terrain re-height', () => {
  it('rebuilds an in-range diamond’s vertices from the new corner heights', () => {
    const world = makeWorldWithRoads(4, 4, [{ x: 1, y: 1 }]);
    setCongestion(world, [{ x: 1, y: 1, v: 120 }]);

    const container = new Container();
    const overlay = new DataViewOverlay(container);
    const internals = internalsOf(overlay);
    overlay.setActiveView('traffic');

    overlay.render(world, fullBounds(4, 4));
    const key = 1 * 4 + 1;
    const gfx = internals.diamonds.get(key)!;
    expect(gfx).toBeDefined();
    const minYBefore = gfx.context.bounds.minY;

    // Raise all four corner vertices of tile (1,1) from 1 to 3 (Δh = 2).
    // This bumps the world terrain revision.
    const terrain = world.getTerrain();
    terrain.unsafeSetVertexHeight(1, 1, 3);
    terrain.unsafeSetVertexHeight(2, 1, 3);
    terrain.unsafeSetVertexHeight(2, 2, 3);
    terrain.unsafeSetVertexHeight(1, 2, 3);

    clearSpy.mockClear();
    destroySpy.mockClear();

    overlay.render(world, fullBounds(4, 4));

    // Same key, same Graphics object — but its polygon was rebuilt from the
    // new corner heights (redrawn exactly once, not destroyed/recreated).
    expect(internals.diamonds.get(key)).toBe(gfx);
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(destroySpy).not.toHaveBeenCalled();
    // Higher corners lift the diamond up-screen by Δh * ELEVATION_HEIGHT.
    expect(gfx.context.bounds.minY).toBe(minYBefore - 2 * ELEVATION_HEIGHT);

    overlay.destroy();
  });
});

describe('DataViewOverlay — view switching', () => {
  it('leaves no diamonds or caches behind when switching Traffic → Jobs → None', () => {
    const world = makeWorldWithRoads(4, 4, [{ x: 0, y: 0 }]);
    // A building so the Jobs view has something to draw.
    world.getMap().getBuildings().addBuilding({
      type: 'residential',
      footprint: [{ x: 2, y: 2 }],
      anchor: { x: 2, y: 2 },
      level: 1,
      density: 0,
      age: 0,
      abandoned: false,
      frontage: 'S',
      structureRect: { x: 2, y: 2, w: 1, h: 1 },
    });
    // Inject congestion AFTER all mutations so no dirty-mark can recompute it away.
    setCongestion(world, [{ x: 0, y: 0, v: 120 }]);

    const container = new Container();
    const overlay = new DataViewOverlay(container);
    const internals = internalsOf(overlay);

    // --- Traffic ---
    overlay.setActiveView('traffic');
    overlay.render(world, fullBounds(4, 4));
    expect(internals.diamonds.size).toBe(1);
    expect(internals.colorByKey.size).toBe(1);
    expect(container.children).toHaveLength(1);

    // --- Traffic → Jobs: the switch itself must evict everything. ---
    overlay.setActiveView('jobs');
    expect(internals.diamonds.size).toBe(0);
    expect(internals.colorByKey.size).toBe(0);
    expect(container.children).toHaveLength(0);

    overlay.render(world, fullBounds(4, 4));
    // Jobs view mounts the building footprint cell (key = 2*4+2 = 10), not the road key.
    expect([...internals.diamonds.keys()]).toEqual([10]);
    expect(internals.colorByKey.size).toBe(1);
    expect(container.children).toHaveLength(1);

    // --- Jobs → None: primitives AND every cache must be empty. ---
    overlay.setActiveView('none');
    overlay.render(world, fullBounds(4, 4));
    expect(internals.diamonds.size).toBe(0);
    expect(internals.colorByKey.size).toBe(0);
    expect(internals.lastFlows).toBeNull();
    expect(internals.cachedShares).toBeNull();
    expect(container.children).toHaveLength(0);

    // --- Back to Traffic: rebuilt from scratch (no stale color cache → no blank overlay). ---
    clearSpy.mockClear();
    overlay.setActiveView('traffic');
    overlay.render(world, fullBounds(4, 4));
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect([...internals.diamonds.keys()]).toEqual([0]);
    expect(container.children).toHaveLength(1);

    overlay.destroy();
  });
});
