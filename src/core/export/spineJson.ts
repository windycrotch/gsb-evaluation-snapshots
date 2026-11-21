/**
 * Spine 4.3 JSON exporter. The structure follows what the official 4.3 runtime's SkeletonJson reads
 * (single `constraints` array with `type`, `inherit`, per channel bezier curves, etc).
 */
import { curveToAbsolute } from '../curve';
import { linkSource } from '../links';
import { drawOrderOffsets, folderSlotsInOrder } from '../folders';
import { deformLength } from '../mesh';
import type { Animation, Attachment, Id, IkKey, Influence, Key, SequenceDef, SkeletonDoc, Timeline } from '../model';
import { GLOBAL_PHYSICS, PHYSICS_PARAMS, polygonVertexCount } from '../model';
import { compileSkeleton, createSkeleton } from '../skeleton';

export const SPINE_VERSION = '4.3.13';

export interface SpineExportOptions {
  /** Include editor-only data (bone colors, fps, image path). */
  nonessential?: boolean;
  imagesPath?: string;
  version?: string;
  /**
   * Split colour keys: a slot whose colour keys only change the alpha (the colour stays the setup colour) gets an `alpha` timeline, and one that
   * only changes the colour (the alpha stays the setup alpha) gets an `rgb` timeline, as Spine writes them. Off, every colour key is an `rgba` one.
   */
  splitColor?: boolean;
}

type Json = Record<string, unknown>;

/** Rounds to 5 decimals. Non-finite values become 0 — JSON would turn NaN / Infinity into `null`, which loaders misread. */
const r5 = (v: number): number => {
  if (!Number.isFinite(v)) return 0;
  const x = Math.round(v * 1e5) / 1e5;
  return Object.is(x, -0) ? 0 : x;
};

/** Rounds to 7 significant digits — for coefficients that can be tiny (5 decimals of 0.00123456 would lose 0.4%). */
const rs = (v: number): number => {
  if (!Number.isFinite(v)) return 0;
  const x = +v.toPrecision(7);
  return Object.is(x, -0) ? 0 : x;
};

function hex2(v: number): string {
  const n = Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(v * 255))) : 255;
  return (n < 16 ? '0' : '') + n.toString(16);
}
function hexColor(c: ArrayLike<number>, withAlpha: boolean): string {
  return hex2(c[0]) + hex2(c[1]) + hex2(c[2]) + (withAlpha ? hex2(c[3]) : '');
}

function fnv(str: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    h1 = Math.imul(h1 ^ str.charCodeAt(i), 0x01000193) >>> 0;
    h2 = (Math.imul(h2 + str.charCodeAt(i), 0x85ebca6b) ^ (h1 >>> 7)) >>> 0;
  }
  const bytes = [h1, h2].flatMap((h) => [h & 255, (h >>> 8) & 255, (h >>> 16) & 255, (h >>> 24) & 255]);
  const b64 = typeof btoa === 'function' ? btoa(String.fromCharCode(...bytes)) : Buffer.from(bytes).toString('base64');
  return b64.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function setIf(o: Json, key: string, v: unknown, def: unknown) {
  if (v !== def) o[key] = v;
}

function curveOf(k: Key, next: Key | undefined, channels: number | readonly number[]): unknown {
  if (!next || k.curve === undefined) return undefined;
  if (k.curve === 'stepped') return 'stepped';
  const out: number[] = [];
  for (const c of typeof channels === 'number' ? Array.from({ length: channels }, (_, i) => i) : channels) {
    const a = curveToAbsolute(k.curve, c, k.time, k.value[c], next.time, next.value[c]);
    out.push(r5(a[0]), r5(a[1]), r5(a[2]), r5(a[3]));
  }
  return out;
}

/** Do two colours (channels in 0..1) write the same bytes? */
function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  for (let i = 0; i < a.length; i++) if (hex2(a[i]) !== hex2(b[i])) return false;
  return true;
}

function withTime(o: Json, time: number) {
  if (time !== 0) o.time = r5(time);
}

