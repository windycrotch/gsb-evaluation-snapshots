import { describe, it, expect } from 'vitest';
import { World, ZONE_GROWTH_INTERVAL } from './World';
import { TileType, createTile } from './Tile';
import {
  evaluateBuildingGrowth,
  evaluateEmptyZoneSpawn,
  findCoveringFrontageSeeds,
  classifyEmptyZoneSpawnBlock,
  primaryGrowthBlock,
  type GrowthRuleContext,
} from './zoneGrowth';
import type { Building } from './Building';

/** Set all 4 corner vertices of tile (x,y) to height h so the tile is flat. */
function setTileFlat(world: World, x: number, y: number, h = 1): void {
  const t = world.getTerrain();
  t.unsafeSetVertexHeight(x, y, h);
  t.unsafeSetVertexHeight(x + 1, y, h);
  t.unsafeSetVertexHeight(x + 1, y + 1, h);
  t.unsafeSetVertexHeight(x, y + 1, h);
}

function seedZone(world: World, x: number, y: number): void {
  world.getMap().setTile(x, y, createTile(x, y, TileType.ZONE_RESIDENTIAL));
  setTileFlat(world, x, y);
}

function seedRoad(world: World, x: number, y: number): void {
  world.getMap().setTile(x, y, createTile(x, y, TileType.ROAD));
}

function seedPower(world: World, ax: number, ay: number): void {
  world.getStructureMap().addStructure({
    type: 'power_plant',
    anchor: { x: ax, y: ay },
    footprint: [
      { x: ax, y: ay }, { x: ax + 1, y: ay },
      { x: ax, y: ay + 1 }, { x: ax + 1, y: ay + 1 },
    ],
  });
  world.markPowerDirty();
  world.recomputePower();
}

function seedWater(world: World, x: number, y: number): void {
  world.getStructureMap().addStructure({
    type: 'water_tower',
    anchor: { x, y },
    footprint: [{ x, y }],
  });
  world.markWaterDirty();
  world.recomputeWater();
}

function addUnitBuilding(world: World, x: number, y: number, frontage: Building['frontage'] = 'S'): Building {
  const added = world.getMap().getBuildings().addBuilding({
    type: 'residential',
    footprint: [{ x, y }],
    anchor: { x, y },
    level: 1,
    density: 0,
    age: 0,
    abandoned: false,
    frontage,
    structureRect: { x, y, w: 1, h: 1 },
  });
  expect(added).not.toBeNull();
  return added!;
}

/** Bundle the world's already-recomputed snapshots into the evaluator's context. */
function ruleContext(world: World): GrowthRuleContext {
  return {
    power: world.getPowerMap(),
    water: world.getWaterMap(),
    police: world.getServiceCoverageMap(),
    fire: world.getFireCoverageMap(),
    hospital: world.getHospitalCoverageMap(),
    school: world.getSchoolCoverageMap(),
    landValue: world.getLandValue(),
  };
}

/**
 * A context whose four graded services always read fully covered, for tests that isolate the
 * binary utility/road gates (power, water) from the service-coverage rung. Power and water stay
 * the world's real snapshots so those gates are still exercised end to end.
 */
function coveredRuleContext(world: World): GrowthRuleContext {
  return {
    ...ruleContext(world),
    police: { getCoverage: () => 255 },
    fire: { getCoverage: () => 255 },
    hospital: { getCoverage: () => 255 },
    school: { getCoverage: () => 255 },
  };
}

function tickOneGrowthInterval(world: World): void {
  for (let i = 0; i < ZONE_GROWTH_INTERVAL; i++) world.tick();
}

