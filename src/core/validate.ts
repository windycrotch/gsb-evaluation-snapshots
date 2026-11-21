/**
 * Document integrity. `repairProject` fixes — in place — everything that would make the editor misbehave or produce an
 * export the official runtimes reject: dangling ids, stale deform keys, duplicate or empty names, NaN, unsorted keys.
 * It runs whenever a project is opened. `validateProject` reports the same findings without touching the document;
 * the fuzz tests use it as the oracle ("after any editor action there is nothing to repair").
 */
import { animationEndTime } from './animate';
import { KEY_EPS, normalizeBoneOrder } from './edit';
import { uid, uniqueName } from './ids';
import { pruneFolders } from './folders';
import { deformLength } from './mesh';
import { syncLinkedMeshes } from './links';
import { cleanSequence, cleanSequenceKey } from './sequence';
import { cleanMarkers } from './markers';
import { cleanPlay } from './playback';
import { cleanGuides } from './snap';
import { repairPoses } from './poses';
import { repairMixes } from './preview';
import {
  BLEND_MODES,
  DEFAULT_BOUNDING_BOX_COLOR,
  DEFAULT_CLIPPING_COLOR,
  DEFAULT_PATH_COLOR,
  DEFAULT_POINT_COLOR,
  GLOBAL_PHYSICS,
  INHERIT_MODES,
  PATH_POSITION_MODES,
  PATH_ROTATE_MODES,
  PATH_SPACING_MODES,
  PHYSICS_PARAMS,
  TRANSFORM_PROPS,
  newBone,
  newSkin,
} from './model';
import type { Animation, Attachment, Id, Influence, Project, SkeletonDoc } from './model';

type Note = (message: string) => void;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isString = (v: unknown): v is string => typeof v === 'string';

/** Reports every problem `repairProject` would fix. The project is left untouched. */
export function validateProject(project: Project): string[] {
  return repairProject(structuredClone(project));
}

/** Repairs `project` in place and returns a human readable list of what was changed (empty = it was already fine). */
export function repairProject(project: Project): string[] {
  const messages: string[] = [];
  const note: Note = (m) => void messages.push(m);
  const doc = project.skeleton;

  if (!finite(doc.fps) || doc.fps < 1 || doc.fps > 240) {
    doc.fps = finite(doc.fps) ? Math.max(1, Math.min(240, Math.round(doc.fps))) : 30;
    note('fps was out of range');
  }
  // a damaged or hand-edited file may lack whole lists
  for (const key of ['bones', 'slots', 'skins', 'constraints', 'events', 'animations'] as const) {
    if (!Array.isArray(doc[key])) (doc as unknown as Record<string, unknown>)[key] = [];
  }

  repairBones(doc, note);
  repairSlots(doc, note);
  repairFolders(doc, note);
  repairSelectionSets(doc, note);
  repairSkins(doc, note);
  repairConstraints(doc, note);
  repairEvents(doc, note);
  repairAnimations(doc, note);

  // a slider whose animation is gone simply does nothing until a new one is chosen
  const animationIds = new Set(doc.animations.map((a) => a.id));
  for (const c of doc.constraints) {
    if (c.type === 'slider' && c.animation !== null && !animationIds.has(c.animation)) {
      c.animation = null;
      note(`slider "${c.name}": its animation does not exist`);
    }
  }

  // skins may only list constraints that survived
  const constraintIds = new Set(doc.constraints.map((c) => c.id));
  for (const skin of doc.skins) {
    const kept = (skin.constraints ?? []).filter((id) => constraintIds.has(id));
    if (kept.length !== (skin.constraints ?? []).length) note(`skin "${skin.name}": dropped unknown constraints`);
    skin.constraints = kept;
  }

  if (project.guides !== undefined) {
    const clean = cleanGuides(project.guides);
    const old = project.guides as { x?: unknown; y?: unknown } | null;
    const same =
      !!old &&
      typeof old === 'object' &&
      JSON.stringify(old.x) === JSON.stringify(clean.x) &&
      JSON.stringify(old.y) === JSON.stringify(clean.y);
    if (!same) note('the guides were repaired');
    project.guides = clean;
  }

  if (project.mixes !== undefined && repairMixes(project)) note('the mix table was repaired');

  if (project.poses !== undefined) {
    const fixed = repairPoses(project.poses);
    if (fixed.notes.length) {
      project.poses = fixed.poses;
      for (const n of fixed.notes) note(n);
    }
  }

  const imageNames = new Set<string>();
  project.images ??= [];
  project.images = project.images.filter((img) => {
    if (!img || !isString(img.name) || imageNames.has(img.name)) {
      note('duplicate or invalid image entry removed');
      return false;
    }
    imageNames.add(img.name);
    if (
      img.psd !== undefined &&
      !(Array.isArray(img.psd) && img.psd.length === 2 && img.psd.every((n) => typeof n === 'number' && Number.isFinite(n)))
    ) {
      delete img.psd;
      note(`image "${img.name}": PSD position dropped`);
    }
    return true;
  });
  repairOthers(project, note);
  return messages;
}

