import type { Compensation } from '@/core/compensate';
import { NO_COMPENSATION } from '@/core/compensate';
import type { Id } from '@/core/model';
import type { BrushShape, StrengthCurve } from '@/core/brush';
import type { SoftShape } from '@/core/soft';
import { NO_TRACK_FILTER } from '@/core/timelineRows';
import type { TrackFilter } from '@/core/timelineRows';
import { createStore, useStore } from './store';
import { DEFAULT_VIEWS, loadLayout } from './layout';
import type { Views } from './layout';

export type Mode = 'setup' | 'animate';
export type Tool =
  | 'select'
  | 'create'
  | 'translate'
  | 'rotate'
  | 'scale'
  | 'shear'
  | 'mesh'
  | 'weights'
  | 'ik'
  | 'clipping'
  | 'boundingbox'
  | 'point'
  | 'path';
/** Tools that draw clipping polygons, bounding boxes and points. */
export const POLYGON_TOOLS: readonly Tool[] = ['clipping', 'boundingbox', 'point'];
/** Tools that create attachments in the viewport (Setup mode only). */
export const ATTACHMENT_TOOLS: readonly Tool[] = [...POLYGON_TOOLS, 'path'];
export type CurveKind = 'linear' | 'bezier' | 'stepped';

export interface Selection {
  bones: Id[];
  slot: Id | null;
  /** Attachment name inside the selected slot. */
  attachment: string | null;
  constraint: Id | null;
  /** Selected mesh vertices (indices) while in mesh/weights tools. */
  vertices: number[];
  /** Other slots selected together with `slot` (Ctrl-click in the tree): the weights tools work on the meshes of all of them at once. */
  extraSlots?: Id[];
}

export interface PoseOverride {
  x?: number;
  y?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  shearX?: number;
  shearY?: number;
}

export interface ViewOptions {
  grid: boolean;
  images: boolean;
  bones: boolean;
  meshes: boolean;
  names: boolean;
  constraints: boolean;
  /** Constraint debug: arrows from what drives a constraint to the bones it moves, with its name and strength; the ones that do not touch the selection fade. */
  constraintInfo: boolean;
  /** Outlines of clipping polygons, bounding boxes and point attachments. */
  outlines: boolean;
  /** Draw bones over images (otherwise behind). */
  bonesOnTop: boolean;
  /** Onion skin: faded poses of the frames around the playhead (Animate mode). */
  onion: boolean;
  /** Motion trails: the path of the selected bones through the animation (Animate mode). */
  trails: boolean;
  /** Rulers along the top and left of the viewport, with the guides laid from them. */
  rulers: boolean;
  /** New bones and moved bones snap to the grid and to the guides. */
  snap: boolean;
  /** Snap moved and new bones to whole pixels (finer than the grid; the grid wins while Snap is on). */
  pixel: boolean;
  /** The outline map: the whole skeleton in a corner, with the part the viewport shows. */
  outline: boolean;
}

export interface Camera {
  x: number;
  y: number;
  /** CSS pixels per world unit. */
  zoom: number;
  /** Flip Viewport (Spine 4.3): the view is mirrored left to right. Only how the scene is looked at; nothing in the file changes. */
  flip?: boolean;
}

export interface WeightBrush {
  size: number;
  strength: number;
  mode: 'add' | 'subtract' | 'smooth' | 'replace';
  bone: Id | null;
  /** Percent of the size over which the brush fades to nothing (100 = from the centre, 0 = a hard edge). */
  feather: number;
  /** How the brush fades inside the feather zone (soft when missing). */
  shape?: BrushShape;
  /** How the strength slider maps to the strength painted (linear when missing). */
  curve?: StrengthCurve;
  /** Bones whose weights the brush leaves alone. */
  locked: Id[];
}

/** How the mesh being edited is shown (Spine's Wireframe, Dim, Isolate and Freeze boxes of the Mesh tools). */
export interface MeshView {
  /** The triangle edges are drawn (the outline and manual edges always are). */
  wireframe: boolean;
  /** Everything outside the mesh is dimmed. */
  dim: boolean;
  /** Everything outside the mesh is hidden. */
  isolate: boolean;
  /** The vertices cannot be dragged (selecting them still works). */
  freeze: boolean;
  /** Only the outline (hull) is drawn and can be picked: the inner vertices and edges are out of the way. */
  hullOnly: boolean;
  /** A click picks a triangle (Triangle order) instead of a vertex. */
  pickTriangle: boolean;
  /** The picked triangle (its place in the drawing order), or null. */
  triangle: number | null;
  /** Soft selection: dragged vertices pull the ones near them with a falloff (see core/soft.ts). */
  soft: boolean;
  /** How far the pull reaches, in world units. */
  softRadius: number;
  softShape: SoftShape;
}

/** What the weights view draws on the mesh (Spine's Pies, Overlay and Selected boxes). */
export interface WeightView {
  pies: boolean;
  overlay: boolean;
  /** Pies only for the selected vertices and the vertices weighted to selected bones; Overlay shows the other bones black. */
  selected: boolean;
}

