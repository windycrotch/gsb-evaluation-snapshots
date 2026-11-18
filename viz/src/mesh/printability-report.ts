/**
 * Human-readable printability verdict built from a MeshReport. Pure (no DOM),
 * so it is unit-testable and reusable from the worker or the panel.
 *
 * The verdict rules mirror validateMesh exactly and are intentionally kept here
 * as presentation only:
 *   watertight = boundaryEdges === 0 && nonManifoldEdges === 0
 *   solid      = watertight && windingConsistent && volumeMm3 > 0
 *
 * Note on non-manifold edges: adjacent hex prisms share side walls, so their
 * coincident edges are referenced by more than two faces after vertex merging.
 * That is expected for this builder (slicers union the touching columns), and
 * the wording below reports it factually rather than as a generic failure.
 */
import type { IndexedMesh } from './heightfield-mesh';
import type { MeshReport } from './validate-mesh';

/** Shown (and asserted in tests) when the builder produced no geometry. */
export const EMPTY_MESH_MESSAGE = 'No geometry to export — all hex metrics are zero, negative, or empty.';

/** Builder-level emptiness, independent of the validation report. */
export function isEmptyMesh(mesh: IndexedMesh): boolean {
  return mesh.triangleCount === 0 || mesh.indices.length === 0;
}

/** Volume with thousands separators and a fixed mm³ unit. */
export function formatVolumeMm3(volumeMm3: number): string {
  return `${volumeMm3.toLocaleString('en-US', { maximumFractionDigits: 2 })} mm³`;
}

function yesNo(v: boolean): string {
  return v ? 'yes' : 'no';
}

/**
 * Multi-line printable summary. Every line is a fixed label/value pair so the
 * panel can render the block verbatim with `white-space: pre-line`.
 */
export function formatPrintabilityReport(report: MeshReport): string {
  const lines = [
    `Triangles: ${report.triangles.toLocaleString('en-US')}`,
    `Vertices (merged): ${report.mergedVertices.toLocaleString('en-US')}`,
    `Boundary edges: ${report.boundaryEdges.toLocaleString('en-US')}`,
    `Non-manifold edges: ${report.nonManifoldEdges.toLocaleString('en-US')}`,
    `Degenerate triangles: ${report.degenerateTriangles.toLocaleString('en-US')}`,
    `Winding consistent: ${yesNo(report.windingConsistent)}`,
    `Volume: ${formatVolumeMm3(report.volumeMm3)}`,
  ];

  // Factual intermediate conditions before the final verdict.
  if (report.boundaryEdges > 0) {
    lines.push(`Open edges: ${report.boundaryEdges} — the mesh has holes and is not watertight.`);
  }
  if (report.nonManifoldEdges > 0) {
    lines.push('Non-manifold edges are expected: adjacent hex prisms share side walls; slicers union the touching columns.');
  }

  if (report.isSolid) {
    lines.push('Verdict: solid ✓ — watertight, consistent winding, positive volume. Ready to slice.');
  } else {
    const reasons: string[] = [];
    if (report.boundaryEdges > 0) reasons.push('open boundary edges');
    if (report.nonManifoldEdges > 0) reasons.push('non-manifold edges from shared prism walls');
    if (!report.windingConsistent) reasons.push('inconsistent winding');
    if (!(report.volumeMm3 > 0)) reasons.push('non-positive volume');
    lines.push(`Verdict: not a solid — ${reasons.join('; ') || 'validation failed'}.`);
  }
  return lines.join('\n');
}
