#!/usr/bin/env node
/**
 * Reproducible geometry verification for ConicPolygonGeometry.
 *
 * Runs in plain Node (ESM, no browser, no network, no external data files) and
 * exercises the real library source through `geoPolygonTriangulate` and
 * `ConicPolygonGeometry`.
 *
 * Every sample is built twice, once with `curvatureResolution = 1` and once
 * with the default `5`, and each variant is checked for:
 *
 *   1. group layout     exactly three groups, in the documented order
 *                       (0 = side, 1 = bottom cap, 2 = top cap); the side group
 *                       holds 6 indices per contour point, each cap holds one
 *                       index triple per triangulated cap triangle; the groups
 *                       tile the index buffer without gaps or overlap.
 *   2. index bounds     all indices are integers in [0, position.count); the
 *                       uv attribute has one entry per position.
 *   3. cap containment  every non-degenerate cap triangle, projected onto the
 *                       unit sphere, has its centroid inside the polygon and
 *                       outside every hole.
 *   4. cap orientation  every non-degenerate cap triangle winds so its
 *                       geometric normal points along the height direction:
 *                       away from the sphere centre for the top cap, toward it
 *                       for the bottom cap.
 *   5. side wall        the side group is watertight: each rim edge belongs to
 *                       exactly one triangle, and every edge that joins a
 *                       top-rim vertex to a bottom-rim vertex (the vertical
 *                       edges and the per-quad diagonals) is shared by exactly
 *                       two triangles. A hole in the wall (侧面破口) and a
 *                       folded or duplicated face both show up here.
 *   6. cap coverage     interior lattice points of the polygon are covered by
 *                       at least one top-cap triangle, which detects missing
 *                       triangles (三角形漏填).
 *   7. clone()          every constructor parameter survives clone() and the
 *                       clone reproduces the same buffers and groups.
 *   8. optional surfaces disabling a surface must not renumber the remaining
 *                       groups: 0/1/2 always identify side/bottom/top.
 *
 * Winding note: spherical containment (d3-geo `geoContains`) is winding
 * sensitive. Exterior rings below are wound clockwise in lon/lat and holes
 * counter-clockwise, the convention used by Natural Earth and d3-geo.
 *
 * Tolerances (documented where they are defined):
 *   - triangles below DEGENERATE_AREA_SR are ignored for orientation and
 *     containment: earcut/Delaunator drop collinear points, leaving zero-area
 *     triangles whose normal is pure round-off;
 *   - cap centroids closer than BOUNDARY_TOL_DEG to a ring are skipped for the
 *     containment test, because floating point decides inside/outside
 *     arbitrarily on the seam;
 *   - coverage only inspects points further than COVERAGE_MARGIN_DEG (or one
 *     `curvatureResolution`, if larger) from the boundary, because the centroid
 *     filter that the library applies to boundary-straddling Delaunay triangles
 *     legitimately leaves an approximately one-spacing sliver near the rim.
 *
 * Exit code 0 when every sample passes, 1 otherwise (failing sample name and
 * reason are printed).
 */

import { geoArea, geoContains } from 'd3-geo';

import ConicPolygonGeometry from '../src/index.js';
import geoPolygonTriangulate from '../src/geoPolygonTriangulate.js';

// ---------------------------------------------------------------------------
// Tolerances
// ---------------------------------------------------------------------------

/** Spherical area (steradians) below which a cap triangle counts as degenerate. */
const DEGENERATE_AREA_SR = 1e-7;

/** Cap centroids within this many degrees of a ring are exempt from containment. */
const BOUNDARY_TOL_DEG = 0.5;

/**
 * Coverage lattice points must lie at least this far inside the polygon.
 *
 * The library discards a Delaunay/Voronoi triangle whose centroid sample falls
 * outside the polygon. A triangle that straddles the rim can therefore be
 * dropped even though part of it is inside, leaving a legitimate sliver of
 * missing cover up to roughly one mesh spacing from the boundary. Mesh spacing
 * is bounded by `curvatureResolution`, so one resolution width is exempt.
 */
const COVERAGE_MARGIN_DEG = 3;

/**
 * Minimum number of interior lattice points the coverage check must sample.
 * A sample that yields fewer points would silently pass the coverage check
 * without testing anything, so that is reported as a failure instead.
 */