describe('primaryGrowthBlock — fixed chain priority', () => {
  it('reports the first failed gate in road > power > water > service > landValue order', () => {
    expect(primaryGrowthBlock({
      hasRoad: false, isPowered: false, isWatered: false, isServiceCovered: false, meetsLandValue: false,
    })).toBe('road');
    expect(primaryGrowthBlock({
      hasRoad: true, isPowered: false, isWatered: false, isServiceCovered: false, meetsLandValue: false,
    })).toBe('power');
    expect(primaryGrowthBlock({
      hasRoad: true, isPowered: true, isWatered: false, isServiceCovered: false, meetsLandValue: false,
    })).toBe('water');
    expect(primaryGrowthBlock({
      hasRoad: true, isPowered: true, isWatered: true, isServiceCovered: false, meetsLandValue: false,
    })).toBe('service');
    expect(primaryGrowthBlock({
      hasRoad: true, isPowered: true, isWatered: true, isServiceCovered: true, meetsLandValue: false,
    })).toBe('landValue');
    expect(primaryGrowthBlock({
      hasRoad: true, isPowered: true, isWatered: true, isServiceCovered: true, meetsLandValue: true,
    })).toBeNull();
  });
});

describe('evaluateBuildingGrowth — normal growth on a fully served lot', () => {
  it('an adjacent-road, powered and watered building passes every locational gate', () => {
    const world = new World(10, 8, { regenerate: false });
    seedZone(world, 2, 2);
    // One continuous road row: the zone fronts it at (2,3), the plant and tower seed into
    // the SAME network further along — utility BFS conducts along connected roads only.
    for (let x = 0; x < 8; x++) seedRoad(world, x, 3);
    seedPower(world, 4, 4); // plant (4,4)-(5,5); cell (4,4) adj road (4,3)
    seedWater(world, 6, 4); // tower (6,4) adj road (6,3)

    const building = addUnitBuilding(world, 2, 2, 'S');
    // Sanity-check the fixture actually supplies the utilities this test relies on.
    expect(world.getPowerMap().isPowered(2, 2)).toBe(true);
    expect(world.getWaterMap().isWatered(2, 2)).toBe(true);

    // A utility-only verdict (threshold 0, services stubbed open) passes fully.
    const utilityVerdict = evaluateBuildingGrowth(building, coveredRuleContext(world), 0, world);
    expect(utilityVerdict.hasRoad).toBe(true);
    expect(utilityVerdict.isPowered).toBe(true);
    expect(utilityVerdict.isWatered).toBe(true);
    expect(utilityVerdict.primaryBlock).toBeNull();
    expect(utilityVerdict.canGrow).toBe(true);

    // With no stations seeded the graded service gate is the first failing rung on the REAL
    // context — proving the chain really does carry all five gates, not just road/power/water.
    expect(utilityVerdict.isServiceCovered).toBe(true);
    const fullVerdict = evaluateBuildingGrowth(building, ruleContext(world), 0.1, world);
    expect(fullVerdict.primaryBlock).toBe('service');
  });
});

describe('evaluateBuildingGrowth — road removal disqualifies the building', () => {
  it('bulldozing the frontage road flips the verdict from eligible to road on the next evaluation', () => {
    const world = new World(8, 6, { regenerate: false });
    seedZone(world, 1, 1);
    // Continuous road row; the plant and tower seed the SAME network through adjacent row cells.
    for (let x = 0; x < 6; x++) seedRoad(world, x, 2);
    seedPower(world, 2, 3); // (2,3) adj road (2,2); row conducts power back to (1,2)
    seedWater(world, 5, 3); // (5,3) adj road (5,2); row conducts water back to (1,2)
    const building = addUnitBuilding(world, 1, 1, 'S');
    expect(world.getPowerMap().isPowered(1, 1)).toBe(true);
    expect(world.getWaterMap().isWatered(1, 1)).toBe(true);

    const before = evaluateBuildingGrowth(building, coveredRuleContext(world), 0, world);
    expect(before.hasRoad).toBe(true);
    expect(before.primaryBlock).toBeNull();

    // Bulldoze the road tile and re-resolve every derived snapshot, exactly as
    // CommandDispatcher.applyCommands does after a road edit.
    world.getMap().setTile(1, 2, createTile(1, 2, TileType.GRASS));
    world.markPowerDirty();
    world.markWaterDirty();
    world.recomputePower();
    world.recomputeWater();

    const after = evaluateBuildingGrowth(building, coveredRuleContext(world), 0, world);
    expect(after.hasRoad).toBe(false);
    // Road outranks every utility gate, even though the power snapshot died with the road too.
    expect(after.primaryBlock).toBe('road');
    expect(after.canGrow).toBe(false);
  });
});

