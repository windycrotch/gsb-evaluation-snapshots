/**
 * Preferences (Spine's Settings window, F12). Kept in the browser, applied at once. Unlike the project they belong to the person, not to the file.
 */
import { cleanSavedCurves } from '@/core/savedCurves';
import type { SavedCurve } from '@/core/savedCurves';
import { keyGrid } from '@/core/edit';
import { createStore, useStore } from './store';

export interface Settings {
  /** Save the open project to the browser every moment it changes. */
  autosave: boolean;
  /** Viewport background, r g b in 0..1. */
  viewportBg: [number, number, number];
  /** Smooth (linear) textures; off shows the pixels as they are. */
  smoothing: boolean;
  /** The wheel zooms around the pointer; off zooms around the middle of the viewport. */
  zoomToMouse: boolean;
  /** Show the welcome window when the editor starts with nothing to restore. */
  showWelcome: boolean;
  /** Onion skin: frames shown before and after the playhead, and the frames between two of them. */
  onionBefore: number;
  onionAfter: number;
  onionGap: number;
  /** Ghosts every few frames, or at the keys around the playhead. */
  onionMode: 'frames' | 'keys';
  /** How far each ghost is moved from the pose, per step (scene units). */
  onionOffsetX: number;
  onionOffsetY: number;
  onionStyle: 'image' | 'silhouette' | 'xray';
  /** Ghosts drawn over the pose. */
  onionTop: boolean;
  onionColorBefore: [number, number, number];
  onionColorAfter: [number, number, number];
  /** Arrows along the motion of the selected bones through the ghosts (from the nearest before-ghost to the pose and on to the after-ghosts). */
  onionArrows: boolean;
  /** Steps of a frame that keys and the playhead snap to: 1 whole frames, 2 halves, 4 quarters, 10 tenths (keys between frames). */
  keyGrid: number;
  /** A new key starts with the interpolation chosen last for a key (the Smooth / Linear / Stepped menu of the timeline follows what Set interpolation picks). */
  lastChosenCurve: boolean;
  /** Draw the grid of single units (pixels of the pictures at 100%) when zoomed in far enough to tell them apart. */
  pixelGrid: boolean;
  /** Show the frames drawn in the last second and the time of the last one, in a corner of the viewport. */
  showFps: boolean;
  /** How thick the bones are drawn in the viewport, in percent of the default. */
  boneScale: number;
  /** Turn of the icon a bone without length is drawn with, in degrees (a view setting: it changes nothing in the file). */
  boneIconRotation: number;
  /** How many parent bones the breadcrumbs of the selection list (the nearest ones). */
  breadcrumbParents: number;
  /** What the Graph shows: the timelines of the keys selected in the Dopesheet (Dopesheet-centric), or of the selected bones whatever keys are selected. */
  graphSync: 'dopesheet' | 'selection';
  /** Easing curves kept under a name, to put on other keys (Timeline menu → Saved curves). */
  savedCurves: SavedCurve[];
  /** Show the hints that pop up over buttons and fields. */
  tooltips: boolean;
  /** Letters of the tools that differ from the defaults (tools.ts). */
  toolKeys: Record<string, string>;
  /** Key combinations of the commands that differ from the defaults (hotkeys.ts), by command id: "Ctrl+Shift+S". */
  keyMap: Record<string, string>;
}

/** A combination as the editor writes it: Ctrl, Alt and Shift in that order, then one key. */
/** The range of the bone size slider, in percent. */
export const BONE_SCALE_RANGE = { min: 25, max: 300, step: 5 } as const;

const COMBO = /^(Ctrl\+)?(Alt\+)?(Shift\+)?(F\d{1,2}|Tab|Space|[^\s+])$/;

export const DEFAULT_SETTINGS: Settings = {
  autosave: true,
  viewportBg: [0.075, 0.082, 0.1],
  smoothing: true,
  zoomToMouse: true,
  showWelcome: true,
  onionBefore: 2,
  onionAfter: 2,
  onionGap: 3,
  onionMode: 'frames',
  onionOffsetX: 0,
  onionOffsetY: 0,
  onionStyle: 'image',
  onionTop: false,
  onionColorBefore: [1, 0.62, 0.55],
  onionColorAfter: [0.55, 0.82, 1],
  onionArrows: false,
  keyGrid: 1,
  lastChosenCurve: false,
  pixelGrid: false,
  showFps: false,
  boneScale: 100,
  boneIconRotation: 0,
  breadcrumbParents: 3,
  graphSync: 'dopesheet',
  savedCurves: [],
  tooltips: true,
  toolKeys: {},
  keyMap: {},
};

const KEY = 'bone2d.settings';

const isRgb = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && n >= 0 && n <= 1);

