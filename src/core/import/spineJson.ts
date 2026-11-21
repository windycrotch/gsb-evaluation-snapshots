/**
 * Spine 4.3 JSON -> Bone 2D project. The structure follows what the official 4.3 `SkeletonJson` reads, so files exported
 * by Spine itself (and by Bone 2D) open. Things Bone 2D has no model for — physics constraints, sequences, draw order
 * folders — are skipped and reported in `warnings`.
 * Images are not part of the JSON: attachments keep their region `path`; pixels come from an atlas (see atlas.ts).
 */
import { animationEndTime } from '../animate';
import { curveFromAbsolute, sampleKeys } from '../curve';
import { uid, uniqueName } from '../ids';
import { deformLength } from '../mesh';
import { attachmentPictures, cleanSequence, cleanSequenceKey, sequenceFrameNames } from '../sequence';
import { isLegacySpineJson, upgradeLegacySpineJson } from './legacy';
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
  emptyProject,
  newAnimation,
  newBone,
  newPhysicsConstraint,
  newSkin,
  newSlot,
} from '../model';
import type {
  Animation,
  Attachment,
  BlendMode,
  Bone,
  Constraint,
  Curve,
  EventDef,
  Id,
  Influence,
  Key,
  MeshAttachment,
  PathTimelines,
  PhysicsTimelines,
  Project,
  RGB,
  RGBA,
  SequenceDef,
  SequenceMode,
  SkeletonDoc,
  Timeline,
  TransformFrom,
  TransformProp,
} from '../model';

type J = Record<string, any>;

