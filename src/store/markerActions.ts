/** Timeline markers of the open animation: add, edit, delete, jump to, and cut the animation into clips at them. */
import { addMarker, neighbourMarker, removeMarker, splitAtMarkers } from '@/core/markers';
import { MARKER_COLORS } from '@/core/model';
import type { Id, Marker } from '@/core/model';
import { currentAnimation, setTime } from './actions';
import { docStore } from './doc';
import { createStore, useStore } from './store';
import { toast, uiStore } from './ui';

/** The marker whose dialog is open (none: closed). */
const markerDialogStore = createStore<{ id: Id | null }>({ id: null });
export const useMarkerDialog = (): Id | null => useStore(markerDialogStore, (s) => s.id);
export const openMarkerDialog = (id: Id) => markerDialogStore.set({ id });
export const closeMarkerDialog = () => markerDialogStore.set({ id: null });

/** Puts a marker at the playhead (the one already there when there is one) and opens its dialog. Returns its id. */
export function addMarkerAtPlayhead(): Id | null {
  const anim = currentAnimation();
  if (!anim) {
    toast('Select an animation first');
    return null;
  }
  const time = uiStore.get().time;
  let id: Id | null = null;
  docStore.update('Add marker', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (!a) return;
    const used = new Set((a.markers ?? []).map((m) => m.color));
    let color = 0;
    while (used.has(color) && color < MARKER_COLORS - 1) color++;
    id = addMarker(a, time, '', color).id;
  });
  if (id) openMarkerDialog(id);
  return id;
}

export function updateMarker(id: Id, patch: Partial<Pick<Marker, 'name' | 'text' | 'color' | 'time' | 'resolved'>>) {
  const anim = currentAnimation();
  if (!anim) return;
  docStore.update('Edit marker', (d) => {
    const m = d.skeleton.animations.find((x) => x.id === anim.id)?.markers?.find((x) => x.id === id);
    if (!m) return;
    if (patch.name !== undefined) m.name = patch.name;
    if (patch.resolved !== undefined && m.review) m.resolved = patch.resolved;
    if (patch.text !== undefined) m.text = patch.text;
    if (patch.color !== undefined) m.color = Math.min(Math.max(0, Math.round(patch.color)), MARKER_COLORS - 1);
    if (patch.time !== undefined && Number.isFinite(patch.time)) m.time = Math.min(Math.max(0, patch.time), anim.duration);
  });
}

export function deleteMarker(id: Id) {
  const anim = currentAnimation();
  if (!anim) return;
  docStore.update('Delete marker', (d) => {
    const a = d.skeleton.animations.find((x) => x.id === anim.id);
    if (a) removeMarker(a, id);
  });
  if (markerDialogStore.get().id === id) closeMarkerDialog();
}

/** Moves the playhead to the next (`dir` 1) or previous marker. */
export function goToMarker(dir: 1 | -1) {
  const m = neighbourMarker(currentAnimation(), uiStore.get().time, dir);
  if (m) setTime(m.time);
  else toast(dir > 0 ? 'No marker after the playhead' : 'No marker before the playhead');
}

/** Cuts the open animation into one animation per stretch between markers. Returns how many were made. */
export function splitAtMarkersAction(): number {
  const anim = currentAnimation();
  if (!anim) return 0;
  const doc = docStore.get().skeleton;
  const pieces = splitAtMarkers(
    anim,
    doc.animations.map((a) => a.name),
  );
  if (!pieces.length) {
    toast('Add a marker inside the animation first: it is cut where the markers are');
    return 0;
  }
  docStore.update('Split animation at markers', (d) => {
    d.skeleton.animations.push(...pieces);
  });
  uiStore.patch({ animationId: pieces[0].id, time: 0, playing: false, overrides: {}, selectedKeys: [] });
  toast(`Made ${pieces.length} animations from "${anim.name}"`, 'ok');
  return pieces.length;
}