/** Takes stored text for what it is worth: what is not valid keeps its default. */
export function readSettings(raw: string | null): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS, toolKeys: {}, keyMap: {} };
  if (!raw) return out;
  try {
    const data = JSON.parse(raw) as Partial<Settings>;
    if (typeof data.autosave === 'boolean') out.autosave = data.autosave;
    if (isRgb(data.viewportBg)) out.viewportBg = data.viewportBg;
    if (typeof data.smoothing === 'boolean') out.smoothing = data.smoothing;
    if (typeof data.zoomToMouse === 'boolean') out.zoomToMouse = data.zoomToMouse;
    if (typeof data.showWelcome === 'boolean') out.showWelcome = data.showWelcome;
    const whole = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
    if (whole(data.onionBefore, 0, 6)) out.onionBefore = data.onionBefore;
    if (whole(data.onionAfter, 0, 6)) out.onionAfter = data.onionAfter;
    if (whole(data.onionGap, 1, 30)) out.onionGap = data.onionGap;
    if (data.onionMode === 'frames' || data.onionMode === 'keys') out.onionMode = data.onionMode;
    if (typeof data.onionOffsetX === 'number' && Number.isFinite(data.onionOffsetX) && Math.abs(data.onionOffsetX) <= 10000)
      out.onionOffsetX = data.onionOffsetX;
    if (typeof data.onionOffsetY === 'number' && Number.isFinite(data.onionOffsetY) && Math.abs(data.onionOffsetY) <= 10000)
      out.onionOffsetY = data.onionOffsetY;
    if (data.onionStyle === 'image' || data.onionStyle === 'silhouette' || data.onionStyle === 'xray') out.onionStyle = data.onionStyle;
    if (typeof data.onionTop === 'boolean') out.onionTop = data.onionTop;
    if (isRgb(data.onionColorBefore)) out.onionColorBefore = data.onionColorBefore;
    if (isRgb(data.onionColorAfter)) out.onionColorAfter = data.onionColorAfter;
    if (typeof data.onionArrows === 'boolean') out.onionArrows = data.onionArrows;
    if (data.keyGrid === 1 || data.keyGrid === 2 || data.keyGrid === 4 || data.keyGrid === 10) out.keyGrid = data.keyGrid;
    if (typeof data.lastChosenCurve === 'boolean') out.lastChosenCurve = data.lastChosenCurve;
    if (typeof data.pixelGrid === 'boolean') out.pixelGrid = data.pixelGrid;
    if (typeof data.showFps === 'boolean') out.showFps = data.showFps;
    if (
      typeof data.boneScale === 'number' &&
      Number.isFinite(data.boneScale) &&
      data.boneScale >= BONE_SCALE_RANGE.min &&
      data.boneScale <= BONE_SCALE_RANGE.max
    )
      out.boneScale = data.boneScale;
    if (Number.isInteger(data.breadcrumbParents) && (data.breadcrumbParents as number) >= 0 && (data.breadcrumbParents as number) <= 10)
      out.breadcrumbParents = data.breadcrumbParents as number;
    if (Array.isArray(data.savedCurves)) out.savedCurves = cleanSavedCurves(data.savedCurves);
    if (data.graphSync === 'dopesheet' || data.graphSync === 'selection') out.graphSync = data.graphSync;
    if (typeof data.boneIconRotation === 'number' && Number.isFinite(data.boneIconRotation) && Math.abs(data.boneIconRotation) <= 180)
      out.boneIconRotation = data.boneIconRotation;
    if (typeof data.tooltips === 'boolean') out.tooltips = data.tooltips;
    if (data.toolKeys && typeof data.toolKeys === 'object') {
      const used = new Set<string>();
      for (const [tool, letter] of Object.entries(data.toolKeys)) {
        if (typeof letter === 'string' && /^[A-Z]$/.test(letter) && !used.has(letter)) {
          out.toolKeys[tool] = letter;
          used.add(letter);
        }
      }
    }
    if (data.keyMap && typeof data.keyMap === 'object') {
      const used = new Set<string>();
      for (const [id, combo] of Object.entries(data.keyMap)) {
        if (typeof combo === 'string' && COMBO.test(combo) && !used.has(combo)) {
          out.keyMap[id] = combo;
          used.add(combo);
        }
      }
    }
  } catch {
    /* damaged: defaults */
  }
  return out;
}

function load(): Settings {
  try {
    return readSettings(localStorage.getItem(KEY));
  } catch {
    return readSettings(null);
  }
}

export const settingsStore = createStore<Settings>(load());
keyGrid.steps = settingsStore.get().keyGrid;
settingsStore.subscribe(() => {
  keyGrid.steps = settingsStore.get().keyGrid;
});

export function useSettings<S>(selector: (s: Settings) => S): S {
  return useStore(settingsStore, selector);
}

/** Changes preferences and remembers them. */
export function setSettings(patch: Partial<Settings>) {
  settingsStore.patch(patch);
  try {
    localStorage.setItem(KEY, JSON.stringify(settingsStore.get()));
  } catch {
    /* not persisted */
  }
}

export function resetSettings() {
  setSettings({ ...DEFAULT_SETTINGS, toolKeys: {}, keyMap: {} });
}