const MIN_COVERAGE_SAMPLES = 20;

/** Minimum fraction of the polygon area the cap triangles must cover. */
const MIN_CAP_AREA_RATIO = 0.9;

// ---------------------------------------------------------------------------
// Vector helpers (unit sphere, matching the library's polar2Cartesian axes)
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const length = v => Math.hypot(v[0], v[1], v[2]);
const normalize = v => {
  const l = length(v);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
};
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * [lng, lat] degrees -> unit vector. This mirrors the library's
 * polar2Cartesian(lat, lng, 1):
 *   x = sin(phi) * cos(theta), y = cos(phi), z = sin(phi) * sin(theta)
 * with phi = (90 - lat), theta = (90 - lng).
 */
const toVector = ([lng, lat]) => {
  const phi = lat * DEG;
  const theta = lng * DEG;
  return [
    Math.cos(phi) * Math.sin(theta),
    Math.sin(phi),
    Math.cos(phi) * Math.cos(theta)
  ];
};

/** Unit vector -> [lng, lat] degrees (inverse of toVector). */
const toLngLat = v => {
  const l = length(v) || 1;
  return [
    Math.atan2(v[0], v[2]) * RAD,
    Math.asin(clamp(v[1] / l, -1, 1)) * RAD
  ];
};

/** Spherical excess (steradians) of the spherical triangle through unit vectors. */
const sphericalTriangleArea = (a, b, c) => {
  const num = Math.abs(dot(a, cross(b, c)));
  const den = 1 + dot(a, b) + dot(b, c) + dot(c, a);
  return 2 * Math.atan2(num, den);
};

/**
 * Angular distance in degrees from a point to the nearest boundary arc.
 * Uses the great-circle normal of each segment and projects onto the segment,
 * clamping to the endpoints outside the arc.
 */
const distanceToBoundary = (rings, lngLat) => {
  const p = normalize(toVector(lngLat));
  let best = Math.PI;

  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const a = normalize(toVector(ring[i]));
      const b = normalize(toVector(ring[i + 1]));
      const nRaw = cross(a, b);
      const nLen = length(nRaw);

      let d;
      if (nLen < 1e-12) {
        d = Math.acos(clamp(dot(p, a), -1, 1));
      } else {
        const n = [nRaw[0] / nLen, nRaw[1] / nLen, nRaw[2] / nLen];
        const projected = [
          p[0] - n[0] * dot(p, n),
          p[1] - n[1] * dot(p, n),
          p[2] - n[2] * dot(p, n)
        ];
        const projectedLen = length(projected);
        if (projectedLen < 1e-12) continue;
        const q = [projected[0] / projectedLen, projected[1] / projectedLen, projected[2] / projectedLen];
        const withinArc = dot(cross(a, q), n) >= -1e-12 && dot(cross(q, b), n) >= -1e-12;
        d = withinArc
          ? Math.asin(clamp(Math.abs(dot(p, n)), 0, 1))
          : Math.min(
            Math.acos(clamp(dot(p, a), -1, 1)),
            Math.acos(clamp(dot(p, b), -1, 1))
          );
      }
      if (d < best) best = d;
    }
  }

  return best * RAD;
};

/** Point-in-spherical-triangle test that respects the triangle's winding. */
const pointInSphericalTriangle = (p, a, b, c) => {
  const orient = Math.sign(dot(a, cross(b, c))) || 1;
  return (
    dot(p, cross(a, b)) * orient >= -1e-12 &&
    dot(p, cross(b, c)) * orient >= -1e-12 &&
    dot(p, cross(c, a)) * orient >= -1e-12
  );
};

// ---------------------------------------------------------------------------
// Inline sample polygons
// ---------------------------------------------------------------------------

/** Box wound clockwise in lon/lat -- d3-geo exterior ring. */
const cwBox = (lng0, lat0, lng1, lat1) => [
  [lng0, lat0],
  [lng0, lat1],
  [lng1, lat1],
  [lng1, lat0],
  [lng0, lat0]
];

/** Same box reversed (counter-clockwise) -- the winding for holes. */
const ccwBox = (lng0, lat0, lng1, lat1) => cwBox(lng0, lat0, lng1, lat1).slice().reverse();

