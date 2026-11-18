/**
 * End-to-end checks for the H3 → mesh → validation → report/STL pipeline,
 * using a small set of constructed hex cells:
 *   - one cell with metric 0 (plus negatives) → empty-mesh branch, no file
 *   - one normal cell → single closed prism on the slab → solid verdict
 *   - two adjacent normal cells → expected non-manifold shared-wall edges
 *
 * Run via `npm test` in viz/ (bundled by esbuild, executed with node --test).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latLngToCell, gridDisk } from 'h3-js';
import { buildHexHeightfieldMesh } from '../src/mesh/heightfield-mesh';
import { validateMesh } from '../src/mesh/validate-mesh';
import { meshToBinarySTL, meshToOBJ } from '../src/mesh/mesh-export';
import {
  EMPTY_MESH_MESSAGE,
  formatPrintabilityReport,
  isEmptyMesh,
} from '../src/mesh/printability-report';

const RES = 9;
const OPTS = { footprintMm: 100, maxHeightMm: 20, baseThicknessMm: 2 };
// Two cells far enough apart that they cannot share an edge.
const h3A = latLngToCell(47.6, -122.3, RES);
const h3B = latLngToCell(47.7, -122.4, RES);

test('all-non-positive metrics build an empty mesh and the report explains why', () => {
  const cells = [
    { h3: h3A, metric: 0 },
    { h3: h3B, metric: -5 },
    { h3: h3A, metric: Number.NaN }, // duplicate + non-finite, filtered by the builder
  ];
  const mesh = buildHexHeightfieldMesh(cells, OPTS);

  assert.ok(isEmptyMesh(mesh), 'zero/negative metrics must produce an empty mesh');
  assert.equal(mesh.triangleCount, 0);
  assert.equal(mesh.positions.length, 0);
  assert.equal(mesh.indices.length, 0);

  const report = validateMesh(mesh);
  assert.equal(report.triangles, 0);
  assert.equal(report.mergedVertices, 0);
  assert.equal(report.boundaryEdges, 0);
  assert.equal(report.nonManifoldEdges, 0);
  assert.equal(report.volumeMm3, 0);
  assert.equal(report.watertight, true); // vacuous on an empty mesh
  assert.equal(report.isSolid, false);   // volume is not positive

  const text = formatPrintabilityReport(report);
  assert.ok(text.includes(EMPTY_MESH_MESSAGE) === false); // empty wording is the caller's guard
  assert.ok(text.includes('Triangles: 0'));
  assert.ok(text.includes('Vertices (merged): 0'));
  assert.ok(text.includes('Boundary edges: 0'));
  assert.ok(text.includes('Non-manifold edges: 0'));
  assert.ok(text.includes('Degenerate triangles: 0'));
  assert.ok(text.includes('Winding consistent: yes'));
  assert.ok(text.includes('Volume: 0 mm³'));
  assert.ok(text.includes('Verdict: not a solid'));
  assert.ok(text.includes('non-positive volume'));

  // The empty STL would be just a header; the worker skips serialization for
  // empty meshes, and the panel therefore never triggers a download.
  const stl = meshToBinarySTL(mesh);
  assert.equal(stl.byteLength, 84);
  assert.equal(new DataView(stl).getUint32(80, true), 0);
});

test('a zero-metric cell plus one normal cell yields a solid, positively-sized mesh', () => {
  const cells = [
    { h3: h3A, metric: 0 },      // contributes no relief
    { h3: h3B, metric: 100 },    // one full-height prism
  ];
  const mesh = buildHexHeightfieldMesh(cells, OPTS);
  assert.equal(isEmptyMesh(mesh), false);
  assert.ok(mesh.triangleCount > 0);

  const report = validateMesh(mesh);
  assert.equal(report.boundaryEdges, 0, 'a closed prism on the slab has no open edges');
  assert.equal(report.nonManifoldEdges, 0, 'a single prism shares no wall with another prism');
  assert.equal(report.degenerateTriangles, 0);
  assert.equal(report.windingConsistent, true);
  assert.ok(report.volumeMm3 > 0, 'volume must be strictly positive');
  assert.equal(report.watertight, true);
  assert.equal(report.isSolid, true, 'watertight + consistent winding + positive volume');

  const text = formatPrintabilityReport(report);
  assert.ok(text.includes(`Triangles: ${report.triangles.toLocaleString('en-US')}`));
  assert.ok(text.includes(`Vertices (merged): ${report.mergedVertices.toLocaleString('en-US')}`));
  assert.ok(text.includes(`Boundary edges: 0`));
  assert.ok(text.includes(`Non-manifold edges: 0`));
  assert.ok(text.includes('Winding consistent: yes'));
  assert.ok(text.includes('mm³'));
  assert.ok(text.includes('Verdict: solid ✓'));
  assert.ok(!text.includes('Non-manifold edges are expected'),
    'the shared-wall explanation must not appear when there are no non-manifold edges');
});

test('adjacent hex prisms produce expected non-manifold edges and a factual report', () => {
  // gridDisk gives a guaranteed edge-sharing neighbor. Equal heights make the
  // shared wall fully coincident: the opposite-facing walls merge onto edges
  // referenced by 4 faces (non-manifold) and traverse some directed edges the
  // same way, so strict directed-winding consistency cannot hold either.
  const neighbor = gridDisk(h3A, 1).filter((h) => h !== h3A)[0];
  assert.ok(neighbor, 'test setup needs a neighboring hex');

  const mesh = buildHexHeightfieldMesh(
    [{ h3: h3A, metric: 100 }, { h3: neighbor, metric: 100 }], OPTS);
  const report = validateMesh(mesh);

  assert.equal(report.boundaryEdges, 0, 'no holes: every outer edge is still paired');
  assert.ok(report.nonManifoldEdges > 0,
    'shared side walls are referenced by >2 faces after vertex merging — expected');
  assert.equal(report.watertight, false, 'non-manifold edges mean not strictly watertight');
  // The two opposing walls traverse some shared directed edges the same way once
  // their vertices merge, so strict directed-winding consistency cannot hold on
  // a shared wall — this is the expected signature of touching prisms.
  assert.equal(report.windingConsistent, false);
  assert.ok(report.volumeMm3 > 0);
  assert.equal(report.isSolid, false);

  const text = formatPrintabilityReport(report);
  assert.ok(text.includes(`Non-manifold edges: ${report.nonManifoldEdges}`));
  assert.ok(text.includes('Non-manifold edges are expected'),
    'the report must explain the shared-wall origin instead of a generic error');
  assert.ok(text.includes('adjacent hex prisms share side walls'));
  assert.ok(text.includes('Verdict: not a solid'));
  assert.ok(text.includes('non-manifold edges from shared prism walls'));
});

test('STL binary layout and OBJ output keep their existing on-disk format', () => {
  const mesh = buildHexHeightfieldMesh([{ h3: h3B, metric: 100 }], OPTS);
  const stl = meshToBinarySTL(mesh);
  const dv = new DataView(stl);

  assert.equal(stl.byteLength, 84 + mesh.triangleCount * 50);
  assert.equal(dv.getUint32(80, true), mesh.triangleCount);
  // First record: a unit-length normal followed by three float32 vertices and a
  // zero attribute-word — the layout slicers expect.
  const n = Math.hypot(dv.getFloat32(84, true), dv.getFloat32(88, true), dv.getFloat32(92, true));
  assert.ok(Math.abs(n - 1) < 1e-6);
  assert.equal(dv.getUint16(84 + 48, true), 0);

  const obj = meshToOBJ(mesh);
  const objLines = obj.split('\n');
  assert.ok(objLines[0].startsWith('# geovizwiz 3D export'));
  assert.ok(objLines.includes('o hexmodel'));
  assert.equal(objLines.filter((l) => l.startsWith('v ')).length, mesh.vertexCount);
  assert.equal(objLines.filter((l) => l.startsWith('f ')).length, mesh.triangleCount);
  // 1-based indexed faces.
  const firstFace = objLines.find((l) => l.startsWith('f '))!;
  for (const idx of firstFace.slice(2).split(' ').map(Number)) {
    assert.ok(idx >= 1 && idx <= mesh.vertexCount);
  }
});
