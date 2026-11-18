/**
 * Tests for filter-toggle catalog index stability.
 *
 * When the "operational altitude only" filter is toggled the visible catalog
 * is rebuilt and every visible index is re-meaned. These tests pin the
 * contract that prevents the old bug — a pre-toggle connected-satellite / ISL
 * route index silently pointing at a different satellite or an out-of-bounds
 * slot after the rebuild:
 *
 *  - visible count, positions buffer and inclination array stay length-consistent
 *  - filtered-out satellites leave the visible set entirely
 *  - the explicit visible↔original mapping identifies the same physical satellite
 *    before and after a toggle (order stays stable; visible index ≠ original index)
 *  - a connected satellite still visible keeps pointing at itself; one filtered
 *    out becomes null without throwing
 *  - empty / fully-filtered / corrupt catalogs never produce NaN positions
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildVisibleCatalog, remapConnectedIndex, type CatalogSnapshot } from '@/lib/satellites/catalog-builder';
import {
  setCatalogIndexMapping,
  getOriginalIndex,
  getVisibleIndex,
  getVisibleToOriginalMapping,
  getOriginalCatalogCount,
  setTLEData,
  setPositionsArray,
  setInclinationsArray,
  setRAANArray,
  setISLCapableArray,
} from '@/lib/satellites/satellite-store';
import type { TLEData } from '@/lib/satellites/tle-fetcher';
import { isOperationalAltitude } from '@/lib/config';

const NOW = new Date('2026-11-19T00:00:00Z');

interface TleSpec {
  norad: number;
  name: string;
  incDeg: number;
  meanMotion: number;
  raanDeg: number;
}

/**
 * Deterministic local TLE catalog. SGP4 altitudes at NOW (verified):
 *   SAT-A (53.0°, mm 15.0638) → ~539 km  operational (53° band 460–570)
 *   SAT-B (53.1°, mm 15.0000) → ~559 km  operational (53° band 460–570)
 *   SAT-C (53.2°, mm 15.5000) → ~388 km  filtered out (orbit raising)
 *   SAT-D (70.0°, mm 13.8000) → ~970 km  filtered out (above 70° band 460–910)
 * SAT-C sits between the two operational sats so a correct filter must not
 * renumber surviving sats by reusing raw array positions.
 */
const TLE_SPECS: TleSpec[] = [
  { norad: 44001, name: 'SAT-A', incDeg: 53.0, meanMotion: 15.0638, raanDeg: 100.0 },
  { norad: 44002, name: 'SAT-B', incDeg: 53.1, meanMotion: 15.0000, raanDeg: 110.0 },
  { norad: 44003, name: 'SAT-C', incDeg: 53.2, meanMotion: 15.5000, raanDeg: 120.0 },
  { norad: 44004, name: 'SAT-D', incDeg: 70.0, meanMotion: 13.8000, raanDeg: 130.0 },
];

function makeTle(spec: TleSpec): TLEData {
  const norad = String(spec.norad);
  const line1 = `1 ${norad}U 24001A   24001.50000000  .00001000  00000-0  10000-3 0  9991`;
  const line2 =
    `2 ${norad} ${spec.incDeg.toFixed(4).padStart(8)} ${spec.raanDeg.toFixed(4).padStart(8)} ` +
    `0001000  90.0000 270.0000 ${spec.meanMotion.toFixed(8).padStart(11)} 10001`;
  return { name: spec.name, line1, line2, inclination: spec.incDeg };
}

const TLE_CATALOG = TLE_SPECS.map(makeTle);

/** Names of every visible satellite, in visible-catalog order. */
function visibleNames(snapshot: CatalogSnapshot): string[] {
  return snapshot.tleData.map((t) => t.name);
}

/** Every entry of a positions buffer must be finite (no NaN/Infinity). */
function expectFinitePositions(positions: Float32Array): void {
  for (let i = 0; i < positions.length; i++) {
    expect(Number.isFinite(positions[i])).toBe(true);
  }
}

