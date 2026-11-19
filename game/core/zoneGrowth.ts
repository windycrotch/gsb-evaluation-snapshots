import type { World } from './World';
import type { Building } from './Building';
import { TileType } from './Tile';
import type { Frontage, Rect } from './buildingFootprint';
import { lotBboxOf } from './buildingFootprint';
import { MIN_STRUCTURE_DEPTH_CAP, LEVEL_THRESHOLDS, ZONE_MAX_LEVEL } from './growthConstants';
import type { PowerMap } from './PowerMap';
import type { WaterMap } from './WaterMap';
import type { ServiceCoverageMap } from './ServiceCoverageMap';
import type { FireCoverageMap } from './FireCoverageMap';
import type { HospitalCoverageMap } from './HospitalCoverageMap';
import type { SchoolCoverageMap } from './SchoolCoverageMap';

export function depthAxisFromFrontage(frontage: Frontage): { dx: number; dy: number } {
  switch (frontage) {
    case 'N': return { dx: 0, dy: 1 };
    case 'S': return { dx: 0, dy: -1 };
    case 'W': return { dx: 1, dy: 0 };
    case 'E': return { dx: -1, dy: 0 };
  }
}

export function pickSeedFrontage(seed: { x: number; y: number }, world: World): Frontage | null {
  const map = world.getMap();
  // Check distances 1..4, tie-break order S > E > W > N at each distance.
  const directions: Array<{ dir: Frontage; dx: number; dy: number }> = [
    { dir: 'S', dx: 0, dy: 1 },
    { dir: 'E', dx: 1, dy: 0 },
    { dir: 'W', dx: -1, dy: 0 },
    { dir: 'N', dx: 0, dy: -1 },
  ];
  for (let k = 1; k <= 4; k++) {
    for (const { dir, dx, dy } of directions) {
      const nx = seed.x + dx * k;
      const ny = seed.y + dy * k;
      const tile = map.getTile(nx, ny);
      if (tile !== null && tile.type === TileType.ROAD) return dir;
    }
  }
  return null;
}

export function countRoadsOnFace(rect: Rect, frontage: Frontage, world: World): number {
  const map = world.getMap();
  let count = 0;
  switch (frontage) {
    case 'N':
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const t = map.getTile(x, rect.y - 1);
        if (t !== null && t.type === TileType.ROAD) count++;
      }
      break;
    case 'S':
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const t = map.getTile(x, rect.y + rect.h);
        if (t !== null && t.type === TileType.ROAD) count++;
      }
      break;
    case 'W':
      for (let y = rect.y; y < rect.y + rect.h; y++) {
        const t = map.getTile(rect.x - 1, y);
        if (t !== null && t.type === TileType.ROAD) count++;
      }
      break;
    case 'E':
      for (let y = rect.y; y < rect.y + rect.h; y++) {
        const t = map.getTile(rect.x + rect.w, y);
        if (t !== null && t.type === TileType.ROAD) count++;
      }
      break;
  }
  return count;
}

/**
 * Max cells a greedy-depth lot spans (frontage seed + interior, measured along the depth axis).
 * Shared with hasSpawnRoadAccess so the overlay's road cue uses the same reach the spawner does.
 */
const LOT_MAX_DEPTH = 4;

export function greedyDepthLot(
  seed: { x: number; y: number },
  frontage: Frontage,
  seedTileType: TileType,
  world: World,
): Rect | null {
  const map = world.getMap();
  const terrain = world.getTerrain();
  const isWater = (x: number, y: number) => world.isWater(x, y);
  const { dx, dy } = depthAxisFromFrontage(frontage);
  const anchorHeight = terrain.getRenderHeight(seed.x, seed.y);

  const cells: Array<{ x: number; y: number }> = [{ x: seed.x, y: seed.y }];

  for (let step = 1; step < LOT_MAX_DEPTH; step++) {
    const nx = seed.x + dx * step;
    const ny = seed.y + dy * step;
    const tile = map.getTile(nx, ny);
    if (tile === null) break;
    if (tile.type !== seedTileType) break;
    if (map.getBuildings().getBuildingAt(nx, ny) !== null) break;
    if (terrain.getRenderHeight(nx, ny) !== anchorHeight) break;
    if (!terrain.isFlatTile(nx, ny, isWater)) break;
    cells.push({ x: nx, y: ny });
  }

  const rect = lotBboxOf(cells);

  if (!validateFootprintRect(rect, seedTileType, world)) return null;

  // Chosen-frontage validation: the chosen frontage face must actually touch a road.
  if (countRoadsOnFace(rect, frontage, world) === 0) return null;

  return rect;
}

