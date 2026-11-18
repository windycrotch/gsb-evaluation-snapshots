import { test } from 'node:test';
import assert from 'node:assert/strict';

import GeoJsonGeometry from '../src/index.js';

// Positions are stored in a Float32 buffer, so angular distances measured back
// from the geometry carry quantization noise. The interpolation itself is
// exact; this tolerance absorbs only that storage-level error.
const FLOAT32_ANGLE_TOLERANCE = 1e-4;

// --- helpers -------------------------------------------------------------

// Angular distance (degrees) between two cartesian position triplets.
function angularDistanceDeg(a, b) {
  const na = Math.hypot(a[0], a[1], a[2]);
  const nb = Math.hypot(b[0], b[1], b[2]);
  let cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (na * nb);
  cos = Math.max(-1, Math.min(1, cos)); // guard against float drift
  return Math.acos(cos) * 180 / Math.PI;
}

// Walk a geometry's index as consecutive line-segment pairs and return the
// largest angular gap between connected vertices.
function maxSegmentAngularGap(geometry) {
  const pos = geometry.attributes.position.array;
  const idx = geometry.index.array;
  let maxGap = 0;

  for (let i = 0; i < idx.length; i += 2) {
    const a = idx[i];
    const b = idx[i + 1];
    const pa = [pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]];
    const pb = [pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]];
    maxGap = Math.max(maxGap, angularDistanceDeg(pa, pb));
  }

  return maxGap;
}

// Every index referenced by a group must stay inside [minVertex, maxVertex].
function groupReferencesInRange(geometry, group, minVertex, maxVertex) {
  const idx = geometry.index.array;
  for (let i = group.start; i < group.start + group.count; i++) {
    if (idx[i] < minVertex || idx[i] > maxVertex) return false;
  }
  return true;
}

function altitudeAt(geometry, vertexIdx, radius) {
  const pos = geometry.attributes.position.array;
  const norm = Math.hypot(
    pos[vertexIdx * 3],
    pos[vertexIdx * 3 + 1],
    pos[vertexIdx * 3 + 2]
  );
  return norm - radius;
}

// --- LineString ----------------------------------------------------------

test('LineString: large-angle segments are densified, every segment <= resolution', () => {
  const resolution = 5;
  const line = { type: 'LineString', coordinates: [[0, 0], [90, 0], [90, 90]] };
  const geometry = new GeoJsonGeometry(line, 1, resolution);

  // Two 90-degree edges need more than the 3 raw vertices.
  assert.ok(geometry.attributes.position.count > 3);

  const gap = maxSegmentAngularGap(geometry);
  assert.ok(
    gap <= resolution + FLOAT32_ANGLE_TOLERANCE,
    `expected max gap <= ${resolution}, got ${gap}`
  );

  // Endpoints are preserved: first/last vertex count at least covers both ends.
  assert.ok(geometry.index);
  assert.equal(geometry.index.array.length % 2, 0);
});

test('LineString: pairs within resolution are not interpolated', () => {
  const line = { type: 'LineString', coordinates: [[0, 0], [3, 0]] };
  const geometry = new GeoJsonGeometry(line, 1, 5);

  // 3-degree pair under a 5-degree resolution stays a single segment.
  assert.equal(geometry.attributes.position.count, 2);
  assert.deepEqual(Array.from(geometry.index.array), [0, 1]);
});

test('LineString: angular distance equal to resolution does not insert points', () => {
  const line = { type: 'LineString', coordinates: [[0, 0], [30, 0]] };
  const geometry = new GeoJsonGeometry(line, 1, 30);

  assert.equal(geometry.attributes.position.count, 2);
});

test('LineString: altitude endpoints are linearly and monotonically interpolated', () => {
  const radius = 1;
  const fromAlt = 0;
  const toAlt = 100;
  const line = {
    type: 'LineString',
    coordinates: [[0, 0, fromAlt], [90, 0, toAlt]]
  };
  const geometry = new GeoJsonGeometry(line, radius, 10);

  const count = geometry.attributes.position.count;
  assert.ok(count > 2, 'intermediate points should have been inserted');

  const alts = [];
  for (let i = 0; i < count; i++) alts.push(altitudeAt(geometry, i, radius));

  // Endpoints keep their exact altitudes.
  assert.ok(Math.abs(alts[0] - fromAlt) < 1e-5);
  assert.ok(Math.abs(alts[count - 1] - toAlt) < 1e-5);

  // Strictly increasing (linear) transition with no reversals.
  for (let i = 1; i < alts.length; i++) {
    assert.ok(
      alts[i] > alts[i - 1] - 1e-6,
      `altitude not monotonic at index ${i}: ${alts[i - 1]} -> ${alts[i]}`
    );
  }

  // Equal spacing confirms linearity: consecutive differences are constant.
  const step = alts[1] - alts[0];
  for (let i = 2; i < alts.length; i++) {
    assert.ok(Math.abs((alts[i] - alts[i - 1]) - step) < 1e-5);
  }
});

