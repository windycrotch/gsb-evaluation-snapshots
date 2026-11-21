/**
 * Every action of the editor by name, for the command palette (Ctrl+K): type a few letters of what you want. Spine has no such thing.
 * The titles are English strings like the rest of the interface and get translated where they are shown.
 */
import {
  closeCurrentLoop,
  deleteTimeAtPlayhead,
  flipViewport,
  insertTimeAtPlayhead,
  keyConstrainedBones,
  keyEditedBones,
  keySelectedBones,
  pasteKeys,
  selectAnimation,
  setMode,
  setTool,
  togglePlay,
} from '@/store/actions';
import { setAxesSplit } from '@/store/axisActions';
import { selectionBack, selectionForward } from '@/store/selHistory';
import { hideUnkeyedBones, mirrorCurrentCycle } from '@/store/animToolActions';
import { addMarkerAtPlayhead, goToMarker, splitAtMarkersAction } from '@/store/markerActions';
import { decodeKey } from '@/core/keyrefs';
import { docStore } from '@/store/doc';
import { openKeyDialog } from '@/store/keyDialog';
import { LAYOUTS, VIEW_LIST } from '@/store/layout';
import { startSetParent } from '@/store/parentActions';
import { copyPose, duplicateSelection, flipScale, moveBoneOrderAction, pastePose, resetPose, swapSides } from '@/store/poseActions';
import { LESSONS } from '@/core/lessons';
import { getLang } from '@/i18n';
import { openLesson } from '@/store/learn';
import { newProject, openProjectFile, packageProject, saveProjectFile } from '@/store/project';
import { pickProjectToCompare } from '@/store/checkpoints';
import { pickReviewFile } from '@/store/reviewActions';
import { loadSample } from '@/store/sample';
import { toast, uiStore } from '@/store/ui';
import { clearGuides } from '@/store/guideActions';
import { isolateSelection, showAll } from '@/store/visibilityActions';
import { applyLayout, toggleAllViews, toggleView } from '@/store/viewActions';
import { applySavedLayout, namedLayoutsStore, saveLayoutDialog } from '@/store/layoutActions';
import { saveSelectionSet, selectSet } from '@/store/selectionSetActions';
import { FLOAT_LIST, toggleFloat } from '@/store/floats';
import { KEYS } from './hotkeys';
import { openAtlasUnpack, openSpineImport } from './importSpine';
import { TOOLS, hotkeyOf } from './tools';
import { viewportApi } from './viewport/Viewport';

export interface Command {
  id: string;
  title: string;
  /** Where it lives in the interface; shown dimmed next to the title. */
  group: string;
  keys?: string;
  run: () => void;
}

/** The key dialog for the first selected key of the timeline. */
function editSelectedKey() {
  const selected = uiStore.get().selectedKeys;
  if (selected.length) openKeyDialog(decodeKey(selected[0]));
  else toast('Select a key in the timeline first');
}

const open = (key: 'exportOpen' | 'helpOpen' | 'updatesOpen' | 'feedbackOpen' | 'settingsOpen' | 'welcomeOpen') => () =>
  uiStore.patch({ [key]: true });

