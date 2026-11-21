/**
 * Linked meshes (Spine's `linkedmesh`): a mesh in a skin that takes its shape from another mesh and has a picture of its own.
 * The usual case is a skin that dresses the same sprite in other clothes: the default skin has the mesh with its weights and
 * deform, the skin has a linked mesh of the same name that points at it and shows another picture.
 *
 * The linked mesh keeps a copy of the shape (so everything that reads a mesh keeps working); `syncLinkedMeshes` is what keeps the
 * copy equal to the source, and what turns a link whose source is gone into an ordinary mesh. It runs after every edit of the
 * document, so the copy is never seen out of date.
 */
import { dropDeformTimeline } from './edit';
import { remapDeformValues } from './mesh';
import type { Id, MeshAttachment, MeshLink, SkeletonDoc, Skin } from './model';

export interface LinkSource {
  skin: Skin;
  slotId: Id;
  mesh: MeshAttachment;
}

/** The mesh a linked mesh (sitting in `slotId`) takes its shape from, or null when the link is not valid. */
export function linkSource(doc: SkeletonDoc, slotId: Id, mesh: MeshAttachment): LinkSource | null {
  const link = mesh.link;
  if (!link) return null;
  const skin = link.skin ? doc.skins.find((s) => s.id === link.skin) : doc.skins[0];
  if (!skin) return null;
  const sourceSlot = link.slot ?? slotId;
  const source = skin.attachments[sourceSlot]?.[link.source];
  // a link of a link would need the loader to resolve them in the right order: the source has to be a plain mesh
  if (!source || source.type !== 'mesh' || source.link || source === mesh) return null;
  return { skin, slotId: sourceSlot, mesh: source };
}

function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameData(a[i], b[i])) return false;
    return true;
  }
  return false;
}

function cloneData<T>(v: T): T {
  return Array.isArray(v) ? (v.map(cloneData) as unknown as T) : v;
}

/** The fields of a mesh that make its shape (and are the same in a mesh and the linked meshes of it). */
const SHAPE = ['uvs', 'triangles', 'hull', 'edges', 'vertices', 'weights', 'width', 'height'] as const;

/** Makes the shape of a linked mesh the shape of its source. Returns true when something changed. */
function copyShape(to: MeshAttachment, from: MeshAttachment): boolean {
  let changed = false;
  for (const key of SHAPE) {
    if (sameData(to[key], from[key])) continue;
    (to as unknown as Record<string, unknown>)[key] = cloneData(from[key]);
    changed = true;
  }
  return changed;
}

/** The deform keys a linked mesh has of its own, made to fit its shape after the shape of its source changed (dropped when they cannot be carried over). */
function keepOwnDeform(doc: SkeletonDoc, skin: Skin, slotId: Id, name: string, before: MeshAttachment, after: MeshAttachment) {
  const bones = new Set(doc.bones.map((b) => b.id));
  const has = (id: Id) => bones.has(id);
  for (const a of doc.animations) {
    const keys = a.deform[skin.id]?.[slotId]?.[name];
    if (!keys) continue;
    const next: number[][] = [];
    for (const k of keys) {
      const v = remapDeformValues(before, after, null, has, k.value);
      if (!v) break;
      next.push(v);
    }
    if (next.length !== keys.length) dropDeformTimeline(a, skin.id, slotId, name);
    else keys.forEach((k, i) => void (k.value = next[i]));
  }
}

/**
 * Brings every linked mesh in line with its source: a link whose source is gone (or is not a plain mesh) is dropped and the mesh
 * stays as it is, and the link of a mesh in the default skin is written the one way (`skin: null`). Returns the number of changes.
 */
export function syncLinkedMeshes(doc: SkeletonDoc): number {
  let changes = 0;
  const defaultId = doc.skins[0]?.id;
  for (const skin of doc.skins) {
    for (const slotId in skin.attachments) {
      const bag = skin.attachments[slotId];
      for (const name in bag) {
        const att = bag[name];
        if (att.type !== 'mesh' || !att.link) continue;
        const source = linkSource(doc, slotId, att);
        if (!source) {
          delete att.link;
          changes++;
          continue;
        }
        if (att.link.skin === defaultId) att.link.skin = null;
        if (att.link.slot === slotId) att.link.slot = null;
        // deform keys of its own (made for it, or copied with a skin) have to follow its new shape, also when it takes the deform of its source
        const old = { ...att };
        if (copyShape(att, source.mesh)) {
          changes++;
          if (old) keepOwnDeform(doc, skin, slotId, name, old, att);
        }
      }
    }
  }
  return changes;
}

/** True when the document has any linked mesh (a quick test before the work of looking at them). */
export function hasLinkedMeshes(doc: SkeletonDoc): boolean {
  for (const skin of doc.skins)
    for (const slotId in skin.attachments)
      for (const name in skin.attachments[slotId]) if ((skin.attachments[slotId][name] as MeshAttachment).link) return true;
  return false;
}

/** A link to the mesh `source` of a slot in a skin, written the way `syncLinkedMeshes` wants it. */
export function makeLink(doc: SkeletonDoc, slotId: Id, from: { skinId: Id; slotId: Id; name: string }, deform = true): MeshLink {
  return {
    source: from.name,
    slot: from.slotId === slotId ? null : from.slotId,
    skin: from.skinId === doc.skins[0]?.id ? null : from.skinId,
    deform,
  };
}

/**
 * Where the deform keys that move a mesh are kept: a linked mesh that shares the deform of its source has none of its own, the
 * keys of the source move it, so a deform made on it goes there.
 */
export function deformHome(doc: SkeletonDoc, skinId: Id, slotId: Id, name: string): { skinId: Id; slotId: Id; name: string } {
  const skin = doc.skins.find((s) => s.id === skinId);
  const att = skin?.attachments[slotId]?.[name];
  if (att?.type !== 'mesh' || !att.link?.deform) return { skinId, slotId, name };
  const source = linkSource(doc, slotId, att);
  if (!source) return { skinId, slotId, name };
  return { skinId: source.skin.id, slotId: source.slotId, name: att.link.source };
}

/** The linked meshes that follow the mesh `name` of a slot in a skin: where they are and which of them share its deform. */
export function linkedTo(
  doc: SkeletonDoc,
  skinId: Id,
  slotId: Id,
  name: string,
): { skin: Skin; slotId: Id; name: string; mesh: MeshAttachment }[] {
  const out: { skin: Skin; slotId: Id; name: string; mesh: MeshAttachment }[] = [];
  for (const skin of doc.skins) {
    for (const sid in skin.attachments) {
      for (const n in skin.attachments[sid]) {
        const att = skin.attachments[sid][n];
        if (att.type !== 'mesh' || !att.link) continue;
        const src = linkSource(doc, sid, att);
        if (src && src.skin.id === skinId && src.slotId === slotId && att.link.source === name)
          out.push({ skin, slotId: sid, name: n, mesh: att });
      }
    }
  }
  return out;
}