describe('World.tick — road demolition freezes growth and re-occupancy restores it (existing abandonment rules)', () => {
  it('a level-2 building whose road is removed stops aging/growing, is abandoned via the land-value sweep, and re-occupies when the road returns', () => {
    const world = new World(8, 8, { regenerate: false });
    const map = world.getMap();
    seedZone(world, 1, 1);
    seedRoad(world, 1, 2);
    seedPower(world, 2, 2); // plant (2,2)-(3,3) powers road (1,2)
    // Seed a level-2 building: with the adjacent road its anchor land value supports level 2.
    const building = map.getBuildings().addBuilding({
      type: 'residential',
      footprint: [{ x: 1, y: 1 }],
      anchor: { x: 1, y: 1 },
      level: 2,
      density: 0,
      age: 0,
      abandoned: false,
      frontage: 'S',
      structureRect: { x: 1, y: 1, w: 1, h: 1 },
    })!;
    world.markLandValueDirty();
    world.recomputeLandValue();

    // Control interval with the road intact: it ages and is NOT swept (road proximity supports L2).
    tickOneGrowthInterval(world);
    const stillOccupied = map.getBuildings().getBuilding(building.id)!;
    expect(stillOccupied.abandoned).toBe(false);
    expect(stillOccupied.age).toBe(1);

    // Remove the road: next growth pass must deny eligibility BEFORE age++, and the
    // uncongested land value collapses (no road proximity) so the existing abandonment
    // sweep condemns the over-level building.
    map.setTile(1, 2, createTile(1, 2, TileType.GRASS));
    world.markPowerDirty();
    world.markLandValueDirty();
    tickOneGrowthInterval(world);

    const derelict = map.getBuildings().getBuilding(building.id)!;
    expect(derelict.abandoned).toBe(true);
    expect(derelict.level).toBe(2); // level is remembered, never reset by abandonment
    expect(derelict.age).toBe(1);   // the road gate runs before age++ — eligibility does not accrue

    // A second roadless interval changes nothing: still frozen, still derelict, still level 2.
    tickOneGrowthInterval(world);
    const stillDerelict = map.getBuildings().getBuilding(building.id)!;
    expect(stillDerelict.abandoned).toBe(true);
    expect(stillDerelict.age).toBe(1);

    // Restore the supply: the land-value sweep now supports level 2 again → re-occupied.
    map.setTile(1, 2, createTile(1, 2, TileType.ROAD));
    world.markPowerDirty();
    world.markLandValueDirty();
    tickOneGrowthInterval(world);

    const recovered = map.getBuildings().getBuilding(building.id)!;
    expect(recovered.abandoned).toBe(false);
    expect(recovered.level).toBe(2);
    expect(recovered.age).toBe(2); // road+power back → aging resumes on the recovery pass
  });
});

