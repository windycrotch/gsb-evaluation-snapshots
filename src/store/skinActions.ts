/** Skins: create, rename, delete, pictures, links, scopes, merge and duplicate. */
import { linkedTo, makeLink } from '@/core/links';
import { freshName, pruneSequences } from '@/core/edit';
import { duplicateSkin, mergeSkin, repointSkinPictures, setSkinRequired, setSkinScope, toggleOverride } from '@/core/skins';
import type { DuplicateSkinOptions, MergeSkinOptions, ScopeKind } from '@/core/skins';
import { newSkin } from '@/core/model';
import type { Id } from '@/core/model';
import { applySkinPicks, planSkinImages, putSkinImage } from '@/core/skinImages';
import { docStore } from './doc';
import { toast, uiStore } from './ui';
import { project, skeletonDoc } from './accessors';

export function setActiveSkin(id: Id | null) {
  const ui = uiStore.get();
  let mix = id && ui.skinMix.includes(id) ? ui.skinMix.filter((m) => m !== id) : ui.skinMix;
  // a pinned skin stays shown when another one is chosen
  const old = ui.skinId;
  if (old && old !== id && ui.skinPins.includes(old) && !mix.includes(old) && skeletonDoc().skins.some((s) => s.id === old))
    mix = [...mix, old];
  uiStore.patch({ skinId: id, skinMix: mix });
}

/**
 * Pins a skin (or lets it go): a pinned skin stays shown together with whichever skin is chosen, instead of being replaced by it.
 * Pinning a skin that is not the active one shows it at once. Editor only: the export does not change.
 */
export function toggleSkinPin(id: Id) {
  const ui = uiStore.get();
  const doc = skeletonDoc();
  if (doc.skins[0]?.id === id || !doc.skins.some((s) => s.id === id)) return;
  const pinned = ui.skinPins.includes(id);
  uiStore.patch({
    skinPins: pinned ? ui.skinPins.filter((p) => p !== id) : [...ui.skinPins, id],
    skinMix: !pinned && ui.skinId !== id && !ui.skinMix.includes(id) ? [...ui.skinMix, id] : ui.skinMix,
  });
}

/** Shows a skin together with the active one (and the others in the mix), or takes it out again. Editor only: the export does not change. */
export function toggleSkinMix(id: Id) {
  const ui = uiStore.get();
  const doc = skeletonDoc();
  if (doc.skins[0]?.id === id || ui.skinId === id || !doc.skins.some((s) => s.id === id)) return;
  uiStore.patch({ skinMix: ui.skinMix.includes(id) ? ui.skinMix.filter((m) => m !== id) : [...ui.skinMix, id] });
}

export function createSkin(name?: string): Id {
  const doc = skeletonDoc();
  const skin = newSkin(freshName(name?.trim() || 'skin', doc.skins));
  docStore.update('New skin', (d) => {
    d.skeleton.skins.push(skin);
  });
  setActiveSkin(skin.id);
  return skin.id;
}

export function renameSkin(id: Id, name: string) {
  const clean = name.trim();
  if (!clean) return;
  const doc = skeletonDoc();
  docStore.update('Rename skin', (d) => {
    const s = d.skeleton.skins.find((x) => x.id === id);
    if (s && s !== d.skeleton.skins[0])
      s.name = freshName(
        clean,
        doc.skins.filter((x) => x.id !== id),
      );
  });
}

export function deleteSkin(id: Id) {
  const doc = skeletonDoc();
  if (doc.skins[0]?.id === id) {
    toast('The default skin cannot be deleted');
    return;
  }
  docStore.update('Delete skin', (d) => {
    d.skeleton.skins = d.skeleton.skins.filter((s) => s.id !== id);
    for (const a of d.skeleton.animations) {
      delete a.deform[id];
      if (a.sequence) delete a.sequence[id];
      pruneSequences(a);
    }
  });
  if (uiStore.get().skinId === id) setActiveSkin(null);
  if (uiStore.get().skinMix.includes(id)) uiStore.patch({ skinMix: uiStore.get().skinMix.filter((m) => m !== id) });
  if (uiStore.get().skinPins.includes(id)) uiStore.patch({ skinPins: uiStore.get().skinPins.filter((m) => m !== id) });
}

/** In a non-default skin: shows `imageName` instead of the default attachment `placeholder` of a slot. */
export function setSkinImage(skinId: Id, slotId: Id, placeholder: string, imageName: string) {
  const img = project().images.find((i) => i.name === imageName);
  if (!img) return;
  docStore.update('Skin image', (d) => {
    putSkinImage(d.skeleton, skinId, slotId, placeholder, img);
  });
}

/**
 * Makes the skin of a prefix from the pictures that carry it ("arctic/head", "arctic-head" -> the skin "arctic" shows that picture where the
 * default skin has "head"). A skin of that name that already exists gets the new pictures. One step in the history. Returns the skin, or null
 * when no picture of the prefix fits an attachment.
 */
