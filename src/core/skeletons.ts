/**
 * Several skeletons in one project (they share the pictures). `project.skeleton` is always the one being edited, so everything in the editor keeps
 * working on it unchanged; the others wait in `project.others`, and `project.activeAt` says where the edited one stands in the list the person
 * sees. Switching moves a skeleton in or out of `project.skeleton`. What belongs to one skeleton only and lives on the project (the pose library
 * and the mix table) travels with it in `doc.aside` while it waits. All functions edit the project they are given (an Immer draft in the store).
 */
import { uniqueName } from './ids';
import type { Project, SkeletonDoc } from './model';
import { newBone, newSkin } from './model';

/** Every skeleton in the order the person sees them; the edited one is `project.skeleton`. */
export function skeletonList(p: Pick<Project, 'skeleton' | 'others' | 'activeAt'>): SkeletonDoc[] {
  const others = p.others ?? [];
  const at = clampAt(p.activeAt, others.length);
  return [...others.slice(0, at), p.skeleton, ...others.slice(at)];
}

/** Where the edited skeleton stands in the list. */
export const activeIndex = (p: Pick<Project, 'others' | 'activeAt'>): number => clampAt(p.activeAt, (p.others ?? []).length);

export const skeletonCount = (p: Pick<Project, 'others'>): number => 1 + (p.others?.length ?? 0);

function clampAt(at: number | undefined, others: number): number {
  return Number.isInteger(at) && at! >= 0 && at! <= others ? at! : 0;
}

/** A name for a new skeleton that no other skeleton of the project has. */
export function newSkeletonName(p: Pick<Project, 'skeleton' | 'others' | 'activeAt'>, base: string): string {
  return uniqueName(
    base.trim() || 'skeleton',
    skeletonList(p).map((d) => d.name),
  );
}

/** A skeleton with a root bone and nothing else. */
export function blankSkeleton(name: string, fps = 30): SkeletonDoc {
  return {
    name,
    fps,
    bones: [newBone({ name: 'root' })],
    slots: [],
    skins: [newSkin('default')],
    constraints: [],
    events: [],
    animations: [],
  };
}

/** Puts the per-skeleton parts of the project away with the skeleton that leaves, and takes the ones of the skeleton that arrives. */
function carry(p: Project, leaving: SkeletonDoc, arriving: SkeletonDoc) {
  const aside: NonNullable<SkeletonDoc['aside']> = {};
  if (p.poses?.length) aside.poses = p.poses;
  if (p.mixes) aside.mixes = p.mixes;
  if (aside.poses || aside.mixes) leaving.aside = aside;
  else delete leaving.aside;
  const from = arriving.aside;
  if (from?.poses) p.poses = from.poses;
  else delete p.poses;
  if (from?.mixes) p.mixes = from.mixes;
  else delete p.mixes;
  delete arriving.aside;
}

/** Makes the skeleton at `index` of the list the edited one. Returns false when there is no such skeleton or it already is. */
export function switchSkeleton(p: Project, index: number): boolean {
  const list = skeletonList(p);
  const at = activeIndex(p);
  if (!Number.isInteger(index) || index < 0 || index >= list.length || index === at) return false;
  const leaving = p.skeleton;
  const arriving = list[index];
  carry(p, leaving, arriving);
  p.others = list.filter((_, i) => i !== index);
  p.skeleton = arriving;
  p.activeAt = index;
  return true;
}

/** Adds a skeleton at the end of the list and makes it the edited one. Returns its index. */
export function addSkeleton(p: Project, doc: SkeletonDoc): number {
  const list = skeletonList(p);
  const leaving = p.skeleton;
  carry(p, leaving, doc);
  p.others = [...list];
  p.skeleton = doc;
  p.activeAt = list.length;
  return list.length;
}

/**
 * A copy of the edited skeleton of a (plain, not draft) project, named like it with a number; it carries the pose library and the mix table of the
 * original, as a copy of the whole thing should. Hand it to `duplicateSkeleton`.
 */
export function copyOfSkeleton(p: Project): SkeletonDoc {
  const copy = structuredClone(p.skeleton);
  copy.name = newSkeletonName(p, p.skeleton.name);
  const aside: NonNullable<SkeletonDoc['aside']> = {};
  if (p.poses?.length) aside.poses = structuredClone(p.poses);
  if (p.mixes) aside.mixes = structuredClone(p.mixes);
  if (aside.poses || aside.mixes) copy.aside = aside;
  else delete copy.aside;
  return copy;
}

/** Adds a copy made by `copyOfSkeleton` right after the edited skeleton and makes it the edited one. Returns its index. */
export function duplicateSkeleton(p: Project, copy: SkeletonDoc): number {
  const at = activeIndex(p);
  const list = skeletonList(p);
  carry(p, p.skeleton, copy);
  list.splice(at + 1, 0, copy);
  p.others = list.filter((d) => d !== copy);
  p.skeleton = copy;
  p.activeAt = at + 1;
  return at + 1;
}

/** Takes the skeleton at `index` out of the project (never the last one). The one next to it becomes the edited one when it was the edited one. */
export function removeSkeleton(p: Project, index: number): boolean {
  const list = skeletonList(p);
  if (list.length < 2 || !Number.isInteger(index) || index < 0 || index >= list.length) return false;
  const at = activeIndex(p);
  if (index !== at) {
    const kept = list.filter((_, i) => i !== index);
    p.others = kept.filter((d) => d !== p.skeleton);
    p.activeAt = index < at ? at - 1 : at;
    return true;
  }
  // the edited one goes: its neighbour takes over (the one after it, or the one before when it was the last)
  const next = index < list.length - 1 ? index : index - 1;
  const arriving = list.filter((_, i) => i !== index)[next];
  const rest = list.filter((_, i) => i !== index);
  delete p.poses;
  delete p.mixes;
  const from = arriving.aside;
  if (from?.poses) p.poses = from.poses;
  if (from?.mixes) p.mixes = from.mixes;
  delete arriving.aside;
  p.skeleton = arriving;
  p.others = rest.filter((d) => d !== arriving);
  p.activeAt = next;
  return true;
}

/** Gives the skeleton at `index` a new name (made unique among the others). */
export function renameSkeleton(p: Project, index: number, name: string): boolean {
  const list = skeletonList(p);
  const doc = list[index];
  const wanted = name.trim();
  if (!doc || !wanted || wanted === doc.name) return false;
  doc.name = uniqueName(
    wanted,
    list.filter((d) => d !== doc).map((d) => d.name),
  );
  return true;
}