describe('evaluateBuildingGrowth — power vs water reason priority', () => {
  it('power missing reports power even when water is also missing (power > water)', () => {
    // Two DISCONNECTED road networks so the water-only network can be powered while the
    // building's own network has neither utility. Utilities conduct along roads only.
    const world = new World(10, 8, { regenerate: false });
    seedZone(world, 1, 1);
    seedRoad(world, 1, 2); // network A — the building's frontage road, no plant and no tower
    // Network B far away, fully provisioned — proves the absence on A is real, not a fixture gap.
    seedRoad(world, 8, 6);
    seedPower(world, 6, 6);
    seedWater(world, 8, 5);

    const building = addUnitBuilding(world, 1, 1, 'S');
    expect(world.getPowerMap().isPowered(1, 1)).toBe(false);
    expect(world.getWaterMap().isWatered(1, 1)).toBe(false);

    const verdict = evaluateBuildingGrowth(building, coveredRuleContext(world), 0, world);
    expect(verdict.hasRoad).toBe(true);
    expect(verdict.isPowered).toBe(false);
    expect(verdict.isWatered).toBe(false);
    expect(verdict.primaryBlock).toBe('power'); // not 'water'
  });

  it('power present but water missing reports water', () => {
    const world = new World(8, 8, { regenerate: false });
    seedZone(world, 1, 1);
    seedRoad(world, 1, 2);
    seedPower(world, 2, 2); // powers the road; no water tower anywhere
    const building = addUnitBuilding(world, 1, 1, 'S');

    expect(world.getPowerMap().isPowered(1, 1)).toBe(true);
    expect(world.getWaterMap().isWatered(1, 1)).toBe(false);

    const verdict = evaluateBuildingGrowth(building, coveredRuleContext(world), 0, world);
    expect(verdict.isPowered).toBe(true);
    expect(verdict.isWatered).toBe(false);
    expect(verdict.primaryBlock).toBe('water');
  });

  it('road missing outranks both power and water failures (road > power > water)', () => {
    const world = new World(6, 6, { regenerate: false });
    seedZone(world, 1, 1);
    // No road at all → no power/water can reach the cell either.
    const building = addUnitBuilding(world, 1, 1, 'S');
    const verdict = evaluateBuildingGrowth(building, coveredRuleContext(world), 0, world);
    expect(verdict.hasRoad).toBe(false);
    expect(verdict.isPowered).toBe(false);
    expect(verdict.isWatered).toBe(false);
    expect(verdict.primaryBlock).toBe('road');
  });

  it('service and landValue reasons sit behind water in the chain', () => {
    // Hand-built context: road/power/water all open, but the four coverage anchors fail.
    const world = new World(6, 6, { regenerate: false });
    seedZone(world, 1, 1);
    seedRoad(world, 1, 2);
    seedPower(world, 2, 2);
    seedWater(world, 0, 2);
    const building = addUnitBuilding(world, 1, 1, 'S');
    world.markWaterDirty();
    world.recomputeWater();
    expect(world.getWaterMap().isWatered(1, 1)).toBe(true);

    // No stations seeded → every coverage surface reads 0 at the anchor → service block.
    const noService = evaluateBuildingGrowth(building, ruleContext(world), 0, world);
    expect(noService.hasRoad).toBe(true);
    expect(noService.isPowered).toBe(true);
    expect(noService.isWatered).toBe(true);
    expect(noService.isServiceCovered).toBe(false);
    expect(noService.primaryBlock).toBe('service');

    // With coverage forced open via a stub context but land value held below threshold,
    // the chain advances to the final gate. Land value threshold 1 is unreachable (values clamp ≤1
    // only for genuinely maxed anchors; this bare anchor reads far lower).
    const coveredCtx: GrowthRuleContext = {
      ...ruleContext(world),
      police: { getCoverage: () => 255 },
      fire: { getCoverage: () => 255 },
      hospital: { getCoverage: () => 255 },
      school: { getCoverage: () => 255 },
    };
    const lvBlocked = evaluateBuildingGrowth(building, coveredCtx, 1, world);
    expect(lvBlocked.isServiceCovered).toBe(true);
    expect(lvBlocked.meetsLandValue).toBe(false);
    expect(lvBlocked.primaryBlock).toBe('landValue');
  });
});