/** The other skeletons of the project: each one is repaired like the edited one, and the table of them is kept consistent. */
function repairOthers(project: Project, note: Note) {
  if (project.others === undefined && project.activeAt === undefined) return;
  if (!Array.isArray(project.others)) {
    project.others = [];
    note('the list of other skeletons was repaired');
  }
  const kept = project.others.filter((o) => o && typeof o === 'object' && Array.isArray(o.bones));
  if (kept.length !== project.others.length) note('skeletons that could not be read were dropped');
  project.others = kept;
  const at = project.activeAt;
  if (!Number.isInteger(at) || at! < 0 || at! > kept.length) {
    if (at !== undefined) note('the position of the edited skeleton was repaired');
    project.activeAt = 0;
  }
  const seen = new Set<string>([isString(project.skeleton.name) ? project.skeleton.name : '']);
  for (const other of kept) {
    // the same checks as for the edited one, on a project that has this skeleton and its own pose library and mix table
    const sub: Project = {
      format: 'bone2d',
      version: 1,
      name: project.name,
      skeleton: other,
      images: [],
      poses: other.aside?.poses,
      mixes: other.aside?.mixes,
    };
    for (const m of repairProject(sub)) note(`skeleton "${other.name}": ${m}`);
    const aside: NonNullable<SkeletonDoc['aside']> = {};
    if (sub.poses?.length) aside.poses = sub.poses;
    if (sub.mixes) aside.mixes = sub.mixes;
    if (aside.poses || aside.mixes) other.aside = aside;
    else delete other.aside;
    let name = isString(other.name) && other.name.trim() ? other.name : 'skeleton';
    if (seen.has(name)) name = uniqueName(name, seen);
    if (name !== other.name) {
      other.name = name;
      note('a skeleton name was made unique');
    }
    seen.add(name);
  }
  if (!kept.length) {
    delete project.others;
    delete project.activeAt;
  }
}

function dedupeIds(list: { id: Id }[], what: string, note: Note) {
  const seen = new Set<Id>();
  for (const x of list) {
    if (!isString(x.id) || !x.id || seen.has(x.id)) {
      x.id = uid();
      note(`${what}: duplicate or missing id replaced`);
    }
    seen.add(x.id);
  }
}

function dedupeNames(list: { name: string }[], fallback: string, what: string, note: Note) {
  const seen = new Set<string>();
  for (const x of list) {
    let name = isString(x.name) && x.name.trim() ? x.name : fallback;
    if (seen.has(name)) name = uniqueName(name, seen);
    if (name !== x.name) {
      note(`${what} "${String(x.name)}" renamed to "${name}"`);
      x.name = name;
    }
    seen.add(name);
  }
}

function validColor(c: unknown, length: 3 | 4): boolean {
  return Array.isArray(c) && c.length >= length && c.slice(0, length).every(finite);
}

function repairBones(doc: SkeletonDoc, note: Note) {
  if (!doc.bones.length) {
    doc.bones.push(newBone({ name: 'root' }));
    note('the skeleton had no bones: added a root');
  }
  dedupeIds(doc.bones, 'bone', note);
  dedupeNames(doc.bones, 'bone', 'bone', note);
  const ids = new Set(doc.bones.map((b) => b.id));
  for (const b of doc.bones) {
    for (const k of ['x', 'y', 'rotation', 'shearX', 'shearY', 'length'] as const) {
      if (!finite(b[k])) {
        b[k] = 0;
        note(`bone "${b.name}": ${k} was not a number`);
      }
    }
    for (const k of ['scaleX', 'scaleY'] as const) {
      if (!finite(b[k])) {
        b[k] = 1;
        note(`bone "${b.name}": ${k} was not a number`);
      }
    }
    if (!INHERIT_MODES.includes(b.inherit)) {
      b.inherit = 'normal';
      note(`bone "${b.name}": unknown inherit mode`);
    }
    if (b.parent != null && (!ids.has(b.parent) || b.parent === b.id)) {
      b.parent = doc.bones[0].id === b.id ? null : doc.bones[0].id;
      note(`bone "${b.name}": parent does not exist`);
    }
    if (b.parent === undefined) b.parent = null;
    if (!validColor(b.color, 4)) b.color = [0.6, 0.6, 0.6, 1];
    b.skinRequired = !!b.skinRequired;
    b.hidden = !!b.hidden;
    b.locked = !!b.locked;
  }
  const byId = new Map(doc.bones.map((b) => [b.id, b] as const));
  for (const b of doc.bones) {
    let cur = b;
    let steps = 0;
    while (cur.parent && steps <= doc.bones.length) {
      cur = byId.get(cur.parent)!;
      steps++;
    }
    if (steps > doc.bones.length) {
      b.parent = null;
      note(`bone "${b.name}": parent chain was a cycle`);
    }
  }
  const order = new Map(doc.bones.map((b, i) => [b.id, i] as const));
  if (doc.bones.some((b) => b.parent && order.get(b.parent)! > order.get(b.id)!)) {
    normalizeBoneOrder(doc);
    note('bones were not ordered parents-first');
  }
}