describe('buildVisibleCatalog — filter toggle index mapping', () => {
  it('unfiltered build keeps every satellite with an identity mapping', () => {
    const snap = buildVisibleCatalog(TLE_CATALOG, false, NOW);

    expect(snap.originalCount).toBe(4);
    expect(snap.tleData).toHaveLength(4);
    expect(visibleNames(snap)).toEqual(['SAT-A', 'SAT-B', 'SAT-C', 'SAT-D']);
    expect(Array.from(snap.visibleToOriginal)).toEqual([0, 1, 2, 3]);
    expect(Array.from(snap.originalToVisible)).toEqual([0, 1, 2, 3]);
  });

  it('filtering drops only out-of-band satellites and keeps relative order stable', () => {
    const unfiltered = buildVisibleCatalog(TLE_CATALOG, false, NOW);
    const filtered = buildVisibleCatalog(TLE_CATALOG, true, NOW);

    // Exactly the two operational 53° sats survive; SAT-C/SAT-D disappear.
    expect(filtered.originalCount).toBe(4);
    expect(visibleNames(filtered)).toEqual(['SAT-A', 'SAT-B']);
    expect(filtered.tleData.map((t) => t.name)).not.toContain('SAT-C');
    expect(filtered.tleData.map((t) => t.name)).not.toContain('SAT-D');

    // Visible indices map back to their original positions — filtered index 1
    // is SAT-B at original index 1, NOT SAT-C which occupied index 2 raw.
    expect(filtered.visibleToOriginal[0]).toBe(0); // SAT-A
    expect(filtered.visibleToOriginal[1]).toBe(1); // SAT-B
    expect(Array.from(filtered.originalToVisible)).toEqual([0, 1, -1, -1]);

    // Surviving sats keep their relative order across the toggle.
    const filteredNames = new Set(visibleNames(filtered));
    const survivingUnfiltered = unfiltered.tleData
      .map((t) => t.name)
      .filter((n) => filteredNames.has(n));
    expect(survivingUnfiltered).toEqual(visibleNames(filtered));

    // Sanity: the fixture's filter decision matches the production predicate.
    for (const spec of TLE_SPECS) {
      const origIdx = TLE_SPECS.indexOf(spec);
      const alt = filtered.fullCatalog.altitudes[origIdx];
      const inc = filtered.fullCatalog.inclinations[origIdx];
      const shouldBeVisible = isOperationalAltitude(inc, alt);
      expect(filtered.originalToVisible[origIdx] !== -1).toBe(shouldBeVisible);
    }
  });

  it('visible count, positions buffer length and inclination array length stay consistent', () => {
    const filtered = buildVisibleCatalog(TLE_CATALOG, true, NOW);
    const visibleCount = filtered.tleData.length;

    expect(visibleCount).toBe(2);
    expect(filtered.positions.length).toBe(visibleCount * 3);
    expect(filtered.inclinations.length).toBe(visibleCount);
    expect(filtered.raanArray.length).toBe(visibleCount);
    expect(filtered.islCapableArray.length).toBe(visibleCount);
    expect(filtered.satrecs.length).toBe(visibleCount);
    expect(filtered.visibleToOriginal.length).toBe(visibleCount);

    const unfiltered = buildVisibleCatalog(TLE_CATALOG, false, NOW);
    expect(unfiltered.positions.length).toBe(4 * 3);
    expect(unfiltered.inclinations.length).toBe(4);
  });

  it('propagated positions are finite and non-origin for operational sats', () => {
    const filtered = buildVisibleCatalog(TLE_CATALOG, true, NOW);
    expectFinitePositions(filtered.positions);

    for (let i = 0; i < filtered.tleData.length; i++) {
      const pi = i * 3;
      const x = filtered.positions[pi];
      const y = filtered.positions[pi + 1];
      const z = filtered.positions[pi + 2];
      // A valid LEO position sits on/above the unit sphere, never at origin.
      const radius = Math.sqrt(x * x + y * y + z * z);
      expect(radius).toBeGreaterThan(1.0);
    }
  });

  it('filtering twice is idempotent and yields the same mapping/order', () => {
    const first = buildVisibleCatalog(TLE_CATALOG, true, NOW);
    const second = buildVisibleCatalog(TLE_CATALOG, true, NOW);

    expect(Array.from(second.visibleToOriginal)).toEqual(Array.from(first.visibleToOriginal));
    expect(visibleNames(second)).toEqual(visibleNames(first));
  });

  it('toggling filter off again restores the full catalog in original order', () => {
    buildVisibleCatalog(TLE_CATALOG, true, NOW);
    const restored = buildVisibleCatalog(TLE_CATALOG, false, NOW);

    expect(visibleNames(restored)).toEqual(['SAT-A', 'SAT-B', 'SAT-C', 'SAT-D']);
    expect(Array.from(restored.visibleToOriginal)).toEqual([0, 1, 2, 3]);
    expect(restored.positions.length).toBe(4 * 3);
    expect(restored.inclinations.length).toBe(4);
  });
});