describe('unified chain — side-effect free and stable within one tick', () => {
  it('repeated evaluations of the same building return deep-identical verdicts and never mutate state', () => {
    const world = new World(8, 8, { regenerate: false });
    seedZone(world, 1, 1);
    seedRoad(world, 1, 2);
    seedPower(world, 2, 2);
    const building = addUnitBuilding(world, 1, 1, 'S');
    const ctx = coveredRuleContext(world);

    const first = evaluateBuildingGrowth(building, ctx, 0.1, world);
    const second = evaluateBuildingGrowth(building, ctx, 0.1, world);
    const third = evaluateBuildingGrowth(building, ctx, 0.1, world);
    expect(second).toEqual(first);
    expect(third).toEqual(first);

    // The building and the snapshot backing arrays are untouched by the read-only chain.
    const untouched = mapBuildingSnapshot(building);
    evaluateBuildingGrowth(building, ctx, 0.1, world);
    expect(mapBuildingSnapshot(building)).toEqual(untouched);
    expect(world.getTick()).toBe(0); // no tick side effects
  });

  it('repeated empty-zone classifications are identical and agree with the spawn-block adapter', () => {
    const world = new World(8, 8, { regenerate: false });
    seedZone(world, 2, 2);
    seedRoad(world, 2, 3);
    const isPowered = () => false; // no plant → the frontage seed is unpowered

    const a = evaluateEmptyZoneSpawn({ x: 2, y: 2 }, world, isPowered);
    const b = evaluateEmptyZoneSpawn({ x: 2, y: 2 }, world, isPowered);
    expect(a).toBe('power');
    expect(b).toBe(a);
    // The legacy adapter and the new chain are literally the same verdict.
    expect(classifyEmptyZoneSpawnBlock({ x: 2, y: 2 }, world, isPowered)).toBe(a);
  });
});

function mapBuildingSnapshot(b: Building) {
  return {
    id: b.id, level: b.level, density: b.density, age: b.age,
    abandoned: b.abandoned, frontage: b.frontage,
    structureRect: { ...b.structureRect },
  };
}

describe('evaluateEmptyZoneSpawn / findCoveringFrontageSeeds — shared coverage with the spawner', () => {
  it('a roadless empty zone reports road; adding power cannot change that verdict', () => {
    const world = new World(8, 8, { regenerate: false });
    seedZone(world, 2, 2);
    expect(findCoveringFrontageSeeds({ x: 2, y: 2 }, world)).toEqual([]);
    expect(evaluateEmptyZoneSpawn({ x: 2, y: 2 }, world, () => true)).toBe('road');
  });

  it('a road-adjacent empty zone reports power when unpowered and null when powered', () => {
    const world = new World(8, 8, { regenerate: false });
    seedZone(world, 2, 2);
    seedRoad(world, 2, 3);
    const seeds = findCoveringFrontageSeeds({ x: 2, y: 2 }, world);
    expect(seeds).toContainEqual({ x: 2, y: 2 });
    expect(evaluateEmptyZoneSpawn({ x: 2, y: 2 }, world, () => false)).toBe('power');
    expect(evaluateEmptyZoneSpawn({ x: 2, y: 2 }, world, () => true)).toBeNull();
  });

  it('respects the 4-cell depth cap and occupancy breaks, matching greedyDepthLot coverage', () => {
    const world = new World(8, 8, { regenerate: false });
    // 1×5 strip with the road one cell beyond the cap.
    for (let y = 0; y < 5; y++) seedZone(world, 2, y);
    seedRoad(world, 2, 5);
    // Depth-3 cell (2,1) is covered by the frontage seed (2,4); the depth-4 cell (2,0) is not.
    expect(evaluateEmptyZoneSpawn({ x: 2, y: 1 }, world, () => true)).toBeNull();
    expect(evaluateEmptyZoneSpawn({ x: 2, y: 0 }, world, () => true)).toBe('road');

    // An occupied frontage cell walls off the cells behind it → road block.
    world.getMap().getBuildings().addBuilding({
      type: 'residential', footprint: [{ x: 2, y: 4 }], anchor: { x: 2, y: 4 },
      level: 1, density: 0, age: 0, abandoned: false, frontage: 'S',
      structureRect: { x: 2, y: 4, w: 1, h: 1 },
    });
    expect(evaluateEmptyZoneSpawn({ x: 2, y: 2 }, world, () => true)).toBe('road');
  });
});
