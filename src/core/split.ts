/**
 * Split bone (Spine: the Split button in the bone properties, with Nested and Fibonacci boxes): cuts one bone into several shorter ones
 * along its own x axis. The original keeps its name, its slots, weights and keys and becomes the first part; the new parts have no keys.
 * Nested: every new part is a child of the one before it (a chain: tail, spine, tentacle). Not nested: the parts stand side by side as
 * siblings under the parent of the original. Equal lengths, or Fibonacci (each part shorter than the one before: 5 3 2 1 1).
 * In the nested case the children of the original go to the part they sit on (by their x), so a hand at the end of a forearm follows the last part.
 */
import { DEG2RAD } from './math';
import type { Bone, Id, SkeletonDoc } from './model';
import { newBone } from './model';
import { freshName, normalizeBoneOrder, reconcileDeform } from './edit';
import { normalizeInfluences } from './mesh';
import type { Influence, MeshAttachment } from './model';

export const MAX_SPLIT = 32;

export interface SplitOptions {
  nested: boolean;
  fibonacci: boolean;
  /**
   * What happens to the vertices of meshes that follow the bone: `keep` leaves all their weight on the first part (Spine), `split` gives each
   * vertex to the part it lies on (by its position along the bone), `blend` also shares the weight between neighbours around each cut, so the
   * mesh bends smoothly there. Absent = `keep`.
   */
  weights?: 'keep' | 'split' | 'blend';
}

/** Lengths of `count` parts that add up to `total`. Fibonacci: the longest first (…5, 3, 2, 1, 1). */
export function splitLengths(total: number, count: number, fibonacci: boolean): number[] {
  const w: number[] = [];
  if (fibonacci) {
    let a = 1;
    let b = 1;
    for (let i = 0; i < count; i++) {
      w.push(a);
      [a, b] = [b, a + b];
    }
    w.reverse();
  } else for (let i = 0; i < count; i++) w.push(1);
  const sum = w.reduce((s, x) => s + x, 0);
  return w.map((x) => (total * x) / sum);
}

/** Splits the bone in the document. Returns the ids of the new parts in order, or an error text. */
export function splitBoneInDoc(doc: SkeletonDoc, id: Id, count: number, opts: SplitOptions): { ids: Id[] } | { error: string } {
  const bone = doc.bones.find((b) => b.id === id);
  if (!bone) return { error: 'Bone not found' };
  const n = Math.round(count);
  if (!(n >= 2) || n > MAX_SPLIT) return { error: `Split into 2 to ${MAX_SPLIT} bones` };
  if (!opts.nested && !bone.parent) return { error: 'The root bone can only be split nested' };
  if (!(bone.length > 0)) return { error: 'The bone has no length to split' };
  const lens = splitLengths(bone.length, n, opts.fibonacci);
  const offsets: number[] = [];
  let at = 0;
  for (const l of lens) {
    offsets.push(at);
    at += l;
  }
  const originalChildren = doc.bones.filter((b) => b.parent === id);
  if (opts.nested) {
    // a two-bone IK chain needs its second bone to stay a child of the first: it cannot move on to a later part
    for (const c of doc.constraints) {
      if (c.type !== 'ik' || c.bones.length !== 2 || c.bones[0] !== id) continue;
      const second = originalChildren.find((b) => b.id === c.bones[1]);
      if (second && offsets.some((o, i) => i > 0 && second.x >= o - 1e-9))
        return {
          error: `"${bone.name}" is the first bone of the IK constraint "${c.name}": the second bone would end up under a later part. Split it side by side, or remove the constraint first`,
        };
    }
  }
  const parts: Bone[] = [];
  const baseName = bone.name;
  for (let i = 1; i < n; i++) {
    const name = freshName(`${baseName}${i + 1}`, [...doc.bones, ...parts]);
    if (opts.nested) {
      parts.push(
        newBone({
          name,
          parent: i === 1 ? id : parts[i - 2].id,
          x: lens[i - 1],
          length: lens[i],
          color: bone.color,
          skinRequired: bone.skinRequired,
        }),
      );
    } else {
      // along the bone's own x axis, in the space of its parent
      const ang = (bone.rotation + bone.shearX) * DEG2RAD;
      parts.push(
        newBone({
          name,
          parent: bone.parent,
          x: bone.x + Math.cos(ang) * bone.scaleX * offsets[i],
          y: bone.y + Math.sin(ang) * bone.scaleX * offsets[i],
          rotation: bone.rotation,
          scaleX: bone.scaleX,
          scaleY: bone.scaleY,
          shearX: bone.shearX,
          shearY: bone.shearY,
          inherit: bone.inherit,
          length: lens[i],
          color: bone.color,
          skinRequired: bone.skinRequired,
        }),
      );
    }
  }
  bone.length = lens[0];
  if (opts.nested) {
    // the parts are the original's frame moved along x, so a child only needs its x shifted
    for (const ch of originalChildren) {
      let k = 0;
      for (let i = 1; i < n; i++) if (ch.x >= offsets[i] - 1e-9) k = i;
      if (k === 0) continue;
      ch.parent = parts[k - 1].id;
      ch.x -= offsets[k];
    }
  }
  const at0 = doc.bones.findIndex((b) => b.id === id);
  doc.bones.splice(at0 + 1, 0, ...parts);
  normalizeBoneOrder(doc);
  if (opts.weights === 'split' || opts.weights === 'blend')
    redistributeWeights(doc, id, [id, ...parts.map((p) => p.id)], offsets, lens, opts.weights === 'blend');
  return { ids: parts.map((p) => p.id) };
}