export interface SpineImportResult {
  project: Project;
  /** Things that could not be imported or were approximated. */
  warnings: string[];
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
const obj = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
/** An enum value as the official loader reads it (first letter case does not matter), or the default. */
const oneOf = <T extends string>(v: unknown, list: readonly T[], def: T): T => {
  if (typeof v !== 'string' || !v) return def;
  const norm = v[0].toLowerCase() + v.slice(1);
  return (list as readonly string[]).includes(norm) ? (norm as T) : def;
};

function hexByte(h: string, i: number): number {
  const v = parseInt(h.substr(i * 2, 2), 16);
  return Number.isFinite(v) ? v / 255 : 1;
}
function rgba(hex: unknown, def: RGBA): RGBA {
  if (typeof hex !== 'string' || hex.length < 6) return [...def] as RGBA;
  return [hexByte(hex, 0), hexByte(hex, 1), hexByte(hex, 2), hex.length >= 8 ? hexByte(hex, 3) : 1];
}
function rgb(hex: unknown): RGB | null {
  if (typeof hex !== 'string' || hex.length < 6) return null;
  return [hexByte(hex, 0), hexByte(hex, 1), hexByte(hex, 2)];
}

/** Normalized bezier / stepped / linear interpolation of the key `i` of a timeline, from Spine's absolute control points. */
function curveOf(map: J, next: J | undefined, channels: number, valueOf: (k: J) => number[], progress = false): Curve | undefined {
  const c = map.curve;
  if (!next) return undefined;
  if (c === 'stepped') return 'stepped';
  if (!Array.isArray(c) || c.length < 4) return undefined;
  const v1 = valueOf(map);
  const v2 = valueOf(next);
  const t1 = num(map.time, 0);
  const t2 = num(next.time, 0);
  const out: number[] = [];
  for (let ch = 0; ch < channels; ch++) {
    const part = c.slice(ch * 4, ch * 4 + 4);
    if (part.length < 4 || !part.every((x: unknown) => typeof x === 'number')) out.push(1 / 3, 1 / 3, 2 / 3, 2 / 3);
    // deform curves are stored in "progress" space (0..1): only the time axis is relative to the segment
    else if (progress) out.push(t2 !== t1 ? (part[0] - t1) / (t2 - t1) : 0, part[1], t2 !== t1 ? (part[2] - t1) / (t2 - t1) : 1, part[3]);
    else out.push(...curveFromAbsolute(part, t1, v1[ch], t2, v2[ch]));
  }
  return out;
}

function timeline(keys: unknown, channels: number, valueOf: (k: J) => number[], progress = false): Timeline {
  const list = arr(keys).map(obj);
  const out: Timeline = [];
  list.forEach((k, i) => {
    const key: Key = { time: num(k.time, 0), value: valueOf(k) };
    const curve = curveOf(k, list[i + 1], channels, valueOf, progress);
    if (curve !== undefined) key.curve = curve;
    out.push(key);
  });
  return out;
}

/** A 6-channel key (light rgb + dark rgb) as a 7-channel one with a constant alpha in the fourth channel. */
function withAlphaChannel(k: Key, alpha: number): Key {
  const v = k.value;
  const out: Key = { time: k.time, value: [v[0], v[1], v[2], alpha, v[3], v[4], v[5]] };
  if (Array.isArray(k.curve)) out.curve = [...k.curve.slice(0, 12), 1 / 3, 1 / 3, 2 / 3, 2 / 3, ...k.curve.slice(12)];
  else if (k.curve !== undefined) out.curve = k.curve;
  return out;
}

type CurveSpec = 'linear' | 'stepped' | number[];
const LINEAR_CURVE = [1 / 3, 1 / 3, 2 / 3, 2 / 3];

/** How a timeline runs from `time` on: the curve of its own key there, or the one of the segment `time` falls inside (`inside`). */
function curveAt(keys: Timeline | null, time: number): { spec: CurveSpec; inside: boolean } {
  if (!keys?.length) return { spec: 'linear', inside: false };
  let i = -1;
  keys.forEach((k, n) => {
    if (k.time <= time + 1e-5) i = n;
  });
  if (i < 0 || i === keys.length - 1) return { spec: 'linear', inside: false };
  const own = Math.abs(keys[i].time - time) < 1e-5;
  const c = keys[i].curve;
  const spec: CurveSpec = c === 'stepped' ? 'stepped' : Array.isArray(c) ? c : 'linear';
  return { spec, inside: !own && spec !== 'linear' };
}

/**
 * Merges a colour (rgb) timeline and an alpha timeline into rgba keys: one key at every time either has a key, the other channels sampled there
 * (the setup colour for a timeline that is missing). A key that both have keeps both curves. `exact` is false when a key of one timeline falls
 * inside a curved or stepped segment of the other, or when one is stepped and the other is not (a key has one kind of curve in the editor).
 */
export function mergeRgbAlpha(rgb: Timeline | null, alpha: Timeline | null, setup: ArrayLike<number>): { keys: Timeline; exact: boolean } {
  const times: number[] = [];
  for (const k of [...(rgb ?? []), ...(alpha ?? [])]) if (!times.some((t) => Math.abs(t - k.time) < 1e-5)) times.push(k.time);
  times.sort((x, y) => x - y);
  let exact = true;
  const keys = times.map((time): Key => {
    const color = [setup[0], setup[1], setup[2]];
    const a = [setup[3]];
    if (rgb?.length) sampleKeys(rgb, time, color);
    if (alpha?.length) sampleKeys(alpha, time, a);
    const key: Key = { time, value: [color[0], color[1], color[2], a[0]] };
    const c = curveAt(rgb, time);
    const d = curveAt(alpha, time);
    if (c.inside || d.inside) exact = false;
    if (c.spec === 'stepped' && d.spec === 'stepped') {
      key.curve = 'stepped';
      return key;
    }
    if (c.spec === 'stepped' || d.spec === 'stepped') exact = false;
    const part = (s: { spec: CurveSpec; inside: boolean }, channels: number) =>
      Array.isArray(s.spec) && !s.inside ? s.spec.slice(0, channels * 4) : Array.from({ length: channels }, () => LINEAR_CURVE).flat();
    const bezier = (s: { spec: CurveSpec; inside: boolean }) => Array.isArray(s.spec) && !s.inside;
    if (bezier(c) || bezier(d)) key.curve = [...part(c, 3), ...part(d, 1)];
    return key;
  });
  return { keys, exact };
}

const single = (name: string, def: number) => (k: J) => [num(k[name] ?? (name === 'value' ? k.angle : undefined), def)];
const pair = (def: number) => (k: J) => [num(k.x, def), num(k.y, def)];

export function importSpineJson(input: unknown, name = 'imported'): SpineImportResult {
  let root = obj(input);
  if (!Array.isArray(root.bones) || root.bones.length === 0) throw new Error('Not a Spine skeleton: no bones');
  const warnings: string[] = [];
  const warn = (m: string) => {
    if (!warnings.includes(m)) warnings.push(m);
  };
  const header = obj(root.skeleton);
  const version = str(header.spine, '');
  if (isLegacySpineJson(root)) {
    // Spine 4.0 - 4.2: the constraints live in separate arrays and transform constraints have another shape
    const upgraded = upgradeLegacySpineJson(root);
    root = upgraded.root;
    warn(`Spine ${version || 'older than 4.3'} file: converted to the 4.3 structure`);
    for (const w of upgraded.warnings) warn(w);
  } else if (version && !version.startsWith('4.3')) warn(`The file was exported by Spine ${version}; only 4.3 files import faithfully`);

  const project = emptyProject(name);
  const doc: SkeletonDoc = project.skeleton;
  doc.fps = num(header.fps, 30) || 30;
  if (typeof header.referenceScale === 'number' && header.referenceScale > 0 && header.referenceScale !== 100)
    doc.referenceScale = header.referenceScale;
  doc.bones = [];
  doc.skins = [];

  const boneByName = new Map<string, Bone>();
  const boneNames = new Set<string>();
  for (const bm of root.bones.map(obj)) {
    const n = uniqueName(str(bm.name, 'bone'), boneNames);
    boneNames.add(n);
    const parent = typeof bm.parent === 'string' ? (boneByName.get(bm.parent)?.id ?? null) : null;
    if (typeof bm.parent === 'string' && !parent) warn(`bone "${n}": parent "${bm.parent}" was not defined before it`);
    // `inherit` since 4.2, `transform` before; the official loaders accept the first letter in either case ("NoScale")
    const inherit = oneOf(bm.inherit ?? bm.transform, INHERIT_MODES, 'normal');
    const b = newBone({
      name: n,
      parent,
      length: num(bm.length, 0),
      x: num(bm.x, 0),
      y: num(bm.y, 0),
      rotation: num(bm.rotation, 0),
      scaleX: num(bm.scaleX, 1),
      scaleY: num(bm.scaleY, 1),
      shearX: num(bm.shearX, 0),
      shearY: num(bm.shearY, 0),
      inherit,
      skinRequired: bool(bm.skin, false),
      color: rgba(bm.color, [0.6, 0.6, 0.6, 1]),
    });
    boneByName.set(n, b);
    doc.bones.push(b);
  }
  const boneId = (n: unknown): Id | null => (typeof n === 'string' ? (boneByName.get(n)?.id ?? null) : null);

  const slotByName = new Map<string, ReturnType<typeof newSlot>>();
  for (const sm of arr(root.slots).map(obj)) {
    const bone = boneId(sm.bone);
    if (!bone) {
      warn(`slot "${str(sm.name, '?')}" was skipped: its bone "${str(sm.bone, '?')}" does not exist`);
      continue;
    }
    const n = uniqueName(str(sm.name, 'slot'), new Set(slotByName.keys()));
    const s = newSlot({
      name: n,
      bone,
      color: rgba(sm.color, [1, 1, 1, 1]),
      dark: rgb(sm.dark),
      attachment: typeof sm.attachment === 'string' ? sm.attachment : null,
      blend: BLEND_MODES.includes(sm.blend) ? (sm.blend as BlendMode) : 'normal',
    });
    slotByName.set(n, s);
    doc.slots.push(s);
  }
  const slotId = (n: unknown): Id | null => (typeof n === 'string' ? (slotByName.get(n)?.id ?? null) : null);

  const constraintByName = new Map<string, Constraint>();
  const sliderAnimations: { id: Id; animation: string }[] = [];
  for (const cm of arr(root.constraints).map(obj)) {
    const cname = uniqueName(str(cm.name, 'constraint'), new Set(constraintByName.keys()));
    const type = str(cm.type, '');
    const skinRequired = bool(cm.skin, false);
    if (type === 'ik') {
      const bones = arr(cm.bones).map(boneId);
      const target = boneId(cm.target);
      if (!bones.length || bones.some((b) => !b) || !target) {
        warn(`IK constraint "${cname}" was skipped: a bone is missing`);
        continue;
      }
      const c: Constraint = {
        id: uid(),
        type: 'ik',
        name: cname,
        bones: bones as Id[],
        target,
        mix: num(cm.mix, 1),
        softness: num(cm.softness, 0),
        bendPositive: bool(cm.bendPositive, true),
        compress: bool(cm.compress, false),
        stretch: bool(cm.stretch, false),
        scaleY: cm.scaleY === 'uniform' || cm.scaleY === 'volume' ? cm.scaleY : 'none',
        skinRequired,
      };
      constraintByName.set(cname, c);
      doc.constraints.push(c);
    } else if (type === 'transform') {
      const bones = arr(cm.bones).map(boneId);
      const source = boneId(cm.source);
      if (!bones.length || bones.some((b) => !b) || !source) {
        warn(`transform constraint "${cname}" was skipped: a bone is missing`);
        continue;
      }
      const used = new Set<TransformProp>();
      const properties: TransformFrom[] = [];
      for (const [fromName, fromEntry] of Object.entries(obj(cm.properties))) {
        if (!TRANSFORM_PROPS.includes(fromName as TransformProp)) continue;
        const to = Object.entries(obj(obj(fromEntry).to))
          .filter(([toName]) => TRANSFORM_PROPS.includes(toName as TransformProp))
          .map(([toName, te]) => {
            used.add(toName as TransformProp);
            return {
              prop: toName as TransformProp,
              offset: num(obj(te).offset, 0),
              max: num(obj(te).max, 1),
              scale: num(obj(te).scale, 1),
            };
          });
        if (to.length) properties.push({ prop: fromName as TransformProp, offset: num(obj(fromEntry).offset, 0), to });
      }
      const mixX = used.has('x') ? num(cm.mixX, 1) : 1;
      const mixScaleX = used.has('scaleX') ? num(cm.mixScaleX, 1) : 1;
      const c: Constraint = {
        id: uid(),
        type: 'transform',
        name: cname,
        bones: bones as Id[],
        source,
        localSource: bool(cm.localSource, false),
        localTarget: bool(cm.localTarget, false),
        additive: bool(cm.additive, false),
        clamp: bool(cm.clamp, false),
        properties,
        offsets: {
          rotation: num(cm.rotation, 0),
          x: num(cm.x, 0),
          y: num(cm.y, 0),
          scaleX: num(cm.scaleX, 0),
          scaleY: num(cm.scaleY, 0),
          shearY: num(cm.shearY, 0),
        },
        mix: {
          rotate: used.has('rotate') ? num(cm.mixRotate, 1) : 1,
          x: mixX,
          y: used.has('y') ? num(cm.mixY, mixX) : 1,
          scaleX: mixScaleX,
          scaleY: used.has('scaleY') ? num(cm.mixScaleY, mixScaleX) : 1,
          shearY: used.has('shearY') ? num(cm.mixShearY, 1) : 1,
        },
        skinRequired,
      };
      constraintByName.set(cname, c);
      doc.constraints.push(c);
    } else if (type === 'slider') {
      const driver = typeof cm.bone === 'string' ? boneId(cm.bone) : null;
      if (typeof cm.bone === 'string' && !driver) {
        warn(`slider "${cname}" was skipped: its bone "${cm.bone}" does not exist`);
        continue;
      }
      const property: TransformProp = TRANSFORM_PROPS.includes(cm.property) ? cm.property : 'rotate';
      const c: Constraint = {
        id: uid(),
        type: 'slider',
        name: cname,
        animation: null,
        additive: bool(cm.additive, false),
        loop: bool(cm.loop, false),
        mix: num(cm.mix, 1),
        time: driver ? 0 : num(cm.time, 0),
        bone: driver,
        property,
        from: num(cm.from, 0),
        to: num(cm.to, 0),
        scale: num(cm.scale, 1),
        max: num(cm.max, 0),
        local: bool(cm.local, false),
        skinRequired,
      };
      if (typeof cm.animation === 'string') sliderAnimations.push({ id: c.id, animation: cm.animation });
      constraintByName.set(cname, c);
      doc.constraints.push(c);
    } else if (type === 'path') {
      const bones = arr(cm.bones).map(boneId);
      const slot = slotId(cm.slot);
      if (!bones.length || bones.some((b) => !b) || !slot) {
        warn(`path constraint "${cname}" was skipped: a bone or its slot is missing`);
        continue;
      }
      const mixX = num(cm.mixX, 1);
      const c: Constraint = {
        id: uid(),
        type: 'path',
        name: cname,
        bones: bones as Id[],
        target: slot,
        positionMode: oneOf(cm.positionMode, PATH_POSITION_MODES, 'percent'),
        spacingMode: oneOf(cm.spacingMode, PATH_SPACING_MODES, 'length'),
        rotateMode: oneOf(cm.rotateMode, PATH_ROTATE_MODES, 'tangent'),
        offsetRotation: num(cm.rotation, 0),
        position: num(cm.position, 0),
        spacing: num(cm.spacing, 0),
        mix: { rotate: num(cm.mixRotate, 1), x: mixX, y: num(cm.mixY, mixX) },
        skinRequired,
      };
      constraintByName.set(cname, c);
      doc.constraints.push(c);
    } else if (type === 'physics') {
      const bone = boneId(cm.bone);
      if (!bone) {
        warn(`physics constraint "${cname}" was skipped: its bone "${str(cm.bone, '?')}" does not exist`);
        continue;
      }
      const fps = num(cm.fps, 60);
      const mass = num(cm.mass, 1);
      const c: Constraint = newPhysicsConstraint({
        name: cname,
        bone,
        x: num(cm.x, 0),
        y: num(cm.y, 0),
        rotate: num(cm.rotate, 0),
        scaleX: num(cm.scaleX, 0),
        shearX: num(cm.shearX, 0),
        scaleY: cm.scaleY === 'uniform' || cm.scaleY === 'volume' ? cm.scaleY : 'none',
        limit: num(cm.limit, 5000),
        fps: fps > 0 ? fps : 60,
        inertia: num(cm.inertia, 0.5),
        strength: num(cm.strength, 100),
        damping: Math.max(0, num(cm.damping, 0.85)),
        mass: mass > 0 ? mass : 1,
        wind: num(cm.wind, 0),
        gravity: num(cm.gravity, 0),
        mix: num(cm.mix, 1),
        global: Object.fromEntries(PHYSICS_PARAMS.map((p) => [p, bool(cm[`${p}Global`], false)])) as Record<
          (typeof PHYSICS_PARAMS)[number],
          boolean
        >,
        skinRequired,
      });
      constraintByName.set(cname, c);
      doc.constraints.push(c);
    } else {
      warn(`${type || 'unknown'} constraint "${cname}" is not supported by Bone 2D and was skipped`);
    }
  }

  const skinList = arr(root.skins).map(obj);
  if (!skinList.some((s) => s.name === 'default')) skinList.unshift({ name: 'default', attachments: {} });
  skinList.sort((a, b) => (a.name === 'default' ? -1 : b.name === 'default' ? 1 : 0));
  const linked: { skin: ReturnType<typeof newSkin>; slot: Id; key: string; map: J }[] = [];
  const imageSizes = new Map<string, { width: number; height: number }>();
  const skinByName = new Map<string, ReturnType<typeof newSkin>>();
  for (const sm of skinList) {
    const skin = newSkin(uniqueName(str(sm.name, 'skin'), new Set(skinByName.keys())));
    skinByName.set(skin.name, skin);
    skin.bones = arr(sm.bones)
      .map(boneId)
      .filter((b): b is Id => !!b);
    for (const list of ['ik', 'transform', 'slider', 'path', 'physics'] as const) {
      for (const cn of arr(sm[list])) {
        const c = constraintByName.get(String(cn));
        if (c && c.type === list) skin.constraints.push(c.id);
      }
    }
    for (const [slotName, perSlot] of Object.entries(obj(sm.attachments))) {
      const sid = slotId(slotName);
      if (!sid) {
        warn(`skin "${skin.name}": attachments of the unknown slot "${slotName}" were skipped`);
        continue;
      }
      const bag = (skin.attachments[sid] ??= {});
      for (const [key, am] of Object.entries(obj(perSlot))) {
        const att = readAttachment(skin.name, key, obj(am), boneIdsByIndex(), warn, imageSizes, slotId);
        if (att === 'linked') linked.push({ skin, slot: sid, key, map: obj(am) });
        else if (att) bag[key] = att;
      }
    }
    doc.skins.push(skin);
  }
  // linked meshes keep a link to their source mesh (the shape is copied from it and kept equal to it, see core/links.ts)
  const defaultSkinDoc = skinByName.get('default') ?? doc.skins[0];
  let pending = linked;
  while (pending.length) {
    const rest: typeof linked = [];
    for (const l of pending) {
      // 4.3 files name the source mesh `source` (older ones `parent`) and may keep it in another slot or skin; no skin means the default skin
      const sourceName = String(l.map.source ?? l.map.parent);
      const sourceSlot = typeof l.map.slot === 'string' ? (slotId(l.map.slot) ?? l.slot) : l.slot;
      const sourceSkin = typeof l.map.skin === 'string' ? skinByName.get(l.map.skin) : defaultSkinDoc;
      const parent = sourceSkin?.attachments[sourceSlot]?.[sourceName] ?? defaultSkinDoc.attachments[sourceSlot]?.[sourceName];
      if (!parent || parent.type !== 'mesh') {
        // the source may itself be a linked mesh that is not read yet; the ones that are never found are reported below
        rest.push(l);
        continue;
      }
      const inSkin = sourceSkin?.attachments[sourceSlot]?.[sourceName] ? sourceSkin : defaultSkinDoc;
      const path = str(l.map.path, str(l.map.name, l.key));
      const copy: MeshAttachment = {
        ...structuredClone(parent),
        name: str(l.map.name, l.key),
        path,
        color: rgba(l.map.color, [1, 1, 1, 1]),
      };
      const ownSequence = readSequenceDef(l.map.sequence);
      if (ownSequence) copy.sequence = ownSequence;
      else delete copy.sequence;
      // a link to a linked mesh is a link to its source (the loader needs a source that is not linked)
      const base = parent.link
        ? { source: parent.link.source, slot: parent.link.slot ?? sourceSlot, skin: parent.link.skin ?? defaultSkinDoc.id }
        : { source: sourceName, slot: sourceSlot, skin: inSkin.id };
      copy.link = {
        source: base.source,
        slot: base.slot === l.slot ? null : base.slot,
        skin: base.skin === defaultSkinDoc.id ? null : base.skin,
        deform: l.map.timelines !== false && (parent.link ? parent.link.deform : true),
      };
      l.skin.attachments[l.slot][l.key] = copy;
    }
    if (rest.length === pending.length) {
      for (const l of rest)
        warn(`linked mesh "${l.key}" was skipped: its source mesh "${String(l.map.source ?? l.map.parent)}" does not exist`);
      break;
    }
    pending = rest;
  }

  function boneIdsByIndex(): Id[] {
    return doc.bones.map((b) => b.id);
  }

  const eventByName = new Map<string, Id>();
  for (const [en, em] of Object.entries(obj(root.events))) {
    const e = obj(em);
    const id = uid();
    eventByName.set(en, id);
    const def: EventDef = { id, name: en, int: num(e.int, 0), float: num(e.float, 0), string: str(e.string, '') };
    if (typeof e.audio === 'string' && e.audio) {
      def.audio = e.audio;
      def.volume = num(e.volume, 1);
      def.balance = num(e.balance, 0);
    }
    doc.events.push(def);
  }

  const animationByName = new Map<string, Animation>();
  for (const [an, am] of Object.entries(obj(root.animations))) {
    const a = readAnimation(an, obj(am));
    animationByName.set(an, a);
    doc.animations.push(a);
  }
  for (const s of sliderAnimations) {
    const c = doc.constraints.find((x) => x.id === s.id);
    const anim = animationByName.get(s.animation);
    if (c && c.type === 'slider') {
      if (anim) c.animation = anim.id;
      else warn(`slider "${c.name}": its animation "${s.animation}" does not exist`);
    }
  }

  function readAnimation(an: string, am: J): Animation {
    const a = newAnimation(an, 0);
    // bones
    for (const [bn, bt] of Object.entries(obj(am.bones))) {
      const bid = boneId(bn);
      if (!bid) {
        warn(`animation "${an}": timelines of the unknown bone "${bn}" were skipped`);
        continue;
      }
      const t = obj(bt);
      const tl = (a.bones[bid] ??= {});
      if (t.rotate) tl.rotate = timeline(t.rotate, 1, single('value', 0));
      if (t.translate) tl.translate = timeline(t.translate, 2, pair(0));
      if (t.scale) tl.scale = timeline(t.scale, 2, pair(1));
      if (t.shear) tl.shear = timeline(t.shear, 2, pair(0));
      // the split axes keep their own key times and curves
      for (const [axis, def] of [
        ['translatex', 0],
        ['translatey', 0],
        ['scalex', 1],
        ['scaley', 1],
        ['shearx', 0],
        ['sheary', 0],
      ] as const) {
        if (t[axis]) tl[axis] = timeline(t[axis], 1, single('value', def));
      }
      if (t.inherit) warn(`animation "${an}": inherit timelines are not supported and were skipped`);
      if (!Object.keys(tl).length) delete a.bones[bid];
    }
    // slots
    for (const [sn, st] of Object.entries(obj(am.slots))) {
      const sid = slotId(sn);
      if (!sid) {
        warn(`animation "${an}": timelines of the unknown slot "${sn}" were skipped`);
        continue;
      }
      const t = obj(st);
      const tl = (a.slots[sid] ??= {});
      if (t.attachment)
        tl.attachment = arr(t.attachment)
          .map(obj)
          .map((k) => ({ time: num(k.time, 0), name: typeof k.name === 'string' ? k.name : null }));
      if (t.rgba) tl.rgba = timeline(t.rgba, 4, (k) => [...rgba(k.color, [1, 1, 1, 1])]);
      else if (t.rgb || t.alpha) {
        // separate colour and alpha timelines (Spine 4.x): our colour keys hold both, so the two are merged at the times of either
        const setup = slotByName.get(sn)!.color;
        const merged = mergeRgbAlpha(
          t.rgb ? timeline(t.rgb, 3, (k) => rgba(k.color, [1, 1, 1, 1]).slice(0, 3)) : null,
          t.alpha ? timeline(t.alpha, 1, single('value', 0)) : null,
          setup,
        );
        tl.rgba = merged.keys;
        if (!merged.exact)
          warn(
            `animation "${an}": the rgb and alpha timelines of a slot have keys at different times, so the curves between them are approximated`,
          );
      }
      if (t.rgba2 || t.rgb2) {
        const slot = slotByName.get(sn)!;
        if (!slot.dark) {
          slot.dark = [0, 0, 0];
          warn(`slot "${sn}" has two-color keys but no dark color: black was assumed`);
        }
        if (t.rgba2) tl.rgba2 = timeline(t.rgba2, 7, (k) => [...rgba(k.light, [1, 1, 1, 1]), ...(rgb(k.dark) ?? [0, 0, 0])]);
        else {
          warn(`animation "${an}": a separate rgb2 timeline became a two-color timeline (alpha stays at the setup value)`);
          tl.rgba2 = timeline(t.rgb2, 6, (k) => [...(rgb(k.light) ?? [1, 1, 1]), ...(rgb(k.dark) ?? [0, 0, 0])]).map((k) =>
            withAlphaChannel(k, slot.color[3]),
          );
        }
        if (tl.rgba) {
          delete tl.rgba;
          warn(`animation "${an}": rgba keys next to two-color keys were skipped`);
        }
      }
      if (!Object.keys(tl).length) delete a.slots[sid];
    }
    // ik
    for (const [cn, keys] of Object.entries(obj(am.ik))) {
      const c = constraintByName.get(cn);
      if (!c || c.type !== 'ik') continue;
      const list = arr(keys).map(obj);
      a.ik[c.id] = list.map((k, i) => {
        const key: any = {
          time: num(k.time, 0),
          value: [num(k.mix, 1), num(k.softness, 0)],
          bendPositive: bool(k.bendPositive, true),
          compress: bool(k.compress, false),
          stretch: bool(k.stretch, false),
        };
        const curve = curveOf(k, list[i + 1], 2, (x) => [num(x.mix, 1), num(x.softness, 0)]);
        if (curve !== undefined) key.curve = curve;
        return key;
      });
    }
    // transform constraint mixes
    for (const [cn, keys] of Object.entries(obj(am.transform))) {
      const c = constraintByName.get(cn);
      if (!c || c.type !== 'transform') continue;
      const valueOf = (k: J) => {
        const mixX = num(k.mixX, 1);
        const mixScaleX = num(k.mixScaleX, 1);
        return [num(k.mixRotate, 1), mixX, num(k.mixY, mixX), mixScaleX, num(k.mixScaleY, mixScaleX), num(k.mixShearY, 1)];
      };
      a.transform[c.id] = timeline(keys, 6, valueOf);
    }
    // slider time / mix
    for (const [cn, tm] of Object.entries(obj(am.slider))) {
      const c = constraintByName.get(cn);
      if (!c || c.type !== 'slider') continue;
      const t = obj(tm);
      const tl: { time?: Timeline; mix?: Timeline } = {};
      if (t.time) tl.time = timeline(t.time, 1, single('value', 1));
      if (t.mix) tl.mix = timeline(t.mix, 1, single('value', 1));
      if (Object.keys(tl).length) a.slider[c.id] = tl;
    }
    // path constraint position / spacing / mix
    for (const [cn, tm] of Object.entries(obj(am.path))) {
      const c = constraintByName.get(cn);
      if (!c || c.type !== 'path') continue;
      const t = obj(tm);
      const tl: PathTimelines = {};
      if (t.position) tl.position = timeline(t.position, 1, single('value', 0));
      if (t.spacing) tl.spacing = timeline(t.spacing, 1, single('value', 0));
      if (t.mix) {
        tl.mix = timeline(t.mix, 3, (k) => {
          const mixX = num(k.mixX, 1);
          return [num(k.mixRotate, 1), mixX, num(k.mixY, mixX)];
        });
      }
      if (Object.keys(tl).length) a.path[c.id] = tl;
    }
    // physics constraint parameters; the global timelines have an empty constraint name
    for (const [cn, tm] of Object.entries(obj(am.physics))) {
      const c = cn === '' ? null : constraintByName.get(cn);
      if (cn !== '' && (!c || c.type !== 'physics')) continue;
      const t = obj(tm);
      const tl: PhysicsTimelines = {};
      for (const p of PHYSICS_PARAMS) if (t[p]) tl[p] = timeline(t[p], 1, single('value', p === 'mix' ? 1 : 0));
      if (Array.isArray(t.reset) && t.reset.length)
        tl.reset = arr(t.reset)
          .map(obj)
          .map((k) => ({ time: num(k.time, 0), value: [1] }));
      if (Object.keys(tl).length) a.physics[c ? c.id : GLOBAL_PHYSICS] = tl;
    }
    // deform
    for (const [skinName, perSkin] of Object.entries(obj(am.attachments))) {
      const skin = skinByName.get(skinName);
      if (!skin) continue;
      for (const [slotName, perSlot] of Object.entries(obj(perSkin))) {
        const sid = slotId(slotName);
        if (!sid) continue;
        for (const [attName, tlMap] of Object.entries(obj(perSlot))) {
          const mesh = skin.attachments[sid]?.[attName];
          const sequenceKeys = arr(obj(tlMap).sequence).map(obj);
          if (sequenceKeys.length) {
            if (mesh && (mesh.type === 'region' || mesh.type === 'mesh') && mesh.sequence) {
              let lastDelay = 0;
              const keys = sequenceKeys.map((k) => {
                const delay = num(k.delay, lastDelay);
                lastDelay = delay;
                return cleanSequenceKey({ time: num(k.time, 0), mode: k.mode as SequenceMode, index: num(k.index, 0), delay });
              });
              (((a.sequence ??= {})[skin.id] ??= {})[sid] ??= {})[attName] = keys;
            } else warn(`animation "${an}": sequence keys of "${attName}" were skipped (it has no sequence)`);
          }
          const keys = arr(obj(tlMap).deform).map(obj);
          if (!keys.length) continue;
          if (!mesh || (mesh.type !== 'mesh' && mesh.type !== 'path')) {
            warn(`animation "${an}": deform of "${attName}" was skipped (not a mesh or a path)`);
            continue;
          }
          const expected = deformLength(mesh, (id) => doc.bones.some((b) => b.id === id));
          const valueOf = (k: J) => {
            const out = new Array<number>(expected).fill(0);
            const offset = num(k.offset, 0);
            arr(k.vertices).forEach((v, i) => {
              if (offset + i < expected && typeof v === 'number') out[offset + i] = v;
            });
            return out;
          };
          ((a.deform[skin.id] ??= {})[sid] ??= {})[attName] = timeline(keys, 1, valueOf, true);
        }
      }
    }
    // draw order
    if (Array.isArray(am.drawOrder)) {
      a.drawOrder = arr(am.drawOrder)
        .map(obj)
        .map((k) => ({ time: num(k.time, 0), order: drawOrderFromOffsets(arr(k.offsets).map(obj)) }));
    }
    // draw order folders: one folder per distinct set of slots, shared by the animations
    if (Array.isArray(am.drawOrderFolder)) {
      for (const tl of arr(am.drawOrderFolder).map(obj)) {
        const members = arr(tl.slots)
          .map((n) => doc.slots.find((s) => s.name === String(n))?.id)
          .filter((id): id is Id => !!id);
        if (!members.length) continue;
        const sameSet = (list: Id[]) => list.length === members.length && members.every((m) => list.includes(m));
        let folder = doc.drawOrderFolders?.find((x) => sameSet(x.slots));
        if (!folder) {
          if (doc.drawOrderFolders?.some((x) => x.slots.some((s) => members.includes(s)))) {
            warn(`animation "${an}": a draw order folder shares slots with another folder and was skipped`);
            continue;
          }
          folder = { id: uid(), name: `folder ${(doc.drawOrderFolders?.length ?? 0) + 1}`, slots: members };
          (doc.drawOrderFolders ??= []).push(folder);
        }
        (a.drawOrderFolder ??= {})[folder.id] = arr(tl.keys)
          .map(obj)
          .map((k) => ({ time: num(k.time, 0), order: drawOrderFromOffsets(arr(k.offsets).map(obj), members) }));
      }
    }
    // events
    a.events = arr(am.events)
      .map(obj)
      .filter((k) => eventByName.has(String(k.name)))
      .map((k) => {
        const key: any = { time: num(k.time, 0), event: eventByName.get(String(k.name))! };
        if (typeof k.int === 'number') key.int = k.int;
        if (typeof k.float === 'number') key.float = k.float;
        if (typeof k.string === 'string') key.string = k.string;
        if (typeof k.volume === 'number') key.volume = k.volume;
        if (typeof k.balance === 'number') key.balance = k.balance;
        return key;
      });
    a.duration = Math.max(animationEndTime(a), 1 / doc.fps);
    return a;
  }

  /** The order a list of draw order offsets makes of `list` (every slot of the skeleton, or the slots of a folder in their order). */
  function drawOrderFromOffsets(offsets: J[], list: Id[] = doc.slots.map((s) => s.id)): Id[] {
    const n = list.length;
    const order = new Array<number>(n).fill(-1);
    const unchanged: number[] = [];
    let original = 0;
    for (const o of offsets) {
      const si = list.findIndex((id) => doc.slots.find((s) => s.id === id)?.name === o.slot);
      if (si < 0) continue;
      while (original !== si) unchanged.push(original++);
      const target = original + num(o.offset, 0);
      if (target >= 0 && target < n) order[target] = original;
      original++;
    }
    while (original < n) unchanged.push(original++);
    for (let i = n - 1; i >= 0; i--) if (order[i] === -1) order[i] = unchanged.pop() ?? i;
    return order.map((i) => list[i]);
  }

  const used = new Set<string>();
  for (const skin of doc.skins)
    for (const slot of Object.values(skin.attachments))
      for (const att of Object.values(slot)) {
        for (const picture of attachmentPictures(att)) used.add(picture);
      }
  project.images = [...used].map((p) => ({
    id: uid(),
    name: p,
    width: imageSizes.get(p)?.width ?? 0,
    height: imageSizes.get(p)?.height ?? 0,
  }));
  return { project, warnings };
}

/** A sequence of the file (count, start 1, digits 0, setup 0), or undefined when the attachment has none. */
function readSequenceDef(raw: unknown): SequenceDef | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as J;
  return cleanSequence({ count: num(s.count, 1), start: num(s.start, 1), digits: num(s.digits, 0), setupIndex: num(s.setup, 0) });
}