/** Draw order folders: a list of {id, name, slots}, each slot in at most one folder, no folder left empty. */
function repairFolders(doc: SkeletonDoc, note: Note) {
  if (doc.drawOrderFolders === undefined) return;
  if (!Array.isArray(doc.drawOrderFolders)) {
    delete doc.drawOrderFolders;
    note('draw order folders were not a list');
    return;
  }
  const valid = doc.drawOrderFolders.filter((f) => f && typeof f === 'object' && isString(f.id) && Array.isArray(f.slots));
  if (valid.length !== doc.drawOrderFolders.length) note('damaged draw order folders removed');
  doc.drawOrderFolders = valid;
  dedupeIds(doc.drawOrderFolders, 'draw order folder', note);
  for (const f of doc.drawOrderFolders) if (!isString(f.name) || !f.name.trim()) f.name = 'folder';
  dedupeNames(doc.drawOrderFolders, 'folder', 'draw order folder', note);
  const before = JSON.stringify(doc.drawOrderFolders.map((f) => f.slots));
  const gone = pruneFolders(doc);
  if (gone.length || JSON.stringify((doc.drawOrderFolders ?? []).map((f) => f.slots)) !== before)
    note('draw order folders repaired (unknown or shared slots, empty folders)');
}

/** Selection sets: a list of {id, name, bones}; a set keeps only the bones that exist and a set with none is dropped. */
function repairSelectionSets(doc: SkeletonDoc, note: Note) {
  if (doc.selectionSets === undefined) return;
  if (!Array.isArray(doc.selectionSets)) {
    delete doc.selectionSets;
    note('selection sets were not a list');
    return;
  }
  const alive = new Set(doc.bones.map((b) => b.id));
  const before = JSON.stringify(doc.selectionSets);
  const valid = doc.selectionSets.filter((s) => s && typeof s === 'object' && isString(s.id) && Array.isArray(s.bones));
  for (const s of valid) {
    s.bones = [...new Set(s.bones.filter((id) => isString(id) && alive.has(id)))];
    if (!isString(s.name) || !s.name.trim()) s.name = 'Set';
  }
  doc.selectionSets = valid.filter((s) => s.bones.length > 0);
  dedupeIds(doc.selectionSets, 'selection set', note);
  dedupeNames(doc.selectionSets, 'Set', 'selection set', note);
  if (!doc.selectionSets.length) delete doc.selectionSets;
  if (JSON.stringify(doc.selectionSets ?? []) !== before && before !== '[]')
    note('selection sets repaired (damaged entries, unknown bones, empty sets)');
}

function repairSlots(doc: SkeletonDoc, note: Note) {
  dedupeIds(doc.slots, 'slot', note);
  dedupeNames(doc.slots, 'slot', 'slot', note);
  const boneIds = new Set(doc.bones.map((b) => b.id));
  for (const s of doc.slots) {
    if (!boneIds.has(s.bone)) {
      s.bone = doc.bones[0].id;
      note(`slot "${s.name}": bone does not exist`);
    }
    if (!validColor(s.color, 4)) s.color = [1, 1, 1, 1];
    if (s.dark != null && !validColor(s.dark, 3)) s.dark = null;
    if (!BLEND_MODES.includes(s.blend)) s.blend = 'normal';
    if (s.attachment !== null && !isString(s.attachment)) s.attachment = null;
    s.hidden = !!s.hidden;
  }
}

/**
 * Checks per vertex influences, fixing what can be fixed in place. Returns a problem or null.
 * A vertex without usable influences follows the root (the same fallback `compileSkeleton` applies).
 */
function repairWeights(
  weights: Influence[][],
  label: string,
  boneIds: Set<Id>,
  rootId: Id,
  fixed: (message: string) => void,
): string | null {
  for (let i = 0; i < weights.length; i++) {
    const list = weights[i];
    if (!Array.isArray(list)) return 'invalid weights';
    const kept = list.filter(
      (inf) => Array.isArray(inf) && boneIds.has(inf[0]) && finite(inf[1]) && finite(inf[2]) && finite(inf[3]) && inf[3] > 0,
    );
    const sum = kept.reduce((s, inf) => s + inf[3], 0);
    if (kept.length === 0) {
      weights[i] = [[rootId, 0, 0, 1]];
      fixed(`${label}: vertex ${i} had no influences`);
    } else if (kept.length !== list.length || Math.abs(sum - 1) > 1e-6) {
      weights[i] = kept.map((inf) => [inf[0], inf[1], inf[2], inf[3] / sum] as typeof inf);
      fixed(`${label}: vertex ${i} had invalid or unnormalized influences`);
    }
  }
  return null;
}