export function exportSpineJson(doc: SkeletonDoc, options: SpineExportOptions = {}): Json {
  const data = compileSkeleton(doc);
  const boneById = new Map(doc.bones.map((b) => [b.id, b] as const));
  const slotById = new Map(doc.slots.map((s) => [s.id, s] as const));
  const skinById = new Map(doc.skins.map((s) => [s.id, s] as const));
  const boneName = (id: Id) => boneById.get(id)?.name ?? '';
  const slotName = (id: Id) => slotById.get(id)?.name ?? '';

  const setup = createSkeleton(data);
  setup.setToSetupPose();
  setup.updateWorldTransform();
  const bounds = setup.getBounds() ?? [0, 0, 0, 0];
  const skeleton: Json = {
    hash: '',
    spine: options.version ?? SPINE_VERSION,
    x: r5(bounds[0]),
    y: r5(bounds[1]),
    width: r5(bounds[2]),
    height: r5(bounds[3]),
    referenceScale: doc.referenceScale ?? 100,
  };
  if (options.nonessential !== false) {
    skeleton.fps = doc.fps;
    skeleton.images = options.imagesPath ?? './images/';
  }

  const bones: Json[] = data.bones.map((bd) => {
    const b = boneById.get(bd.id)!;
    const o: Json = { name: b.name };
    if (b.parent) o.parent = boneName(b.parent);
    setIf(o, 'length', r5(b.length), 0);
    setIf(o, 'x', r5(b.x), 0);
    setIf(o, 'y', r5(b.y), 0);
    setIf(o, 'rotation', r5(b.rotation), 0);
    setIf(o, 'scaleX', r5(b.scaleX), 1);
    setIf(o, 'scaleY', r5(b.scaleY), 1);
    setIf(o, 'shearX', r5(b.shearX), 0);
    setIf(o, 'shearY', r5(b.shearY), 0);
    setIf(o, 'inherit', b.inherit, 'normal');
    if (bd.skinRequired) o.skin = true;
    if (options.nonessential !== false) {
      const col = hexColor(b.color, true);
      if (col !== '989898ff') o.color = col;
    }
    return o;
  });

  const slots: Json[] = doc.slots.map((s) => {
    const o: Json = { name: s.name, bone: boneName(s.bone) };
    const col = hexColor(s.color, true);
    if (col !== 'ffffffff') o.color = col;
    if (s.dark) o.dark = hexColor(s.dark, false);
    if (s.attachment) o.attachment = s.attachment;
    if (s.blend !== 'normal') o.blend = s.blend;
    return o;
  });

  const constraints: Json[] = [];
  /** Sliders that make it into the file (a slider without an animation does nothing and the official loader rejects it). */
  const exportedSliders = new Set<Id>();
  const sliderAnimations = new Set<Id>();
  for (const c of doc.constraints) if (c.type === 'slider' && c.animation) sliderAnimations.add(c.animation);
  for (const c of doc.constraints) {
    if (c.type === 'slider') {
      const animation = c.animation ? doc.animations.find((a) => a.id === c.animation) : undefined;
      if (!animation) continue;
      exportedSliders.add(c.id);
      const o: Json = { type: 'slider', name: c.name, animation: animation.name };
      if (c.skinRequired) o.skin = true;
      if (c.additive) o.additive = true;
      if (c.loop) o.loop = true;
      setIf(o, 'mix', r5(c.mix), 1);
      if (c.bone && boneById.has(c.bone)) {
        o.bone = boneName(c.bone);
        o.property = c.property;
        setIf(o, 'from', rs(c.from), 0);
        setIf(o, 'to', rs(c.to), 0);
        setIf(o, 'scale', rs(c.scale), 1);
        setIf(o, 'max', rs(c.max), 0);
        if (c.local) o.local = true;
      } else setIf(o, 'time', rs(c.time), 0);
      constraints.push(o);
    } else if (c.type === 'ik') {
      const o: Json = { type: 'ik', name: c.name, bones: c.bones.map(boneName), target: boneName(c.target) };
      if (c.skinRequired) o.skin = true;
      setIf(o, 'mix', r5(c.mix), 1);
      setIf(o, 'softness', r5(c.softness), 0);
      if (!c.bendPositive) o.bendPositive = false;
      if (c.compress) o.compress = true;
      if (c.stretch) o.stretch = true;
      if (c.scaleY !== 'none') o.scaleY = c.scaleY;
      constraints.push(o);
    } else if (c.type === 'transform') {
      const o: Json = { type: 'transform', name: c.name, bones: c.bones.map(boneName), source: boneName(c.source) };
      if (c.skinRequired) o.skin = true;
      if (c.localSource) o.localSource = true;
      if (c.localTarget) o.localTarget = true;
      if (c.additive) o.additive = true;
      if (c.clamp) o.clamp = true;
      const props: Json = {};
      const used = new Set<string>();
      for (const f of c.properties) {
        if (!f.to.length) continue;
        const to: Json = {};
        for (const t of f.to) {
          used.add(t.prop);
          const te: Json = {};
          setIf(te, 'offset', rs(t.offset), 0);
          setIf(te, 'max', rs(t.max), 1);
          setIf(te, 'scale', rs(t.scale), 1);
          to[t.prop] = te;
        }
        const fe: Json = {};
        setIf(fe, 'offset', rs(f.offset), 0);
        fe.to = to;
        props[f.prop] = fe;
      }
      o.properties = props;
      setIf(o, 'rotation', r5(c.offsets.rotation), 0);
      setIf(o, 'x', r5(c.offsets.x), 0);
      setIf(o, 'y', r5(c.offsets.y), 0);
      setIf(o, 'scaleX', r5(c.offsets.scaleX), 0);
      setIf(o, 'scaleY', r5(c.offsets.scaleY), 0);
      setIf(o, 'shearY', r5(c.offsets.shearY), 0);
      // always explicit: the loader defaults mixY/mixScaleY to the X mix, which may be unused
      if (used.has('rotate')) o.mixRotate = r5(c.mix.rotate);
      if (used.has('x')) o.mixX = r5(c.mix.x);
      if (used.has('y')) o.mixY = r5(c.mix.y);
      if (used.has('scaleX')) o.mixScaleX = r5(c.mix.scaleX);
      if (used.has('scaleY')) o.mixScaleY = r5(c.mix.scaleY);
      if (used.has('shearY')) o.mixShearY = r5(c.mix.shearY);
      constraints.push(o);
    } else if (c.type === 'path') {
      const slot = slotById.get(c.target);
      if (!slot) continue;
      const o: Json = { type: 'path', name: c.name, bones: c.bones.map(boneName), slot: slot.name };
      if (c.skinRequired) o.skin = true;
      // the loader's defaults are percent / length / tangent
      setIf(o, 'positionMode', c.positionMode, 'percent');
      setIf(o, 'spacingMode', c.spacingMode, 'length');
      setIf(o, 'rotateMode', c.rotateMode, 'tangent');
      setIf(o, 'rotation', r5(c.offsetRotation), 0);
      setIf(o, 'position', rs(c.position), 0);
      setIf(o, 'spacing', rs(c.spacing), 0);
      setIf(o, 'mixRotate', r5(c.mix.rotate), 1);
      setIf(o, 'mixX', r5(c.mix.x), 1);
      o.mixY = r5(c.mix.y); // always explicit: the loader defaults mixY to the X mix
      constraints.push(o);
    } else if (c.type === 'physics') {
      const bone = boneById.get(c.bone);
      if (!bone) continue;
      const o: Json = { type: 'physics', name: c.name, bone: bone.name };
      if (c.skinRequired) o.skin = true;
      // the loader's defaults: x / y / rotate / scaleX / shearX 0, limit 5000, fps 60, inertia 0.5, strength 100, damping 0.85, mass 1, mix 1
      setIf(o, 'x', rs(c.x), 0);
      setIf(o, 'y', rs(c.y), 0);
      setIf(o, 'rotate', rs(c.rotate), 0);
      setIf(o, 'scaleX', rs(c.scaleX), 0);
      if (c.scaleY !== 'none') o.scaleY = c.scaleY;
      setIf(o, 'shearX', rs(c.shearX), 0);
      setIf(o, 'limit', rs(c.limit), 5000);
      setIf(o, 'fps', rs(c.fps), 60);
      setIf(o, 'inertia', rs(c.inertia), 0.5);
      setIf(o, 'strength', rs(c.strength), 100);
      setIf(o, 'damping', rs(c.damping), 0.85);
      setIf(o, 'mass', rs(c.mass), 1);
      setIf(o, 'wind', rs(c.wind), 0);
      setIf(o, 'gravity', rs(c.gravity), 0);
      setIf(o, 'mix', rs(c.mix), 1);
      for (const p of PHYSICS_PARAMS) if (c.global[p]) o[`${p}Global`] = true;
      constraints.push(o);
    }
  }

  const skins: Json[] = doc.skins.map((s) => {
    const o: Json = { name: s.name };
    if (s.bones.length) o.bones = s.bones.map(boneName);
    const listed = s.constraints.map((id) => doc.constraints.find((c) => c.id === id));
    for (const type of ['ik', 'transform', 'slider', 'path', 'physics'] as const) {
      const names = listed.filter((c) => c && c.type === type && (type !== 'slider' || exportedSliders.has(c.id))).map((c) => c!.name);
      if (names.length) o[type] = names;
    }
    const compiledSkin = data.skinById.get(s.id);
    const attachments: Json = {};
    for (const slotId in s.attachments) {
      const sn = slotName(slotId);
      if (!sn) continue;
      const perSlot: Json = {};
      for (const key in s.attachments[slotId]) {
        const compiled = compiledSkin?.attachments[data.slotIndex.get(slotId) ?? -1]?.get(key);
        const att = s.attachments[slotId][key];
        const source = att.type === 'mesh' && att.link ? linkSource(doc, slotId, att) : null;
        const linked: LinkJson | null =
          source && att.type === 'mesh' && att.link
            ? {
                source: att.link.source,
                slot: source.slotId !== slotId ? slotName(source.slotId) : '',
                skin: source.skin !== doc.skins[0] ? source.skin.name : '',
                deform: att.link.deform,
              }
            : null;
        perSlot[key] = exportAttachment(
          att,
          key,
          data.boneIndex,
          slotName,
          compiled?.kind === 'path' ? compiled.lengths : [],
          linked,
          options.nonessential !== false,
        );
      }
      attachments[sn] = perSlot;
    }
    o.attachments = attachments;
    return o;
  });

  const events: Json = {};
  for (const e of doc.events) {
    const o: Json = {};
    setIf(o, 'int', e.int, 0);
    setIf(o, 'float', r5(e.float), 0);
    if (e.string) o.string = e.string;
    if (e.audio) {
      o.audio = e.audio;
      setIf(o, 'volume', r5(e.volume ?? 1), 1);
      setIf(o, 'balance', r5(e.balance ?? 0), 0);
    }
    events[e.name] = o;
  }

  const animations: Json = {};
  const rootBone = data.bones.length ? data.bones[0].name : 'root';
  for (const a of doc.animations)
    animations[a.name] = exportAnimation(doc, a, {
      boneName,
      slotName,
      skinById,
      rootBone,
      exportedSliders,
      splitColor: options.splitColor,
      sliderAnimations,
    });

  const out: Json = { skeleton, bones };
  if (slots.length) out.slots = slots;
  if (constraints.length) out.constraints = constraints;
  if (skins.length) out.skins = skins;
  if (doc.events.length) out.events = events;
  if (doc.animations.length) out.animations = animations;
  skeleton.hash = fnv(JSON.stringify(out));
  return out;
}

