/** Window arrangements saved under a name (Setup, Animate, Mesh…): kept in the browser, like the one that is open now. */
import { uid } from '@/core/ids';
import { loadNamedLayouts, saveNamedLayouts, uniqueLayoutName } from './layout';
import type { NamedLayout } from './layout';
import { askName } from './ask';
import { createStore, useStore } from './store';
import { toast, uiStore } from './ui';

export const namedLayoutsStore = createStore<{ list: NamedLayout[] }>({ list: loadNamedLayouts() });
export const useNamedLayouts = (): NamedLayout[] => useStore(namedLayoutsStore, (s) => s.list);

function commit(list: NamedLayout[]) {
  namedLayoutsStore.set({ list });
  saveNamedLayouts(list);
}

/** Keeps the windows and their sizes as they are now under a name; the same name again replaces that arrangement. Returns it. */
export function saveLayoutAs(name: string): NamedLayout | null {
  const wanted = name.trim();
  if (!wanted) return null;
  const { views, panel } = uiStore.get();
  const list = namedLayoutsStore.get().list;
  const same = list.find((l) => l.name.toLowerCase() === wanted.toLowerCase());
  const entry: NamedLayout = {
    id: same?.id ?? uid(),
    name: same?.name ?? uniqueLayoutName(list, wanted),
    views: { ...views },
    panel: { ...panel },
  };
  commit(same ? list.map((l) => (l === same ? entry : l)) : [...list, entry]);
  return entry;
}

/** Asks for a name, then keeps the arrangement. */
export async function saveLayoutDialog() {
  const list = namedLayoutsStore.get().list;
  const name = await askName('Save layout', 'Name of this arrangement of the windows', uniqueLayoutName(list, 'My layout'));
  if (!name) return;
  const entry = saveLayoutAs(name);
  if (entry) toast(`Layout "${entry.name}" saved`, 'ok');
}

export function applySavedLayout(id: string) {
  const entry = namedLayoutsStore.get().list.find((l) => l.id === id);
  if (entry) uiStore.patch({ views: { ...entry.views }, panel: { ...entry.panel } });
}

export function deleteSavedLayout(id: string) {
  commit(namedLayoutsStore.get().list.filter((l) => l.id !== id));
}