/** Why an attachment cannot be used (null = fine). Fixes what can be fixed in place and reports it through `fixed`. */
function attachmentProblem(
  att: Attachment,
  boneIds: Set<Id>,
  slotIds: Set<Id>,
  rootId: Id,
  fixed: (message: string) => void,
): string | null {
  if (att && att.type === 'point') {
    if (!isString(att.name)) return 'missing name';
    if (!validColor(att.color, 4)) att.color = [...DEFAULT_POINT_COLOR];
    for (const k of ['x', 'y', 'rotation'] as const) if (!finite(att[k])) return `${k} is not a number`;
    return null;
  }
  if (att && att.type === 'path') {
    if (!isString(att.name)) return 'missing name';
    if (!validColor(att.color, 4)) att.color = [...DEFAULT_PATH_COLOR];
    att.closed = !!att.closed;
    att.constantSpeed = !!att.constantSpeed;
    // three points per node (in-handle, anchor, out-handle); a path needs at least two nodes
    if (!att.weights) {
      att.weights = null;
      if (!Array.isArray(att.vertices) || att.vertices.length % 6 !== 0 || !att.vertices.every(finite)) return 'invalid vertices';
      if (att.vertices.length < 12) return 'a path needs at least 2 nodes';
      return null;
    }
    if (!Array.isArray(att.weights) || att.weights.length % 3 !== 0 || att.weights.length < 6) return 'a path needs at least 2 nodes';
    att.vertices = [];
    return repairWeights(att.weights, `path "${att.name}"`, boneIds, rootId, fixed);
  }
  if (att && (att.type === 'clipping' || att.type === 'boundingbox')) {
    if (!isString(att.name)) return 'missing name';
    if (!validColor(att.color, 4)) att.color = [...(att.type === 'clipping' ? DEFAULT_CLIPPING_COLOR : DEFAULT_BOUNDING_BOX_COLOR)];
    if (att.type === 'clipping') {
      att.convex = !!att.convex;
      att.inverse = !!att.inverse;
      if (att.end != null && (!isString(att.end) || !slotIds.has(att.end))) {
        att.end = null;
        fixed(`clipping "${att.name}": its end slot does not exist`);
      }
      if (att.end === undefined) att.end = null;
    }
    if (!att.weights) {
      att.weights = null;
      if (!Array.isArray(att.vertices) || att.vertices.length % 2 !== 0 || !att.vertices.every(finite)) return 'invalid vertices';
      if (att.vertices.length < 6) return 'a polygon needs at least 3 vertices';
      return null;
    }
    if (!Array.isArray(att.weights) || att.weights.length < 3) return 'a polygon needs at least 3 vertices';
    att.vertices = [];
    return repairWeights(att.weights, `${att.type} "${att.name}"`, boneIds, rootId, fixed);
  }
  if (!att || (att.type !== 'region' && att.type !== 'mesh')) return 'unknown type';
  if (!isString(att.name) || !isString(att.path)) return 'missing name or path';
  if (!validColor(att.color, 4)) att.color = [1, 1, 1, 1];
  if (att.sequence !== undefined) {
    const cleaned = cleanSequence(att.sequence);
    const old = att.sequence as Partial<typeof cleaned> | null;
    if (
      !old ||
      typeof old !== 'object' ||
      old.count !== cleaned.count ||
      old.start !== cleaned.start ||
      old.digits !== cleaned.digits ||
      old.setupIndex !== cleaned.setupIndex
    )
      fixed(`${att.type} "${att.name}": its sequence was repaired`);
    att.sequence = cleaned;
  }
  if (att.type === 'region') {
    for (const k of ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'width', 'height'] as const)
      if (!finite(att[k])) return `${k} is not a number`;
    return null;
  }
  if (att.link !== undefined) {
    const l = att.link as Partial<NonNullable<typeof att.link>> | null;
    if (
      !l ||
      typeof l !== 'object' ||
      !isString(l.source) ||
      !(l.slot === null || isString(l.slot)) ||
      !(l.skin === null || isString(l.skin))
    ) {
      delete att.link;
      fixed(`mesh "${att.name}": its link to a source mesh was not valid and was removed`);
    } else att.link.deform = l.deform !== false;
  }
  if (!finite(att.width) || !finite(att.height)) return 'size is not a number';
  const n = att.uvs.length / 2;
  if (!Number.isInteger(n) || n < 3 || !att.uvs.every(finite)) return 'invalid uvs';
  if (att.triangles.length % 3 !== 0 || att.triangles.some((i) => !Number.isInteger(i) || i < 0 || i >= n)) return 'invalid triangles';
  if (!Number.isInteger(att.hull) || att.hull < 3 || att.hull > n) return 'invalid hull';
  att.edges ??= [];
  if (!att.weights) {
    if (att.vertices.length !== att.uvs.length || !att.vertices.every(finite)) return 'vertex count does not match uvs';
    return null;
  }
  if (att.weights.length !== n) return 'weights do not match uvs';
  att.vertices = [];
  return repairWeights(att.weights, `mesh "${att.name}"`, boneIds, rootId, fixed);
}

function repairSkins(doc: SkeletonDoc, note: Note) {
  if (!doc.skins.length) {
    doc.skins.push(newSkin('default'));
    note('the skeleton had no default skin');
  }
  dedupeIds(doc.skins, 'skin', note);
  dedupeNames(doc.skins, 'skin', 'skin', note);
  const slotIds = new Set(doc.slots.map((s) => s.id));
  const boneIds = new Set(doc.bones.map((b) => b.id));
  for (const skin of doc.skins) {
    skin.bones = (skin.bones ?? []).filter((id) => boneIds.has(id));
    skin.attachments ??= {};
    for (const slotId of Object.keys(skin.attachments)) {
      const perSlot = skin.attachments[slotId];
      if (!slotIds.has(slotId) || !perSlot || typeof perSlot !== 'object') {
        delete skin.attachments[slotId];
        note(`skin "${skin.name}": attachments of a missing slot removed`);
        continue;
      }
      for (const name of Object.keys(perSlot)) {
        const problem = attachmentProblem(perSlot[name], boneIds, slotIds, doc.bones[0].id, note);
        if (problem) {
          delete perSlot[name];
          note(`skin "${skin.name}": attachment "${name}" removed (${problem})`);
        }
      }
    }
  }
  // a linked mesh has the shape of its source; one whose source is gone keeps its own copy
  const synced = syncLinkedMeshes(doc);
  if (synced) note(`linked meshes were brought in line with their source (${synced})`);
}