function readAttachment(
  skinName: string,
  key: string,
  m: J,
  boneIds: Id[],
  warn: (message: string) => void,
  sizes: Map<string, { width: number; height: number }>,
  slotId: (name: string) => Id | null,
): Attachment | 'linked' | null {
  const type = str(m.type, 'region');
  const name = str(m.name, key);
  const path = str(m.path, name);
  const color = rgba(m.color, [1, 1, 1, 1]);
  const sequence = readSequenceDef(m.sequence);
  /** Every frame of a sequence is a picture of the size of the attachment. */
  const setSizes = (width: number, height: number) => {
    for (const picture of sequence ? sequenceFrameNames(path, sequence) : [path])
      if (!sizes.has(picture)) sizes.set(picture, { width, height });
  };
  if (type === 'region') {
    const width = num(m.width, 0);
    const height = num(m.height, 0);
    setSizes(width, height);
    return {
      type: 'region',
      name,
      path,
      x: num(m.x, 0),
      y: num(m.y, 0),
      rotation: num(m.rotation, 0),
      scaleX: num(m.scaleX, 1),
      scaleY: num(m.scaleY, 1),
      width,
      height,
      color,
      ...(sequence ? { sequence } : {}),
    };
  }
  if (type === 'linkedmesh') return 'linked';
  if (type === 'mesh') {
    const uvs = arr(m.uvs).map((v) => num(v, 0));
    const vertexCount = uvs.length / 2;
    const vertices = arr(m.vertices).map((v) => num(v, 0));
    const width = num(m.width, 0);
    const height = num(m.height, 0);
    setSizes(width, height);
    const mesh: MeshAttachment = {
      type: 'mesh',
      name,
      path,
      color,
      width,
      height,
      uvs,
      triangles: arr(m.triangles).map((v) => num(v, 0)),
      hull: num(m.hull, vertexCount),
      // the file's edges are editor data and the format does not say how its indices count (and whether the hull is in it), so they are not
      // used as constraints here: the triangles of the file are kept as they are and manual edges are drawn again in the editor
      edges: [],
      vertices: [],
      weights: null,
      ...(sequence ? { sequence } : {}),
    };
    const data = readVertices(vertices, uvs.length, boneIds);
    mesh.vertices = data.vertices;
    mesh.weights = data.weights;
    return mesh;
  }
  if (type === 'path') {
    const count = Math.max(0, Math.floor(num(m.vertexCount, 0)));
    if (count < 6 || count % 3 !== 0) {
      warn(`skin "${skinName}": path "${key}" was skipped (it needs at least two nodes, three points each)`);
      return null;
    }
    // the file's `lengths` are not kept: they are measured again from the setup pose
    const data = readVertices(
      arr(m.vertices).map((v) => num(v, 0)),
      count * 2,
      boneIds,
    );
    return {
      type: 'path',
      name,
      color: rgba(m.color, DEFAULT_PATH_COLOR),
      closed: bool(m.closed, false),
      constantSpeed: bool(m.constantSpeed, true),
      ...data,
    };
  }
  if (type === 'point')
    return { type: 'point', name, x: num(m.x, 0), y: num(m.y, 0), rotation: num(m.rotation, 0), color: rgba(m.color, DEFAULT_POINT_COLOR) };
  if (type === 'boundingbox' || type === 'clipping') {
    const count = Math.max(0, Math.floor(num(m.vertexCount, 0)));
    const data = readVertices(
      arr(m.vertices).map((v) => num(v, 0)),
      count * 2,
      boneIds,
    );
    if (type === 'boundingbox') return { type, name, color: rgba(m.color, DEFAULT_BOUNDING_BOX_COLOR), ...data };
    const end = typeof m.end === 'string' ? slotId(m.end) : null;
    if (typeof m.end === 'string' && !end)
      warn(`clipping "${key}": the end slot "${m.end}" does not exist; it clips until the end of the draw order`);
    return {
      type,
      name,
      color: rgba(m.color, DEFAULT_CLIPPING_COLOR),
      end,
      convex: bool(m.convex, false),
      inverse: bool(m.inverse, false),
      ...data,
    };
  }
  warn(`skin "${skinName}": ${type} attachment "${key}" is not supported and was skipped`);
  return null;
}

/** Spine vertex array: plain x,y when its length is `plainLength`, otherwise `[count, (bone, x, y, weight)*]` per vertex. */
function readVertices(vertices: number[], plainLength: number, boneIds: Id[]): { vertices: number[]; weights: Influence[][] | null } {
  if (vertices.length === plainLength) return { vertices, weights: null };
  const weights: Influence[][] = [];
  for (let i = 0; i < vertices.length;) {
    const count = vertices[i++];
    const list: Influence[] = [];
    for (let k = 0; k < count && i + 3 < vertices.length + 1; k++, i += 4) {
      const bone = boneIds[vertices[i]];
      if (bone !== undefined) list.push([bone, vertices[i + 1], vertices[i + 2], vertices[i + 3]]);
    }
    weights.push(list);
  }
  return { vertices: [], weights };
}
