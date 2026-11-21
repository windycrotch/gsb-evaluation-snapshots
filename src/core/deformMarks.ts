/** Which vertices of a mesh a deform moves: what the Deform tool highlights, so the person sees where a pose already has changes. */
import type { VertexData } from './skeleton';

/**
 * One flag per vertex: true when the deform array moves it by more than `eps`. An unweighted mesh has two numbers per vertex, a
 * weighted one two per influence (see `VertexData.bones`); a vertex is moved when any of its numbers is.
 */
export function deformedVertices(
  att: Pick<VertexData, 'vertexCount' | 'weighted' | 'bones'>,
  deform: ArrayLike<number>,
  eps = 1e-3,
): boolean[] {
  const out = new Array<boolean>(att.vertexCount).fill(false);
  if (!deform.length) return out;
  if (!att.weighted || !att.bones) {
    for (let i = 0; i < att.vertexCount; i++) out[i] = Math.abs(deform[i * 2] ?? 0) > eps || Math.abs(deform[i * 2 + 1] ?? 0) > eps;
    return out;
  }
  let v = 0;
  let f = 0;
  for (let i = 0; i < att.vertexCount; i++) {
    const count = att.bones[v];
    v += 1 + count;
    for (let k = 0; k < count; k++, f += 2) if (Math.abs(deform[f] ?? 0) > eps || Math.abs(deform[f + 1] ?? 0) > eps) out[i] = true;
  }
  return out;
}
