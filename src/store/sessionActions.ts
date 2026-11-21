/** What the person looks at: the accessors of the open document, mode, tool, selection, time and playback. */
import { snapTime } from '@/core/edit';
import { selectionOfMatch } from '@/core/treeFilter';
import type { TreeMatch } from '@/core/treeFilter';
import { cleanPlay, playOf, playSpan, samePlay } from '@/core/playback';
import type { Id, PlaySettings } from '@/core/model';
import { docStore } from './doc';
import { ATTACHMENT_TOOLS, emptySelection, toast, uiStore } from './ui';
import type { Selection, Tool } from './ui';
import { skeletonDoc, slotById, currentAnimation } from './accessors';
import { createAnimation } from './animationActions';

/**
 * Changes how the current animation plays (loop, ping-pong, play range). It is kept on the animation, so every animation has its own
 * settings and they are saved with the project; the playback loop and the timeline read them back through `ui`.
 */
export function setPlay(patch: Partial<PlaySettings>) {
  const anim = currentAnimation();
  if (!anim) return;
  const next = cleanPlay({ ...playOf(anim), ...patch }, anim.duration);
  if (samePlay(next, playOf(anim))) return;
  docStore.update('Playback settings', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (a) a.play = next;
  });
}

export function setMode(mode: 'setup' | 'animate') {
  const ui = uiStore.get();
  if (ui.mode === mode) return;
  if (mode === 'animate') {
    const doc = skeletonDoc();
    let animId = ui.animationId;
    if (!animId || !doc.animations.some((a) => a.id === animId)) animId = doc.animations[0]?.id ?? null;
    if (!animId) animId = createAnimation('animation');
    uiStore.patch({
      mode,
      animationId: animId,
      overrides: {},
      tool: ui.tool === 'create' || ui.tool === 'mesh' || ui.tool === 'weights' || ATTACHMENT_TOOLS.includes(ui.tool) ? 'select' : ui.tool,
    });
  } else {
    uiStore.patch({ mode, playing: false, overrides: {} });
  }
}

export function setTool(tool: Tool) {
  const ui = uiStore.get();
  if (ui.mode === 'animate' && (tool === 'create' || tool === 'weights' || ATTACHMENT_TOOLS.includes(tool))) {
    toast(
      tool === 'create'
        ? 'Switch to Setup mode to create bones'
        : tool === 'weights'
          ? 'Switch to Setup mode to edit weights'
          : 'Switch to Setup mode to create attachments',
    );
    return;
  }
  uiStore.patch({ tool });
}

export function setSelection(sel: Partial<Selection>) {
  uiStore.patch({ selection: { ...emptySelection, ...sel } });
}

export function clearSelection() {
  uiStore.patch({ selection: emptySelection });
}

/**
 * Drops selected bones / slot / attachment / constraint that no longer exist (undo of their creation, a deletion …),
 * so no panel or tool is ever asked about an entity that is gone.
 */
export function sanitizeSelection() {
  const doc = skeletonDoc();
  const sel = uiStore.get().selection;
  const bones = sel.bones.filter((id) => doc.bones.some((b) => b.id === id));
  const slotOk = sel.slot === null || doc.slots.some((s) => s.id === sel.slot);
  const attOk = slotOk && (sel.attachment === null || (sel.slot !== null && !!doc.skins[0]?.attachments[sel.slot]?.[sel.attachment]));
  const constraintOk = sel.constraint === null || doc.constraints.some((c) => c.id === sel.constraint);
  const extra =
    slotOk && sel.slot !== null ? (sel.extraSlots ?? []).filter((id) => id !== sel.slot && doc.slots.some((s) => s.id === id)) : [];
  if (bones.length === sel.bones.length && slotOk && attOk && constraintOk && extra.length === (sel.extraSlots ?? []).length) return;
  uiStore.patch({
    selection: {
      bones,
      slot: slotOk ? sel.slot : null,
      attachment: attOk ? sel.attachment : null,
      constraint: constraintOk ? sel.constraint : null,
      vertices: attOk ? sel.vertices : [],
      extraSlots: extra,
    },
  });
}

/** Flip Viewport (Spine 4.3): mirrors the view left to right, or puts it back. Only the view: nothing in the document changes. */
export function flipViewport() {
  const cam = uiStore.get().camera;
  uiStore.patch({ camera: { ...cam, flip: !cam.flip } });
}

export function selectBone(id: Id, additive = false) {
  const cur = uiStore.get().selection;
  if (additive) {
    const bones = cur.bones.includes(id) ? cur.bones.filter((b) => b !== id) : [...cur.bones, id];
    setSelection({ bones });
  } else setSelection({ bones: [id] });
}

/** Select (next to the hierarchy filter): selects the bones and slots that match the filter, all at once. Returns how many things it selected. */
export function selectMatches(match: TreeMatch): number {
  const sel = selectionOfMatch(match);
  const n = sel.bones.length + (sel.slot ? 1 + sel.extraSlots.length : 0);
  if (!n) return 0;
  const doc = skeletonDoc();
  const slot = sel.slot ? doc.slots.find((s) => s.id === sel.slot) : undefined;
  setSelection({ bones: sel.bones, slot: slot ? slot.id : null, attachment: slot?.attachment ?? null, extraSlots: sel.extraSlots });
  return n;
}

/** Ctrl-click on a slot: adds it to the slots the weights tools work on together with the selected one, or takes it out again. */
export function toggleExtraSlot(slotId: Id) {
  const sel = uiStore.get().selection;
  if (!sel.slot || sel.slot === slotId) return;
  const had = sel.extraSlots ?? [];
  const extra = had.includes(slotId) ? had.filter((id) => id !== slotId) : [...had, slotId];
  uiStore.patch({ selection: { ...sel, extraSlots: extra } });
}

export function selectSlot(slotId: Id, attachment?: string | null) {
  const slot = slotById(slotId);
  setSelection({
    slot: slotId,
    attachment: attachment === undefined ? (slot?.attachment ?? null) : attachment,
    bones: slot ? [slot.bone] : [],
  });
}

export function setTime(t: number, snap = true) {
  const ui = uiStore.get();
  const anim = currentAnimation();
  const fps = skeletonDoc().fps;
  let time = snap ? snapTime(t, fps) : Math.max(0, t);
  if (anim) time = Math.min(time, anim.duration);
  uiStore.patch({ time, overrides: Object.keys(ui.overrides).length ? {} : ui.overrides });
}

export function togglePlay() {
  const ui = uiStore.get();
  if (ui.mode !== 'animate') setMode('animate');
  const anim = currentAnimation();
  if (!anim) return;
  const now = uiStore.get();
  if (!now.playing) {
    // start inside the play range, and from its beginning when a single play already reached the end
    const [lo, hi] = playSpan(anim.duration, now.range);
    if (now.time < lo || (now.time >= hi - 1e-6 && !now.loop)) uiStore.patch({ time: lo });
  }
  uiStore.patch({ playing: !uiStore.get().playing, overrides: {} });
}
