/**
 * Take from a checkpoint (or from another version of the project): the things the person picks out of the list of differences are put into
 * the open skeleton, the rest stays as it is. A thing that is gone comes back (with the bones it hangs on), a thing that changed goes back to
 * the other version, the skeleton's own settings are taken over. What is only in the open skeleton is never deleted here (use the tools for that).
 * Pure: it works on a project (a draft inside an undoable step) and a skeleton to take from, and leaves the latter alone.
 */
import type { ChangeArea } from './checkpoints';
import { uid, uniqueName } from './ids';
import { imageUsage } from './images';
import type { Bone, Constraint, EventDef, Id, ImageRef, Project, SkeletonDoc, Slot } from './model';
import { repairProject } from './validate';

export interface MergeRef {
  area: ChangeArea;
  id?: Id;
}

export interface MergeResult {
  /** Picked things that were put in. */
  taken: number;
  /** Picked things that could not be (a thing that is not in the other version, a bone that cannot be placed without a loop). */
  skipped: number;
  /** Bones that were brought back only because something picked hangs on them. */
  carried: number;
  /** Pictures the taken things use that the open project did not have. */
  pictures: number;
  /** Things the integrity check had to fix afterwards (a timeline of a bone that is not there, ...). */
  repaired: number;
}

const ORDER: ChangeArea[] = ['skeleton', 'bone', 'slot', 'skin', 'constraint', 'event', 'animation'];

const clone = <T>(v: T): T => structuredClone(v);

/** Makes `target` hold exactly the fields of `src` (the identity of `target` stays: it may be a draft of the open document). */
function replaceInPlace<T extends object>(target: T, src: T) {
  const t = target as Record<string, unknown>;
  for (const k of Object.keys(t)) if (!(k in src)) delete t[k];
  Object.assign(t, src);
}

/** Puts `item` in `list` where it stood in the other version: before the first thing that follows it there and is in `list` too, else last. */
function insertLike<T extends { id: Id }>(list: T[], item: T, other: readonly T[]) {
  const at = other.findIndex((x) => x.id === item.id);
  for (let i = at + 1; at >= 0 && i < other.length; i++) {
    const j = list.findIndex((x) => x.id === other[i].id);
    if (j >= 0) return void list.splice(j, 0, item);
  }
  list.push(item);
}

/** True when bone `id` is in `cur` afterwards: the bones it hangs on that are missing are brought back from `file`, parents first. Counts them in `carried`. */
function ensureBone(cur: SkeletonDoc, file: SkeletonDoc, id: Id | null, res: MergeResult): boolean {
  const chain: Bone[] = [];
  const seen = new Set<Id>();
  for (let at = id; at && !cur.bones.some((b) => b.id === at);) {
    if (seen.has(at)) return false;
    seen.add(at);
    const fb = file.bones.find((b) => b.id === at);
    if (!fb) return false;
    chain.unshift(fb);
    at = fb.parent;
  }
  for (const fb of chain) {
    const b = clone(fb);
    b.name = uniqueName(
      b.name,
      cur.bones.map((x) => x.name),
    );
    insertLike(cur.bones, b, file.bones);
    res.carried++;
  }
  return true;
}

/** Brings back a slot of `file` that `cur` lacks, with its bone and its pictures in the skins both versions have. */
function ensureSlot(cur: SkeletonDoc, file: SkeletonDoc, id: Id, res: MergeResult): boolean {
  if (cur.slots.some((s) => s.id === id)) return true;
  const fs = file.slots.find((s) => s.id === id);
  if (!fs || !ensureBone(cur, file, fs.bone, res)) return false;
  const s: Slot = clone(fs);
  s.name = uniqueName(
    s.name,
    cur.slots.map((x) => x.name),
  );
  insertLike(cur.slots, s, file.slots);
  for (const skin of cur.skins) {
    const there = file.skins.find((x) => x.id === skin.id)?.attachments[id];
    if (there && !skin.attachments[id]) skin.attachments[id] = clone(there);
  }
  return true;
}

/** The strings inside a value, keys of records included. */
function strings(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof v === 'string') out.add(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      strings(x, out);
    }
  return out;
}

/** True when going up from `bone` through the parents leads back to `bone` or never ends. */
function loops(cur: SkeletonDoc, bone: Bone): boolean {
  const seen = new Set<Id>();
  for (let b: Bone | undefined = bone; b;) {
    if (seen.has(b.id)) return true;
    seen.add(b.id);
    b = b.parent ? cur.bones.find((x) => x.id === b!.parent) : undefined;
  }
  return false;
}

/**
 * Puts the things `refs` name into `project` (a draft or a copy), taking them from `file` (another version of the skeleton; it is not changed
 * and nothing of it is shared with the result). Pictures the taken things use are added to `project.images` from `file.images`. The integrity
 * check runs at the end, so the result is always a sound document.
 */
