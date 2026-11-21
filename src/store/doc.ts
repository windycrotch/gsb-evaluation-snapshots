import { applyPatches, enablePatches, produceWithPatches, setAutoFreeze } from 'immer';
import type { Draft, Patch } from 'immer';
import { syncLinkedMeshes } from '@/core/links';
import { emptyProject } from '@/core/model';
import type { Project } from '@/core/model';
import { useStore } from './store';
import type { Store } from './store';

enablePatches();
setAutoFreeze(true);

/** Something outside the document that goes with a step of the history (the pixels behind a picture): undone and redone with it. */
export interface HistoryEffect {
  undo: () => void;
  redo: () => void;
}

interface HistoryEntry {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  effect?: HistoryEffect;
}

/**
 * The undoable document. Every change is an immer recipe; patches give us undo/redo for free.
 * Gestures (drags) coalesce all updates between `beginGesture` and `endGesture` into one history entry.
 */
export class DocStore implements Store<Project> {
  private state: Project = emptyProject();
  private listeners = new Set<() => void>();
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private gesture: { entry: HistoryEntry | null; label: string } | null = null;
  /** Bumps on every change (also undo/redo/replace) — handy for cheap "did anything change" checks. */
  revision = 0;
  /** Bumps when a different project is put in place (open, new, sample): things kept for the session about the old one (checkpoints) are then stale. */
  epoch = 0;
  dirty = false;

  get = () => this.state;

  set = (next: Project | ((p: Project) => Project)) => {
    this.replace(typeof next === 'function' ? next(this.state) : next);
  };

  patch = (p: Partial<Project>) => {
    this.update('patch', (d) => void Object.assign(d, p));
  };

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit() {
    this.revision++;
    this.listeners.forEach((l) => l());
  }

  /** Replaces the whole project and clears history (open / new). */
  replace(project: Project, keepHistory = false) {
    this.state = project;
    if (!keepHistory) {
      this.epoch++;
      this.undoStack = [];
      this.redoStack = [];
    }
    this.gesture = null;
    this.dirty = false;
    this.emit();
  }

  update(label: string, recipe: (draft: Draft<Project>) => void) {
    const [next, patches, inverse] = produceWithPatches(this.state, (d) => {
      recipe(d);
      // a linked mesh follows the shape of its source: the copy is brought up to date in the same step (and the same undo)
      syncLinkedMeshes(d.skeleton);
    });
    if (patches.length === 0) return;
    this.state = next;
    this.dirty = true;
    this.redoStack = [];
    if (this.gesture) {
      if (this.gesture.entry) {
        this.gesture.entry.patches.push(...patches);
        this.gesture.entry.inverse = [...inverse, ...this.gesture.entry.inverse];
      } else {
        this.gesture.entry = { label: this.gesture.label, patches: [...patches], inverse: [...inverse] };
        this.undoStack.push(this.gesture.entry);
      }
    } else {
      this.undoStack.push({ label, patches, inverse });
    }
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.emit();
  }

  /** Ties an effect to the last step of the history, so Undo and Redo run it too. Does nothing when the last update changed nothing. */
  attachEffect(effect: HistoryEffect) {
    const top = this.undoStack[this.undoStack.length - 1];
    if (!top) return;
    const before = top.effect;
    top.effect = before ? { undo: () => (effect.undo(), before.undo()), redo: () => (before.redo(), effect.redo()) } : effect;
  }

  beginGesture(label: string) {
    this.gesture = { entry: null, label };
  }

  endGesture() {
    this.gesture = null;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  get undoLabel() {
    return this.undoStack[this.undoStack.length - 1]?.label;
  }
  get redoLabel() {
    return this.redoStack[this.redoStack.length - 1]?.label;
  }

  /** The labels of what can be undone (oldest first) and redone (next first): the History window shows them. */
  get history(): { past: string[]; future: string[] } {
    return { past: this.undoStack.map((e) => e.label), future: [...this.redoStack].reverse().map((e) => e.label) };
  }

  /** Goes to the state after the index-th past entry (-1 = before the first one), or after the index-th step of the future (index >= past length). */
  jumpTo(index: number) {
    while (this.undoStack.length - 1 > index && this.canUndo) this.undo();
    while (this.undoStack.length - 1 < index && this.canRedo) this.redo();
  }

  undo() {
    this.gesture = null;
    const e = this.undoStack.pop();
    if (!e) return;
    this.state = applyPatches(this.state, e.inverse);
    e.effect?.undo();
    this.redoStack.push(e);
    this.dirty = true;
    this.emit();
  }

  redo() {
    this.gesture = null;
    const e = this.redoStack.pop();
    if (!e) return;
    this.state = applyPatches(this.state, e.patches);
    e.effect?.redo();
    this.undoStack.push(e);
    this.dirty = true;
    this.emit();
  }
}

export const docStore = new DocStore();

export function useProject(): Project {
  return useStore(docStore, (p) => p);
}