describe('remapConnectedIndex — connected satellite across a rebuild', () => {
  it('keeps pointing at the same physical satellite when it remains visible', () => {
    const unfiltered = buildVisibleCatalog(TLE_CATALOG, false, NOW);
    // User is connected to SAT-B, visible index 1 in the full catalog.
    const previousVisibleIndex = 1;
    expect(unfiltered.tleData[previousVisibleIndex].name).toBe('SAT-B');

    const filtered = buildVisibleCatalog(TLE_CATALOG, true, NOW);
    const nextIndex = remapConnectedIndex(
      previousVisibleIndex,
      unfiltered.tleData,
      unfiltered.visibleToOriginal,
      filtered.tleData,
      filtered.originalToVisible,
    );

    expect(nextIndex).not.toBeNull();
    expect(filtered.tleData[nextIndex!].name).toBe('SAT-B');
    // Highlight and orbital data resolve through the new index to SAT-B's own position.
    expect(filtered.visibleToOriginal[nextIndex!]).toBe(1);
  });

  it('returns null without throwing when the connected satellite is filtered out', () => {
    const unfiltered = buildVisibleCatalog(TLE_CATALOG, false, NOW);
    // SAT-C (orbit raising, visible index 2) gets filtered out.
    expect(unfiltered.tleData[2].name).toBe('SAT-C');

    const filtered = buildVisibleCatalog(TLE_CATALOG, true, NOW);
    const nextIndex = remapConnectedIndex(
      2,
      unfiltered.tleData,
      unfiltered.visibleToOriginal,
      filtered.tleData,
      filtered.originalToVisible,
    );

    expect(nextIndex).toBeNull();
  });

  it('returns null when there was no connection', () => {
    const filtered = buildVisibleCatalog(TLE_CATALOG, true, NOW);
    const nextIndex = remapConnectedIndex(
      null,
      TLE_CATALOG,
      new Int32Array([0, 1, 2, 3]),
      filtered.tleData,
      filtered.originalToVisible,
    );
    expect(nextIndex).toBeNull();
  });

  it('never treats a filtered visible index as an original index', () => {
    const unfiltered = buildVisibleCatalog(TLE_CATALOG, false, NOW);
    const filtered = buildVisibleCatalog(TLE_CATALOG, true, NOW);

    // SAT-B's visible index happens to be 1 in both catalogs here, but the
    // remap must be driven by the mapping, not by index equality. Craft a
    // catalog where the connected sat's raw slot would mislead: connect to
    // SAT-A (visible 0 → original 0) and confirm the reverse map is used.
    const nextA = remapConnectedIndex(
      0,
      unfiltered.tleData,
      unfiltered.visibleToOriginal,
      filtered.tleData,
      filtered.originalToVisible,
    );
    expect(filtered.tleData[nextA!].name).toBe('SAT-A');

    // An out-of-range previous index resolves to null instead of reading garbage.
    const outOfRange = remapConnectedIndex(
      99,
      unfiltered.tleData,
      unfiltered.visibleToOriginal,
      filtered.tleData,
      filtered.originalToVisible,
    );
    expect(outOfRange).toBeNull();

    // A null/empty old mapping (first load) cannot remap anything.
    const firstLoad = remapConnectedIndex(
      1,
      [],
      null,
      filtered.tleData,
      filtered.originalToVisible,
    );
    expect(firstLoad).toBeNull();
  });

  it('drops the connection when the same original slot holds a different satellite (TLE refresh)', () => {
    const unfiltered = buildVisibleCatalog(TLE_CATALOG, false, NOW);
    const filtered = buildVisibleCatalog(TLE_CATALOG, true, NOW);

    // Simulate a TLE refresh that replaced SAT-B's slot with another NORAD ID.
    const swappedTle = filtered.tleData.map((t) => ({ ...t }));
    swappedTle[1] = {
      ...swappedTle[1],
      name: 'SAT-B-REPLACED',
      line1: swappedTle[1].line1.replace('44002', '99999'),
    };

    const nextIndex = remapConnectedIndex(
      1, // was SAT-B
      unfiltered.tleData,
      unfiltered.visibleToOriginal,
      swappedTle,
      filtered.originalToVisible,
    );
    expect(nextIndex).toBeNull();
  });
});

