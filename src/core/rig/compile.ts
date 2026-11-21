/** Compiles a skeleton document into `SkeletonData` (memoised by document). */
import { BONE_PROPS, polygonVertexCount } from '../model';
import type { Attachment, Id, Influence, SkeletonDoc } from '../model';
import { parentFirst } from '../boneorder';
import { hasLinkedMeshes, linkSource } from '../links';
import { pathCurveLengths } from '../path';
import type { AttachmentData, BoneData, ConstraintData, PathAttachmentData, SkeletonData, SkinData, SlotData, VertexData } from './data';
import { Skeleton } from './skeleton';
import { meshWorldVertices } from './geometry';

const attachmentCache = new WeakMap<Attachment, { key: string; data: AttachmentData }>();

function compileAttachment(att: Attachment, boneIndex: Map<Id, number>, boneOrderKey: string): AttachmentData {
  const weighted =
    (att.type === 'mesh' || att.type === 'clipping' || att.type === 'boundingbox' || att.type === 'path') && att.weights != null;
  const hit = attachmentCache.get(att);
  if (hit && (!weighted || hit.key === boneOrderKey)) return hit.data;

  let data: AttachmentData;
  if (att.type === 'point') {
    data = { kind: 'point', src: att, name: att.name, color: att.color, x: att.x, y: att.y, rotation: att.rotation };
  } else if (att.type === 'path') {
    data = {
      kind: 'path',
      src: att,
      name: att.name,
      color: att.color,
      closed: att.closed,
      constantSpeed: att.constantSpeed,
      lengths: [],
      ...compileVertices(polygonVertexCount(att), att.vertices, att.weights, boneIndex),
    };
  } else if (att.type === 'clipping') {
    data = {
      kind: 'clipping',
      src: att,
      name: att.name,
      color: att.color,
      end: att.end,
      convex: att.convex,
      inverse: att.inverse,
      ...compileVertices(polygonVertexCount(att), att.vertices, att.weights, boneIndex),
    };
  } else if (att.type === 'boundingbox') {
    data = {
      kind: 'boundingbox',
      src: att,
      name: att.name,
      color: att.color,
      ...compileVertices(polygonVertexCount(att), att.vertices, att.weights, boneIndex),
    };
  } else if (att.type === 'region') {
    data = {
      kind: 'region',
      src: att,
      name: att.name,
      path: att.path,
      x: att.x,
      y: att.y,
      rotation: att.rotation,
      scaleX: att.scaleX,
      scaleY: att.scaleY,
      width: att.width,
      height: att.height,
      color: att.color,
    };
  } else {
    const vertexCount = att.uvs.length >> 1;
    data = {
      kind: 'mesh',
      src: att,
      name: att.name,
      path: att.path,
      color: att.color,
      width: att.width,
      height: att.height,
      uvs: Float32Array.from(att.uvs),
      triangles: Uint16Array.from(att.triangles),
      hull: att.hull,
      ...compileVertices(vertexCount, att.vertices, att.weights, boneIndex),
    };
  }
  attachmentCache.set(att, { key: boneOrderKey, data });
  return data;
}

/** Packs unweighted (x,y) or weighted (influence) vertex data into the typed arrays `meshWorldVertices` reads. */
function compileVertices(vertexCount: number, vertices: number[], weights: Influence[][] | null, boneIndex: Map<Id, number>): VertexData {
  if (!weights) {
    const positions = Float32Array.from(vertices);
    return { vertexCount, weighted: false, positions, bones: null, deformLength: positions.length };
  }
  let influences = 0;
  const lists: { bone: number; x: number; y: number; w: number }[][] = [];
  for (let i = 0; i < vertexCount; i++) {
    const src = weights[i] ?? [];
    const list: { bone: number; x: number; y: number; w: number }[] = [];
    for (const inf of src) {
      const bi = boneIndex.get(inf[0]);
      if (bi === undefined) continue;
      list.push({ bone: bi, x: inf[1], y: inf[2], w: inf[3] });
    }
    if (list.length === 0) list.push({ bone: 0, x: 0, y: 0, w: 1 });
    influences += list.length;
    lists.push(list);
  }
  const positions = new Float32Array(influences * 3);
  const bones = new Int32Array(vertexCount + influences);
  let p = 0;
  let b = 0;
  for (const list of lists) {
    bones[b++] = list.length;
    for (const inf of list) {
      bones[b++] = inf.bone;
      positions[p++] = inf.x;
      positions[p++] = inf.y;
      positions[p++] = inf.w;
    }
  }
  return { vertexCount, weighted: true, positions, bones, deformLength: influences * 2 };
}