export function buildCommands(): Command[] {
  const doc = docStore.get().skeleton;
  const list: Command[] = [
    { id: 'file.new', group: 'File', title: 'New project', run: () => newProject() },
    { id: 'file.open', group: 'File', title: 'Open…', keys: KEYS.open, run: () => void openProjectFile() },
    { id: 'file.save', group: 'File', title: 'Save', keys: KEYS.save, run: () => void saveProjectFile() },
    { id: 'file.comparefile', group: 'File', title: 'Compare with a project file', run: () => pickProjectToCompare() },
    { id: 'file.reviewimport', group: 'File', title: 'Import review comments', run: () => pickReviewFile() },
    { id: 'file.package', group: 'File', title: 'Package project (ZIP)', run: () => void packageProject() },
    { id: 'file.saveas', group: 'File', title: 'Save as…', keys: KEYS.saveAs, run: () => void saveProjectFile(true) },
    { id: 'file.export', group: 'File', title: 'Export', keys: KEYS.export, run: open('exportOpen') },
    { id: 'file.import', group: 'File', title: 'Import Spine data (JSON 4.0–4.3, binary 4.3)…', run: () => openSpineImport() },
    { id: 'file.importAdd', group: 'File', title: 'Import Spine data as a new skeleton…', run: () => openSpineImport(true) },
    { id: 'file.unpack', group: 'File', title: 'Unpack an atlas into pictures…', run: () => openAtlasUnpack() },
    { id: 'file.demo', group: 'File', title: 'Load demo rig (Kit)', run: () => void loadSample() },
    { id: 'file.welcome', group: 'File', title: 'Welcome screen', run: open('welcomeOpen') },
    { id: 'edit.selback', group: 'Edit', title: 'Previous selection', run: () => void selectionBack() },
    { id: 'edit.selforward', group: 'Edit', title: 'Next selection', run: () => void selectionForward() },
    { id: 'edit.undo', group: 'Edit', title: 'Undo', keys: KEYS.undo, run: () => docStore.undo() },
    { id: 'edit.redo', group: 'Edit', title: 'Redo', keys: KEYS.redo, run: () => docStore.redo() },
    { id: 'edit.duplicate', group: 'Edit', title: 'Duplicate bones', keys: KEYS.duplicate, run: () => duplicateSelection(false) },
    { id: 'edit.mirror', group: 'Edit', title: 'Mirror bones', keys: KEYS.mirror, run: () => duplicateSelection(true) },
    { id: 'anim.closeloop', group: 'Animation', title: 'Close the loop (end = start)', run: () => void closeCurrentLoop('first', false) },
    { id: 'view.showall', group: 'View', title: 'Show everything hidden', keys: KEYS.showAll, run: () => void showAll() },
    { id: 'view.isolate', group: 'View', title: 'Show only the selection', keys: KEYS.isolate, run: () => void isolateSelection() },
    { id: 'edit.parent', group: 'Edit', title: 'Set parent', keys: KEYS.parent, run: () => void startSetParent() },
    { id: 'edit.reset', group: 'Edit', title: 'Reset pose', run: () => resetPose() },
    { id: 'edit.flipscalex', group: 'Edit', title: 'Flip scale X of the selected bones', run: () => flipScale('x') },
    { id: 'edit.flipscaley', group: 'Edit', title: 'Flip scale Y of the selected bones', run: () => flipScale('y') },
    { id: 'edit.boneup', group: 'Edit', title: 'Move the bone up among its siblings', run: () => moveBoneOrderAction(-1) },
    { id: 'edit.bonedown', group: 'Edit', title: 'Move the bone down among its siblings', run: () => moveBoneOrderAction(1) },
    { id: 'edit.copypose', group: 'Edit', title: 'Copy pose', run: () => copyPose() },
    { id: 'edit.swapsides', group: 'Edit', title: 'Swap left and right pose', run: () => swapSides() },
    { id: 'edit.pastepose', group: 'Edit', title: 'Paste pose', run: () => pastePose() },
    {
      id: 'mode.toggle',
      group: 'Animation',
      title: 'Setup ⇄ Animate',
      keys: KEYS.mode,
      run: () => setMode(uiStore.get().mode === 'setup' ? 'animate' : 'setup'),
    },
    { id: 'anim.keyedited', group: 'Animation', title: 'Key edited channels', keys: KEYS.key, run: () => keyEditedBones() },
    {
      id: 'anim.keyshown',
      group: 'Animation',
      title: 'Key all channels of the selected bones',
      keys: KEYS.keyShown,
      run: () => keySelectedBones(),
    },
    {
      id: 'anim.inserttime',
      group: 'Animation',
      title: 'Insert time at the playhead (the frames set next to Length)',
      run: () => void insertTimeAtPlayhead(uiStore.get().timeGap ?? 6),
    },
    {
      id: 'anim.deletetime',
      group: 'Animation',
      title: 'Delete time after the playhead (the frames set next to Length)',
      run: () => void deleteTimeAtPlayhead(uiStore.get().timeGap ?? 6),
    },
    {
      id: 'anim.pastehold',
      group: 'Animation',
      title: 'Paste keys at the playhead, hold (linear between keys of the same value)',
      keys: KEYS.pasteHold,
      run: () => void pasteKeys(uiStore.get().time, true),
    },
    { id: 'anim.keyconstrained', group: 'Animation', title: 'Key the pose after the constraints', run: () => keyConstrainedBones() },
    { id: 'anim.marker.add', group: 'Animation', title: 'Add a marker at the playhead', run: () => void addMarkerAtPlayhead() },
    { id: 'anim.marker.next', group: 'Animation', title: 'Go to the next marker', run: () => goToMarker(1) },
    { id: 'anim.marker.prev', group: 'Animation', title: 'Go to the previous marker', run: () => goToMarker(-1) },
    { id: 'anim.marker.split', group: 'Animation', title: 'Split the animation at its markers', run: () => void splitAtMarkersAction() },
    {
      id: 'anim.mirrorcycle',
      group: 'Animation',
      title: 'Make a full cycle from the half cycle (swap left and right)',
      run: () => void mirrorCurrentCycle({ flipCentre: true }),
    },
    { id: 'anim.hideunkeyed', group: 'Animation', title: 'Hide bones without keys in this animation', run: () => void hideUnkeyedBones() },
    { id: 'anim.editkey', group: 'Animation', title: 'Edit the selected key…', run: () => editSelectedKey() },
    {
      id: 'anim.split.translate',
      group: 'Animation',
      title: 'Split position keys of the selected bones into X / Y',
      run: () => setAxesSplit(uiStore.get().selection.bones, 'translate', true),
    },
    {
      id: 'anim.merge.translate',
      group: 'Animation',
      title: 'Merge position X / Y keys of the selected bones',
      run: () => setAxesSplit(uiStore.get().selection.bones, 'translate', false),
    },
    {
      id: 'anim.split.scale',
      group: 'Animation',
      title: 'Split scale keys of the selected bones into X / Y',
      run: () => setAxesSplit(uiStore.get().selection.bones, 'scale', true),
    },
    {
      id: 'anim.merge.scale',
      group: 'Animation',
      title: 'Merge scale X / Y keys of the selected bones',
      run: () => setAxesSplit(uiStore.get().selection.bones, 'scale', false),
    },
    {
      id: 'anim.split.shear',
      group: 'Animation',
      title: 'Split shear keys of the selected bones into X / Y',
      run: () => setAxesSplit(uiStore.get().selection.bones, 'shear', true),
    },
    {
      id: 'anim.merge.shear',
      group: 'Animation',
      title: 'Merge shear X / Y keys of the selected bones',
      run: () => setAxesSplit(uiStore.get().selection.bones, 'shear', false),
    },
    { id: 'anim.play', group: 'Animation', title: 'Play / pause', keys: KEYS.play, run: () => togglePlay() },
    { id: 'view.frame', group: 'View', title: 'Frame skeleton', keys: KEYS.frame, run: () => viewportApi.frame() },
    {
      id: 'view.frameselection',
      group: 'View',
      title: 'Frame the selection',
      keys: KEYS.frameSelection,
      run: () => viewportApi.frameSelection(),
    },
    { id: 'view.flip', group: 'View', title: 'Flip the viewport', keys: KEYS.flipView, run: () => flipViewport() },
    { id: 'view.zoom100', group: 'View', title: 'Zoom to 100%', keys: KEYS.zoom100, run: () => viewportApi.zoom100() },
    {
      id: 'view.trails',
      group: 'View',
      title: 'Motion trails',
      run: () => uiStore.patch({ view: { ...uiStore.get().view, trails: !uiStore.get().view.trails } }),
    },
    {
      id: 'view.onion',
      group: 'View',
      title: 'Onion skin',
      run: () => uiStore.patch({ view: { ...uiStore.get().view, onion: !uiStore.get().view.onion } }),
    },
    {
      id: 'view.rulers',
      group: 'View',
      title: 'Rulers and guides',
      run: () => uiStore.patch({ view: { ...uiStore.get().view, rulers: !uiStore.get().view.rulers } }),
    },
    {
      id: 'view.snap',
      group: 'View',
      title: 'Snap to grid and guides',
      run: () => uiStore.patch({ view: { ...uiStore.get().view, snap: !uiStore.get().view.snap } }),
    },
    {
      id: 'view.pixel',
      group: 'View',
      title: 'Snap to whole pixels',
      run: () => uiStore.patch({ view: { ...uiStore.get().view, pixel: !uiStore.get().view.pixel } }),
    },
    {
      id: 'view.outline',
      group: 'View',
      title: 'Outline map',
      run: () => uiStore.patch({ view: { ...uiStore.get().view, outline: !uiStore.get().view.outline } }),
    },
    { id: 'view.clearguides', group: 'View', title: 'Clear guides', run: () => void clearGuides() },
    {
      id: 'view.grid',
      group: 'View',
      title: 'Grid',
      run: () => uiStore.patch({ view: { ...uiStore.get().view, grid: !uiStore.get().view.grid } }),
    },
    {
      id: 'view.names',
      group: 'View',
      title: 'Bone names',
      run: () => uiStore.patch({ view: { ...uiStore.get().view, names: !uiStore.get().view.names } }),
    },
    { id: 'view.hide', group: 'Windows', title: 'Hide / show all windows', keys: KEYS.hideViews, run: () => toggleAllViews() },
    { id: 'app.settings', group: 'Help', title: 'Settings', keys: KEYS.settings, run: open('settingsOpen') },
    { id: 'app.shortcuts', group: 'Help', title: 'Shortcuts & help', keys: KEYS.help, run: open('helpOpen') },
    ...LESSONS.map((l) => ({
      id: `app.lesson.${l.id}`,
      group: 'Help',
      title: getLang() === 'ru' ? `Урок: ${l.title.ru}` : `Lesson: ${l.title.en}`,
      run: () => void openLesson(l.id),
    })),
    { id: 'app.updates', group: 'Help', title: 'Updates: what is new and the project activity', run: open('updatesOpen') },
    { id: 'app.feedback', group: 'Help', title: 'Send feedback to the author', run: open('feedbackOpen') },
  ];
  for (const t of TOOLS)
    list.push({ id: `tool.${t.tool}`, group: 'Tools', title: t.title, keys: hotkeyOf(t.tool), run: () => setTool(t.tool) });
  for (const v of VIEW_LIST) list.push({ id: `win.${v.id}`, group: 'Windows', title: v.label, run: () => toggleView(v.id) });
  for (const w of FLOAT_LIST)
    list.push({ id: `float.${w.id}`, group: 'Windows', title: `Floating: ${w.label}`, run: () => toggleFloat(w.id) });
  for (const l of LAYOUTS) list.push({ id: `layout.${l.id}`, group: 'Windows', title: `Layout: ${l.label}`, run: () => applyLayout(l.id) });
  list.push({ id: 'layout.save', group: 'Windows', title: 'Save layout as…', run: () => void saveLayoutDialog() });
  for (const l of namedLayoutsStore.get().list)
    list.push({ id: `layout.saved.${l.id}`, group: 'Windows', title: `Layout: ${l.name}`, run: () => applySavedLayout(l.id) });
  list.push({ id: 'edit.saveset', group: 'Edit', title: 'Keep the selected bones as a selection set', run: () => void saveSelectionSet() });
  for (const s of doc.selectionSets ?? [])
    list.push({ id: `set.${s.id}`, group: 'Selection sets', title: `Select set: ${s.name}`, run: () => selectSet(s.id) });
  for (const a of doc.animations)
    list.push({ id: `anim.${a.id}`, group: 'Animations', title: a.name, run: () => (selectAnimation(a.id), setMode('animate')) });
  return list;
}

/** The commands that contain every word typed, best first (a title that starts with the text, then shorter ones). */
export function filterCommands(all: Command[], query: string, translate: (s: string) => string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return all;
  const scored: { c: Command; score: number }[] = [];
  for (const c of all) {
    const title = translate(c.title).toLowerCase();
    const hay = `${title} ${translate(c.group).toLowerCase()} ${c.title.toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) continue;
    scored.push({ c, score: (title.startsWith(words[0]) ? 0 : 100) + title.length });
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.c);
}