/** Vertex array of a mesh / polygon: plain x,y, or `[count, (bone, x, y, weight)*]` per vertex when weighted. */
function exportVertices(att: { vertices: number[]; weights: Influence[][] | null }, boneIndex: Map<Id, number>): number[] {
  if (!att.weights) return att.vertices.map((x) => r5(x));
  const v: number[] = [];
  for (const list of att.weights) {
    const valid = list.filter((inf) => boneIndex.has(inf[0]));
    if (valid.length === 0) {
      v.push(1, 0, 0, 0, 1); // follow the root, exactly like the editor's own fallback (and the deform layout matches)
      continue;
    }
    v.push(valid.length);
    for (const inf of valid) v.push(boneIndex.get(inf[0])!, r5(inf[1]), r5(inf[2]), r5(inf[3]));
  }
  return v;
}

/** Where a linked mesh takes its shape from, by the names the file uses (an empty slot / skin = its own slot / the default skin). */
interface LinkJson {
  source: string;
  slot: string;
  skin: string;
  deform: boolean;
}

function exportAttachment(
  att: Attachment,
  key: string,
  boneIndex: Map<Id, number>,
  slotName: (id: Id) => string,
  pathLengths: number[],
  linked: LinkJson | null,
  nonessential = true,
): Json {
  const o: Json = {};
  if (att.name !== key) o.name = att.name;
  if (att.type === 'path') {
    o.type = 'path';
    if (att.closed) o.closed = true;
    if (!att.constantSpeed) o.constantSpeed = false; // the loader's default is true
    o.vertexCount = polygonVertexCount(att);
    o.vertices = exportVertices(att, boneIndex);
    o.lengths = pathLengths.map((v) => r5(v));
    o.color = hexColor(att.color, true);
    return o;
  }
  if (att.type === 'point') {
    o.type = 'point';
    setIf(o, 'x', r5(att.x), 0);
    setIf(o, 'y', r5(att.y), 0);
    setIf(o, 'rotation', r5(att.rotation), 0);
    o.color = hexColor(att.color, true);
    return o;
  }
  if (att.type === 'boundingbox' || att.type === 'clipping') {
    o.type = att.type;
    if (att.type === 'clipping') {
      const end = att.end ? slotName(att.end) : '';
      if (end) o.end = end;
      if (att.convex) o.convex = true;
      if (att.inverse) o.inverse = true;
    }
    o.vertexCount = polygonVertexCount(att);
    o.vertices = exportVertices(att, boneIndex);
    o.color = hexColor(att.color, true);
    return o;
  }
  if (att.type === 'region') {
    if (att.path !== att.name) o.path = att.path;
    setIf(o, 'x', r5(att.x), 0);
    setIf(o, 'y', r5(att.y), 0);
    setIf(o, 'scaleX', r5(att.scaleX), 1);
    setIf(o, 'scaleY', r5(att.scaleY), 1);
    setIf(o, 'rotation', r5(att.rotation), 0);
    o.width = r5(att.width);
    o.height = r5(att.height);
    const col = hexColor(att.color, true);
    if (col !== 'ffffffff') o.color = col;
    if (att.sequence) o.sequence = exportSequence(att.sequence);
    return o;
  }
  if (linked) {
    o.type = 'linkedmesh';
    if (att.path !== att.name) o.path = att.path;
    const lcol = hexColor(att.color, true);
    if (lcol !== 'ffffffff') o.color = lcol;
    o.width = r5(att.width);
    o.height = r5(att.height);
    o.source = linked.source;
    if (linked.slot) o.slot = linked.slot;
    if (linked.skin) o.skin = linked.skin;
    if (!linked.deform) o.timelines = false; // the loader's default is true
    if (att.sequence) o.sequence = exportSequence(att.sequence);
    return o;
  }
  o.type = 'mesh';
  if (att.path !== att.name) o.path = att.path;
  const col = hexColor(att.color, true);
  if (col !== 'ffffffff') o.color = col;
  o.width = r5(att.width);
  o.height = r5(att.height);
  o.uvs = att.uvs.map((v) => r5(v));
  o.triangles = att.triangles.slice();
  o.hull = att.hull;
  if (nonessential && att.edges?.length) o.edges = att.edges.slice(); // the manual edges (editor data)
  o.vertices = exportVertices(att, boneIndex);
  if (att.sequence) o.sequence = exportSequence(att.sequence);
  return o;
}

