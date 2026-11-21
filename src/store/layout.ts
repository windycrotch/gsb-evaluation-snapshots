/**
 * Which windows (views) are open. Spine lets you open and close every view and keeps the arrangement; so does this: the choice is remembered in the browser.
 * Pure data here (no store), so it can be read by the UI store at start-up and tested.
 */
export type ViewId =
  | 'tree'
  | 'images'
  | 'animations'
  | 'skins'
  | 'playback'
  | 'tools'
  | 'poses'
  | 'metrics'
  | 'history'
  | 'comments'
  | 'preview'
  | 'inspector'
  | 'timeline';
export type Views = Record<ViewId, boolean>;

/** The windows with the side of the screen they live on, in the order of the Windows menu. */
export const VIEW_LIST: { id: ViewId; label: string; side: 'left' | 'right' | 'bottom' }[] = [
  { id: 'tree', label: 'Hierarchy', side: 'left' },
  { id: 'images', label: 'Images', side: 'left' },
  { id: 'animations', label: 'Animations', side: 'left' },
  { id: 'skins', label: 'Skins', side: 'left' },
  { id: 'playback', label: 'Playback', side: 'left' },
  { id: 'tools', label: 'Animation tools', side: 'left' },
  { id: 'poses', label: 'Poses', side: 'left' },
  { id: 'metrics', label: 'Metrics', side: 'left' },
  { id: 'history', label: 'History', side: 'left' },
  { id: 'comments', label: 'Comments', side: 'left' },
  { id: 'preview', label: 'Preview', side: 'left' },
  { id: 'inspector', label: 'Inspector', side: 'right' },
  { id: 'timeline', label: 'Timeline', side: 'bottom' },
];

export const DEFAULT_VIEWS: Views = {
  tree: true,
  images: true,
  animations: false,
  skins: false,
  playback: false,
  tools: false,
  poses: false,
  metrics: false,
  history: false,
  comments: false,
  preview: false,
  inspector: true,
  timeline: true,
};

/** Ready arrangements, the first one is the default. */
export const LAYOUTS: { id: string; label: string; views: Views }[] = [
  { id: 'default', label: 'Default', views: DEFAULT_VIEWS },
  {
    id: 'rigging',
    label: 'Rigging',
    views: {
      tree: true,
      images: true,
      animations: false,
      skins: false,
      playback: false,
      tools: false,
      poses: false,
      metrics: false,
      history: false,
      comments: false,
      preview: false,
      inspector: true,
      timeline: false,
    },
  },
  {
    id: 'animation',
    label: 'Animation',
    views: {
      tree: true,
      images: false,
      animations: true,
      skins: false,
      playback: false,
      tools: false,
      poses: false,
      metrics: false,
      history: false,
      comments: false,
      preview: false,
      inspector: true,
      timeline: true,
    },
  },
  {
    id: 'viewport',
    label: 'Viewport only',
    views: {
      tree: false,
      images: false,
      animations: false,
      skins: false,
      playback: false,
      tools: false,
      poses: false,
      metrics: false,
      history: false,
      comments: false,
      preview: false,
      inspector: false,
      timeline: false,
    },
  },
];

const KEY = 'bone2d.layout';

export interface SavedLayout {
  views: Views;
  panel: { left: number; right: number; bottom: number };
}

/** Takes a stored value for what it is worth: unknown or missing windows keep their defaults. */
export function readLayout(raw: string | null): Partial<SavedLayout> {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as Partial<SavedLayout>;
    const out: Partial<SavedLayout> = {};
    if (data.views && typeof data.views === 'object') {
      const views = { ...DEFAULT_VIEWS };
      for (const v of VIEW_LIST) if (typeof data.views[v.id] === 'boolean') views[v.id] = data.views[v.id];
      out.views = views;
    }
    const p = data.panel;
    if (p && [p.left, p.right, p.bottom].every((n) => typeof n === 'number' && n >= 100 && n <= 1200))
      out.panel = { left: p.left, right: p.right, bottom: p.bottom };
    return out;
  } catch {
    return {};
  }
}

export function loadLayout(): Partial<SavedLayout> {
  try {
    return readLayout(localStorage.getItem(KEY));
  } catch {
    return {};
  }
}

export function saveLayout(layout: SavedLayout) {
  try {
    localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    /* storage can be blocked */
  }
}

export interface NamedLayout extends SavedLayout {
  id: string;
  name: string;
}

const NAMED_KEY = 'bone2d.layouts';

/** Takes the stored list for what it is worth: entries without a name are dropped, windows that are unknown keep their defaults, names are made unique. */
export function readNamedLayouts(raw: string | null): NamedLayout[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    const out: NamedLayout[] = [];
    for (const item of list as Partial<NamedLayout>[]) {
      if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !item.name.trim() || typeof item.id !== 'string') continue;
      const own = readLayout(JSON.stringify({ views: item.views, panel: item.panel }));
      out.push({
        id: item.id,
        name: uniqueLayoutName(out, item.name),
        views: own.views ?? { ...DEFAULT_VIEWS },
        panel: own.panel ?? { left: 240, right: 280, bottom: 240 },
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** The name as it is, or with a number when another saved arrangement already has it. */
export function uniqueLayoutName(list: readonly { name: string }[], wanted: string): string {
  const base = wanted.trim() || 'Layout';
  const taken = new Set(list.map((l) => l.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

export function loadNamedLayouts(): NamedLayout[] {
  try {
    return readNamedLayouts(localStorage.getItem(NAMED_KEY));
  } catch {
    return [];
  }
}

export function saveNamedLayouts(list: readonly NamedLayout[]) {
  try {
    localStorage.setItem(NAMED_KEY, JSON.stringify(list));
  } catch {
    /* storage can be blocked */
  }
}

/** True when the views are exactly this arrangement. */
export const sameViews = (a: Views, b: Views) => VIEW_LIST.every((v) => a[v.id] === b[v.id]);