/**
 * Classify why an empty zone tile is not spawning, for the player-facing empty-zone cue.
 *
 * Thin adapter over the unified rule chain (`evaluateEmptyZoneSpawn` +
 * `findCoveringFrontageSeeds`): this function no longer walks coverage itself, so the
 * overlay cue and the spawner's actual lot reach are guaranteed to be the same code.
 * The chain walks the same road-fronting lot COVERAGE the spawner uses (contiguous
 * same-type, EMPTY cells within LOT_MAX_DEPTH; terrain ignored), looking for a frontage
 * seed — a cell whose next cell is a road — whose lot (footprint claimed whole at
 * spawn) would cover `seed`. `isPowered(x,y)` is injected (the overlay passes the
 * PowerMap) and is consulted on the FRONTAGE SEED, not on `seed` itself: World.tick
 * checks power on the seed it spawns from, then the lot absorbs deeper cells, so an
 * interior cell needs no power of its own. Returns:
 *   'road'  — no road-fronting lot can reach the tile (build/extend a road),
 *   'power' — a lot reaches it but NO covering frontage seed is powered (connect power),
 *   null    — a powered frontage seed will spawn a covering lot (or only terrain/demand
 *             blocks it, which roads/power can't fix) → no cue.
 * Priority is road > power: the head of the shared chain (see GrowthBlockReason).
 *
 * Why coverage, not a per-tile test: a road-on-own-face test is too STRICT (interior
 * cells of a deep lot have no road/power on their own face yet are covered by the
 * frontage seed), while a road-within-4 test (pickSeedFrontage) is too LOOSE (it
 * ignores zone-type contiguity, so a road across unzoned land would falsely suppress
 * the cue). Occupancy mirrors the spawn gate too: a building anywhere in the run
 * (including the frontage seed) breaks it, since greedyDepthLot stops at occupied
 * cells and World.tick spawns only from empty seeds.
 */
export function classifyEmptyZoneSpawnBlock(
  seed: { x: number; y: number },
  world: World,
  isPowered: (x: number, y: number) => boolean,
): 'road' | 'power' | null {
  // Delegates to the unified empty-zone chain; its verdict domain is already exactly
  // 'road' | 'power' | null, so this stays a behavior-preserving adapter.
  return evaluateEmptyZoneSpawn(seed, world, isPowered);
}

export function initialStructureRect(lot: Rect, frontage: Frontage): Rect {
  switch (frontage) {
    case 'N': return { x: lot.x, y: lot.y, w: lot.w, h: 1 };
    case 'S': return { x: lot.x, y: lot.y + lot.h - 1, w: lot.w, h: 1 };
    case 'W': return { x: lot.x, y: lot.y, w: 1, h: lot.h };
    case 'E': return { x: lot.x + lot.w - 1, y: lot.y, w: 1, h: lot.h };
  }
}

export function structureRectFillsLotDepth(sr: Rect, lot: Rect, frontage: Frontage): boolean {
  if (frontage === 'N' || frontage === 'S') return sr.h === lot.h;
  return sr.w === lot.w;
}

/**
 * Depth of the structure along the lot's depth axis — the axis isStructureRectInLot does NOT
 * pin (N/S pin sr.w to the lot width, so depth is sr.h; W/E pin sr.h, so depth is sr.w).
 * Exported so mergePolicy's equal-depth gate reads the depth axis from the same place
 * structureDepthCap and canExtendStructure do.
 */
export function structureDepth(sr: Rect, frontage: Frontage): number {
  return (frontage === 'N' || frontage === 'S') ? sr.h : sr.w;
}

/**
 * Width of the lot along its frontage axis (parallel to the road).
 * Exported so inspectTile can report the same width measure maxDensityForLot
 * and structureDepthCap gate on.
 */
export function lotWidthAlongFrontage(lot: Rect, frontage: Frontage): number {
  return (frontage === 'N' || frontage === 'S') ? lot.w : lot.h;
}

// Cap structure depth at max(MIN_STRUCTURE_DEPTH_CAP, lot width). This keeps
// narrow lots from growing into thin slabs while letting wider (merged) lots
// progress toward a square footprint up to the lot's bounds.
function structureDepthCap(lot: Rect, frontage: Frontage): number {
  return Math.max(MIN_STRUCTURE_DEPTH_CAP, lotWidthAlongFrontage(lot, frontage));
}