/** The loader's defaults: start 1, digits 0, setup 0. */
function exportSequence(s: SequenceDef): Json {
  const o: Json = { count: s.count };
  setIf(o, 'start', s.start, 1);
  setIf(o, 'digits', s.digits, 0);
  setIf(o, 'setup', s.setupIndex, 0);
  return o;
}

interface Names {
  boneName: (id: Id) => string;
  slotName: (id: Id) => string;
  skinById: Map<Id, SkeletonDoc['skins'][number]>;
  rootBone: string;
  exportedSliders: Set<Id>;
  /** See `SpineExportOptions.splitColor`. */
  splitColor?: boolean;
  /** Animations a slider plays (ids): their colour keys stay rgba, because a slider applies them over a pose the same slot may already have, and an alpha or rgb timeline would leave the other part of that pose in place. */
  sliderAnimations?: Set<Id>;
}

function exportAnimation(doc: SkeletonDoc, a: Animation, n: Names): Json {
  const out: Json = {};
  const ikById = new Map(doc.constraints.map((c) => [c.id, c] as const));
  const boneIds = new Set(doc.bones.map((b) => b.id));

  // bones
  const bones: Json = {};
  for (const boneId in a.bones) {
    const name = n.boneName(boneId);
    if (!name) continue;
    const tl = a.bones[boneId];
    const o: Json = {};
    const put = (label: string, keys: Timeline | undefined, fields: string[], channels: number) => {
      if (!keys || !keys.length) return;
      o[label] = keys.map((k, i) => {
        const e: Json = {};
        withTime(e, k.time);
        for (let c = 0; c < channels; c++) e[fields[c]] = r5(k.value[c]);
        const cv = curveOf(k, keys[i + 1], channels);
        if (cv !== undefined) e.curve = cv;
        return e;
      });
    };
    put('rotate', tl.rotate, ['value'], 1);
    put('translate', tl.translate, ['x', 'y'], 2);
    put('translatex', tl.translatex, ['value'], 1);
    put('translatey', tl.translatey, ['value'], 1);
    put('scale', tl.scale, ['x', 'y'], 2);
    put('scalex', tl.scalex, ['value'], 1);
    put('scaley', tl.scaley, ['value'], 1);
    put('shear', tl.shear, ['x', 'y'], 2);
    put('shearx', tl.shearx, ['value'], 1);
    put('sheary', tl.sheary, ['value'], 1);
    if (Object.keys(o).length) bones[name] = o;
  }
  if (Object.keys(bones).length) out.bones = bones;

  // slots
  const slots: Json = {};
  for (const slotId in a.slots) {
    const name = n.slotName(slotId);
    if (!name) continue;
    const tl = a.slots[slotId];
    const o: Json = {};
    if (tl.attachment && tl.attachment.length) {
      o.attachment = tl.attachment.map((k) => {
        const e: Json = {};
        withTime(e, k.time);
        e.name = k.name;
        return e;
      });
    }
    const setup = doc.slots.find((s) => s.id === slotId)?.color;
    const keep = (k: Timeline[number], from: number, to: number) => !!setup && sameBytes(k.value.slice(from, to), setup.slice(from, to));
    const split = n.splitColor && !n.sliderAnimations?.has(a.id);
    const alphaOnly = split && tl.rgba?.length && !tl.rgba2?.length && tl.rgba.every((k) => keep(k, 0, 3));
    const colorOnly = split && !alphaOnly && tl.rgba?.length && !tl.rgba2?.length && tl.rgba.every((k) => keep(k, 3, 4));
    if (alphaOnly && tl.rgba) {
      // only the alpha changes: an `alpha` timeline (the curve is the one of the alpha channel)
      const keys = tl.rgba;
      o.alpha = keys.map((k, i) => {
        const e: Json = {};
        withTime(e, k.time);
        // 8-bit, like every colour of the file (the binary format stores it as a byte, and the two must read the same)
        const v = r5(Math.round(Math.max(0, Math.min(1, k.value[3])) * 255) / 255);
        if (v !== 0) e.value = v;
        const cv = curveOf(k, keys[i + 1], [3]);
        if (cv !== undefined) e.curve = cv;
        return e;
      });
    } else if (colorOnly && tl.rgba) {
      const keys = tl.rgba;
      o.rgb = keys.map((k, i) => {
        const e: Json = {};
        withTime(e, k.time);
        e.color = hexColor(k.value, false);
        const cv = curveOf(k, keys[i + 1], 3);
        if (cv !== undefined) e.curve = cv;
        return e;
      });
    } else if (tl.rgba && tl.rgba.length) {
      const keys = tl.rgba;
      o.rgba = keys.map((k, i) => {
        const e: Json = {};
        withTime(e, k.time);
        e.color = hexColor(k.value, true);
        const cv = curveOf(k, keys[i + 1], 4);
        if (cv !== undefined) e.curve = cv;
        return e;
      });
    }
    if (tl.rgba2 && tl.rgba2.length) {
      const keys = tl.rgba2;
      o.rgba2 = keys.map((k, i) => {
        const e: Json = {};
        withTime(e, k.time);
        e.light = hexColor(k.value, true);
        e.dark = hexColor(k.value.slice(4), false);
        const cv = curveOf(k, keys[i + 1], 7);
        if (cv !== undefined) e.curve = cv;
        return e;
      });
    }
    if (Object.keys(o).length) slots[name] = o;
  }
  if (Object.keys(slots).length) out.slots = slots;

  // ik
  const ik: Json = {};
  for (const cid in a.ik) {
    const c = ikById.get(cid);
    const keys = a.ik[cid];
    if (!c || !keys.length) continue;
    ik[c.name] = keys.map((k: IkKey, i) => {
      const e: Json = {};
      withTime(e, k.time);
      setIf(e, 'mix', r5(k.value[0]), 1);
      setIf(e, 'softness', r5(k.value[1]), 0);
      if (!k.bendPositive) e.bendPositive = false;
      if (k.compress) e.compress = true;
      if (k.stretch) e.stretch = true;
      const cv = curveOf(k, keys[i + 1], 2);
      if (cv !== undefined) e.curve = cv;
      return e;
    });
  }
  if (Object.keys(ik).length) out.ik = ik;

  // transform constraint mixes
  const transform: Json = {};
  for (const cid in a.transform ?? {}) {
    const c = ikById.get(cid);
    const keys = a.transform[cid];
    if (!c || c.type !== 'transform' || !keys.length) continue;
    transform[c.name] = keys.map((k, i) => {
      const e: Json = {};
      withTime(e, k.time);
      e.mixRotate = r5(k.value[0]);
      e.mixX = r5(k.value[1]);
      e.mixY = r5(k.value[2]);
      e.mixScaleX = r5(k.value[3]);
      e.mixScaleY = r5(k.value[4]);
      e.mixShearY = r5(k.value[5]);
      const cv = curveOf(k, keys[i + 1], 6);
      if (cv !== undefined) e.curve = cv;
      return e;
    });
  }
  if (Object.keys(transform).length) out.transform = transform;

  // slider time / mix
  const slider: Json = {};
  for (const cid in a.slider ?? {}) {
    const c = ikById.get(cid);
    if (!c || c.type !== 'slider' || !n.exportedSliders.has(cid)) continue;
    const tl = a.slider[cid];
    const o: Json = {};
    const put1 = (label: string, keys: Timeline | undefined) => {
      if (!keys || !keys.length) return;
      o[label] = keys.map((k, i) => {
        const e: Json = {};
        withTime(e, k.time);
        e.value = r5(k.value[0]);
        const cv = curveOf(k, keys[i + 1], 1);
        if (cv !== undefined) e.curve = cv;
        return e;
      });
    };
    put1('time', tl.time);
    put1('mix', tl.mix);
    if (Object.keys(o).length) slider[c.name] = o;
  }
  if (Object.keys(slider).length) out.slider = slider;

  // path constraint position / spacing / mix
  const path: Json = {};
  for (const cid in a.path ?? {}) {
    const c = ikById.get(cid);
    if (!c || c.type !== 'path') continue;
    const tl = a.path[cid];
    const o: Json = {};
    const put1 = (label: string, keys: Timeline | undefined) => {
      if (!keys || !keys.length) return;
      o[label] = keys.map((k, i) => {
        const e: Json = {};
        withTime(e, k.time);
        e.value = rs(k.value[0]);
        const cv = curveOf(k, keys[i + 1], 1);
        if (cv !== undefined) e.curve = cv;
        return e;
      });
    };
    put1('position', tl.position);
    put1('spacing', tl.spacing);
    if (tl.mix?.length) {
      const keys = tl.mix;
      o.mix = keys.map((k, i) => {
        const e: Json = {};
        withTime(e, k.time);
        e.mixRotate = r5(k.value[0]);
        e.mixX = r5(k.value[1]);
        e.mixY = r5(k.value[2]);
        const cv = curveOf(k, keys[i + 1], 3);
        if (cv !== undefined) e.curve = cv;
        return e;
      });
    }
    if (Object.keys(o).length) path[c.name] = o;
  }
  if (Object.keys(path).length) out.path = path;

  // physics constraint parameters; the global timelines sit under an empty constraint name
  const physics: Json = {};
  for (const cid in a.physics ?? {}) {
    const c = ikById.get(cid);
    if (cid !== GLOBAL_PHYSICS && (!c || c.type !== 'physics')) continue;
    const tl = a.physics[cid];
    const o: Json = {};
    for (const p of PHYSICS_PARAMS) {
      const keys = tl[p];
      if (!keys || !keys.length) continue;
      o[p] = keys.map((k, i) => {
        const e: Json = {};
        withTime(e, k.time);
        e.value = rs(k.value[0]);
        const cv = curveOf(k, keys[i + 1], 1);
        if (cv !== undefined) e.curve = cv;
        return e;
      });
    }
    if (tl.reset?.length) {
      o.reset = tl.reset.map((k) => {
        const e: Json = {};
        withTime(e, k.time);
        return e;
      });
    }
    if (Object.keys(o).length) physics[cid === GLOBAL_PHYSICS ? '' : c!.name] = o;
  }
  if (Object.keys(physics).length) out.physics = physics;

  // deform -> animations.attachments[skin][slot][attachment].deform
  const attachments: Json = {};
  for (const skinId in a.deform) {
    const skin = n.skinById.get(skinId);
    if (!skin) continue;
    const perSkin: Json = {};
    for (const slotId in a.deform[skinId]) {
      const sn = n.slotName(slotId);
      if (!sn) continue;
      const perSlot: Json = {};
      for (const attName in a.deform[skinId][slotId]) {
        const keys = a.deform[skinId][slotId][attName];
        if (!keys.length) continue;
        // the official loader throws on a missing attachment and silently misreads keys of the wrong size
        const mesh = skin.attachments[slotId]?.[attName];
        if (!mesh || (mesh.type !== 'mesh' && mesh.type !== 'path')) continue;
        if (mesh.type === 'mesh' && mesh.link?.deform && linkSource(doc, slotId, mesh)) continue; // the deform of the source moves it; keys of its own are never read
        const expected = deformLength(mesh, (id) => boneIds.has(id));
        if (keys.some((k) => k.value.length !== expected)) continue;
        perSlot[attName] = {
          deform: keys.map((k, i) => {
            const e: Json = {};
            withTime(e, k.time);
            let first = -1;
            let last = -1;
            for (let j = 0; j < k.value.length; j++) {
              if (Math.abs(k.value[j]) > 1e-6) {
                if (first < 0) first = j;
                last = j;
              }
            }
            if (first >= 0) {
              if (first > 0) e.offset = first;
              e.vertices = k.value.slice(first, last + 1).map((v) => r5(v));
            }
            const next = keys[i + 1];
            if (next && k.curve !== undefined) e.curve = k.curve === 'stepped' ? 'stepped' : curveAbsDeform(k, next);
            return e;
          }),
        };
      }
      if (Object.keys(perSlot).length) perSkin[sn] = perSlot;
    }
    if (Object.keys(perSkin).length) attachments[skin.name] = perSkin;
  }
  // sequence keys sit beside the deform keys, per attachment
  for (const skinId in a.sequence ?? {}) {
    const skin = n.skinById.get(skinId);
    if (!skin) continue;
    for (const slotId in a.sequence![skinId]) {
      const sn = n.slotName(slotId);
      if (!sn) continue;
      for (const attName in a.sequence![skinId][slotId]) {
        const keys = a.sequence![skinId][slotId][attName];
        const att = skin.attachments[slotId]?.[attName];
        if (!keys.length || !att || (att.type !== 'region' && att.type !== 'mesh') || !att.sequence) continue;
        const perSkin = (attachments[skin.name] ??= {}) as Json;
        const perSlot = (perSkin[sn] ??= {}) as Json;
        const target = (perSlot[attName] ??= {}) as Json;
        target.sequence = keys.map((k) => {
          const e: Json = {};
          withTime(e, k.time);
          if (k.mode !== 'hold') e.mode = k.mode;
          if (k.index !== 0) e.index = k.index;
          e.delay = r5(k.delay);
          return e;
        });
      }
    }
  }
  if (Object.keys(attachments).length) out.attachments = attachments;

  // draw order
  if (a.drawOrder.length) {
    const setupIndex = new Map(doc.slots.map((s, i) => [s.id, i] as const));
    out.drawOrder = a.drawOrder.map((k) => {
      const e: Json = {};
      withTime(e, k.time);
      const offsets = drawOrderOffsets(
        doc.slots.map((s) => s.id),
        k.order.filter((id) => setupIndex.has(id)),
      );
      if (offsets.length) e.offsets = offsets.map((o) => ({ slot: n.slotName(o.id), offset: o.offset }));
      return e;
    });
  }
  // draw order folders: the slots of the folder (setup order) and its own keys
  const folderTimelines: Json[] = [];
  for (const f of doc.drawOrderFolders ?? []) {
    const keys = a.drawOrderFolder?.[f.id];
    const members = folderSlotsInOrder(doc, f);
    if (!keys?.length || !members.length) continue;
    folderTimelines.push({
      slots: members.map((id) => n.slotName(id)),
      keys: keys.map((k) => {
        const e: Json = {};
        withTime(e, k.time);
        const offsets = drawOrderOffsets(members, k.order);
        if (offsets.length) e.offsets = offsets.map((o) => ({ slot: n.slotName(o.id), offset: o.offset }));
        return e;
      }),
    });
  }
  if (folderTimelines.length) out.drawOrderFolder = folderTimelines;

  // events
  if (a.events.length) {
    const evName = (id: Id) => doc.events.find((e) => e.id === id)?.name;
    const evDef = (id: Id) => doc.events.find((e) => e.id === id);
    out.events = a.events
      .filter((k) => evName(k.event))
      .map((k) => {
        const e: Json = {};
        withTime(e, k.time);
        e.name = evName(k.event);
        if (k.int !== undefined) e.int = k.int;
        if (k.float !== undefined) e.float = k.float;
        if (k.string !== undefined) e.string = k.string;
        const def = evDef(k.event);
        if (def?.audio) {
          // always both, written out: the official 4.3.13 JSON loader takes the VOLUME of the definition as the default balance of a key
          e.volume = r5(k.volume ?? def.volume ?? 1);
          e.balance = r5(k.balance ?? def.balance ?? 0);
        }
        return e;
      });
  }

  // Spine derives the animation length from its last key — of the timelines that are really in the file (sliders without an
  // animation, for instance, are not). Pad one so an explicit duration survives export.
  if (a.duration > lastKeyTime(out) + 1e-6) padDuration(out, a.duration, n);
  return out;
}