export interface UiState {
  mode: Mode;
  tool: Tool;
  selection: Selection;
  animationId: Id | null;
  time: number;
  playing: boolean;
  loop: boolean;
  /** Play forward, then backward, instead of jumping back to the start. */
  pingPong: boolean;
  /** Seconds [start, end] that play and loop instead of the whole animation (Spine's loop range), or null. */
  range: [number, number] | null;
  speed: number;
  /** Show the pose at the start of the frame the time falls in, as a game running at the animation's frame rate does (Spine's Stepped). */
  stepped: boolean;
  /** Setup mode: what stays in place in the scene when a bone is edited (Spine's Compensation). */
  compensate: Compensation;
  autoKey: boolean;
  defaultCurve: CurveKind;
  camera: Camera;
  skinId: Id | null;
  /** Skins shown together with the active one. */
  skinMix: Id[];
  /** Skins kept shown when another skin is chosen (see toggleSkinPin). */
  skinPins: Id[];
  view: ViewOptions;
  overrides: Record<Id, PoseOverride>;
  timelineView: 'dopesheet' | 'graph';
  /** How many frames Insert time / Delete time cut in (default 6). */
  timeGap?: number;
  /** Which tracks the dopesheet lists (see `filterRows`). */
  trackFilter: TrackFilter;
  /** Timeline horizontal zoom (pixels per second) and scroll (seconds at left edge). */
  tlZoom: number;
  tlScroll: number;
  /** Selected keyframes (encoded refs, see timeline/keys.ts). */
  selectedKeys: string[];
  /** Expanded entity rows in the dopesheet. */
  expanded: Record<string, boolean>;
  /** Bones, slots and constraints whose timelines the editor does not play (Mute; kept for the session, never saved or exported). */
  muted: string[];
  /** Drawn faded under the pose being edited, to compare with: an animation id, `'setup'` for the setup pose, or null. */
  reference: string | null;
  /** The checkpoint whose pose is drawn under the current one, to compare with. */
  compare: string | null;
  brush: WeightBrush;
  weightView: WeightView;
  meshView: MeshView;
  toast: { id: number; text: string; kind: 'info' | 'error' | 'ok' } | null;
  panel: { left: number; right: number; bottom: number };
  /** Which windows are open (see layout.ts). */
  views: Views;
  exportOpen: boolean;
  helpOpen: boolean;
  updatesOpen: boolean;
  feedbackOpen: boolean;
  settingsOpen: boolean;
  welcomeOpen: boolean;
  paletteOpen: boolean;
  /** Set Parent is waiting for the click on the new parent bone. */
  pickParent: boolean;
  /** A point of the world the rotate tool turns the selected bones about, instead of the origin of each bone (kept for the session). */
  pivot: { x: number; y: number } | null;
  /** The next click in the viewport sets the pivot. */
  pivotPick: boolean;
}

export const emptySelection: Selection = { bones: [], slot: null, attachment: null, constraint: null, vertices: [], extraSlots: [] };

const saved = loadLayout();

export const uiStore = createStore<UiState>({
  mode: 'setup',
  tool: 'select',
  selection: emptySelection,
  animationId: null,
  time: 0,
  playing: false,
  loop: true,
  pingPong: false,
  range: null,
  speed: 1,
  stepped: false,
  compensate: NO_COMPENSATION,
  autoKey: true,
  defaultCurve: 'bezier',
  camera: { x: 0, y: 120, zoom: 1.2 },
  skinId: null,
  skinMix: [],
  skinPins: [],
  view: {
    grid: true,
    images: true,
    bones: true,
    meshes: true,
    names: false,
    constraints: true,
    constraintInfo: false,
    outlines: true,
    bonesOnTop: true,
    onion: false,
    trails: false,
    rulers: false,
    snap: false,
    pixel: false,
    outline: false,
  },
  overrides: {},
  timelineView: 'dopesheet',
  trackFilter: NO_TRACK_FILTER,
  tlZoom: 220,
  tlScroll: -0.05,
  selectedKeys: [],
  expanded: {},
  muted: [],
  reference: null,
  compare: null,
  brush: { size: 40, strength: 0.5, mode: 'add', bone: null, feather: 100, locked: [] },
  weightView: { pies: false, overlay: false, selected: false },
  meshView: {
    wireframe: true,
    dim: false,
    isolate: false,
    freeze: false,
    hullOnly: false,
    pickTriangle: false,
    triangle: null,
    soft: false,
    softRadius: 60,
    softShape: 'smooth',
  },
  toast: null,
  panel:
    saved.panel ??
    (typeof window !== 'undefined' && window.innerWidth < 1150
      ? { left: 210, right: 240, bottom: 250 }
      : { left: 270, right: 300, bottom: 300 }),
  views: saved.views ?? DEFAULT_VIEWS,
  exportOpen: false,
  helpOpen: false,
  updatesOpen: false,
  feedbackOpen: false,
  settingsOpen: false,
  welcomeOpen: false,
  paletteOpen: false,
  pickParent: false,
  pivot: null,
  pivotPick: false,
});

export function useUi<S>(selector: (s: UiState) => S, equals?: (a: S, b: S) => boolean): S {
  return useStore(uiStore, selector, equals);
}

let toastId = 1;
export function toast(text: string, kind: 'info' | 'error' | 'ok' = 'info', ms?: number) {
  const id = toastId++;
  uiStore.patch({ toast: { id, text, kind } });
  setTimeout(
    () => {
      if (uiStore.get().toast?.id === id) uiStore.patch({ toast: null });
    },
    ms ?? (kind === 'error' ? 6000 : 2600),
  );
}
