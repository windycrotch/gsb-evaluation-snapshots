/**
 * The floating tool windows (Spine's Slot color, Mesh tools and Weights panels): small windows that hover over the viewport, can be dragged
 * anywhere and stay where they were left. While one is open the same controls are not repeated in the Inspector. Open or closed and the position
 * are remembered in the browser. Pure helpers first (tested), then the store.
 */
import { createStore, useStore } from './store';

export type FloatId = 'slotColor' | 'meshTools' | 'weights';

export const FLOAT_LIST: { id: FloatId; label: string }[] = [
  { id: 'slotColor', label: 'Slot color' },
  { id: 'meshTools', label: 'Mesh tools' },
  { id: 'weights', label: 'Weights' },
];

export interface FloatPos {
  x: number;
  y: number;
}

export interface FloatState {
  open: Record<FloatId, boolean>;
  pos: Record<FloatId, FloatPos>;
  /** Bottom to top: the last one is drawn over the others. */
  order: FloatId[];
}

export const DEFAULT_FLOATS: FloatState = {
  open: { slotColor: false, meshTools: false, weights: false },
  pos: { slotColor: { x: 340, y: 90 }, meshTools: { x: 380, y: 130 }, weights: { x: 420, y: 170 } },
  order: ['slotColor', 'meshTools', 'weights'],
};

const KEY = 'bone2d.floats';
const IDS = FLOAT_LIST.map((f) => f.id);

const isPos = (p: unknown): p is FloatPos =>
  !!p && typeof p === 'object' && Number.isFinite((p as FloatPos).x) && Number.isFinite((p as FloatPos).y);

/** Takes stored text for what it is worth: what is missing or wrong keeps its default. */
export function readFloats(raw: string | null): FloatState {
  const out: FloatState = { open: { ...DEFAULT_FLOATS.open }, pos: { ...DEFAULT_FLOATS.pos }, order: [...DEFAULT_FLOATS.order] };
  if (!raw) return out;
  try {
    const data = JSON.parse(raw) as Partial<FloatState>;
    for (const id of IDS) {
      if (typeof data.open?.[id] === 'boolean') out.open[id] = data.open[id];
      const p = data.pos?.[id];
      if (isPos(p)) out.pos[id] = { x: p.x, y: p.y };
    }
    if (Array.isArray(data.order)) {
      const seen = data.order.filter((id, i, a): id is FloatId => IDS.includes(id) && a.indexOf(id) === i);
      out.order = [...seen, ...IDS.filter((id) => !seen.includes(id))];
    }
  } catch {
    /* damaged: defaults */
  }
  return out;
}

/** A position that keeps a window of `size` on the screen, with at least its title bar in reach. */
export function clampFloat(pos: FloatPos, size: { w: number; h: number }, screen: { w: number; h: number }): FloatPos {
  const x = Math.min(Math.max(0, pos.x), Math.max(0, screen.w - Math.min(size.w, screen.w)));
  const y = Math.min(Math.max(0, pos.y), Math.max(0, screen.h - 40));
  return { x, y };
}

function load(): FloatState {
  try {
    return readFloats(localStorage.getItem(KEY));
  } catch {
    return readFloats(null);
  }
}

export const floatStore = createStore<FloatState>(load());
export const useFloats = <S>(selector: (s: FloatState) => S) => useStore(floatStore, selector);

floatStore.subscribe(() => {
  try {
    localStorage.setItem(KEY, JSON.stringify(floatStore.get()));
  } catch {
    /* storage can be blocked */
  }
});

const raised = (order: FloatId[], id: FloatId): FloatId[] => [...order.filter((x) => x !== id), id];

export function toggleFloat(id: FloatId, on?: boolean) {
  const s = floatStore.get();
  const next = on ?? !s.open[id];
  floatStore.set({ ...s, open: { ...s.open, [id]: next }, order: next ? raised(s.order, id) : s.order });
}

export function moveFloat(id: FloatId, pos: FloatPos) {
  const s = floatStore.get();
  floatStore.set({ ...s, pos: { ...s.pos, [id]: pos } });
}

export function raiseFloat(id: FloatId) {
  const s = floatStore.get();
  if (s.order[s.order.length - 1] !== id) floatStore.set({ ...s, order: raised(s.order, id) });
}

/** True when a floating window shows these controls, so the Inspector leaves them out. */
export const isFloating = (id: FloatId): boolean => floatStore.get().open[id];