function repairConstraints(doc: SkeletonDoc, note: Note) {
  dedupeIds(doc.constraints, 'constraint', note);
  const boneById = new Map(doc.bones.map((b) => [b.id, b] as const));
  const slotIds = new Set(doc.slots.map((s) => s.id));
  const keep = doc.constraints.filter((c) => {
    const problem = constraintProblem(c, boneById, slotIds);
    if (problem) note(`constraint "${c.name}" removed (${problem})`);
    else if (c.type === 'physics') repairPhysics(c, note);
    return !problem;
  });
  if (keep.length !== doc.constraints.length) doc.constraints = keep;
  dedupeNames(doc.constraints, 'constraint', 'constraint', note);
}

/** Values the simulation cannot run with (a step of 0 seconds, a negative mass or damping) are put back to something it can. */
function repairPhysics(c: Extract<SkeletonDoc['constraints'][number], { type: 'physics' }>, note: Note) {
  const fix = (what: string, ok: boolean, set: () => void) => {
    if (ok) return;
    set();
    note(`constraint "${c.name}": invalid ${what} reset`);
  };
  fix('fps', c.fps > 0, () => (c.fps = 60));
  fix('mass', c.mass > 0, () => (c.mass = 1));
  fix('damping', c.damping >= 0 && c.damping <= 1, () => (c.damping = Math.min(1, Math.max(0, c.damping))));
  fix('limit', c.limit >= 0, () => (c.limit = 5000));
  if (!c.global || typeof c.global !== 'object')
    c.global = { inertia: false, strength: false, damping: false, mass: false, wind: false, gravity: false, mix: false };
  for (const p of PHYSICS_PARAMS) c.global[p] = c.global[p] === true;
}

function constraintProblem(
  c: SkeletonDoc['constraints'][number],
  boneById: Map<Id, SkeletonDoc['bones'][number]>,
  slotIds: Set<Id>,
): string | null {
  if (!c || (c.type !== 'ik' && c.type !== 'transform' && c.type !== 'slider' && c.type !== 'path' && c.type !== 'physics'))
    return 'unknown type';
  if (c.type === 'physics') {
    if (!boneById.has(c.bone)) return 'bone does not exist';
    if (c.scaleY !== 'none' && c.scaleY !== 'uniform' && c.scaleY !== 'volume') return 'unknown mode';
    if (
      ![c.x, c.y, c.rotate, c.scaleX, c.shearX, c.limit, c.fps, c.inertia, c.strength, c.damping, c.mass, c.wind, c.gravity, c.mix].every(
        finite,
      )
    )
      return 'a value is not a number';
    return null;
  }
  if (c.type === 'slider') {
    if (c.bone !== null && !boneById.has(c.bone)) return 'driver bone does not exist';
    if (!TRANSFORM_PROPS.includes(c.property)) return 'unknown property';
    if (![c.mix, c.time, c.from, c.to, c.scale, c.max].every(finite)) return 'a value is not a number';
    return null;
  }
  if (c.type === 'path') {
    if (!Array.isArray(c.bones) || c.bones.length === 0 || c.bones.some((id) => !boneById.has(id))) return 'bone does not exist';
    if (!slotIds.has(c.target)) return 'target slot does not exist';
    if (
      !PATH_POSITION_MODES.includes(c.positionMode) ||
      !PATH_SPACING_MODES.includes(c.spacingMode) ||
      !PATH_ROTATE_MODES.includes(c.rotateMode)
    )
      return 'unknown mode';
    if (![c.offsetRotation, c.position, c.spacing].every(finite) || !c.mix || ![c.mix.rotate, c.mix.x, c.mix.y].every(finite))
      return 'a value is not a number';
    return null;
  }
  if (!Array.isArray(c.bones) || c.bones.length === 0 || c.bones.some((id) => !boneById.has(id))) return 'bone does not exist';
  if (c.type === 'ik') {
    if (!boneById.has(c.target)) return 'target does not exist';
    if (c.bones.length > 2) return 'more than two bones';
    if (!boneById.get(c.bones[0])!.parent) return 'the root bone cannot be constrained by IK (the official runtimes crash on it)';
    if (c.bones.length === 2 && boneById.get(c.bones[1])!.parent !== c.bones[0]) return 'the second bone is not a child of the first';
    if (!finite(c.mix) || !finite(c.softness)) return 'mix or softness is not a number';
    return null;
  }
  if (!boneById.has(c.source)) return 'source does not exist';
  if (!Array.isArray(c.properties)) return 'no properties';
  for (const f of c.properties) {
    if (!TRANSFORM_PROPS.includes(f.prop) || !finite(f.offset) || !Array.isArray(f.to)) return 'invalid property';
    for (const t of f.to)
      if (!TRANSFORM_PROPS.includes(t.prop) || !finite(t.offset) || !finite(t.max) || !finite(t.scale)) return 'invalid mapped property';
  }
  if (!c.offsets || !c.mix || Object.values(c.offsets).some((v) => !finite(v)) || Object.values(c.mix).some((v) => !finite(v)))
    return 'offsets or mix is not a number';
  return null;
}