/**
 * Ring encircling a pole at a constant latitude. Longitudes must descend for a
 * north cap and ascend for a south cap so that the ring bounds the small
 * spherical region containing the pole.
 */
const polarRing = (lat, longitudes) => [
  ...longitudes.map(lng => [lng, lat]),
  [longitudes[0], lat]
];

const DESCENDING_LNG = [];
for (let lng = 180; lng >= -180; lng -= 30) DESCENDING_LNG.push(lng);
const ASCENDING_LNG = [];
for (let lng = -180; lng <= 180; lng += 30) ASCENDING_LNG.push(lng);

const SAMPLES = [
  {
    name: 'plain-square',
    kind: 'plain',
    rings: [cwBox(0, 0, 30, 30)]
  },
  {
    name: 'polygon-with-hole',
    kind: 'hole',
    rings: [cwBox(0, 0, 40, 40), ccwBox(12, 12, 28, 28)]
  },
  {
    name: 'polygon-with-two-holes',
    kind: 'hole',
    rings: [cwBox(-10, -10, 30, 30), ccwBox(0, 0, 8, 8), ccwBox(16, 16, 26, 26)]
  },
  {
    name: 'antimeridian',
    kind: 'antimeridian',
    rings: [[
      [170, -15],
      [170, 15],
      [-170, 15],
      [-170, -15],
      [170, -15]
    ]]
  },
  {
    name: 'antimeridian-with-hole',
    kind: 'antimeridian',
    rings: [
      [[170, -25], [170, 25], [-170, 25], [-170, -25], [170, -25]],
      [[176, -6], [-176, -6], [-176, 6], [176, 6], [176, -6]]
    ]
  },
  {
    name: 'north-pole-wedge',
    kind: 'north-pole',
    rings: [[
      [-120, 65],
      [-120, 90],
      [120, 90],
      [120, 65],
      [0, 65],
      [-120, 65]
    ]]
  },
  {
    name: 'south-pole-wedge',
    kind: 'south-pole',
    rings: [[
      [-120, -65],
      [0, -65],
      [120, -65],
      [120, -90],
      [-120, -90],
      [-120, -65]
    ]]
  },
  {
    name: 'north-pole-encircling',
    kind: 'north-pole',
    rings: [polarRing(82, DESCENDING_LNG)]
  },
  {
    name: 'south-pole-encircling',
    kind: 'south-pole',
    rings: [polarRing(-82, ASCENDING_LNG)]
  }
];

const RESOLUTIONS = [1, 5];

// ---------------------------------------------------------------------------
// Variant verification
// ---------------------------------------------------------------------------