/**
 * Cap the density tier a lot can reach, keyed on the same frontage-axis
 * width as `structureDepthCap` so both lot-size limits share one measure.
 * A 1-wide (unmerged) lot stops at tier 1; only an assembled >=2-wide lot
 * reaches tier 2 — land assembly, not waiting, unlocks the top tier.
 */
export function maxDensityForLot(lot: Rect, frontage: Frontage): 1 | 2 {
  return lotWidthAlongFrontage(lot, frontage) >= 2 ? 2 : 1;
}

// A structure can grow further only when it has neither hit the depth cap
// nor saturated the lot's depth.
export function canExtendStructure(sr: Rect, lot: Rect, frontage: Frontage): boolean {
  if (structureRectFillsLotDepth(sr, lot, frontage)) return false;
  return structureDepth(sr, frontage) < structureDepthCap(lot, frontage);
}

export function extendStructureToward(structureRect: Rect, lot: Rect, frontage: Frontage): Rect | null {
  if (!canExtendStructure(structureRect, lot, frontage)) return null;
  const sr = structureRect;
  switch (frontage) {
    case 'N': return { x: sr.x, y: sr.y, w: sr.w, h: sr.h + 1 };
    case 'S': return { x: sr.x, y: sr.y - 1, w: sr.w, h: sr.h + 1 };
    case 'W': return { x: sr.x, y: sr.y, w: sr.w + 1, h: sr.h };
    case 'E': return { x: sr.x - 1, y: sr.y, w: sr.w + 1, h: sr.h };
  }
}

/**
 * Count road-adjacent perimeter cells per side (N, S, E, W).
 * "Road-adjacent" means the orthogonal neighbor outside the rect on that side
 * is a ROAD tile. Out-of-bounds counts as not a road.
 */
function countRoadsByFace(rect: Rect, world: World): { N: number; S: number; E: number; W: number } {
  const map = world.getMap();
  let N = 0, S = 0, E = 0, W = 0;

  // N side: row y = rect.y-1, x from rect.x to rect.x+w-1
  for (let x = rect.x; x < rect.x + rect.w; x++) {
    const t = map.getTile(x, rect.y - 1);
    if (t !== null && t.type === TileType.ROAD) N++;
  }

  // S side: row y = rect.y+h, x from rect.x to rect.x+w-1
  for (let x = rect.x; x < rect.x + rect.w; x++) {
    const t = map.getTile(x, rect.y + rect.h);
    if (t !== null && t.type === TileType.ROAD) S++;
  }

  // W side: col x = rect.x-1, y from rect.y to rect.y+h-1
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    const t = map.getTile(rect.x - 1, y);
    if (t !== null && t.type === TileType.ROAD) W++;
  }

  // E side: col x = rect.x+w, y from rect.y to rect.y+h-1
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    const t = map.getTile(rect.x + rect.w, y);
    if (t !== null && t.type === TileType.ROAD) E++;
  }

  return { N, S, E, W };
}

/**
 * Returns the side with the most road-adjacent perimeter cells.
 * Tie-break: S > E > W > N. Returns null when no perimeter cell touches a road.
 */
export function pickFrontage(rect: Rect, world: World): Frontage | null {
  const counts = countRoadsByFace(rect, world);
  const max = Math.max(counts.N, counts.S, counts.E, counts.W);
  if (max === 0) return null;

  // Tie-break order: S, E, W, N
  if (counts.S === max) return 'S';
  if (counts.E === max) return 'E';
  if (counts.W === max) return 'W';
  return 'N';
}

/**
 * Returns true iff the rect is a valid footprint candidate:
 * - w and h each in {1..4} (defense in depth)
 * - every cell in-bounds
 * - every cell's tile type matches seedTileType
 * - every cell unowned (no building)
 * - every cell is flat (terrain.isFlatTile)
 * - every cell shares the same getRenderHeight as rect.x, rect.y
 * - at least one road-adjacent perimeter cell (pickFrontage non-null)
 */