function repairEvents(doc: SkeletonDoc, note: Note) {
  dedupeIds(doc.events, 'event', note);
  dedupeNames(doc.events, 'event', 'event', note);
  for (const e of doc.events) {
    if (!finite(e.int)) e.int = 0;
    if (!finite(e.float)) e.float = 0;
    if (!isString(e.string)) e.string = '';
    if (e.audio !== undefined && (!isString(e.audio) || !e.audio)) {
      delete e.audio;
      delete e.volume;
      delete e.balance;
      note(`event "${e.name}": its sound was not a path and was removed`);
    }
    if (e.audio === undefined) {
      delete e.volume;
      delete e.balance;
    } else {
      if (e.volume !== undefined && (!finite(e.volume) || e.volume < 0 || e.volume > 1))
        e.volume = finite(e.volume) ? Math.min(1, Math.max(0, e.volume)) : 1;
      if (e.balance !== undefined && (!finite(e.balance) || e.balance < -1 || e.balance > 1))
        e.balance = finite(e.balance) ? Math.min(1, Math.max(-1, e.balance)) : 0;
    }
  }
}

interface KeyLike {
  time: number;
  value?: number[];
  curve?: unknown;
}

/**
 * Drops invalid keys, sorts by time, merges keys at the same time (the later one wins) and removes malformed curves.
 * `channels` = required length of `value` ('any' = not checked). Returns true when anything changed.
 */
function cleanKeys<K extends KeyLike>(keys: K[], channels: number | 'any', curveChannels: number): boolean {
  const before = keys.slice();
  let changed = false;
  const valid = keys.filter((k) => {
    if (!k || !finite(k.time) || k.time < 0) return false;
    if (channels === 'any') return true;
    return Array.isArray(k.value) && k.value.length === channels && k.value.every(finite);
  });
  valid.sort((a, b) => a.time - b.time);
  const merged: K[] = [];
  for (const k of valid) {
    if (merged.length && Math.abs(merged[merged.length - 1].time - k.time) <= KEY_EPS) merged[merged.length - 1] = k;
    else merged.push(k);
  }
  for (const k of merged) {
    const c = k.curve;
    if (c === undefined || c === 'stepped') continue;
    if (!Array.isArray(c) || c.length !== curveChannels * 4 || !c.every(finite)) {
      delete k.curve;
      changed = true;
    }
  }
  if (changed || merged.length !== before.length || merged.some((k, i) => k !== before[i])) {
    keys.splice(0, keys.length, ...merged);
    return true;
  }
  return false;
}

