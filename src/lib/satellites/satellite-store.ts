/**
 * In-memory satellite catalog.
 * Stores TLE data and satrec objects for satellite propagation.
 */

import type { TLEData } from './tle-fetcher';
import type { SatRec, SatelliteOrbitalData } from './propagator';
import { parseLaunchInfoFromLine1 } from './tle-parse';

let tleData: TLEData[] = [];
let satrecObjects: SatRec[] = [];
let connectedIndex: number | null = null;
let positionsArray: Float32Array | null = null;
let connectedOrbitalData: SatelliteOrbitalData | null = null;
let connectedGroundStation: string | null = null;
let inclinationsArray: Float32Array | null = null;

// Full (unfiltered) catalog — used for shell stats regardless of altitude filter toggle
let fullCatalogCount = 0;
let fullCatalogInclinations: Float32Array | null = null;
let fullCatalogAltitudes: Float32Array | null = null;
let fullCatalogLaunchYears: Uint16Array | null = null;

// ISL augmentation arrays
let raanArray: Float32Array | null = null;
let islCapableArray: Uint8Array | null = null;

// Index mapping between the visible (possibly altitude-filtered) catalog and
// the full unfiltered catalog. All render/state indices in this module refer
// to the VISIBLE catalog; the mapping is the only sanctioned way to reach the
// underlying satellite — visible index N must never be treated as an original
// catalog index after a filter toggle.
//   visibleToOriginal[visibleIdx] = original catalog index
//   originalToVisible[originalIdx] = visible catalog index, or -1 when filtered out
let visibleToOriginalIndices: Int32Array = new Int32Array(0);
let originalToVisibleIndices: Int32Array = new Int32Array(0);
let originalCatalogCount = 0;

// Current ISL route
export interface RoutePath {
  type: 'direct' | 'isl';
  satelliteIndices: number[];
  groundStationIndex: number;
  latencyMs: number;
  hopCount: number;
}

let currentRoute: RoutePath | null = null;

// Detected PoP (Point of Presence) — set from /api/pop response
let detectedPop: string | null = null;

/** Set the TLE data catalog */
export function setTLEData(data: TLEData[]): void {
  tleData = data;
}

/** Set the satrec objects */
export function setSatrecObjects(satrecs: SatRec[]): void {
  satrecObjects = satrecs;
}

/** Get the full TLE data catalog */
export function getTLEData(): TLEData[] {
  return tleData;
}

/** Get the total number of satellites */
export function getSatelliteCount(): number {
  return tleData.length;
}

/** Get a satellite name by index */
export function getSatelliteName(index: number): string {
  return tleData[index]?.name ?? 'Unknown';
}

/** Get the satrec objects */
export function getSatrecs(): SatRec[] {
  return satrecObjects;
}

/** Set which satellite is "connected" */
export function setConnectedIndex(index: number | null): void {
  connectedIndex = index;
}

/** Get the connected satellite index */
export function getConnectedIndex(): number | null {
  return connectedIndex;
}

/** Set the shared satellite positions Float32Array */
export function setPositionsArray(positions: Float32Array): void {
  positionsArray = positions;
}

/** Get the shared satellite positions Float32Array */
export function getPositionsArray(): Float32Array | null {
  return positionsArray;
}

/** Set orbital data for the connected satellite */
export function setConnectedOrbitalData(data: SatelliteOrbitalData | null): void {
  connectedOrbitalData = data;
}

/** Get orbital data for the connected satellite */
export function getConnectedOrbitalData(): SatelliteOrbitalData | null {
  return connectedOrbitalData;
}

/** Set connected ground station name */
export function setConnectedGroundStation(name: string | null): void {
  connectedGroundStation = name;
}

/** Get connected ground station name */
export function getConnectedGroundStation(): string | null {
  return connectedGroundStation;
}

/** Set the inclinations array */
export function setInclinationsArray(inclinations: Float32Array): void {
  inclinationsArray = inclinations;
}

/** Get the inclinations array */
export function getInclinationsArray(): Float32Array | null {
  return inclinationsArray;
}