export function validateFootprintRect(
  rect: Rect,
  seedTileType: TileType,
  world: World,
): boolean {
  if (rect.w < 1 || rect.w > 4 || rect.h < 1 || rect.h > 4) return false;

  const map = world.getMap();
  const terrain = world.getTerrain();
  const isWater = (x: number, y: number) => world.isWater(x, y);

  const anchorHeight = terrain.getRenderHeight(rect.x, rect.y);

  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const tile = map.getTile(x, y);
      if (tile === null) return false;
      if (tile.type !== seedTileType) return false;
      if (map.getBuildings().getBuildingAt(x, y) !== null) return false;
      if (!terrain.isFlatTile(x, y, isWater)) return false;
      if (terrain.getRenderHeight(x, y) !== anchorHeight) return false;
    }
  }

  return pickFrontage(rect, world) !== null;
}

/**
 * Returns true iff the building's stored frontage face still touches a road.
 * Use this for growth/merge gates — not the generic any-side check.
 */
export function hasFrontageRoadAccess(building: Building, world: World): boolean {
  return countRoadsOnFace(lotBboxOf(building.footprint), building.frontage, world) > 0;
}

/**
 * Convenience wrapper: returns true iff the building's footprint has at least
 * one road-adjacent perimeter cell. Assumes a canonical footprint (Task 4 invariant).
 */
export function hasRoadAccess(building: Building, world: World): boolean {
  let minX = building.footprint[0].x;
  let minY = building.footprint[0].y;
  let maxX = building.footprint[0].x;
  let maxY = building.footprint[0].y;

  for (const c of building.footprint) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.y > maxY) maxY = c.y;
  }

  const rect: Rect = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  return pickFrontage(rect, world) !== null;
}

/**
 * Expand a rect to a cell list in row-major order (y-major, x-minor).
 */
export function footprintCells(rect: Rect): Array<{ x: number; y: number }> {
  const cells: Array<{ x: number; y: number }> = [];
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      cells.push({ x, y });
    }
  }
  return cells;
}

/**
 * Returns the highest building level that the given land value can support.
 * Mirrors the LEVEL_THRESHOLDS[level+1] gate in World.tick's level-up branch:
 * a building may level up to L only when landValue >= LEVEL_THRESHOLDS[L].
 * Floor is 1 — a building at level 1 is never considered over-supported regardless
 * of land value (there is no "level 0" to fall back to for an existing building).
 *
 * The mirror is deliberately ONE-SIDED in its INPUT: World.tick's growth gates pass the
 * congested land value, its abandonment sweep passes the uncongested one. Why, and what
 * that buys, is documented once at the sweep in World.tick — do not restate it here. This
 * function is a pure threshold lookup over whatever value it is handed.
 */
export function maxSupportedLevel(landValue: number): number {
  for (let L = ZONE_MAX_LEVEL; L >= 1; L--) {
    if (landValue >= LEVEL_THRESHOLDS[L]) return L;
  }
  return 1;
}

/**
 * Returns true when a building's current level exceeds what the land value can
 * support — the condition that triggers abandonment/dilapidation.
 * Uses the same LEVEL_THRESHOLDS gate as World.tick's level-up branch; the sweep calls it
 * with the congestion-free land value (see maxSupportedLevel).
 * Level 1 is the floor: a level-1 building is never under-supported.
 */
export function isUnderSupported(level: number, landValue: number): boolean {
  return level > maxSupportedLevel(landValue);
}

// ---------------------------------------------------------------------------
// Unified growth-eligibility rule chain
//
// ONE explainable, replayable chain decides "may this lot keep growing?" for every
// caller: World.tick's spawn / aging / level-up / structure-grow / density / merge
// branches, the empty-zone spawn-block classifier, and the player-facing utility
// overlay. The player-visible reason therefore cannot drift from the reason the
// simulation actually applies.
//
// The chain orders the five locational gates as
//   road > power > water > service > landValue
// and `primaryBlock` reports the FIRST failing gate — the single badge/cue a player
// sees. In particular power outranks water (when both fail, the cue is 'power'),
// and road outranks every utility gate.
//
// Every predicate here is SIDE-EFFECT FREE: it reads only the world's already
// recomputed snapshot maps (power, water, the four coverage maps, land value) and the
// immutable map/building state, and never marks anything dirty or mutates a building.
// Repeated calls with no intervening world mutation return bit-identical results.
// Transient per-tick inputs that are not locational — demand, the upkeep-funding
// freeze, age cooldowns — stay in World.tick on purpose: they are city-wide scalars
// with no per-tile reason to display, so folding them in would give the overlay a
// cue the map cannot render.
// ---------------------------------------------------------------------------