/** Fills `deformSource` and `deformFollowers`: which linked meshes follow the deform of which source. */
function resolveLinkedMeshes(doc: SkeletonDoc, data: SkeletonData) {
  doc.skins.forEach((skin, si) => {
    const compiledSkin = data.skins[si];
    for (const slotId in skin.attachments) {
      const slotIdx = data.slotIndex.get(slotId);
      if (slotIdx === undefined) continue;
      for (const name in skin.attachments[slotId]) {
        const att = skin.attachments[slotId][name];
        if (att.type !== 'mesh' || !att.link?.deform) continue;
        const source = linkSource(doc, slotId, att);
        const sourceIdx = source ? data.slotIndex.get(source.slotId) : undefined;
        if (!source || sourceIdx === undefined) continue;
        const from = compiledSkin.attachments[slotIdx]?.get(name);
        const to = data.skinById.get(source.skin.id)?.attachments[sourceIdx]?.get(att.link.source);
        if (!from || !to) continue;
        data.deformSource.set(from, to);
        if (sourceIdx !== slotIdx) {
          const list = data.deformFollowers.get(to) ?? [];
          if (!list.includes(slotIdx)) list.push(slotIdx);
          data.deformFollowers.set(to, list);
        }
      }
    }
  });
}

const compileMemo = new WeakMap<SkeletonDoc, SkeletonData>();

