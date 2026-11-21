/** The reference video of the session (rotoscoping): which file, how it is placed, and whether it shows. Never saved or exported. */
import { DEFAULT_REF_VIDEO, cleanRefVideoView } from '@/core/refVideo';
import type { RefVideoView } from '@/core/refVideo';
import { createStore, useStore } from './store';
import { toast, uiStore } from './ui';

export interface RefVideoState {
  url: string | null;
  name: string;
  /** The size and length of the video, known once it has loaded. */
  width: number;
  height: number;
  duration: number;
  show: boolean;
  view: RefVideoView;
}

const EMPTY: RefVideoState = { url: null, name: '', width: 0, height: 0, duration: 0, show: true, view: DEFAULT_REF_VIDEO };

export const refVideoStore = createStore<RefVideoState>(EMPTY);
export const useRefVideo = (): RefVideoState => useStore(refVideoStore, (s) => s);

const isVideoFile = (f: { type: string; name: string }): boolean =>
  /^video\//.test(f.type) || /\.(mp4|webm|mov|m4v|ogv|mkv)$/i.test(f.name);

/** Puts a video file under the scene. The video itself stays in this browser tab: it is not part of the project. */
export function loadRefVideo(file: File): boolean {
  if (!isVideoFile(file)) {
    toast('Choose a video file', 'error');
    return false;
  }
  const old = refVideoStore.get().url;
  if (old) URL.revokeObjectURL(old);
  refVideoStore.set({ ...EMPTY, url: URL.createObjectURL(file), name: file.name });
  return true;
}

export function clearRefVideo() {
  const old = refVideoStore.get().url;
  if (old) URL.revokeObjectURL(old);
  refVideoStore.set(EMPTY);
}

/** The video reports its size and length. */
export function setRefVideoMeta(width: number, height: number, duration: number) {
  refVideoStore.patch({ width, height, duration: Number.isFinite(duration) ? duration : 0 });
}

export function setRefVideoView(patch: Partial<RefVideoView>) {
  const s = refVideoStore.get();
  refVideoStore.patch({ view: cleanRefVideoView({ ...s.view, ...patch }) });
}

export const setRefVideoShow = (show: boolean) => refVideoStore.patch({ show });

/** The video starts at the playhead: its first frame goes with the frame the animation is on now. */
export function startRefVideoHere() {
  setRefVideoView({ offset: -uiStore.get().time });
}
