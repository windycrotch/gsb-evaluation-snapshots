import { flipViewport, keyEditedBones, keySelectedBones, setMode, setSelection, togglePlay } from '@/store/actions';
import { docStore } from '@/store/doc';
import { startSetParent } from '@/store/parentActions';
import { duplicateSelection } from '@/store/poseActions';
import { openProjectFile, saveProjectFile } from '@/store/project';
import { uiStore } from '@/store/ui';
import { isolateSelection, showAll } from '@/store/visibilityActions';
import { toggleAllViews } from '@/store/viewActions';
import type { KeyId } from './hotkeys';
import { viewportApi } from './viewport/Viewport';

/**
 * What each movable key combination does (hotkeys.ts holds the combinations). The handler in App.tsx looks the typed combination up there,
 * so a combination the person moved in Settings is the only one that works.
 */
export const KEY_ACTIONS: Partial<Record<KeyId, (e: KeyboardEvent) => void>> = {
  undo: (e) => {
    e.preventDefault();
    docStore.undo();
  },
  redo: (e) => {
    e.preventDefault();
    docStore.redo();
  },
  save: (e) => {
    e.preventDefault();
    void saveProjectFile();
  },
  saveAs: (e) => {
    e.preventDefault();
    void saveProjectFile(true);
  },
  open: (e) => {
    e.preventDefault();
    void openProjectFile();
  },
  export: (e) => {
    e.preventDefault();
    uiStore.patch({ exportOpen: true });
  },
  palette: (e) => {
    e.preventDefault();
    uiStore.patch({ paletteOpen: !uiStore.get().paletteOpen });
  },
  duplicate: (e) => {
    e.preventDefault();
    duplicateSelection(false);
  },
  mirror: (e) => {
    e.preventDefault();
    duplicateSelection(true);
  },
  selectAll: (e) => {
    e.preventDefault();
    setSelection({ bones: docStore.get().skeleton.bones.map((b) => b.id) });
  },
  showAll: (e) => {
    e.preventDefault();
    showAll();
  },
  isolate: (e) => {
    e.preventDefault();
    isolateSelection();
  },
  parent: (e) => {
    e.preventDefault();
    startSetParent();
  },
  frame: () => viewportApi.frame(),
  frameSelection: () => viewportApi.frameSelection(),
  zoom100: () => viewportApi.zoom100(),
  flipView: (e) => {
    e.preventDefault();
    flipViewport();
  },
  key: () => keyEditedBones(),
  keyShown: () => keySelectedBones(),
  mode: (e) => {
    e.preventDefault();
    setMode(uiStore.get().mode === 'setup' ? 'animate' : 'setup');
  },
  play: (e) => {
    e.preventDefault();
    if (uiStore.get().mode === 'animate') togglePlay();
    if (viewportApi.controller) viewportApi.controller.spaceDown = false;
  },
  help: () => uiStore.patch({ helpOpen: true }),
  hideViews: (e) => {
    e.preventDefault();
    toggleAllViews();
  },
  settings: (e) => {
    e.preventDefault();
    uiStore.patch({ settingsOpen: !uiStore.get().settingsOpen });
  },
};