export function createSkinFromImages(prefix: string): Id | null {
  const picks = planSkinImages(skeletonDoc(), project().images, prefix);
  if (!picks.length) {
    toast('No picture with that prefix fits an attachment', 'error');
    return null;
  }
  let result = { skinId: '' as Id, placed: 0 };
  docStore.update('Skin from images', (d) => {
    result = applySkinPicks(d.skeleton, prefix, picks, d.images);
  });
  if (!result.placed) return null;
  setActiveSkin(result.skinId);
  const odd = picks.filter((p) => p.sizeDiffers).length;
  toast(
    odd ? `Skin made from ${result.placed} pictures; ${odd} of a different size than the mesh` : `Skin made from ${result.placed} pictures`,
    odd ? 'info' : 'ok',
  );
  return result.skinId;
}

/**
 * Makes a mesh of the default skin follow the shape of another mesh of it (two slots that share one shape: a left and a right arm).
 * The mesh keeps its picture, colour and sequence; its own shape is replaced by the source's (undo brings it back).
 */
export function linkMeshTo(slotId: Id, name: string, source: { slotId: Id; name: string }) {
  const doc = docStore.get().skeleton;
  const skin = doc.skins[0];
  const own = skin.attachments[slotId]?.[name];
  const src = skin.attachments[source.slotId]?.[source.name];
  if (own?.type !== 'mesh' || src?.type !== 'mesh' || src === own) return;
  if (src.link) {
    toast('That mesh is a linked mesh itself: link to the mesh it follows', 'error');
    return;
  }
  if (linkedTo(doc, skin.id, slotId, name).length) {
    toast('Other meshes follow this one: unlink them first', 'error');
    return;
  }
  docStore.update('Link mesh', (d) => {
    const m = d.skeleton.skins[0].attachments[slotId]?.[name];
    if (m?.type === 'mesh')
      m.link = makeLink(d.skeleton, slotId, { skinId: d.skeleton.skins[0].id, slotId: source.slotId, name: source.name });
  });
}

/** Whether a linked mesh keeps using the deform timelines of its source mesh. */
export function setLinkDeform(skinId: Id, slotId: Id, name: string, on: boolean) {
  docStore.update('Linked mesh deform', (d) => {
    const m = d.skeleton.skins.find((s) => s.id === skinId)?.attachments[slotId]?.[name];
    if (m?.type === 'mesh' && m.link) m.link.deform = on;
  });
}

/** Cuts a linked mesh loose from its source: it keeps the shape it has now and can be edited on its own. */
export function unlinkMesh(skinId: Id, slotId: Id, name: string) {
  docStore.update('Unlink mesh', (d) => {
    const m = d.skeleton.skins.find((s) => s.id === skinId)?.attachments[slotId]?.[name];
    if (m?.type === 'mesh') delete m.link;
  });
}

export function removeSkinImage(skinId: Id, slotId: Id, placeholder: string) {
  docStore.update('Remove skin image', (d) => {
    const skin = d.skeleton.skins.find((s) => s.id === skinId);
    if (skin) delete skin.attachments[slotId]?.[placeholder];
  });
}

export function duplicateSkinAction(id: Id, opts?: DuplicateSkinOptions, pictures?: { find: string; replace: string }) {
  let made: Id | null = null;
  let repointed = 0;
  docStore.update('Duplicate skin', (d) => {
    made = duplicateSkin(d.skeleton, id, opts)?.id ?? null;
    // the copy shows pictures of its own: a part of the picture names is swapped, where the swapped name is a picture that exists
    if (made && pictures?.find)
      repointed = repointSkinPictures(d.skeleton, made, pictures.find, pictures.replace, new Set(d.images.map((i) => i.name)));
  });
  if (made) {
    setActiveSkin(made);
    if (pictures?.find)
      toast(
        repointed
          ? `Duplicated, ${repointed} pictures point at other pictures`
          : 'Duplicated, no picture name matched a picture that exists',
        repointed ? 'ok' : 'info',
      );
  } else toast('The default skin cannot be duplicated');
}

/** Merges a skin into another: its attachments (and, with the options, bones, constraints and keys) are copied there; the skin itself stays. */
export function mergeSkinAction(fromId: Id, intoId: Id, opts?: MergeSkinOptions) {
  let result: { added: number; replaced: number } | null = null;
  let into = '';
  docStore.update('Merge skins', (d) => {
    result = mergeSkin(d.skeleton, fromId, intoId, opts);
    into = d.skeleton.skins.find((s) => s.id === intoId)?.name ?? '';
  });
  const r = result as { added: number; replaced: number } | null;
  if (!r) toast('Pick another skin to merge into');
  else if (!r.added && !r.replaced) toast('Nothing to merge: every attachment is already there', 'info');
  else toast(`Merged into "${into}": ${r.added} added, ${r.replaced} replaced`, 'ok');
  return r;
}

/** "Skin required": the bone or constraint is only active in the skins that list it. */
export function setSkinRequiredAction(kind: ScopeKind, id: Id, required: boolean) {
  docStore.update(required ? 'Require skin' : 'Always active', (d) => setSkinRequired(d.skeleton, kind, id, required));
}

export function setSkinScopeAction(skinId: Id, kind: ScopeKind, id: Id, on: boolean) {
  docStore.update('Skin scope', (d) => setSkinScope(d.skeleton, skinId, kind, id, on));
}

export function toggleSkinOverride(skinId: Id, slotId: Id, name: string) {
  docStore.update('Skin attachment', (d) => void toggleOverride(d.skeleton, skinId, slotId, name));
}