export function mergeFromFile(project: Project, file: Pick<Project, 'skeleton' | 'images'>, refs: readonly MergeRef[]): MergeResult {
  const res: MergeResult = { taken: 0, skipped: 0, carried: 0, pictures: 0, repaired: 0 };
  const cur = project.skeleton;
  const src = file.skeleton;
  const sorted = [...refs].sort((a, b) => ORDER.indexOf(a.area) - ORDER.indexOf(b.area));
  for (const ref of sorted) {
    const ok = take(cur, src, ref, res);
    if (ok) res.taken++;
    else res.skipped++;
  }
  if (!res.taken) return res; // nothing went in: nothing to settle
  // the pictures the skeleton shows now
  const have = new Set(project.images.map((i) => i.name));
  for (const name of imageUsage(cur).keys()) {
    if (have.has(name)) continue;
    const ref = file.images.find((i) => i.name === name);
    if (!ref) continue;
    const copy: ImageRef = clone(ref);
    if (project.images.some((i) => i.id === copy.id)) copy.id = uid();
    project.images.push(copy);
    have.add(name);
    res.pictures++;
  }
  res.repaired = repairProject(project).length;
  return res;
}

function take(cur: SkeletonDoc, src: SkeletonDoc, ref: MergeRef, res: MergeResult): boolean {
  switch (ref.area) {
    case 'skeleton': {
      cur.fps = src.fps;
      if (src.referenceScale === undefined) delete cur.referenceScale;
      else cur.referenceScale = src.referenceScale;
      cur.name = src.name;
      return true;
    }
    case 'bone': {
      const fb = src.bones.find((b) => b.id === ref.id);
      if (!fb) return false;
      const cb = cur.bones.find((b) => b.id === ref.id);
      if (!cb) return ensureBone(cur, src, fb.id, res) && (res.carried--, true);
      if (fb.parent && !ensureBone(cur, src, fb.parent, res)) return false;
      const before = cb.parent;
      const mine = cb.name;
      replaceInPlace(cb, clone(fb));
      if (loops(cur, cb)) cb.parent = before; // the other version hangs it under something that hangs under it here
      cb.name =
        fb.name === mine
          ? mine
          : uniqueName(
              fb.name,
              cur.bones.filter((b) => b !== cb).map((b) => b.name),
            );
      return true;
    }
    case 'slot': {
      const fs = src.slots.find((s) => s.id === ref.id);
      if (!fs) return false;
      const cs = cur.slots.find((s) => s.id === fs.id);
      if (!cs) return ensureSlot(cur, src, fs.id, res);
      if (!ensureBone(cur, src, fs.bone, res)) return false;
      replaceInPlace(cs, clone(fs));
      cs.name = uniqueName(
        fs.name,
        cur.slots.filter((s) => s !== cs).map((s) => s.name),
      );
      return true;
    }
    case 'skin': {
      const fk = src.skins.find((s) => s.id === ref.id);
      if (!fk) return false;
      for (const b of fk.bones) ensureBone(cur, src, b, res);
      for (const slot of Object.keys(fk.attachments)) ensureSlot(cur, src, slot, res);
      const ck = cur.skins.find((s) => s.id === fk.id);
      if (ck) replaceInPlace(ck, clone(fk));
      else insertLike(cur.skins, clone(fk), src.skins);
      const now = cur.skins.find((s) => s.id === fk.id)!;
      now.name = uniqueName(
        fk.name,
        cur.skins.filter((s) => s !== now).map((s) => s.name),
      );
      return true;
    }
    case 'constraint': {
      const fc = src.constraints.find((c) => c.id === ref.id);
      if (!fc) return false;
      // what the constraint works on comes back with it
      for (const s of strings(fc)) {
        if (src.bones.some((b) => b.id === s)) ensureBone(cur, src, s, res);
        else if (src.slots.some((x) => x.id === s)) ensureSlot(cur, src, s, res);
      }
      const copy: Constraint = clone(fc);
      const cc = cur.constraints.find((c) => c.id === fc.id);
      if (cc) replaceInPlace(cc, copy);
      else insertLike(cur.constraints, copy, src.constraints);
      const now = cur.constraints.find((c) => c.id === fc.id)!;
      now.name = uniqueName(
        fc.name,
        cur.constraints.filter((c) => c !== now).map((c) => c.name),
      );
      return true;
    }
    case 'event': {
      const fe = src.events.find((e) => e.id === ref.id);
      if (!fe) return false;
      const copy: EventDef = clone(fe);
      const ce = cur.events.find((e) => e.id === fe.id);
      if (ce) replaceInPlace(ce, copy);
      else insertLike(cur.events, copy, src.events);
      const now = cur.events.find((e) => e.id === fe.id)!;
      now.name = uniqueName(
        fe.name,
        cur.events.filter((e) => e !== now).map((e) => e.name),
      );
      return true;
    }
    case 'animation': {
      const fa = src.animations.find((a) => a.id === ref.id);
      if (!fa) return false;
      const copy = clone(fa);
      const ca = cur.animations.find((a) => a.id === fa.id);
      if (ca) replaceInPlace(ca, copy);
      else insertLike(cur.animations, copy, src.animations);
      const now = cur.animations.find((a) => a.id === fa.id)!;
      now.name = uniqueName(
        fa.name,
        cur.animations.filter((a) => a !== now).map((a) => a.name),
      );
      return true;
    }
  }
}
