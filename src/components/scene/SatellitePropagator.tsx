'use client';

import { useRef, useEffect, useCallback } from 'react';
import { useFrame } from '@react-three/fiber';
import { useSatellites } from '@/hooks/useSatellites';
import { propagateBatch, propagateSingle } from '@/lib/satellites/propagator';
import {
  setTLEData,
  setSatrecObjects,
  setPositionsArray,
  setConnectedOrbitalData,
  setInclinationsArray,
  setFullCatalog,
  setRAANArray,
  setISLCapableArray,
  setCurrentRoute,
  setCatalogIndexMapping,
  getVisibleToOriginalMapping,
} from '@/lib/satellites/satellite-store';
import { buildVisibleCatalog, remapConnectedIndex } from '@/lib/satellites/catalog-builder';
import { resetRouteState } from '@/lib/utils/isl-pathfinder';
import { useAppStore } from '@/stores/app-store';
import type { TLEData } from '@/lib/satellites/tle-fetcher';
import type { SatRec } from '@/lib/satellites/propagator';

const NUM_BATCHES = 6;

/**
 * Headless component that owns satellite propagation.
 * Always mounted regardless of camera mode — writes positions
 * into the shared positionsArray in satellite-store.
 */
export default function SatellitePropagator() {
  const { tleData, loading } = useSatellites();
  const satrecsRef = useRef<SatRec[]>([]);
  const positionsRef = useRef<Float32Array | null>(null);
  const batchIndexRef = useRef(0);
  const countRef = useRef(0);
  // Visible TLE catalog from the previous rebuild, retained so the connected
  // satellite can be identified across the next rebuild (the store's TLE is
  // overwritten during the rebuild itself).
  const previousTleRef = useRef<TLEData[]>([]);
  const altitudeFilter = useAppStore((s) => s.altitudeFilter);

  // Rebuild the visible catalog when TLE data arrives or the filter changes.
  // A rebuild re-meanings every visible index, so the rebuild owns the
  // visible↔original index mapping and translates (or drops) the connected
  // satellite through it instead of letting a stale index point at another
  // satellite or an out-of-bounds slot.
  useEffect(() => {
    if (!tleData || tleData.length === 0) return;

    const now = new Date();
    const previousConnectedIndex = useAppStore.getState().connectedSatelliteIndex;
    const previousTle = previousTleRef.current;
    const previousMapping = getVisibleToOriginalMapping();

    const catalog = buildVisibleCatalog(tleData, altitudeFilter, now);

    console.log(
      `Showing ${catalog.tleData.length} satellites${altitudeFilter ? ` (filtered from ${catalog.originalCount})` : ''}`,
    );

    setTLEData(catalog.tleData);
    setSatrecObjects(catalog.satrecs);
    satrecsRef.current = catalog.satrecs;
    previousTleRef.current = catalog.tleData;

    const count = catalog.satrecs.length;
    countRef.current = count;
    positionsRef.current = catalog.positions;
    setPositionsArray(catalog.positions);
    setInclinationsArray(catalog.inclinations);
    setRAANArray(catalog.raanArray);
    setISLCapableArray(catalog.islCapableArray);
    setFullCatalog(
      catalog.fullCatalog.count,
      catalog.fullCatalog.inclinations,
      catalog.fullCatalog.altitudes,
      catalog.fullCatalog.launchYears,
    );
    // Explicit visible↔original mapping — consumers must not treat a visible
    // index as an original-catalog index.
    setCatalogIndexMapping(catalog.visibleToOriginal, catalog.originalCount);

    console.log(`Loaded ${count} satellites`);
    useAppStore.getState().setSatellitesLoaded(true);

    // Route indices are always rebuilt from scratch — a held route's hop
    // indices cannot survive the re-meaning. The connected satellite is only
    // retained when the same physical satellite remains visible; otherwise
    // its state goes null rather than silently highlighting another satellite
    // or reading an out-of-bounds position.
    setCurrentRoute(null);
    resetRouteState();
    const nextConnectedIndex = remapConnectedIndex(
      previousConnectedIndex,
      previousTle,
      previousMapping.length > 0 ? previousMapping : null,
      catalog.tleData,
      catalog.originalToVisible,
    );
    if (nextConnectedIndex === null) {
      setConnectedOrbitalData(null);
    }
    useAppStore.getState().setConnectedSatellite(nextConnectedIndex);
    useAppStore.getState().bumpSatellitesVersion();
  }, [tleData, altitudeFilter]);

  // Update connected satellite orbital data (every 500ms)
  const orbitalUpdateRef = useRef(0);
  useFrame(() => {
    const now = performance.now();
    if (now - orbitalUpdateRef.current < 500) return;
    orbitalUpdateRef.current = now;

    const idx = useAppStore.getState().connectedSatelliteIndex;
    const satrecs = satrecsRef.current;
    if (idx !== null && satrecs[idx]) {
      const data = propagateSingle(satrecs[idx], new Date());
      setConnectedOrbitalData(data);
    } else {
      setConnectedOrbitalData(null);
    }
  });

  // Per-frame batched propagation
  const propagateFrame = useCallback(() => {
    const satrecs = satrecsRef.current;
    const positions = positionsRef.current;
    const count = countRef.current;

    if (!satrecs.length || !positions || count === 0) return;

    const now = new Date();
    const batchSize = Math.ceil(count / NUM_BATCHES);
    const batchIdx = batchIndexRef.current;
    const startIdx = batchIdx * batchSize;
    const batchCount = Math.min(batchSize, count - startIdx);

    if (batchCount > 0) {
      propagateBatch(satrecs, now, startIdx, batchCount, positions);
    }

    batchIndexRef.current = (batchIdx + 1) % NUM_BATCHES;
  }, []);

  useFrame(propagateFrame);

  if (loading || !tleData) return null;
  return null;
}