function repairAnimations(doc: SkeletonDoc, note: Note) {
  dedupeIds(doc.animations, 'animation', note);
  dedupeNames(doc.animations, 'animation', 'animation', note);
  const boneIds = new Set(doc.bones.map((b) => b.id));
  const slotIds = new Set(doc.slots.map((s) => s.id));
  const eventIds = new Set(doc.events.map((e) => e.id));
  const constraints = new Map(doc.constraints.map((c) => [c.id, c] as const));
  const skins = new Map(doc.skins.map((s) => [s.id, s] as const));

  for (const a of doc.animations) {
    const where = `animation "${a.name}"`;
    a.bones ??= {};
    a.slots ??= {};
    a.ik ??= {};
    a.transform ??= {};
    a.slider ??= {};
    a.path ??= {};
    a.physics ??= {};
    a.deform ??= {};
    a.drawOrder ??= [];
    a.events ??= [];
    if (a.markers !== undefined) {
      const clean = cleanMarkers(a.markers, a.duration);
      if (JSON.stringify(clean) !== JSON.stringify(a.markers)) note(`${where}: markers repaired`);
      if (clean.length) a.markers = clean;
      else delete a.markers;
    }
    if (a.play !== undefined) {
      const clean = cleanPlay(a.play, a.duration);
      if (JSON.stringify(clean) !== JSON.stringify(a.play)) note(`${where}: playback settings repaired`);
      a.play = clean;
    }

    for (const id of Object.keys(a.bones)) {
      const tl = a.bones[id];
      if (!boneIds.has(id) || !tl || typeof tl !== 'object') {
        delete a.bones[id];
        note(`${where}: timelines of a missing bone removed`);
        continue;
      }
      const spec = {
        rotate: 1,
        translate: 2,
        translatex: 1,
        translatey: 1,
        scale: 2,
        scalex: 1,
        scaley: 1,
        shear: 2,
        shearx: 1,
        sheary: 1,
      } as const;
      for (const prop of Object.keys(tl) as (keyof typeof spec)[]) {
        const keys = tl[prop];
        if (!(prop in spec) || !Array.isArray(keys)) {
          delete tl[prop];
          note(`${where}: invalid bone timeline removed`);
        } else if (cleanKeys(keys, spec[prop], spec[prop])) note(`${where}: bone ${prop} keys repaired`);
      }
    }

    for (const id of Object.keys(a.slots)) {
      const tl = a.slots[id];
      if (!slotIds.has(id) || !tl || typeof tl !== 'object') {
        delete a.slots[id];
        note(`${where}: timelines of a missing slot removed`);
        continue;
      }
      if (tl.attachment) {
        if (!Array.isArray(tl.attachment)) delete tl.attachment;
        else {
          for (const k of tl.attachment) if (k && k.name !== null && !isString(k.name)) k.name = null;
          if (cleanKeys(tl.attachment, 'any', 0)) note(`${where}: attachment keys repaired`);
        }
      }
      if (tl.rgba) {
        if (!Array.isArray(tl.rgba)) delete tl.rgba;
        else if (cleanKeys(tl.rgba, 4, 4)) note(`${where}: color keys repaired`);
      }
      if (tl.rgba2) {
        if (!Array.isArray(tl.rgba2)) delete tl.rgba2;
        else if (cleanKeys(tl.rgba2, 7, 7)) note(`${where}: two-color keys repaired`);
      }
      if (tl.rgba2 && tl.rgba) {
        delete tl.rgba; // a slot is keyed either with rgba or with rgba2
        note(`${where}: color keys next to two-color keys removed`);
      }
      if (tl.rgba2?.length) {
        const slot = doc.slots.find((s) => s.id === id);
        if (slot && !slot.dark) {
          slot.dark = [0, 0, 0]; // the runtime needs the setup dark color of a slot with two-color keys
          note(`${where}: slot "${slot.name}" got a dark color for its two-color keys`);
        }
      }
    }

    for (const id of Object.keys(a.ik)) {
      const c = constraints.get(id);
      if (!c || c.type !== 'ik' || !Array.isArray(a.ik[id])) {
        delete a.ik[id];
        note(`${where}: IK timeline of a missing constraint removed`);
        continue;
      }
      for (const k of a.ik[id]) {
        if (!k) continue;
        k.bendPositive = !!k.bendPositive;
        k.compress = !!k.compress;
        k.stretch = !!k.stretch;
      }
      if (cleanKeys(a.ik[id], 2, 2)) note(`${where}: IK keys repaired`);
    }

    for (const id of Object.keys(a.transform)) {
      const c = constraints.get(id);
      if (!c || c.type !== 'transform' || !Array.isArray(a.transform[id])) {
        delete a.transform[id];
        note(`${where}: transform timeline of a missing constraint removed`);
        continue;
      }
      if (cleanKeys(a.transform[id], 6, 6)) note(`${where}: transform mix keys repaired`);
    }

    for (const id of Object.keys(a.slider)) {
      const c = constraints.get(id);
      const tl = a.slider[id];
      if (!c || c.type !== 'slider' || !tl || typeof tl !== 'object') {
        delete a.slider[id];
        note(`${where}: slider timeline of a missing slider removed`);
        continue;
      }
      for (const prop of ['time', 'mix'] as const) {
        const keys = tl[prop];
        if (keys === undefined) continue;
        if (!Array.isArray(keys)) delete tl[prop];
        else if (cleanKeys(keys, 1, 1)) note(`${where}: slider ${prop} keys repaired`);
      }
    }

    for (const id of Object.keys(a.path)) {
      const c = constraints.get(id);
      const tl = a.path[id];
      if (!c || c.type !== 'path' || !tl || typeof tl !== 'object') {
        delete a.path[id];
        note(`${where}: path timeline of a missing constraint removed`);
        continue;
      }
      const spec = { position: 1, spacing: 1, mix: 3 } as const;
      for (const prop of Object.keys(tl) as (keyof typeof spec)[]) {
        const keys = tl[prop];
        if (!(prop in spec) || !Array.isArray(keys)) {
          delete tl[prop];
          note(`${where}: invalid path timeline removed`);
        } else if (cleanKeys(keys, spec[prop], spec[prop])) note(`${where}: path ${prop} keys repaired`);
      }
    }

    for (const id of Object.keys(a.physics)) {
      const c = constraints.get(id);
      const tl = a.physics[id];
      if ((id !== GLOBAL_PHYSICS && (!c || c.type !== 'physics')) || !tl || typeof tl !== 'object') {
        delete a.physics[id];
        note(`${where}: physics timeline of a missing constraint removed`);
        continue;
      }
      for (const prop of Object.keys(tl) as (keyof typeof tl)[]) {
        const keys = tl[prop];
        if (!(prop === 'reset' || (PHYSICS_PARAMS as string[]).includes(prop)) || !Array.isArray(keys)) {
          delete tl[prop];
          note(`${where}: invalid physics timeline removed`);
          continue;
        }
        if (cleanKeys(keys, 1, 1)) note(`${where}: physics ${prop} keys repaired`);
        // the simulation divides by the mass and raises the damping to a power
        if (prop === 'mass') for (const k of keys) k.value[0] = Math.max(k.value[0], 1e-4);
        if (prop === 'damping') for (const k of keys) k.value[0] = Math.min(1, Math.max(k.value[0], 0));
      }
    }

    repairDeform(doc, a, skins, boneIds, note, where);
    repairSequences(a, skins, note, where);

    for (const k of a.drawOrder) {
      const seen = new Set<Id>();
      k.order = (Array.isArray(k.order) ? k.order : []).filter((id) => slotIds.has(id) && !seen.has(id) && !!seen.add(id));
    }
    if (cleanKeys(a.drawOrder, 'any', 0)) note(`${where}: draw order keys repaired`);
    if (a.drawOrderFolder !== undefined) {
      const folderIds = new Map((doc.drawOrderFolders ?? []).map((f) => [f.id, new Set(f.slots)] as const));
      if (!a.drawOrderFolder || typeof a.drawOrderFolder !== 'object') a.drawOrderFolder = {};
      for (const id of Object.keys(a.drawOrderFolder)) {
        const members = folderIds.get(id);
        const keys = a.drawOrderFolder[id];
        if (!members || !Array.isArray(keys)) {
          delete a.drawOrderFolder[id];
          note(`${where}: keys of a missing draw order folder removed`);
          continue;
        }
        for (const k of keys) {
          const seen = new Set<Id>();
          k.order = (Array.isArray(k.order) ? k.order : []).filter((s) => members.has(s) && !seen.has(s) && !!seen.add(s));
        }
        if (cleanKeys(keys, 'any', 0)) note(`${where}: draw order folder keys repaired`);
        if (!keys.length) delete a.drawOrderFolder[id];
      }
      if (!Object.keys(a.drawOrderFolder).length) delete a.drawOrderFolder;
    }

    const before = a.events.length;
    a.events = a.events.filter((k) => eventIds.has(k.event));
    if (a.events.length !== before) note(`${where}: keys of a missing event removed`);
    // event keys may share a time (two events fire together), so they are only validated and sorted
    a.events = a.events.filter((k) => finite(k.time) && k.time >= 0);
    a.events.sort((x, y) => x.time - y.time);

    // an explicit duration may exceed the last key, never fall short of it (the export derives the length from the keys)
    const end = animationEndTime(a);
    if (!finite(a.duration) || a.duration <= 0 || a.duration < end - 1e-6) {
      a.duration = Math.max(end, 1 / doc.fps);
      note(`${where}: duration was shorter than its last key`);
    }
  }
}

