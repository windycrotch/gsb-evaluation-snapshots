/**
 * Names in bulk: the matcher behind the hierarchy filter (words, `*` and `?` wildcards, `/regular expression/`) and Find and replace for the
 * names of bones, slots, skins, events, constraints, animations and pictures (a picture name is the name of an atlas region: the attachments that
 * show it follow). Pure functions over the document and the project.
 */
import { cleanImageName, renameImage, sequenceFrameOwner } from './images';
import type { Id, Project, SkeletonDoc } from './model';
import { skeletonList } from './skeletons';

export type NameTest = (name: string) => boolean;

/**
 * A test for a typed filter, or null when nothing is typed. Three forms: `/text/` (a regular expression, `/text/i` is case blind),
 * text with `*` (any run of characters) or `?` (one character), and plain words (each one has to be in the name, in any case).
 * A regular expression that does not parse matches nothing, so the tree shows it as an empty result instead of failing.
 */
export function nameMatcher(query: string): NameTest | null {
  const q = query.trim();
  if (!q) return null;
  const slashed = /^\/(.+)\/([a-z]*)$/s.exec(q);
  if (slashed) {
    try {
      const re = new RegExp(slashed[1], slashed[2].replace(/[gy]/g, ''));
      return (name) => re.test(name);
    } catch {
      return () => false;
    }
  }
  if (/[*?]/.test(q)) {
    const source = q
      .split('')
      .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
      .join('');
    const re = new RegExp(source, 'is');
    return (name) => re.test(name);
  }
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return (name) => {
    const n = name.toLowerCase();
    return words.every((w) => n.includes(w));
  };
}

export type NameKind = 'bone' | 'slot' | 'skin' | 'event' | 'constraint' | 'animation' | 'image';
export const NAME_KINDS: readonly NameKind[] = ['bone', 'slot', 'skin', 'event', 'constraint', 'animation', 'image'];

/** What a replacement may touch, when it is not everything: the ids of bones, slots, constraints, skins and animations, and the names of pictures. */
export interface RenameScope {
  ids?: ReadonlySet<Id>;
  images?: ReadonlySet<string>;
}

export interface FindReplaceOptions {
  find: string;
  replace: string;
  /** `find` is a regular expression and `replace` may use $1, $2 ... */
  regex: boolean;
  matchCase: boolean;
  /** Only the first match inside each name. */
  firstOnly: boolean;
  kinds: readonly NameKind[];
  /** Only these (default: all). */
  scope?: RenameScope;
}

export interface RenameChange {
  kind: NameKind;
  id: Id;
  from: string;
  to: string;
}

export interface RenamePlan {
  changes: RenameChange[];
  /** A name that matched but could not change: it would be empty, the same as another name, or (a picture) the frame of a sequence. */
  skipped: { kind: NameKind; from: string; to: string; why: 'empty' | 'taken' | 'frame' }[];
  /** The expression did not parse. */
  invalid: boolean;
}

function listOf(doc: SkeletonDoc, kind: Exclude<NameKind, 'image'>): { id: Id; name: string }[] {
  switch (kind) {
    case 'bone':
      return doc.bones;
    case 'slot':
      return doc.slots;
    case 'skin':
      return doc.skins;
    case 'event':
      return doc.events;
    case 'constraint':
      return doc.constraints;
    case 'animation':
      return doc.animations;
  }
}

/**
 * What Find and replace would do, without doing it. Names are replaced one after the other: when two would end up the same the second
 * is skipped (it is listed), so the result never needs the validator to repair a duplicate. The default skin keeps its name.
 */
export function planRename(doc: SkeletonDoc, opts: FindReplaceOptions, project?: Project): RenamePlan {
  const plan: RenamePlan = { changes: [], skipped: [], invalid: false };
  if (!opts.find) return plan;
  let re: RegExp;
  try {
    const source = opts.regex ? opts.find : opts.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(source, (opts.matchCase ? '' : 'i') + (opts.firstOnly ? '' : 'g') + 's');
  } catch {
    plan.invalid = true;
    return plan;
  }
  // a plain replacement is taken literally: "$" in it does not mean a group
  const swap = (name: string) => (opts.regex ? name.replace(re, opts.replace) : name.replace(re, () => opts.replace));
  for (const kind of NAME_KINDS) {
    if (!opts.kinds.includes(kind)) continue;
    if (kind === 'image') {
      if (project) planImages(project, opts, swap, plan);
      continue;
    }
    const list = listOf(doc, kind);
    const taken = new Set(list.map((x) => x.name));
    list.forEach((item, index) => {
      if (kind === 'skin' && index === 0) return;
      if (opts.scope?.ids && !opts.scope.ids.has(item.id)) return;
      const to = swap(item.name);
      if (to === item.name) return;
      if (!to.trim()) return void plan.skipped.push({ kind, from: item.name, to, why: 'empty' });
      if (taken.has(to)) return void plan.skipped.push({ kind, from: item.name, to, why: 'taken' });
      taken.delete(item.name);
      taken.add(to);
      plan.changes.push({ kind, id: item.id, from: item.name, to });
    });
  }
  return plan;
}

/** The pictures: a change has the old name of the picture as its id. A picture that is the frame of a sequence cannot be renamed on its own. */
function planImages(project: Project, opts: FindReplaceOptions, swap: (name: string) => string, plan: RenamePlan) {
  const taken = new Set(project.images.map((i) => i.name));
  const docs = skeletonList(project);
  for (const image of project.images) {
    if (opts.scope?.images && !opts.scope.images.has(image.name)) continue;
    const to = cleanImageName(swap(image.name));
    if (to === image.name || swap(image.name) === image.name) continue;
    if (!to) {
      plan.skipped.push({ kind: 'image', from: image.name, to, why: 'empty' });
      continue;
    }
    if (docs.some((d) => sequenceFrameOwner(d, image.name))) {
      plan.skipped.push({ kind: 'image', from: image.name, to, why: 'frame' });
      continue;
    }
    if (taken.has(to)) {
      plan.skipped.push({ kind: 'image', from: image.name, to, why: 'taken' });
      continue;
    }
    taken.delete(image.name);
    taken.add(to);
    plan.changes.push({ kind: 'image', id: image.name, from: image.name, to });
  }
}

/** Renames the pictures of a plan (and the attachments that show them). Returns how many changed. */
export function applyImageRename(project: Project, changes: readonly RenameChange[]): number {
  let n = 0;
  for (const c of changes) if (c.kind === 'image' && renameImage(project, c.from, c.to).ok) n++;
  return n;
}

/** Puts the names of a plan into the document (not the pictures: see `applyImageRename`). Returns how many names changed. */
export function applyRename(doc: SkeletonDoc, changes: readonly RenameChange[]): number {
  let n = 0;
  for (const c of changes) {
    if (c.kind === 'image') continue;
    const item = listOf(doc, c.kind).find((x) => x.id === c.id);
    if (item && item.name === c.from) {
      item.name = c.to;
      n++;
    }
  }
  return n;
}