/**
 * The five locational gates, in priority order. `'road'` is most fundamental —
 * power, water and graded coverage all propagate through ROAD cells, so a lot
 * whose frontage face lost its road cannot be powered or covered either.
 */
export type GrowthBlockReason = 'road' | 'power' | 'water' | 'service' | 'landValue';

/**
 * The verdict of one eligibility evaluation. Every gate gets its own boolean so a
 * caller can apply just the gates it needs (spawn reads only road+power; the merge
 * loop reads road+power+water; the level-up branch reads all five), while
 * `primaryBlock` is the shared explainable reason for overlays and tests.
 */
export interface GrowthEligibility {
  /** The building's stored frontage face still touches at least one road cell. */
  hasRoad: boolean;
  /** At least one footprint cell sits on a powered cell (binary field → footprint scan). */
  isPowered: boolean;
  /** At least one footprint cell sits on a watered cell (binary field → footprint scan). */
  isWatered: boolean;
  /** All four graded services (police, fire, hospital, school) cover the anchor. */
  isServiceCovered: boolean;
  /** Congested anchor land value clears the threshold the caller asked for. */
  meetsLandValue: boolean;
  /** True iff every gate passed. */
  canGrow: boolean;
  /** The first failing gate in road > power > water > service > landValue order; null when canGrow. */
  primaryBlock: GrowthBlockReason | null;
}

/** Frozen snapshots World.tick resolves before the growth pass; the evaluator only reads them. */
export interface GrowthRuleContext {
  power: Pick<PowerMap, 'isPowered'>;
  water: Pick<WaterMap, 'isWatered'>;
  police: Pick<ServiceCoverageMap, 'getCoverage'>;
  fire: Pick<FireCoverageMap, 'getCoverage'>;
  hospital: Pick<HospitalCoverageMap, 'getCoverage'>;
  school: Pick<SchoolCoverageMap, 'getCoverage'>;
  /**
   * Land-value surface to gate against. World.tick's growth branches pass the CONGESTED
   * value (`LandValueMap.getValue`); callers that want the abandonment verdict pass the
   * uncongested surface instead. The evaluator is a pure threshold lookup over whichever
   * surface it is handed, exactly like maxSupportedLevel.
   */
  landValue: { getValue(x: number, y: number): number };
}

/** Raw coverage threshold shared by all four graded services (see ServiceCoverageMap). */
const SERVICE_ANCHOR_THRESHOLD_RAW = Math.round(0.25 * 255);

/** Pick the first failed gate in the fixed chain order; null when every gate passed. */
export function primaryGrowthBlock(flags: {
  hasRoad: boolean;
  isPowered: boolean;
  isWatered: boolean;
  isServiceCovered: boolean;
  meetsLandValue: boolean;
}): GrowthBlockReason | null {
  if (!flags.hasRoad) return 'road';
  if (!flags.isPowered) return 'power';
  if (!flags.isWatered) return 'water';
  if (!flags.isServiceCovered) return 'service';
  if (!flags.meetsLandValue) return 'landValue';
  return null;
}

/**
 * Evaluate the full locational rule chain for one EXISTING building against frozen
 * snapshots. Pure: no world/building mutation, no dirty marks, deterministic for a
 * given world state.
 *
 * Graded fields (the four services, land value) gate at the building's ANCHOR; binary
 * fields (power, water) scan the whole FOOTPRINT — any one satisfied cell passes —
 * matching the split documented in ServiceCoverageMap/PowerMap.
 *
 * @param landValueThreshold the LEVEL_THRESHOLDS entry for the next level; pass 0 when
 *   the caller does not gate on land value (e.g. the utility-only overlay badge).
 */