/** Sequence keys: only for a region or mesh that has a sequence, sorted, one key per time, every field a valid value. */
function repairSequences(a: Animation, skins: Map<Id, SkeletonDoc['skins'][number]>, note: Note, where: string) {
  if (a.sequence === undefined) return;
  if (!a.sequence || typeof a.sequence !== 'object') {
    delete a.sequence;
    note(`${where}: invalid sequence timelines removed`);
    return;
  }
  for (const skinId of Object.keys(a.sequence)) {
    const skin = skins.get(skinId);
    const perSkin = a.sequence[skinId];
    if (!skin || !perSkin || typeof perSkin !== 'object') {
      delete a.sequence[skinId];
      note(`${where}: sequence timelines of a missing skin removed`);
      continue;
    }
    for (const slotId of Object.keys(perSkin)) {
      const perSlot = perSkin[slotId];
      for (const name of Object.keys(perSlot ?? {})) {
        const att = skin.attachments[slotId]?.[name] as Attachment | undefined;
        const keys = perSlot[name];
        if (!att || (att.type !== 'region' && att.type !== 'mesh') || !att.sequence || !Array.isArray(keys)) {
          delete perSlot[name];
          note(`${where}: sequence timeline of "${name}" removed (it has no sequence)`);
          continue;
        }
        const cleaned = keys.filter((k) => k && typeof k === 'object' && finite(k.time) && k.time >= 0).map((k) => cleanSequenceKey(k));
        cleaned.sort((x, y) => x.time - y.time);
        const unique = cleaned.filter((k, i) => i === cleaned.length - 1 || Math.abs(cleaned[i + 1].time - k.time) > 1e-6);
        const same =
          unique.length === keys.length &&
          unique.every(
            (k, i) => k.time === keys[i].time && k.mode === keys[i].mode && k.index === keys[i].index && k.delay === keys[i].delay,
          );
        if (!same) note(`${where}: sequence keys of "${name}" repaired`);
        if (!same) perSlot[name] = unique;
        if (unique.length === 0) delete perSlot[name];
      }
      if (!perSlot || Object.keys(perSlot).length === 0) delete perSkin[slotId];
    }
    if (Object.keys(perSkin).length === 0) delete a.sequence[skinId];
  }
  if (Object.keys(a.sequence).length === 0) delete a.sequence;
}

function repairDeform(
  doc: SkeletonDoc,
  a: Animation,
  skins: Map<Id, SkeletonDoc['skins'][number]>,
  boneIds: Set<Id>,
  note: Note,
  where: string,
) {
  const has = (id: Id) => boneIds.has(id);
  for (const skinId of Object.keys(a.deform)) {
    const skin = skins.get(skinId);
    const perSkin = a.deform[skinId];
    if (!skin || !perSkin || typeof perSkin !== 'object') {
      delete a.deform[skinId];
      note(`${where}: deform timelines of a missing skin removed`);
      continue;
    }
    for (const slotId of Object.keys(perSkin)) {
      const perSlot = perSkin[slotId];
      for (const att of Object.keys(perSlot ?? {})) {
        const mesh = skin.attachments[slotId]?.[att] as Attachment | undefined;
        const keys = perSlot[att];
        if (!mesh || (mesh.type !== 'mesh' && mesh.type !== 'path') || !Array.isArray(keys)) {
          delete perSlot[att];
          note(`${where}: deform timeline of a missing mesh "${att}" removed`);
          continue;
        }
        const expected = deformLength(mesh, has);
        if (keys.some((k) => !k || !Array.isArray(k.value) || k.value.length !== expected || !k.value.every(finite))) {
          delete perSlot[att];
          note(`${where}: deform keys of "${att}" no longer match the mesh and were removed`);
          continue;
        }
        if (cleanKeys(keys, 'any', 1)) note(`${where}: deform keys of "${att}" repaired`);
      }
      if (!perSlot || Object.keys(perSlot).length === 0) delete perSkin[slotId];
    }
    if (Object.keys(perSkin).length === 0) delete a.deform[skinId];
  }
}