/**
 * The share of a vertex at `x` (along the original bone) that each part gets. The part it lies on takes all; with `blend` the two parts at a cut
 * trade weight across a band around it (half way through at the cut itself), the width of half of the shorter neighbour.
 */
export function partShares(x: number, offsets: number[], lens: number[], blend: boolean): number[] {
  const n = offsets.length;
  const shares = new Array<number>(n).fill(0);
  let k = 0;
  for (let i = 1; i < n; i++) if (x >= offsets[i] - 1e-9) k = i;
  shares[k] = 1;
  if (!blend) return shares;
  const band = (a: number, b: number) => Math.max(1e-9, Math.min(lens[a], lens[b]) / 2);
  if (k > 0) {
    const h = band(k - 1, k);
    const d = x - offsets[k];
    if (d < h) {
      const t = 0.5 + d / (2 * h);
      shares[k] = t;
      shares[k - 1] = 1 - t;
    }
  }
  if (k < n - 1) {
    const h = band(k, k + 1);
    const d = offsets[k + 1] - x;
    if (d < h) {
      const t = 0.5 + d / (2 * h);
      shares[k] = Math.min(shares[k], t);
      shares[k + 1] = 1 - t;
      if (k > 0 && shares[k - 1] > 0) shares[k] = Math.max(0, 1 - shares[k - 1] - shares[k + 1]); // a part shorter than the two bands
    }
  }
  return shares;
}

/** The weighted meshes of the default skin that follow `id` hand its vertices to the parts (see `SplitOptions.weights`); deform keys follow their influences. */
function redistributeWeights(doc: SkeletonDoc, id: Id, partIds: Id[], offsets: number[], lens: number[], blend: boolean) {
  const skin = doc.skins[0];
  if (!skin) return;
  for (const slotId of Object.keys(skin.attachments)) {
    for (const [name, att] of Object.entries(skin.attachments[slotId])) {
      if (att.type !== 'mesh' || !att.weights || att.link) continue;
      if (!att.weights.some((list) => list.some((inf) => inf[0] === id))) continue;
      const before = att;
      const weights = att.weights.map((list) => {
        if (!list.some((inf) => inf[0] === id)) return list;
        const out: Influence[] = [];
        for (const inf of list) {
          if (inf[0] !== id) {
            out.push(inf);
            continue;
          }
          const shares = partShares(inf[1], offsets, lens, blend);
          shares.forEach((share, i) => {
            if (share > 1e-9) out.push([partIds[i], inf[1] - offsets[i], inf[2], inf[3] * share]);
          });
        }
        // the same bone twice (a part that was already an influence) adds up
        const merged = new Map<Id, Influence>();
        for (const inf of out) {
          const had = merged.get(inf[0]);
          merged.set(inf[0], had ? [inf[0], had[1], had[2], had[3] + inf[3]] : [...inf]);
        }
        return normalizeInfluences([...merged.values()]);
      });
      const after: MeshAttachment = { ...before, weights };
      skin.attachments[slotId][name] = after;
      reconcileDeform(doc, slotId, name, before, after, null);
    }
  }
}
