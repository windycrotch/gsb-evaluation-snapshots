/**
 * The interactive lessons (core/lessons.ts) as they run in the editor: which one is on, where it started, what the person skipped. The state
 * of the lesson is read from the other stores whenever they change. Only what the person finished is remembered (in this browser, nowhere
 * else); a running lesson is not kept over a reload.
 */
import { countKeys } from '@/core/stats';
import { lessonById, progressOf } from '@/core/lessons';
import type { LessonHelper, LessonProgress, LessonState } from '@/core/lessons';
import { drawDemoImages } from './demo/art';
import { docStore } from './doc';
import { importImageFiles } from './imageImportActions';
import { loadSample } from './sample';
import { createStore, useStore } from './store';
import { uiStore } from './ui';

export interface LearnState {
  /** The lesson that is running (its id), or null. */
  active: string | null;
  /** The editor as it was when the lesson started: steps that ask for a change compare with it. */
  base: LessonState | null;
  skipped: string[];
  /** Steps that were done at some moment: they stay done even when the editor leaves the state they asked for. */
  kept: string[];
  /** Only the title bar is shown. */
  collapsed: boolean;
  progress: LessonProgress | null;
  /** Lessons that were taken to the end (or the end was reached by skipping). */
  finished: string[];
  /** A lesson was started by itself once (after the first demo): it is not forced again. */
  offered: boolean;
}

const KEY = 'bone2d.learn';

/** Takes stored text for what it is worth: what is not valid stays at the default. */
export function readLearn(raw: string | null): Pick<LearnState, 'finished' | 'offered'> {
  const out = { finished: [] as string[], offered: false };
  if (!raw) return out;
  try {
    const data = JSON.parse(raw) as { finished?: unknown; offered?: unknown };
    if (Array.isArray(data.finished)) out.finished = data.finished.filter((id): id is string => typeof id === 'string' && !!lessonById(id));
    if (typeof data.offered === 'boolean') out.offered = data.offered;
  } catch {
    /* damaged: defaults */
  }
  return out;
}

function load() {
  try {
    return readLearn(localStorage.getItem(KEY));
  } catch {
    return readLearn(null);
  }
}

export const learnStore = createStore<LearnState>({
  active: null,
  base: null,
  skipped: [],
  kept: [],
  collapsed: false,
  progress: null,
  ...load(),
});

function remember() {
  const { finished, offered } = learnStore.get();
  try {
    localStorage.setItem(KEY, JSON.stringify({ finished, offered }));
  } catch {
    /* not persisted */
  }
}

// What the editor did since the lesson started: counted here because the stores only hold the present. A lesson start begins a new tally.
const newTally = () => ({
  /** Steps made in the document. */
  edits: 0,
  /** The document that was current at the last look, to tell when it changed. */
  lastDoc: docStore.get(),
  /** Latches: true once the editor was in that state, even if it is not any more. */
  seenPlaying: false,
  seenExport: false,
  seenWeightsTool: false,
  seenGraph: false,
  /** The kind of change the last step of the history was (read from its label): a lesson about curves needs the kind, not just "an edit". */
  interpEdits: 0,
  handleEdits: 0,
  /** How many times the shown skin changed, and the skin shown at the last look. */
  skinSwitches: 0,
  lastSkin: uiStore.get().skinId,
  /** The files the Export window gave out. */
  zips: 0,
  players: 0,
  /** IK: the number of constraints when the lesson began, and the count of edits when a new one first appeared. */
  baseIk: null as number | null,
  editsAtIk: null as number | null,
});
let tally = newTally();

/** What is counted in a document. Walking a big rig on every frame of a playback would be a waste, so it is redone only for another document. */
function countDoc(doc: ReturnType<typeof docStore.get>) {
  const sk = doc.skeleton;
  const roots = new Set(sk.bones.filter((b) => !b.parent).map((b) => b.id));
  let meshes = 0;
  let weighted = 0;
  for (const skin of sk.skins)
    for (const bySlot of Object.values(skin.attachments))
      for (const att of Object.values(bySlot))
        if (att.type === 'mesh') {
          meshes++;
          if (att.weights) weighted++;
        }
  return {
    keys: sk.animations.reduce((n, a) => n + countKeys(a), 0),
    eventKeys: sk.animations.reduce((n, a) => n + a.events.length, 0),
    ownSlots: sk.slots.filter((sl) => !roots.has(sl.bone)).length,
    ik: sk.constraints.filter((c) => c.type === 'ik').length,
    meshes,
    weighted,
  };
}
let counted: { doc: ReturnType<typeof docStore.get>; n: ReturnType<typeof countDoc> } | null = null;