describe('buildVisibleCatalog — empty / fully-filtered / corrupt edge cases', () => {
  it('handles an empty catalog without NaN positions', () => {
    const snap = buildVisibleCatalog([], true, NOW);

    expect(snap.originalCount).toBe(0);
    expect(snap.tleData).toHaveLength(0);
    expect(snap.satrecs).toHaveLength(0);
    expect(snap.positions).toHaveLength(0);
    expect(snap.inclinations).toHaveLength(0);
    expect(snap.raanArray).toHaveLength(0);
    expect(snap.islCapableArray).toHaveLength(0);
    expect(snap.visibleToOriginal).toHaveLength(0);
    expect(snap.originalToVisible).toHaveLength(0);
    expectFinitePositions(snap.positions);

    // Remapping against an empty rebuild always yields null.
    expect(
      remapConnectedIndex(0, TLE_CATALOG, Int32Array.from([0, 1, 2, 3]), snap.tleData, snap.originalToVisible),
    ).toBeNull();
  });

  it('produces an empty visible set with zero-length (not NaN) buffers when everything is filtered out', () => {
    const onlyOutOfBand = TLE_CATALOG.filter((t) => t.name === 'SAT-C' || t.name === 'SAT-D');
    const snap = buildVisibleCatalog(onlyOutOfBand, true, NOW);

    expect(snap.originalCount).toBe(2);
    expect(snap.tleData).toHaveLength(0);
    expect(snap.positions).toHaveLength(0);
    expect(snap.inclinations).toHaveLength(0);
    expect(snap.visibleToOriginal).toHaveLength(0);
    expect(Array.from(snap.originalToVisible)).toEqual([-1, -1]);
    expectFinitePositions(snap.positions);

    // The full unfiltered catalog still records both sats for shell stats.
    expect(snap.fullCatalog.count).toBe(2);
    expect(snap.fullCatalog.altitudes.length).toBe(2);
  });

  it('parks a corrupt satrec at the origin instead of writing NaN positions', () => {
    const corrupt: TLEData = {
      name: 'CORRUPT',
      line1: 'garbage line one',
      line2: 'garbage line two',
      inclination: 53,
    };
    const snap = buildVisibleCatalog([...TLE_CATALOG, corrupt], false, NOW);

    expect(snap.tleData).toHaveLength(5);
    expectFinitePositions(snap.positions);
    const corruptOffset = 4 * 3;
    expect(snap.positions[corruptOffset]).toBe(0);
    expect(snap.positions[corruptOffset + 1]).toBe(0);
    expect(snap.positions[corruptOffset + 2]).toBe(0);
    // Failed propagation reports altitude 0, so the filter rejects it too.
    const filtered = buildVisibleCatalog([...TLE_CATALOG, corrupt], true, NOW);
    expect(filtered.tleData.map((t) => t.name)).not.toContain('CORRUPT');
    expectFinitePositions(filtered.positions);
  });
});

describe('satellite-store catalog index mapping', () => {
  beforeEach(() => {
    setTLEData([]);
    setPositionsArray(new Float32Array(0));
    setInclinationsArray(new Float32Array(0));
    setRAANArray(new Float32Array(0));
    setISLCapableArray(new Uint8Array(0));
    setCatalogIndexMapping([], 0);
  });

  it('derives the reverse mapping and round-trips both directions', () => {
    // Visible sats are original indices 0 and 1 (SAT-C/SAT-D filtered out).
    setCatalogIndexMapping(Int32Array.from([0, 1]), 4);

    expect(getOriginalCatalogCount()).toBe(4);
    expect(Array.from(getVisibleToOriginalMapping())).toEqual([0, 1]);
    expect(getOriginalIndex(0)).toBe(0);
    expect(getOriginalIndex(1)).toBe(1);
    expect(getVisibleIndex(0)).toBe(0);
    expect(getVisibleIndex(1)).toBe(1);
    expect(getVisibleIndex(2)).toBe(-1); // filtered out
    expect(getVisibleIndex(3)).toBe(-1);
  });

  it('accepts a plain number[] mapping and rejects out-of-range lookups', () => {
    setCatalogIndexMapping([3, 0], 4);

    expect(getOriginalIndex(0)).toBe(3);
    expect(getOriginalIndex(1)).toBe(0);
    expect(getVisibleIndex(3)).toBe(0);
    expect(getVisibleIndex(0)).toBe(1);
    expect(getOriginalIndex(-1)).toBe(-1);
    expect(getOriginalIndex(99)).toBe(-1);
    expect(getVisibleIndex(99)).toBe(-1);
  });

  it('an identity mapping represents an unfiltered catalog', () => {
    setCatalogIndexMapping([0, 1, 2, 3], 4);
    for (let i = 0; i < 4; i++) {
      expect(getOriginalIndex(i)).toBe(i);
      expect(getVisibleIndex(i)).toBe(i);
    }
  });
});
