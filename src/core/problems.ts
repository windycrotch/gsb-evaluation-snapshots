/**
 * Problems with a fix: what the Metrics window lists before an export (`projectWarnings`) can mostly be put right in one step.
 * A fix changes the project it is given (inside one undo step in the editor) and says whether it did anything, so the same call is safe to repeat.
 *
 * "Safe" fixes lose nothing the file needs: an image nothing shows, the surplus influences of a vertex, deform keys the export ignores.
 * The others delete something that may be a placeholder on purpose (an empty animation, a slot without a picture), so they are only done one at a time.
 */
import { dropDeformTimeline, removeSlots, reconcileDeform } from './edit';
import { unusedImages } from './images';
import { pruneWeights } from './mesh';
import type { MeshAttachment, Project } from './model';
import { cleanMixes, withoutAnimation } from './preview';
import { MAX_INFLUENCES } from './stats';
import type { Warning, WarningKind } from './stats';

/** Warnings that have a fix at all. */
const FIXABLE: readonly WarningKind[] = ['unusedImage', 'tooManyInfluences', 'ignoredDeform', 'emptyAnimation', 'emptySlot'];

/** The fixes that lose nothing: "Fix all" does these and no others. */
const SAFE_FIXES: readonly WarningKind[] = ['unusedImage', 'tooManyInfluences', 'ignoredDeform'];

export const canFix = (w: Warning) => FIXABLE.includes(w.kind);
export const isSafeFix = (w: Warning) => SAFE_FIXES.includes(w.kind);

/** Removes an animation and everything that pointed at it (a slider that applied it, the mix table). */
export function removeAnimation(project: Project, id: string) {
  const doc = project.skeleton;
  doc.animations = doc.animations.filter((a) => a.id !== id);
  for (const c of doc.constraints) if (c.type === 'slider' && c.animation === id) c.animation = null;
  if (project.mixes) {
    const clean = cleanMixes(withoutAnimation(project.mixes, id), new Set(doc.animations.map((a) => a.id)));
    if (clean) project.mixes = clean;
    else delete project.mixes;
  }
}

/** Puts one warning right in `project`. Returns true when something changed (false: it was already fixed, or it has no fix). */
export function fixProblem(project: Project, w: Warning): boolean {
  const doc = project.skeleton;
  const ref = w.ref ?? {};
  switch (w.kind) {
    case 'unusedImage': {
      // still checked against every skeleton of the project: the list may be older than the document
      if (!unusedImages(project).includes(w.subject)) return false;
      project.images = project.images.filter((i) => i.name !== w.subject);
      return true;
    }
    case 'emptyAnimation': {
      if (!ref.animation || !doc.animations.some((a) => a.id === ref.animation)) return false;
      removeAnimation(project, ref.animation);
      return true;
    }
    case 'emptySlot': {
      if (!ref.slot || !doc.slots.some((s) => s.id === ref.slot)) return false;
      removeSlots(doc, new Set([ref.slot]));
      return true;
    }
    case 'ignoredDeform': {
      if (!ref.animation || !ref.skin || !ref.slot || !ref.name) return false;
      const a = doc.animations.find((x) => x.id === ref.animation);
      if (!a?.deform[ref.skin]?.[ref.slot]?.[ref.name]) return false;
      dropDeformTimeline(a, ref.skin, ref.slot, ref.name);
      return true;
    }
    case 'tooManyInfluences': {
      if (!ref.skin || !ref.slot || !ref.name) return false;
      const found = doc.skins.find((s) => s.id === ref.skin)?.attachments[ref.slot]?.[ref.name];
      if (found?.type !== 'mesh' || !found.weights) return false;
      let mesh: MeshAttachment = found;
      let at = { skin: ref.skin, slot: ref.slot, name: ref.name };
      // a linked mesh has the weights of its source: the source is the one to fix, the copy follows
      const link = found.link;
      if (link) {
        const from = link.skin ? doc.skins.find((s) => s.id === link.skin) : doc.skins[0];
        const slot = link.slot ?? ref.slot;
        const source = from?.attachments[slot]?.[link.source];
        if (!from || source?.type !== 'mesh' || !source.weights) return false;
        mesh = source;
        at = { skin: from.id, slot, name: link.source };
      }
      const surplus = new Set<number>();
      mesh.weights!.forEach((list, i) => {
        if (list.length > MAX_INFLUENCES) surplus.add(i);
      });
      if (!surplus.size) return false;
      // the old weights stay as they are: pruning makes new lists
      const before: MeshAttachment = { ...mesh };
      // threshold 0: only the number of bones is cut, the strongest ones stay and the rest is scaled back to 1
      mesh.weights = pruneWeights(mesh.weights!, 0, MAX_INFLUENCES, surplus);
      reconcileDeform(doc, at.slot, at.name, before, mesh, null, undefined, at.skin);
      return true;
    }
    default:
      return false;
  }
}

/** Puts every warning that has a safe fix right. Returns how many of them changed something. */
export function fixAllSafe(project: Project, warnings: Warning[]): number {
  let n = 0;
  for (const w of warnings) if (isSafeFix(w) && fixProblem(project, w)) n++;
  return n;
}
