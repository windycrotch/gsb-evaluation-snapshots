/**
 * Visible satellite catalog construction.
 *
 * The propagator rebuilds the whole catalog whenever the TLE set or the
 * "operational altitude only" filter changes. Every rebuild re-meaning the
 * visible indices, so this module owns two things together:
 *
 *  1. The rebuilt arrays (satrecs, positions, inclinations, RAAN/ISL) and
 *  2. The explicit visible↔original index mapping that lets consumers find
 *     the same physical satellite before and after a filter toggle.
 *
 * A filtered visible index must never be used as an original-catalog index —
 * always go through the mapping returned here.
 */

import type { TLEData } from './tle-fetcher';
import { initSatelliteRecords, propagateBatch, propagateSingle, type SatRec } from './propagator';
import { computeISLArrays } from './isl-capability';
import { parseLaunchYear } from './tle-parse';
import { isOperationalAltitude } from '../config';

export interface CatalogSnapshot {
  /** Filtered TLE records, ordered by original catalog index. */
  tleData: TLEData[];
  /** Satrecs aligned with tleData (same ordering, same length). */
  satrecs: SatRec[];
  /** Original-catalog index for each visible entry: tleData[i] is the
   *  original satellite at visibleToOriginal[i]. */
  visibleToOriginal: Int32Array;
  /** Reverse lookup: visible index for each original index, -1 if filtered out. */
  originalToVisible: Int32Array;
  /** Number of satellites in the original (unfiltered) catalog. */
  originalCount: number;
  positions: Float32Array;
  inclinations: Float32Array;
  raanArray: Float32Array;
  islCapableArray: Uint8Array;
  /** Full unfiltered catalog snapshot for shell statistics. */
  fullCatalog: {
    count: number;
    inclinations: Float32Array;
    altitudes: Float32Array;
    launchYears: Uint16Array;
  };
}

/** Parse inclination from TLE line 2 columns 8-16, falling back to the 53° shell. */
function parseInclination(tle: TLEData): number {
  const inc = parseFloat(tle.line2.substring(8, 16));
  return isNaN(inc) ? 53 : inc;
}

/**
 * Build the visible catalog from a TLE set.
 *
 * @param tleData     Full unfiltered TLE catalog (original ordering is preserved).
 * @param filterOn    When true, only satellites at their shell's operational
 *                    altitude are kept. When false the mapping is identity.
 * @param now         Reference time for the initial altitude/position propagation.
 */
export function buildVisibleCatalog(
  tleData: TLEData[],
  filterOn: boolean,
  now: Date,
): CatalogSnapshot {
  const originalCount = tleData.length;
  const allSatrecs = initSatelliteRecords(tleData);

  // Propagate every satellite once for full-catalog stats and filter predicates.
  const allInclinations = new Float32Array(originalCount);
  const allAltitudes = new Float32Array(originalCount);
  const allLaunchYears = new Uint16Array(originalCount);
  for (let i = 0; i < originalCount; i++) {
    allInclinations[i] = parseInclination(tleData[i]);
    const data = propagateSingle(allSatrecs[i], now);
    // A failed propagation reports altitude 0, which the filter rejects —
    // never feed NaN into the operational-altitude predicate.
    allAltitudes[i] = data ? data.altitudeKm : 0;
    allLaunchYears[i] = parseLaunchYear(tleData[i].line1);
  }

  // Build the visible subset by walking the original catalog in order — this
  // keeps relative satellite order stable across filter toggles.
  const keptOriginalIndices: number[] = [];
  if (filterOn) {
    for (let i = 0; i < originalCount; i++) {
      if (isOperationalAltitude(allInclinations[i], allAltitudes[i])) {
        keptOriginalIndices.push(i);
      }
    }
  } else {
    for (let i = 0; i < originalCount; i++) keptOriginalIndices.push(i);
  }
  const visibleToOriginal = Int32Array.from(keptOriginalIndices);
  const visibleCount = visibleToOriginal.length;

  const originalToVisible = new Int32Array(originalCount).fill(-1);
  const visibleTle: TLEData[] = new Array(visibleCount);
  const visibleSatrecs: SatRec[] = new Array(visibleCount);
  for (let visibleIdx = 0; visibleIdx < visibleCount; visibleIdx++) {
    const originalIdx = visibleToOriginal[visibleIdx];
    originalToVisible[originalIdx] = visibleIdx;
    visibleTle[visibleIdx] = tleData[originalIdx];
    visibleSatrecs[visibleIdx] = allSatrecs[originalIdx];
  }

  const positions = new Float32Array(visibleCount * 3);
  const inclinations = new Float32Array(visibleCount);
  const launchYears = new Uint16Array(visibleCount);
  const lines2: string[] = new Array(visibleCount);
  for (let i = 0; i < visibleCount; i++) {
    inclinations[i] = parseInclination(visibleTle[i]);
    launchYears[i] = parseLaunchYear(visibleTle[i].line1);
    lines2[i] = visibleTle[i].line2;
  }

  const { raanArray, islCapableArray } = computeISLArrays(
    lines2, inclinations, launchYears, visibleCount,
  );

  // Initial propagation — propagateBatch already parks failed satellites at
  // the origin rather than writing NaN, but sanitize defensively so no consumer
  // (incl. empty/fully-filtered catalogs) can ever read a NaN position.
  propagateBatch(visibleSatrecs, now, 0, visibleCount, positions);
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) positions[i] = 0;
  }

  return {
    tleData: visibleTle,
    satrecs: visibleSatrecs,
    visibleToOriginal,
    originalToVisible,
    originalCount,
    positions,
    inclinations,
    raanArray,
    islCapableArray,
    fullCatalog: {
      count: originalCount,
      inclinations: allInclinations,
      altitudes: allAltitudes,
      launchYears: allLaunchYears,
    },
  };
}

/** NORAD catalog ID parsed from TLE line 1 columns 3-7; '' when unavailable. */
function noradIdOf(tle: TLEData | undefined): string {
  if (!tle) return '';
  return tle.line1.substring(2, 7).trim();
}

/**
 * Translate a previously-connected visible index across a catalog rebuild.
 *
 * Returns the new visible index of the same physical satellite, or null when
 * the satellite was filtered out / no connection existed. The old mapping
 * converts the visible index to an original index, and the new reverse map
 * locates it in the rebuilt catalog — a filtered visible index is never
 * reinterpreted as an original one. The NORAD check guards against TLE
 * refreshes that reused the same slot for a different satellite.
 */
export function remapConnectedIndex(
  previousVisibleIndex: number | null,
  oldTle: TLEData[],
  oldVisibleToOriginal: Int32Array | null,
  newTle: TLEData[],
  newOriginalToVisible: Int32Array,
): number | null {
  if (previousVisibleIndex === null) return null;
  if (!oldVisibleToOriginal || previousVisibleIndex < 0 ||
      previousVisibleIndex >= oldVisibleToOriginal.length) {
    return null;
  }

  const originalIdx = oldVisibleToOriginal[previousVisibleIndex];
  if (originalIdx < 0 || originalIdx >= newOriginalToVisible.length) return null;

  const newVisibleIdx = newOriginalToVisible[originalIdx];
  if (newVisibleIdx < 0) return null; // filtered out

  // Same original slot must still hold the same physical satellite.
  const oldId = noradIdOf(oldTle[previousVisibleIndex]);
  const newId = noradIdOf(newTle[newVisibleIdx]);
  if (oldId !== '' && newId !== '' && oldId !== newId) return null;

  return newVisibleIdx;
}