export function evaluateBuildingGrowth(
  building: Building,
  ctx: GrowthRuleContext,
  landValueThreshold: number,
  world: World,
): GrowthEligibility {
  const hasRoad = hasFrontageRoadAccess(building, world);
  let isPowered = false;
  let isWatered = false;
  for (const c of building.footprint) {
    if (ctx.power.isPowered(c.x, c.y)) isPowered = true;
    if (ctx.water.isWatered(c.x, c.y)) isWatered = true;
  }
  const { x: ax, y: ay } = building.anchor;
  const isServiceCovered =
    ctx.police.getCoverage(ax, ay) >= SERVICE_ANCHOR_THRESHOLD_RAW &&
    ctx.fire.getCoverage(ax, ay) >= SERVICE_ANCHOR_THRESHOLD_RAW &&
    ctx.hospital.getCoverage(ax, ay) >= SERVICE_ANCHOR_THRESHOLD_RAW &&
    ctx.school.getCoverage(ax, ay) >= SERVICE_ANCHOR_THRESHOLD_RAW;
  const meetsLandValue = ctx.landValue.getValue(ax, ay) >= landValueThreshold;

  const primaryBlock = primaryGrowthBlock({
    hasRoad, isPowered, isWatered, isServiceCovered, meetsLandValue,
  });
  return {
    hasRoad,
    isPowered,
    isWatered,
    isServiceCovered,
    meetsLandValue,
    canGrow: primaryBlock === null,
    primaryBlock,
  };
}

/**
 * Directions walked by the empty-lot coverage scan. This is a COVERAGE walk, not the
 * spawner's frontage tie-break, so the order carries no gameplay meaning — the
 * frontage picker's S > E > W > N tie-break lives untouched in pickSeedFrontage.
 */
const LOT_SCAN_DIRECTIONS: ReadonlyArray<{ dx: number; dy: number }> = [
  { dx: 0, dy: 1 }, { dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: -1 },
];

/**
 * Find every frontage seed whose road-fronting lot COULD cover an empty zone cell
 * `seed`, mirroring the lot reach the spawner uses (contiguous same-type EMPTY cells
 * within LOT_MAX_DEPTH; terrain ignored). For each direction, `seed` sits at depth
 * `step` behind a frontage cell whose next cell is a road. Returns one entry per
 * direction whose frontage seed is reachable.
 *
 * This is the single coverage primitive shared by the spawner-aligned classifier and
 * any future overlay: it encodes only geometry (road reach + zone contiguity +
 * occupancy), leaving the utility verdict to the caller — the same split
 * greedyDepthLot (geometry) and World.tick (utilities) use for actual spawns.
 */
export function findCoveringFrontageSeeds(
  seed: { x: number; y: number },
  world: World,
): Array<{ x: number; y: number }> {
  const map = world.getMap();
  const buildings = map.getBuildings();
  const seedTile = map.getTile(seed.x, seed.y);
  if (seedTile === null) return [];
  const seedType = seedTile.type;
  if (buildings.getBuildingAt(seed.x, seed.y) !== null) return []; // occupied — not an empty zone

  const frontageSeeds: Array<{ x: number; y: number }> = [];
  for (const { dx, dy } of LOT_SCAN_DIRECTIONS) {
    for (let step = 0; step < LOT_MAX_DEPTH; step++) {
      const cx = seed.x + dx * step;
      const cy = seed.y + dy * step;
      if (step > 0) {
        const t = map.getTile(cx, cy);
        if (t === null || t.type !== seedType) break; // contiguity broken before any road frontage
        if (buildings.getBuildingAt(cx, cy) !== null) break; // an occupied cell blocks the lot
      }
      const road = map.getTile(cx + dx, cy + dy);
      if (road !== null && road.type === TileType.ROAD) {
        // (cx,cy) is a frontage seed whose lot covers `seed`.
        frontageSeeds.push({ x: cx, y: cy });
        break; // deeper cells are past the road; this direction has exactly one frontage seed
      }
    }
  }
  return frontageSeeds;
}

/**
 * Empty-zone variant of the chain: does any road-fronting lot covering this empty
 * tile have a POWERED frontage seed? Spawn needs only road + power (water, services
 * and land value gate later growth rungs, never the initial spawn), so the empty-tile
 * verdict collapses the chain to two outcomes:
 *   - no covering frontage seed exists at all              → 'road',
 *   - one exists but none of the covering seeds is powered → 'power',
 *   - a powered seed will spawn a covering lot              → null (no cue).
 * The power predicate is injected so tests can exercise the chain without building a
 * full utility network; production callers pass `world.getPowerMap().isPowered`.
 * Priority is still road > power, the head of the shared chain.
 */
export function evaluateEmptyZoneSpawn(
  seed: { x: number; y: number },
  world: World,
  isPowered: (x: number, y: number) => boolean,
): 'road' | 'power' | null {
  const frontageSeeds = findCoveringFrontageSeeds(seed, world);
  if (frontageSeeds.length === 0) return 'road';
  for (const fs of frontageSeeds) {
    if (isPowered(fs.x, fs.y)) return null;
  }
  return 'power';
}
