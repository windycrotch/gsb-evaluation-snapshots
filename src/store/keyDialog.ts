/** Which key the key dialog is editing (none: closed). Opened from the dopesheet, its menu and the command palette. */
import type { KeyRef } from '@/core/keyrefs';
import { createStore, useStore } from './store';

export const keyDialogStore = createStore<{ ref: KeyRef | null }>({ ref: null });
export const useKeyDialog = (): KeyRef | null => useStore(keyDialogStore, (s) => s.ref);

export const openKeyDialog = (ref: KeyRef) => keyDialogStore.set({ ref });
export const closeKeyDialog = () => keyDialogStore.set({ ref: null });