/** Store the full unfiltered catalog snapshot for shell statistics */
export function setFullCatalog(count: number, inclinations: Float32Array, altitudes: Float32Array, launchYears: Uint16Array): void {
  fullCatalogCount = count;
  fullCatalogInclinations = inclinations;
  fullCatalogAltitudes = altitudes;
  fullCatalogLaunchYears = launchYears;
}

/** Get full catalog data for shell statistics */
export function getFullCatalog(): { count: number; inclinations: Float32Array | null; altitudes: Float32Array | null; launchYears: Uint16Array | null } {
  return { count: fullCatalogCount, inclinations: fullCatalogInclinations, altitudes: fullCatalogAltitudes, launchYears: fullCatalogLaunchYears };
}

/** Set the RAAN array */
export function setRAANArray(raans: Float32Array): void {
  raanArray = raans;
}

/** Get the RAAN array */
export function getRAANArray(): Float32Array | null {
  return raanArray;
}

/** Set the ISL capability array */
export function setISLCapableArray(capable: Uint8Array): void {
  islCapableArray = capable;
}

/** Get the ISL capability array */
export function getISLCapableArray(): Uint8Array | null {
  return islCapableArray;
}

/**
 * Store the mapping between visible-catalog indices and original-catalog
 * indices. The reverse mapping is derived here so the two directions can
 * never disagree. Called on every catalog rebuild (TLE refresh or filter
 * toggle) — an unfiltered catalog passes the identity permutation.
 */
export function setCatalogIndexMapping(
  visibleToOriginal: Int32Array | number[],
  totalOriginalCount: number,
): void {
  const forward = visibleToOriginal instanceof Int32Array
    ? visibleToOriginal
    : Int32Array.from(visibleToOriginal);
  const reverse = new Int32Array(totalOriginalCount).fill(-1);
  for (let visibleIdx = 0; visibleIdx < forward.length; visibleIdx++) {
    const originalIdx = forward[visibleIdx];
    if (originalIdx >= 0 && originalIdx < totalOriginalCount) {
      reverse[originalIdx] = visibleIdx;
    }
  }
  visibleToOriginalIndices = forward;
  originalToVisibleIndices = reverse;
  originalCatalogCount = totalOriginalCount;
}

/** Map a visible-catalog index to its original-catalog index.
 *  Returns -1 when the index is out of range. */
export function getOriginalIndex(visibleIndex: number): number {
  if (visibleIndex < 0 || visibleIndex >= visibleToOriginalIndices.length) return -1;
  return visibleToOriginalIndices[visibleIndex];
}

/** Map an original-catalog index to its current visible-catalog index.
 *  Returns -1 when the satellite was filtered out (or never existed). */
export function getVisibleIndex(originalIndex: number): number {
  if (originalIndex < 0 || originalIndex >= originalToVisibleIndices.length) return -1;
  return originalToVisibleIndices[originalIndex];
}

/** Get the full visible→original index mapping (render/state consumers use
 *  this instead of assuming visible indices equal original indices). */
export function getVisibleToOriginalMapping(): Int32Array {
  return visibleToOriginalIndices;
}

/** Number of satellites in the original (unfiltered) catalog. */
export function getOriginalCatalogCount(): number {
  return originalCatalogCount;
}

/** Set the current ISL route */
export function setCurrentRoute(route: RoutePath | null): void {
  currentRoute = route;
}

/** Get the current ISL route */
export function getCurrentRoute(): RoutePath | null {
  return currentRoute;
}

/** Set the detected PoP */
export function setDetectedPop(pop: string | null): void {
  detectedPop = pop;
}

/** Get the detected PoP */
export function getDetectedPop(): string | null {
  return detectedPop;
}

/** Get NORAD catalog ID from TLE line 1 */
export function getNoradId(index: number): string {
  const tle = tleData[index];
  if (!tle) return '---';
  return tle.line1.substring(2, 7).trim();
}

/** Parse international designator from TLE line 1 (columns 9-16) → { year, launch } */
export function getLaunchInfo(index: number): { year: number; launch: string } | null {
  const tle = tleData[index];
  if (!tle) return null;
  return parseLaunchInfoFromLine1(tle.line1);
}
