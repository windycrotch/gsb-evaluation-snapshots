import { LAYOUTS, VIEW_LIST, saveLayout } from './layout';
import type { ViewId, Views } from './layout';
import { uiStore } from './ui';

export function toggleView(id: ViewId) {
  const views = uiStore.get().views;
  uiStore.patch({ views: { ...views, [id]: !views[id] } });
}

export function applyLayout(id: string) {
  const layout = LAYOUTS.find((l) => l.id === id);
  if (layout) uiStore.patch({ views: { ...layout.views } });
}

let hidden: Views | null = null;

/** F9: hides every window (the viewport gets the whole screen), the next press brings them back. */
export function toggleAllViews() {
  const views = uiStore.get().views;
  if (VIEW_LIST.some((v) => views[v.id])) {
    hidden = views;
    uiStore.patch({ views: Object.fromEntries(VIEW_LIST.map((v) => [v.id, false])) as Views });
  } else {
    uiStore.patch({ views: hidden ?? LAYOUTS[0].views });
    hidden = null;
  }
}

/** Remembers the arrangement and the sizes of the windows; returns the stop function. */
export function startLayoutPersist(): () => void {
  let last = '';
  return uiStore.subscribe(() => {
    const { views, panel } = uiStore.get();
    const next = JSON.stringify({ views, panel });
    if (next === last) return;
    last = next;
    saveLayout({ views, panel });
  });
}