function snapshot(): LessonState {
  const ui = uiStore.get();
  const doc = docStore.get();
  if (counted?.doc !== doc) counted = { doc, n: countDoc(doc) };
  const n = counted.n;
  const t = tally;
  if (t.baseIk !== null && t.editsAtIk === null && n.ik > t.baseIk) t.editsAtIk = t.edits;
  return {
    mode: ui.mode,
    selectedBones: ui.selection.bones.length,
    edits: t.edits,
    keys: n.keys,
    images: doc.images.length,
    bones: doc.skeleton.bones.length,
    ownSlots: n.ownSlots,
    slotSelected: ui.selection.slot !== null,
    meshes: n.meshes,
    weightedMeshes: n.weighted,
    ikConstraints: n.ik,
    editsSinceIk: t.editsAtIk === null ? 0 : t.edits - t.editsAtIk,
    seenWeightsTool: t.seenWeightsTool,
    selectedKeys: ui.selectedKeys.length,
    interpEdits: t.interpEdits,
    handleEdits: t.handleEdits,
    seenGraph: t.seenGraph,
    skins: doc.skeleton.skins.length,
    events: doc.skeleton.events.length,
    eventKeys: n.eventKeys,
    skinSwitches: t.skinSwitches,
    zips: t.zips,
    players: t.players,
    playing: ui.playing,
    seenPlaying: t.seenPlaying,
    seenExport: t.seenExport,
  };
}

const sameProgress = (a: LessonProgress | null, b: LessonProgress) =>
  !!a && a.current === b.current && a.doneCount === b.doneCount && a.marks.join() === b.marks.join();

/** Reads the editor again and updates the lesson; does nothing when none is running. */
function refresh() {
  const s = learnStore.get();
  const lesson = s.active ? lessonById(s.active) : undefined;
  if (!lesson || !s.base) return;
  const ui = uiStore.get();
  if (ui.playing) tally.seenPlaying = true;
  if (ui.exportOpen) tally.seenExport = true;
  if (ui.tool === 'weights') tally.seenWeightsTool = true;
  if (ui.timelineView === 'graph') tally.seenGraph = true;
  if (ui.skinId !== tally.lastSkin) {
    tally.lastSkin = ui.skinId;
    tally.skinSwitches++;
  }
  const progress = progressOf(lesson, snapshot(), s.base, s.skipped, s.kept);
  const fresh = lesson.steps.filter((st, i) => progress.marks[i] === 'done' && !s.kept.includes(st.id)).map((st) => st.id);
  if (fresh.length) learnStore.patch({ kept: [...s.kept, ...fresh] });
  if (sameProgress(s.progress, progress)) return;
  learnStore.patch({ progress });
  if (progress.current === -1 && !s.finished.includes(lesson.id)) {
    learnStore.patch({ finished: [...s.finished, lesson.id] });
    remember();
  }
}

docStore.subscribe(() => {
  const doc = docStore.get();
  if (doc !== tally.lastDoc) {
    tally.lastDoc = doc;
    if (learnStore.get().active) {
      tally.edits++;
      const label = docStore.undoLabel;
      if (label === 'Set interpolation' || label === 'Automatic curve') tally.interpEdits++;
      else if (label === 'Edit curve') tally.handleEdits++;
    }
  }
  refresh();
});
uiStore.subscribe(refresh);

/** The Export window gave a file out: the lesson about the way to the game counts it. */
export function noteExport(kind: 'zip' | 'player') {
  if (kind === 'zip') tally.zips++;
  else tally.players++;
  refresh();
}

/** Starts a lesson on what is open now. */
export function startLesson(id: string) {
  if (!lessonById(id)) return;
  tally = newTally();
  const base = snapshot();
  tally.baseIk = base.ikConstraints;
  learnStore.patch({ active: id, base, skipped: [], kept: [], collapsed: false, progress: null });
  refresh();
}

export function stopLesson() {
  learnStore.patch({ active: null, base: null, skipped: [], kept: [], progress: null });
}

/** The step in front is set aside; it comes back as done when the editor gets into its state by itself. */
export function skipStep() {
  const s = learnStore.get();
  const lesson = s.active ? lessonById(s.active) : undefined;
  const step = lesson && s.progress && s.progress.current >= 0 ? lesson.steps[s.progress.current] : undefined;
  if (!step) return;
  learnStore.patch({ skipped: [...s.skipped, step.id] });
  refresh();
}

export function setLearnCollapsed(collapsed: boolean) {
  learnStore.patch({ collapsed });
}

/** The first time the demo is opened a lesson starts by itself; after that only the person's own request starts one. */
export function offerLesson(id: string) {
  const s = learnStore.get();
  if (s.offered || s.finished.includes(id)) return;
  learnStore.patch({ offered: true });
  remember();
  startLesson(id);
}

/** A lesson on request. The fox lesson on an empty project gets the demo rig first; anything else is left as it is: a lesson works on what is open. */
export async function openLesson(id: string) {
  const sk = docStore.get().skeleton;
  if (id === 'fox' && sk.bones.length <= 1 && sk.slots.length === 0 && sk.animations.length === 0) await loadSample();
  startLesson(id);
}

/** What a button of a lesson step does. */
export async function runLessonHelper(id: LessonHelper) {
  if (id === 'samplePictures') {
    // two pictures of the demo fox (body and tail), added like dropped files
    const all = await drawDemoImages();
    const want = ['fox-body', 'fox-tail'].map((n) => all.find((p) => p.name === n)).filter((p) => !!p);
    const chosen = want.length === 2 ? want : all.slice(0, 2);
    await importImageFiles(chosen.map((p) => new File([p.blob], `${p.name}.png`, { type: 'image/png' })));
  }
}

export function useLearn<S>(selector: (s: LearnState) => S): S {
  return useStore(learnStore, selector);
}