export function compileSkeleton(doc: SkeletonDoc): SkeletonData {
  const memo = compileMemo.get(doc);
  if (memo) return memo;

  const bonesDoc = parentFirst(doc.bones);
  const boneIndex = new Map<Id, number>();
  bonesDoc.forEach((b, i) => boneIndex.set(b.id, i));
  const boneOrderKey = bonesDoc.map((b) => b.id).join('|');

  // A bone below a "skin required" bone is required too: a skin that does not list the parent leaves it without a matrix, and the
  // official runtime would still update the child on top of it (NaN). Spine's editor marks the children itself; here it is a rule.
  const required = new Set<Id>();
  for (const b of bonesDoc) if (b.skinRequired || (b.parent !== null && required.has(b.parent))) required.add(b.id);
  const bones: BoneData[] = bonesDoc.map((b, i) => ({
    index: i,
    id: b.id,
    name: b.name,
    parent: b.parent !== null ? (boneIndex.get(b.parent) ?? -1) : -1,
    children: [],
    length: b.length,
    x: b.x,
    y: b.y,
    rotation: b.rotation,
    scaleX: b.scaleX,
    scaleY: b.scaleY,
    shearX: b.shearX,
    shearY: b.shearY,
    inherit: b.inherit,
    skinRequired: required.has(b.id),
    color: b.color,
  }));
  for (const b of bones) if (b.parent >= 0) bones[b.parent].children.push(b.index);

  const slotIndex = new Map<Id, number>();
  const slots: SlotData[] = doc.slots.map((s, i) => {
    slotIndex.set(s.id, i);
    return {
      index: i,
      id: s.id,
      name: s.name,
      bone: boneIndex.get(s.bone) ?? 0,
      color: s.color,
      dark: s.dark,
      blend: s.blend,
      attachment: s.attachment,
    };
  });

  const constraintIndex = new Map<Id, number>();
  const constraints: ConstraintData[] = [];
  for (const c of doc.constraints) {
    if (c.type === 'slider') {
      const driver = c.bone === null ? -1 : (boneIndex.get(c.bone) ?? -2);
      if (driver === -2) continue; // dangling driver bone
      const animation = c.animation ? (doc.animations.find((a) => a.id === c.animation) ?? null) : null;
      const animatedBones: number[] = [];
      if (animation) {
        for (const id of Object.keys(animation.bones)) {
          const bi = boneIndex.get(id);
          const tl = animation.bones[id];
          if (bi !== undefined && BONE_PROPS.some((p) => tl[p]?.length)) animatedBones.push(bi);
        }
      }
      constraintIndex.set(c.id, constraints.length);
      constraints.push({
        kind: 'slider',
        index: constraints.length,
        id: c.id,
        name: c.name,
        animation,
        animatedBones,
        additive: c.additive,
        loop: c.loop,
        mix: c.mix,
        time: c.time,
        bone: driver,
        property: c.property,
        from: c.from,
        to: c.to,
        scale: c.scale,
        local: c.local,
        skinRequired: c.skinRequired,
      });
      continue;
    }
    if (c.type === 'physics') {
      const bone = boneIndex.get(c.bone);
      if (bone === undefined) continue; // dangling reference
      constraintIndex.set(c.id, constraints.length);
      constraints.push({
        kind: 'physics',
        index: constraints.length,
        id: c.id,
        name: c.name,
        bone,
        x: c.x,
        y: c.y,
        rotate: c.rotate,
        scaleX: c.scaleX,
        shearX: c.shearX,
        scaleY: c.scaleY,
        limit: c.limit,
        step: 1 / c.fps,
        inertia: c.inertia,
        strength: c.strength,
        damping: c.damping,
        massInverse: 1 / c.mass,
        wind: c.wind,
        gravity: c.gravity,
        mix: c.mix,
        global: { ...c.global },
        skinRequired: c.skinRequired,
      });
      continue;
    }
    const bi = c.bones.map((id) => boneIndex.get(id)).filter((v): v is number => v !== undefined);
    if (c.type === 'path') {
      const slot = slotIndex.get(c.target);
      if (bi.length === 0 || bi.length !== c.bones.length || slot === undefined) continue; // dangling reference
      constraintIndex.set(c.id, constraints.length);
      constraints.push({
        kind: 'path',
        index: constraints.length,
        id: c.id,
        name: c.name,
        bones: bi,
        slot,
        positionMode: c.positionMode,
        spacingMode: c.spacingMode,
        rotateMode: c.rotateMode,
        offsetRotation: c.offsetRotation,
        position: c.position,
        spacing: c.spacing,
        mix: [c.mix.rotate, c.mix.x, c.mix.y],
        skinRequired: c.skinRequired,
      });
      continue;
    }
    if (c.type === 'transform') {
      const source = boneIndex.get(c.source);
      if (bi.length === 0 || bi.length !== c.bones.length || source === undefined) continue;
      constraintIndex.set(c.id, constraints.length);
      constraints.push({
        kind: 'transform',
        index: constraints.length,
        id: c.id,
        name: c.name,
        bones: bi,
        source,
        localSource: c.localSource,
        localTarget: c.localTarget,
        additive: c.additive,
        clamp: c.clamp,
        properties: c.properties.map((f) => ({
          prop: f.prop,
          offset: f.offset,
          to: f.to.map((t) => ({ prop: t.prop, offset: t.offset, max: t.max, scale: t.scale })),
        })),
        offsets: [c.offsets.rotation, c.offsets.x, c.offsets.y, c.offsets.scaleX, c.offsets.scaleY, c.offsets.shearY],
        mix: [c.mix.rotate, c.mix.x, c.mix.y, c.mix.scaleX, c.mix.scaleY, c.mix.shearY],
        skinRequired: c.skinRequired,
      });
      continue;
    }
    const target = boneIndex.get(c.target);
    if (bi.length === 0 || bi.length !== c.bones.length || target === undefined) continue; // dangling reference
    constraintIndex.set(c.id, constraints.length);
    constraints.push({
      kind: 'ik',
      index: constraints.length,
      id: c.id,
      name: c.name,
      bones: bi,
      target,
      mix: c.mix,
      softness: c.softness,
      bendDirection: c.bendPositive ? 1 : -1,
      compress: c.compress,
      stretch: c.stretch,
      scaleY: c.scaleY,
      skinRequired: c.skinRequired,
    });
  }

  const skinById = new Map<Id, SkinData>();
  const pathEntries: { att: PathAttachmentData; slot: number }[] = [];
  const skins: SkinData[] = doc.skins.map((s) => {
    const perSlot: Map<string, AttachmentData>[] = slots.map(() => new Map<string, AttachmentData>());
    for (const slotId in s.attachments) {
      const si = slotIndex.get(slotId);
      if (si === undefined) continue;
      const atts = s.attachments[slotId];
      for (const name in atts) {
        const compiled = compileAttachment(atts[name], boneIndex, boneOrderKey);
        if (compiled.kind === 'path') {
          // the lengths depend on the setup pose of THIS document, so every compile gets its own copy of the data
          const own: PathAttachmentData = { ...compiled, lengths: [] };
          pathEntries.push({ att: own, slot: si });
          perSlot[si].set(name, own);
        } else perSlot[si].set(name, compiled);
      }
    }
    const skin: SkinData = {
      id: s.id,
      name: s.name,
      attachments: perSlot,
      bones: s.bones.map((id) => boneIndex.get(id)).filter((v): v is number => v !== undefined),
      constraints: s.constraints.map((id) => constraintIndex.get(id)).filter((v): v is number => v !== undefined),
    };
    skinById.set(s.id, skin);
    return skin;
  });
  const defaultSkin = skins[0] ?? {
    id: '',
    name: 'default',
    attachments: slots.map(() => new Map<string, AttachmentData>()),
    bones: [],
    constraints: [],
  };

  const data: SkeletonData = {
    name: doc.name,
    fps: doc.fps,
    referenceScale: doc.referenceScale ?? 100,
    bones,
    slots,
    skins,
    defaultSkin,
    constraints,
    boneIndex,
    slotIndex,
    constraintIndex,
    skinById,
    deformSource: new Map(),
    deformFollowers: new Map(),
    boneOrderKey,
    folders: (doc.drawOrderFolders ?? []).map((f) => ({
      id: f.id,
      slots: f.slots
        .map((s) => slotIndex.get(s))
        .filter((i): i is number => i !== undefined)
        .sort((a, b) => a - b),
    })),
  };
  if (hasLinkedMeshes(doc)) resolveLinkedMeshes(doc, data);
  if (pathEntries.length) fillPathLengths(data, pathEntries);
  compileMemo.set(doc, data);
  return data;
}

/** Measures the curves of every path attachment in the setup pose (animation and constraints ignored). */
function fillPathLengths(data: SkeletonData, entries: { att: PathAttachmentData; slot: number }[]) {
  const sk = new Skeleton(data);
  sk.updateId = 1;
  for (const b of sk.bones) {
    b.ax = b.x;
    b.ay = b.y;
    b.arotation = b.rotation;
    b.ascaleX = b.scaleX;
    b.ascaleY = b.scaleY;
    b.ashearX = b.shearX;
    b.ashearY = b.shearY;
    b.updateWorldTransform();
  }
  const points: number[] = [];
  for (const { att, slot } of entries) {
    meshWorldVertices(sk, sk.slots[slot], att, null, points);
    att.lengths = pathCurveLengths(points, Math.floor(att.vertexCount / 3), att.closed);
  }
}