/** Highest key time among the timelines of an exported animation. */
function lastKeyTime(node: unknown): number {
  let end = 0;
  if (Array.isArray(node)) {
    for (const item of node) {
      const time = (item as Json | null)?.time;
      if (typeof time === 'number') end = Math.max(end, time);
      else end = Math.max(end, lastKeyTime(item));
    }
  } else if (node && typeof node === 'object') {
    for (const value of Object.values(node as Json)) end = Math.max(end, lastKeyTime(value));
  }
  return end;
}

function curveAbsDeform(k: Key, next: Key): number[] {
  const c = k.curve as number[];
  // Deform curves are normalized 0..1 in value (Spine stores time absolute, value 0..1).
  return [r5(k.time + c[0] * (next.time - k.time)), r5(c[1]), r5(k.time + c[2] * (next.time - k.time)), r5(c[3])];
}

/**
 * Appends a copy of the last key at `duration` to the first existing timeline, so an explicit duration survives export.
 * It never ADDS a timeline: a made-up one (say, a root rotation) would make the animation touch a bone or constraint it
 * does not animate, which changes how the official runtime orders and re-derives transforms when a slider applies it.
 * An animation without any key keeps the length Spine derives for it: none.
 */
function padDuration(out: Json, duration: number, _names: Names) {
  const firstKeys = (group: Json | undefined): Json[] | null => {
    if (!group) return null;
    for (const target in group) {
      const entry = group[target];
      if (Array.isArray(entry) && entry.length) return entry as Json[];
      if (entry && typeof entry === 'object') {
        for (const label in entry as Json) {
          const keys = (entry as Json)[label];
          if (Array.isArray(keys) && keys.length) return keys as Json[];
        }
      }
    }
    return null;
  };
  // a reset key is an event: it is never padded
  const physicsKeys = (): Json[] | null => {
    for (const per of Object.values((out.physics ?? {}) as Json))
      for (const label in per as Json) {
        const keys = (per as Json)[label];
        if (label !== 'reset' && Array.isArray(keys) && keys.length) return keys as Json[];
      }
    return null;
  };
  const deformKeys = (): Json[] | null => {
    for (const skin of Object.values((out.attachments ?? {}) as Json))
      for (const slot of Object.values(skin as Json))
        for (const att of Object.values(slot as Json)) {
          const keys = (att as Json).deform;
          if (Array.isArray(keys) && keys.length) return keys as Json[];
        }
    return null;
  };
  const keys =
    firstKeys(out.bones as Json | undefined) ??
    firstKeys(out.slots as Json | undefined) ??
    firstKeys(out.ik as Json | undefined) ??
    firstKeys(out.transform as Json | undefined) ??
    firstKeys(out.slider as Json | undefined) ??
    firstKeys(out.path as Json | undefined) ??
    physicsKeys() ??
    deformKeys() ??
    (Array.isArray(out.drawOrder) && out.drawOrder.length ? (out.drawOrder as Json[]) : null);
  if (!keys) return;
  const last = { ...keys[keys.length - 1] };
  delete last.curve;
  last.time = r5(duration);
  keys.push(last);
}