const verifyVariant = (sample, resolution) => {
  const { rings } = sample;
  const polygon = { type: 'Polygon', coordinates: rings };

  const { contour, triangles } = geoPolygonTriangulate(rings, { resolution });

  const geometry = new ConicPolygonGeometry(rings, 0.9, 1.1, true, true, true, resolution);

  const position = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  const index = geometry.index;

  const vertexCount = position.count;
  const positions = position.array;
  const indices = index.array;

  const vertex = i => [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]];

  const contourPointCount = contour.reduce((sum, ring) => sum + ring.length, 0);
  const capTriangleCount = triangles.indices.length / 3;

  const failures = [];
  const fail = reason => failures.push(reason);

  // Collect all the numbers the report needs, even when a check fails.
  const stats = {
    name: sample.name,
    kind: sample.kind,
    resolution,
    vertices: vertexCount,
    contourPoints: contourPointCount,
    capTriangles: capTriangleCount,
    groups: geometry.groups.map(g => ({ materialIndex: g.materialIndex, indexCount: g.count })),
    indexBounds: { checked: indices.length, outOfRange: 0, nonInteger: 0 },
    uvMatchesPosition: uv.count === vertexCount,
    caps: {},
    side: {},
    coverage: {},
    areaRatio: {}
  };

  // -- 1. group layout ------------------------------------------------------
  const materialOrder = geometry.groups.map(g => g.materialIndex).join(',');
  if (materialOrder !== '0,1,2') {
    fail(`group materialIndex order is [${materialOrder}], expected [0,1,2] (side, bottom, top)`);
  }

  const groupByMaterial = new Map(geometry.groups.map(g => [g.materialIndex, g]));
  const sideGroup = groupByMaterial.get(0);
  const bottomGroup = groupByMaterial.get(1);
  const topGroup = groupByMaterial.get(2);

  if (!sideGroup || !bottomGroup || !topGroup) {
    fail('one of the three expected groups (0=side, 1=bottom cap, 2=top cap) is missing');
    return { stats, failures };
  }

  let cursor = 0;
  for (const group of geometry.groups) {
    if (group.start !== cursor) {
      fail(`group ${group.materialIndex} starts at index ${group.start}, expected ${cursor} (gap or overlap)`);
    }
    cursor = group.start + group.count;
  }
  if (cursor !== indices.length) {
    fail(`groups cover ${cursor} indices but the index buffer holds ${indices.length}`);
  }

  const expectedSideIndices = 6 * contourPointCount;
  if (sideGroup.count !== expectedSideIndices) {
    fail(`side group holds ${sideGroup.count} indices, expected 6 per contour point (${expectedSideIndices})`);
  }
  for (const [label, group] of [['bottom', bottomGroup], ['top', topGroup]]) {
    const expected = 3 * capTriangleCount;
    if (group.count !== expected) {
      fail(`${label} cap group holds ${group.count} indices, expected ${expected} (3 per cap triangle)`);
    }
  }

  // -- 2. index bounds ------------------------------------------------------
  let outOfRange = 0;
  let nonInteger = 0;
  for (let i = 0; i < indices.length; i++) {
    const value = indices[i];
    if (!Number.isInteger(value)) nonInteger++;
    if (value < 0 || value >= vertexCount) outOfRange++;
  }
  stats.indexBounds = { checked: indices.length, outOfRange, nonInteger };
  if (nonInteger) fail(`${nonInteger} non-integer indices`);
  if (outOfRange) fail(`${outOfRange} indices outside [0, ${vertexCount})`);
  if (uv.count !== vertexCount) fail(`uv attribute holds ${uv.count} entries but position holds ${vertexCount}`);
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) {
      fail('position attribute contains a non-finite value');
      break;
    }
  }

  const expectedVertices = 2 * contourPointCount + 2 * triangles.points.length;
  if (vertexCount !== expectedVertices) {
    fail(`position holds ${vertexCount} vertices, expected ${expectedVertices} (2 contour copies + 2 cap copies)`);
  }

  // -- 3 + 4. cap containment and orientation ------------------------------
  for (const { materialIndex, heightSign } of [
    { materialIndex: 1, heightSign: -1 },
    { materialIndex: 2, heightSign: 1 }
  ]) {
    const group = groupByMaterial.get(materialIndex);
    const label = materialIndex === 1 ? 'bottom' : 'top';
    const capStats = {
      triangles: group.count / 3,
      degenerate: 0,
      nearBoundary: 0,
      checked: 0,
      outsidePolygon: 0,
      insideHole: 0,
      wrongNormal: 0,
      area: 0,
      worstOutside: null
    };

    for (let t = group.start; t < group.start + group.count; t += 3) {
      const i0 = indices[t];
      const i1 = indices[t + 1];
      const i2 = indices[t + 2];
      if (i0 >= vertexCount || i1 >= vertexCount || i2 >= vertexCount) continue;

      const a = vertex(i0);
      const b = vertex(i1);
      const c = vertex(i2);

      const area = sphericalTriangleArea(normalize(a), normalize(b), normalize(c));
      capStats.area += area;

      const normal = cross(
        [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
        [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
      );

      if (area < DEGENERATE_AREA_SR || length(normal) === 0) {
        capStats.degenerate++;
        continue;
      }

      const centroid = normalize([
        (a[0] + b[0] + c[0]) / 3,
        (a[1] + b[1] + c[1]) / 3,
        (a[2] + b[2] + c[2]) / 3
      ]);
      const centroidLngLat = toLngLat(centroid);

      if (Math.sign(dot(normalize(normal), centroid)) !== heightSign) {
        capStats.wrongNormal++;
      }

      const boundaryDistance = distanceToBoundary(rings, centroidLngLat);
      if (boundaryDistance < BOUNDARY_TOL_DEG) {
        capStats.nearBoundary++;
        continue;
      }

      capStats.checked++;
      if (!geoContains(polygon, centroidLngLat)) {
        const insideExterior = geoContains({ type: 'Polygon', coordinates: [rings[0]] }, centroidLngLat);
        if (insideExterior && rings.length > 1) {
          capStats.insideHole++;
        } else {
          capStats.outsidePolygon++;
          if (!capStats.worstOutside || boundaryDistance > capStats.worstOutside.distance) {
            capStats.worstOutside = { lngLat: centroidLngLat, distance: boundaryDistance };
          }
        }
      }
    }

    stats.caps[label] = capStats;

    if (capStats.outsidePolygon) {
      const w = capStats.worstOutside;
      fail(
        `${label} cap: ${capStats.outsidePolygon}/${capStats.checked} triangle centroids fall outside the polygon ` +
        `(worst at ${w.lngLat.map(v => v.toFixed(2)).join(',')}, ${w.distance.toFixed(2)} deg from the boundary)`
      );
    }
    if (capStats.insideHole) {
      fail(`${label} cap: ${capStats.insideHole}/${capStats.checked} triangle centroids fall inside a hole`);
    }
    if (capStats.wrongNormal) {
      fail(`${label} cap: ${capStats.wrongNormal}/${capStats.triangles} triangles wind against the height direction`);
    }
  }

  // -- 5. side wall watertightness -----------------------------------------
  // The side wall is an extruded prism over every contour ring. Two
  // properties together characterise a closed wall:
  //
  //   (a) rim parity: an edge between two top-rim vertices (or two
  //       bottom-rim vertices) is a boundary of the wall, so exactly one
  //       triangle may use it. A rim edge used zero times is a missing face;
  //       used twice or more is a fold.
  //   (b) manifold parity: every edge that mixes a top-rim and a bottom-rim
  //       vertex is interior to the wall, so exactly two triangles must share
  //       it. That covers the vertical edges as well as the per-quad
  //       diagonals, so a breach shows up as a count of 1 and a duplicated
  //       face as a count of 3 or more.
  //
  // Zero-length edges (the duplicated closing vertex of each ring) are skipped
  // by comparing positions, because the library keeps both copies.
  const keyOf = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

  const isTopRim = v => v < contourPointCount;
  const isBottomRim = v => v >= contourPointCount && v < 2 * contourPointCount;

  const samePosition = (i, j) => {
    const a = vertex(i);
    const b = vertex(j);
    return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9 && Math.abs(a[2] - b[2]) < 1e-9;
  };

  const rimEdgeCounts = new Map(); // same-rim edges, normalised to contour indices
  const mixedEdgeCounts = new Map(); // one top-rim + one bottom-rim endpoint
  const verticalEdgeKeys = new Set();

  let sideVertexViolation = 0;
  for (let t = sideGroup.start; t < sideGroup.start + sideGroup.count; t += 3) {
    const tri = [indices[t], indices[t + 1], indices[t + 2]];
    for (let i = 0; i < 3; i++) {
      const u = tri[i];
      const v = tri[(i + 1) % 3];
      if (u >= 2 * contourPointCount || v >= 2 * contourPointCount) {
        sideVertexViolation++;
        continue;
      }
      if (u === v || samePosition(u, v)) continue; // collapsed closing edge
      if (isTopRim(u) && isTopRim(v)) {
        bump(rimEdgeCounts, `top:${keyOf(u, v)}`);
      } else if (isBottomRim(u) && isBottomRim(v)) {
        bump(rimEdgeCounts, `bottom:${keyOf(u - contourPointCount, v - contourPointCount)}`);
      } else {
        bump(mixedEdgeCounts, keyOf(u, v));
        const top = isTopRim(u) ? u : v;
        const bottom = isTopRim(u) ? v : u;
        if (bottom === top + contourPointCount) verticalEdgeKeys.add(top);
      }
    }
  }

  // Expected rim edges: consecutive contour vertices within one ring (including
  // the wrap-around pair). Edges whose endpoints collapse to the same point on
  // the sphere are skipped -- that happens for the duplicated closing vertex
  // and for vertices at a pole, where different longitudes map to one point.
  // The sphere positions of the contour are the first `contourPointCount`
  // entries of `triangles.points`, in contour order.
  const expectedRimEdges = new Set();
  {
    const contourVectors = triangles.points.slice(0, contourPointCount).map(toVector);
    const sameVec = (i, j) => {
      const a = contourVectors[i];
      const b = contourVectors[j];
      return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9 && Math.abs(a[2] - b[2]) < 1e-9;
    };
    let ringStart = 0;
    for (const ring of contour) {
      for (let i = 0; i < ring.length; i++) {
        const u = ringStart + i;
        const v = ringStart + ((i + 1) % ring.length);
        if (u === v || sameVec(u, v)) continue;
        expectedRimEdges.add(keyOf(u, v));
      }
      ringStart += ring.length;
    }
  }

  let missingTop = 0;
  let missingBottom = 0;
  let duplicateRim = 0;
  for (const key of expectedRimEdges) {
    if ((rimEdgeCounts.get(`top:${key}`) || 0) !== 1) missingTop++;
    if ((rimEdgeCounts.get(`bottom:${key}`) || 0) !== 1) missingBottom++;
  }
  for (const [, count] of rimEdgeCounts) {
    if (count !== 1) duplicateRim++;
  }

  let missingVertical = 0;
  let malformedMixedEdges = 0;
  for (const [, count] of mixedEdgeCounts) {
    if (count !== 2) malformedMixedEdges++;
  }
  for (let i = 0; i < contourPointCount; i++) {
    if (!verticalEdgeKeys.has(i)) missingVertical++;
  }

  stats.side = {
    triangles: sideGroup.count / 3,
    expectedRimEdges: expectedRimEdges.size,
    missingTopRimEdges: missingTop,
    missingBottomRimEdges: missingBottom,
    duplicateRimEdges: duplicateRim,
    expectedVerticalEdges: contourPointCount,
    missingVerticalEdges: missingVertical,
    malformedMixedEdges,
    outOfBlockVertices: sideVertexViolation
  };

  if (sideVertexViolation) fail(`side wall: ${sideVertexViolation} vertices lie outside the side group's own vertex block`);
  if (missingTop) fail(`side wall: ${missingTop} contour edges are not used exactly once by the top rim`);
  if (missingBottom) fail(`side wall: ${missingBottom} contour edges are not used exactly once by the bottom rim`);
  if (duplicateRim) fail(`side wall: ${duplicateRim} rim edges are used by more than one triangle (fold)`);
  if (missingVertical) fail(`side wall: ${missingVertical} contour points have no vertical edge (breach)`);
  if (malformedMixedEdges) {
    fail(`side wall: ${malformedMixedEdges} top-to-bottom edges are not shared by exactly two triangles (breach)`);
  }

  // -- 6. cap coverage ------------------------------------------------------
  const capTriangles = [];
  for (let t = topGroup.start; t < topGroup.start + topGroup.count; t += 3) {
    const tri = [indices[t], indices[t + 1], indices[t + 2]];
    if (tri.some(v => v >= vertexCount)) continue;
    capTriangles.push(tri.map(vertex));
  }

  const margin = Math.max(resolution, COVERAGE_MARGIN_DEG);
  const step = Math.max(1, resolution / 2);
  let interiorPoints = 0;
  let uncoveredPoints = 0;
  let worstUncovered = null;

  for (let lat = -89; lat <= 89; lat += step) {
    for (let lng = -179; lng <= 179; lng += step) {
      const lngLat = [lng, lat];
      if (!geoContains(polygon, lngLat)) continue;

      const boundaryDistance = distanceToBoundary(rings, lngLat);
      if (boundaryDistance < margin) continue;

      interiorPoints++;
      const p = toVector(lngLat);
      const covered = capTriangles.some(([a, b, c]) => pointInSphericalTriangle(p, a, b, c));
      if (!covered) {
        uncoveredPoints++;
        if (!worstUncovered || boundaryDistance > worstUncovered.distance) {
          worstUncovered = { lngLat, distance: boundaryDistance };
        }
      }
    }
  }

  stats.coverage = { interiorPoints, uncoveredPoints, marginDeg: margin };
  if (interiorPoints < MIN_COVERAGE_SAMPLES) {
    fail(
      `cap coverage: only ${interiorPoints} interior points were sampled (need >= ${MIN_COVERAGE_SAMPLES}); ` +
      'the sample is too small for this resolution to exercise the coverage check'
    );
  }
  if (uncoveredPoints) {
    fail(
      `cap coverage: ${uncoveredPoints}/${interiorPoints} interior points are not covered by any top-cap triangle ` +
      `(worst at ${worstUncovered.lngLat.join(',')}, ${worstUncovered.distance.toFixed(2)} deg from the boundary)`
    );
  }

  // cap area sanity
  const polygonArea = geoArea(polygon);
  for (const label of ['bottom', 'top']) {
    const ratio = polygonArea > 0 ? stats.caps[label].area / polygonArea : 1;
    stats.areaRatio[label] = ratio;
    if (ratio < MIN_CAP_AREA_RATIO) {
      fail(`${label} cap covers ${(ratio * 100).toFixed(1)}% of the polygon area (expected >= ${MIN_CAP_AREA_RATIO * 100}%)`);
    }
  }

  return { stats, failures };
};

// ---------------------------------------------------------------------------
// Optional-surface group stability
// ---------------------------------------------------------------------------

/**
 * The documented group numbering is fixed: 0 = side, 1 = bottom cap,
 * 2 = top cap. Making one surface optional must not renumber the others, so
 * `materialIndex` has to stay bound to the surface it belongs to. A running
 * counter (the obvious implementation) silently renumbers the top cap to 1 as
 * soon as the bottom cap is disabled, which makes a caller's material array
 * paint the wrong surface.
 */
const verifyOptionalSurfaces = () => {
  const failures = [];
  const rings = SAMPLES[0].rings;

  const cases = [
    { closedBottom: true, closedTop: true, includeSides: true, expected: [0, 1, 2] },
    { closedBottom: true, closedTop: false, includeSides: true, expected: [0, 1] },
    { closedBottom: false, closedTop: true, includeSides: true, expected: [0, 2] },
    { closedBottom: false, closedTop: false, includeSides: true, expected: [0] },
    { closedBottom: true, closedTop: true, includeSides: false, expected: [1, 2] },
    { closedBottom: true, closedTop: false, includeSides: false, expected: [1] },
    { closedBottom: false, closedTop: true, includeSides: false, expected: [2] }
  ];

  for (const { closedBottom, closedTop, includeSides, expected } of cases) {
    const geometry = new ConicPolygonGeometry(rings, 0.9, 1.1, closedBottom, closedTop, includeSides, 5);
    const actual = geometry.groups.map(g => g.materialIndex);
    if (actual.join(',') !== expected.join(',')) {
      const label = `closedBottom=${closedBottom} closedTop=${closedTop} includeSides=${includeSides}`;
      failures.push(
        `${label}: group materialIndex values are [${actual.join(',')}], expected [${expected.join(',')}] ` +
        '(0=side, 1=bottom, 2=top are fixed identifiers)'
      );
    }
  }

  return failures;
};

// ---------------------------------------------------------------------------
// clone() verification
// ---------------------------------------------------------------------------

const verifyClone = () => {
  const failures = [];
  const rings = SAMPLES[1].rings;
  const bottomHeight = (lng, lat) => 0.5 + lat / 1000;
  const topHeight = 1.25;

  const geometry = new ConicPolygonGeometry(rings, bottomHeight, topHeight, true, false, true, 3);
  const cloned = geometry.clone();

  for (const key of [
    'polygonGeoJson',
    'bottomHeight',
    'topHeight',
    'closedBottom',
    'closedTop',
    'includeSides',
    'curvatureResolution'
  ]) {
    const original = geometry.parameters[key];
    const copy = cloned.parameters[key];
    const equal = typeof original === 'function'
      ? typeof copy === 'function' && copy === original
      : JSON.stringify(original) === JSON.stringify(copy);
    if (!equal) failures.push(`clone() did not preserve parameter "${key}"`);
  }

  const sameBuffer = (a, b) => a.count === b.count && a.array.every((value, i) => value === b.array[i]);

  if (!sameBuffer(geometry.index, cloned.index)) failures.push('clone() index buffer differs from the original');
  if (!sameBuffer(geometry.attributes.position, cloned.attributes.position)) failures.push('clone() position buffer differs');
  if (!sameBuffer(geometry.attributes.uv, cloned.attributes.uv)) failures.push('clone() uv buffer differs');
  if (JSON.stringify(geometry.groups) !== JSON.stringify(cloned.groups)) failures.push('clone() group layout differs');

  return failures;
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const percent = v => `${(v * 100).toFixed(1)}%`;

const printSummary = s => {
  const groups = s.groups.map(g => `${g.materialIndex}:${g.indexCount}`).join(' ');
  console.log(
    `[${s.name} | resolution=${s.resolution}] vertices=${s.vertices} contourPoints=${s.contourPoints} ` +
    `capTriangles=${s.capTriangles} sideTriangles=${s.side.triangles}`
  );
  console.log(`    group index counts (materialIndex:indexCount): ${groups}`);
  console.log(
    `    index bounds: ${s.indexBounds.checked} indices, outOfRange=${s.indexBounds.outOfRange}, ` +
    `nonInteger=${s.indexBounds.nonInteger}, uvMatchesPosition=${s.uvMatchesPosition}`
  );
  for (const label of ['bottom', 'top']) {
    const cap = s.caps[label];
    console.log(
      `    ${label} cap: tris=${cap.triangles} degenerate=${cap.degenerate} nearBoundarySkipped=${cap.nearBoundary} ` +
      `outsidePolygon=${cap.outsidePolygon} insideHole=${cap.insideHole} wrongNormal=${cap.wrongNormal} ` +
      `areaRatio=${percent(s.areaRatio[label])}`
    );
  }
  console.log(
    `    side wall: rimEdges=${s.side.expectedRimEdges} missingTop=${s.side.missingTopRimEdges} ` +
    `missingBottom=${s.side.missingBottomRimEdges} duplicateRim=${s.side.duplicateRimEdges} ` +
    `verticalEdges=${s.side.expectedVerticalEdges} missingVertical=${s.side.missingVerticalEdges} ` +
    `malformedMixed=${s.side.malformedMixedEdges}`
  );
  console.log(
    `    coverage: margin=${s.coverage.marginDeg} deg, interiorPoints=${s.coverage.interiorPoints}, ` +
    `uncovered=${s.coverage.uncoveredPoints}`
  );
};

const main = () => {
  const failures = [];
  const summaries = [];
  let variantCount = 0;

  // Guard against silently mis-wound sample data: all our samples must be
  // small regions (well under a hemisphere), i.e. d3-geo's signed area must be
  // positive and modest. A ring wound the other way would make `geoContains`
  // describe the complement of the intended region and every containment check
  // would be meaningless.
  for (const sample of SAMPLES) {
    const area = geoArea({ type: 'Polygon', coordinates: sample.rings });
    if (!(area > 0 && area < Math.PI)) {
      failures.push({
        sample: sample.name,
        resolution: '-',
        reason: `sample polygon has d3-geo area ${area} -- expected a small positive region (check ring winding)`
      });
    }
  }

  for (const sample of SAMPLES) {
    for (const resolution of RESOLUTIONS) {
      variantCount++;
      try {
        const { stats, failures: variantFailures } = verifyVariant(sample, resolution);
        summaries.push(stats);
        for (const reason of variantFailures) failures.push({ sample: sample.name, resolution, reason });
      } catch (error) {
        failures.push({
          sample: sample.name,
          resolution,
          reason: `threw during verification: ${error && error.message ? error.message : error}`
        });
      }
    }
  }

  for (const reason of verifyClone()) {
    failures.push({ sample: 'clone()', resolution: '-', reason });
  }
  for (const reason of verifyOptionalSurfaces()) {
    failures.push({ sample: 'optional-surfaces', resolution: '-', reason });
  }

  console.log('ConicPolygonGeometry geometry verification');
  console.log(`samples=${SAMPLES.length} resolutions=[${RESOLUTIONS.join(', ')}] variants=${variantCount} (+ clone, + optional-surface groups)`);
  console.log('');

  for (const summary of summaries) {
    printSummary(summary);
    console.log('');
  }

  if (failures.length) {
    console.error(`FAILED: ${failures.length} check(s) failed`);
    for (const failure of failures) {
      console.error(`  - [${failure.sample} | resolution=${failure.resolution}] ${failure.reason}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`PASSED: all ${variantCount} sample/resolution variants, clone() and optional-surface groups`);
  process.exitCode = 0;
};

main();
