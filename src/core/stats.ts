/**
 * What is in a project, in numbers, and what looks forgotten: the Metrics window reads this. No DOM; the checks are cheap and only report, they never change the document.
 */
import { keyLists } from './keylists';
import type { Animation, Attachment, Project } from './model';
import { unusedImages } from './images';
import { attachmentPictures } from './sequence';

export interface Stats {
  bones: number;
  slots: number;
  skins: number;
  animations: number;
  events: number;
  images: number;
  constraints: Record<string, number>;
  attachments: Record<string, number>;
  /** Vertices and triangles of all meshes of the default skin and the others together. */
  vertices: number;
  triangles: number;
  weightedVertices: number;
  keys: number;
  /** Timelines: every list of keys of every animation counts once. */
  timelines: number;
  /** Pixels the pictures cover at their own size: regions by their size and scale, meshes by the area of their texture triangles. A rough measure of the fill rate. */
  area: number;
  /** Longest animation, in seconds. */
  longest: number;
}

export type WarningKind =
  'unusedImage' | 'emptyAnimation' | 'emptySlot' | 'tooManyInfluences' | 'duplicatePath' | 'missingFrame' | 'ignoredDeform';

export interface Warning {
  kind: WarningKind;
  /** The thing the warning is about (an image, animation or slot name). */
  subject: string;
  /** Where it is, by id: what a fix and a click on the warning need (a slot, a skin, an attachment name, an animation). */
  ref?: { slot?: string; skin?: string; name?: string; animation?: string };
}

/** Counts the keys of an animation: every array of objects that have a numeric `time`. */
export const countKeys = (anim: Animation): number => keyLists(anim).reduce((n, list) => n + list.length, 0);

/** Counts the timelines of an animation: every list of keys. */
export const countTimelines = (anim: Animation): number => keyLists(anim).length;

/** The pixels one attachment covers at its own size (0 for what is not a picture). */
export function attachmentArea(a: Attachment): number {
  if (a.type === 'region') return Math.abs(a.width * a.height * a.scaleX * a.scaleY);
  if (a.type !== 'mesh') return 0;
  let uv = 0;
  for (let i = 0; i + 2 < a.triangles.length; i += 3) {
    const [p, q, r] = [a.triangles[i] * 2, a.triangles[i + 1] * 2, a.triangles[i + 2] * 2];
    uv += Math.abs((a.uvs[q] - a.uvs[p]) * (a.uvs[r + 1] - a.uvs[p + 1]) - (a.uvs[r] - a.uvs[p]) * (a.uvs[q + 1] - a.uvs[p + 1])) / 2;
  }
  return uv * a.width * a.height;
}

function* attachmentsOf(project: Project): Generator<Attachment> {
  for (const skin of project.skeleton.skins) for (const bySlot of Object.values(skin.attachments)) yield* Object.values(bySlot);
}

export function projectStats(project: Project): Stats {
  const doc = project.skeleton;
  const constraints: Record<string, number> = {};
  for (const c of doc.constraints) constraints[c.type] = (constraints[c.type] ?? 0) + 1;
  const attachments: Stats['attachments'] = {};
  let vertices = 0;
  let triangles = 0;
  let weightedVertices = 0;
  let area = 0;
  for (const a of attachmentsOf(project)) {
    attachments[a.type] = (attachments[a.type] ?? 0) + 1;
    area += attachmentArea(a);
    if (a.type === 'mesh') {
      vertices += a.weights ? a.weights.length : a.vertices.length / 2;
      triangles += a.triangles.length / 3;
      if (a.weights) weightedVertices += a.weights.length;
    }
  }
  let keys = 0;
  let timelines = 0;
  let longest = 0;
  for (const a of doc.animations) {
    keys += countKeys(a);
    timelines += countTimelines(a);
    longest = Math.max(longest, a.duration);
  }
  return {
    bones: doc.bones.length,
    slots: doc.slots.length,
    skins: doc.skins.length,
    animations: doc.animations.length,
    events: doc.events.length,
    images: project.images.length,
    constraints,
    attachments,
    vertices,
    triangles,
    weightedVertices,
    keys,
    timelines,
    area: Math.round(area),
    longest,
  };
}

/** The most influences one vertex may have in the export (the Spine runtimes read any number, but 4 is what the editor and GPUs expect). */
export const MAX_INFLUENCES = 4;

export function projectWarnings(project: Project): Warning[] {
  const out: Warning[] = [];
  const have = new Set(project.images.map((i) => i.name));
  for (const skin of project.skeleton.skins) {
    for (const [slotId, bySlot] of Object.entries(skin.attachments)) {
      for (const a of Object.values(bySlot)) {
        const ref = { slot: slotId, skin: skin.id, name: a.name };
        if ((a.type === 'region' || a.type === 'mesh') && a.sequence && attachmentPictures(a).some((p) => !have.has(p)))
          out.push({ kind: 'missingFrame', subject: a.name, ref });
        if (a.type === 'mesh' && a.weights?.some((w) => w.length > MAX_INFLUENCES))
          out.push({ kind: 'tooManyInfluences', subject: a.name, ref });
      }
    }
  }
  // a linked mesh that shares the deform of its source is moved by the keys of the source: keys of its own are not exported
  for (const anim of project.skeleton.animations) {
    for (const [skinId, bySlot] of Object.entries(anim.deform)) {
      const skin = project.skeleton.skins.find((k) => k.id === skinId);
      for (const [slotId, byName] of Object.entries(bySlot)) {
        for (const [name, keys] of Object.entries(byName)) {
          const att = skin?.attachments[slotId]?.[name];
          if (att?.type === 'mesh' && att.link?.deform && keys.length)
            out.push({
              kind: 'ignoredDeform',
              subject: `${anim.name}: ${name}`,
              ref: { animation: anim.id, skin: skinId, slot: slotId, name },
            });
        }
      }
    }
  }
  // an image another skeleton of the project shows is in use
  for (const name of unusedImages(project)) out.push({ kind: 'unusedImage', subject: name });
  for (const anim of project.skeleton.animations)
    if (countKeys(anim) === 0) out.push({ kind: 'emptyAnimation', subject: anim.name, ref: { animation: anim.id } });
  const filled = new Set<string>();
  for (const skin of project.skeleton.skins)
    for (const [slot, by] of Object.entries(skin.attachments)) if (Object.keys(by).length) filled.add(slot);
  for (const s of project.skeleton.slots) if (!filled.has(s.id)) out.push({ kind: 'emptySlot', subject: s.name, ref: { slot: s.id } });
  return out;
}
