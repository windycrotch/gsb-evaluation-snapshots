/** The picture whose "cut into frames" dialog is open (none: closed). */
import { createStore, useStore } from './store';

const sliceDialogStore = createStore<{ image: string | null }>({ image: null });
export const useSliceDialog = (): string | null => useStore(sliceDialogStore, (s) => s.image);
export const openSliceDialog = (image: string) => sliceDialogStore.set({ image });
export const closeSliceDialog = () => sliceDialogStore.set({ image: null });