test('LineString: 2D endpoints produce 2D output (vertices stay on the sphere)', () => {
  const radius = 2;
  const line = { type: 'LineString', coordinates: [[0, 0], [90, 0]] };
  const geometry = new GeoJsonGeometry(line, radius, 10);

  const pos = geometry.attributes.position.array;
  for (let i = 0; i < geometry.attributes.position.count; i++) {
    const norm = Math.hypot(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    assert.ok(Math.abs(norm - radius) < 1e-6);
  }
});

test('LineString: densification follows the great circle (antimeridian crossing)', () => {
  // 170E to 170W is only 20 degrees apart across the antimeridian.
  const line = { type: 'LineString', coordinates: [[170, 0], [-170, 0]] };
  const geometry = new GeoJsonGeometry(line, 1, 5);

  // 20 degrees / 5 = 4 segments -> 5 vertices.
  assert.equal(geometry.attributes.position.count, 5);
  assert.ok(maxSegmentAngularGap(geometry) <= 5 + FLOAT32_ANGLE_TOLERANCE);
});

// --- Polygon groups ------------------------------------------------------

test('Polygon: outer ring is group 0, holes group 1; indices stay in their own vertex block', () => {
  const polygon = {
    type: 'Polygon',
    coordinates: [
      [[0, 0], [60, 0], [60, 60], [0, 60], [0, 0]],                       // outer
      [[10, 10], [25, 10], [25, 25], [10, 25], [10, 10]],                 // hole 1
      [[35, 35], [50, 35], [50, 50], [35, 50], [35, 50]]                  // hole 2
    ]
  };
  const geometry = new GeoJsonGeometry(polygon, 1, 7);

  assert.equal(geometry.groups.length, 2);
  assert.equal(geometry.groups[0].materialIndex, 0);
  assert.equal(geometry.groups[1].materialIndex, 1);

  const vertexCount = geometry.attributes.position.count;
  const idx = geometry.index.array;

  // Global invariant: no index points outside the position buffer.
  for (const value of idx) {
    assert.ok(value >= 0 && value < vertexCount, `index ${value} out of bounds`);
  }

  // The two groups must reference disjoint, ordered vertex blocks. Derive the
  // split point from the highest vertex referenced by the outer group.
  let outerMax = -1;
  for (let i = geometry.groups[0].start; i < geometry.groups[0].start + geometry.groups[0].count; i++) {
    outerMax = Math.max(outerMax, idx[i]);
  }
  const splitVertex = outerMax + 1;

  assert.ok(
    groupReferencesInRange(geometry, geometry.groups[0], 0, outerMax),
    'outer group references a hole vertex'
  );
  assert.ok(
    groupReferencesInRange(geometry, geometry.groups[1], splitVertex, vertexCount - 1),
    'hole group references an outer vertex or overflows the buffer'
  );

  // Hole indices are re-based locally to start at 0 (the ring's first vertex
  // is the start of the hole's own first edge 0 -> 1). After concatGroup
  // re-offsets them by the outer vertex count, the smallest global hole
  // reference is exactly splitVertex.
  let holeMin = Infinity;
  for (let i = geometry.groups[1].start; i < geometry.groups[1].start + geometry.groups[1].count; i++) {
    holeMin = Math.min(holeMin, idx[i]);
  }
  assert.equal(holeMin, splitVertex);

  // No degenerate self-loops, and every edge joins adjacent vertices within
  // its own ring (guards against an off-by-one in the hole index offset).
  for (let i = 0; i < idx.length; i += 2) {
    const [a, b] = [idx[i], idx[i + 1]];
    assert.notEqual(a, b, 'degenerate self-loop edge');
    assert.equal(Math.abs(a - b), 1, 'edge does not connect adjacent vertices');
  }

  // Every drawn segment still respects the resolution.
  assert.ok(maxSegmentAngularGap(geometry) <= 7 + FLOAT32_ANGLE_TOLERANCE);
});

test('Polygon: no holes yields a single group covering every vertex', () => {
  const polygon = {
    type: 'Polygon',
    coordinates: [
      [[0, 0], [40, 0], [40, 40], [0, 40], [0, 0]]
    ]
  };
  const geometry = new GeoJsonGeometry(polygon, 1, 10);

  assert.equal(geometry.groups.length, 1);
  assert.equal(geometry.groups[0].materialIndex, 0);
  const idx = geometry.index.array;
  for (const value of idx) {
    assert.ok(value >= 0 && value < geometry.attributes.position.count);
  }
});

test('MultiPolygon: outer/hole groups stay disjoint with correct offsets', () => {
  const multiPolygon = {
    type: 'MultiPolygon',
    coordinates: [
      [
        [[0, 0], [30, 0], [30, 30], [0, 30], [0, 0]],
        [[5, 5], [12, 5], [12, 12], [5, 12], [5, 5]]
      ],
      [
        [[50, 50], [80, 50], [80, 80], [50, 80], [50, 80]]
      ]
    ]
  };
  const geometry = new GeoJsonGeometry(multiPolygon, 1, 10);

  assert.equal(geometry.groups.length, 2);
  const vertexCount = geometry.attributes.position.count;
  const idx = geometry.index.array;

  for (const value of idx) {
    assert.ok(value >= 0 && value < vertexCount);
  }

  let outerMax = -1;
  for (let i = geometry.groups[0].start; i < geometry.groups[0].start + geometry.groups[0].count; i++) {
    outerMax = Math.max(outerMax, idx[i]);
  }
  assert.ok(
    groupReferencesInRange(geometry, geometry.groups[1], outerMax + 1, vertexCount - 1)
  );
});

// --- MultiLineString offsets ---------------------------------------------

test('MultiLineString: per-segment offsets are correct with no cross-segment edges', () => {
  const resolution = 10;
  const multiLine = {
    type: 'MultiLineString',
    coordinates: [
      [[0, 0], [50, 0]],       // equator, true 50-degree span -> 5 segments, 6 vertices
      [[70, 0], [120, 0]]      // disjoint equator line, also 50 degrees -> 6 vertices
    ]
  };
  const geometry = new GeoJsonGeometry(multiLine, 1, resolution);

  // Each 50-degree line splits into ceil(50/10) = 5 segments, i.e. 6 vertices.
  assert.equal(geometry.attributes.position.count, 12);
  assert.equal(geometry.groups.length, 1);

  const idx = Array.from(geometry.index.array);

  // The first line owns vertices 0..5, the second 6..11. No edge may bridge
  // the boundary (which would read as a pair crossing vertex 5 -> vertex 6).
  let crossesBoundary = false;
  for (let i = 0; i < idx.length; i += 2) {
    const [a, b] = [idx[i], idx[i + 1]];
    if ((a <= 5 && b >= 6) || (b <= 5 && a >= 6)) crossesBoundary = true;
    // Every edge connects adjacent vertices inside its own line.
    assert.equal(Math.abs(a - b), 1);
  }
  assert.equal(crossesBoundary, false, 'an edge connects two different line segments');

  // First line edges reference 0..5, second line edges reference 6..11.
  const firstLineMax = Math.max(...idx.slice(0, 10));
  const secondLineMin = Math.min(...idx.slice(10));
  assert.equal(firstLineMax, 5);
  assert.equal(secondLineMin, 6);

  assert.ok(maxSegmentAngularGap(geometry) <= resolution + FLOAT32_ANGLE_TOLERANCE);
});

test('MultiLineString: short lines are merged without overlap', () => {
  const multiLine = {
    type: 'MultiLineString',
    coordinates: [
      [[0, 0], [1, 0]],
      [[10, 10], [11, 10]],
      [[20, 20], [21, 20]]
    ]
  };
  const geometry = new GeoJsonGeometry(multiLine, 1, 5);

  assert.equal(geometry.attributes.position.count, 6);
  assert.deepEqual(Array.from(geometry.index.array), [0, 1, 2, 3, 4, 5]);
});

// --- resolution normalization --------------------------------------------

test('invalid resolution (0, negative, NaN) falls back to the default of 5', () => {
  const line = { type: 'LineString', coordinates: [[0, 0], [90, 0]] };

  for (const bad of [0, -1, -5.5, NaN]) {
    const geometry = new GeoJsonGeometry(line, 1, bad);

    assert.equal(
      geometry.parameters.resolution, 5,
      `resolution ${String(bad)} should normalize to 5`
    );
    // 90 degrees at resolution 5 -> 18 segments -> 19 vertices, proving the
    // fallback actually drove interpolation rather than hanging or no-opping.
    assert.equal(geometry.attributes.position.count, 19);
    assert.ok(maxSegmentAngularGap(geometry) <= 5 + FLOAT32_ANGLE_TOLERANCE);
  }
});

test('omitted resolution defaults to 5', () => {
  const line = { type: 'LineString', coordinates: [[0, 0], [90, 0]] };
  const geometry = new GeoJsonGeometry(line);

  assert.equal(geometry.parameters.resolution, 5);
  assert.equal(geometry.attributes.position.count, 19);
});

test('valid custom resolution is preserved and honored', () => {
  const line = { type: 'LineString', coordinates: [[0, 0], [90, 0]] };
  const geometry = new GeoJsonGeometry(line, 1, 15);

  assert.equal(geometry.parameters.resolution, 15);
  assert.equal(geometry.attributes.position.count, 7); // 90 / 15 = 6 segments
  assert.ok(maxSegmentAngularGap(geometry) <= 15 + FLOAT32_ANGLE_TOLERANCE);
});

// --- empty inputs do not crash -------------------------------------------

test('empty LineString and Polygon produce empty geometry instead of throwing', () => {
  const emptyLine = new GeoJsonGeometry({ type: 'LineString', coordinates: [] }, 1, 0);
  assert.equal(emptyLine.index, null);
  assert.equal(emptyLine.attributes.position, undefined);

  const emptyPolygon = new GeoJsonGeometry({ type: 'Polygon', coordinates: [] }, 1, NaN);
  assert.equal(emptyPolygon.index, null);
  assert.equal(emptyPolygon.attributes.position, undefined);
});
