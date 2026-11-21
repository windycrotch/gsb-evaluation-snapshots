/**
 * The demo character "Kit": a fox with a fluffy tail, a scarf and ears, in two skins (a red fox and an arctic one).
 *
 * `buildDemoRig` makes the whole project from data: bones, slots, weighted meshes, two IK legs, seven physics constraints (tail, ears,
 * scarf), two skins, four animations (idle, walk, wave, jump) with blinking and events. It does not touch the DOM:
 * the pictures are drawn by art.ts from the same outlines (DEMO_PARTS), and tests/demo.test.ts validates, exports, loads the rig into the official
 * runtime and plays it.
 */
import { emptyProject, newAnimation, newBone, newPhysicsConstraint, newSkin, newSlot } from '@/core/model';
import type {
  Animation,
  Bone,
  Constraint,
  ImageRef,
  Inherit,
  MeshAttachment,
  Project,
  RegionAttachment,
  RGBA,
  Timeline,
} from '@/core/model';
import { uid } from '@/core/ids';
import { adjacency, bindMesh, interiorPoints, smoothWeights, subdivideOutline, triangulate } from '@/core/mesh';
import type { BoneMats } from '@/core/mesh';
import { compileSkeleton, createSkeleton } from '@/core/skeleton';
import { ellipse, pictureBox, spline, translate, tube } from './geometry';
import type { Pt } from './geometry';

interface BoneSpec {
  name: string;
  parent: string | null;
  x: number;
  y: number;
  /** World rotation in degrees (CCW). */
  angle: number;
  length: number;
  inherit?: Inherit;
  color: RGBA;
}

const rad = (d: number) => (d * Math.PI) / 180;

const SPINE: RGBA = [0.95, 0.95, 0.95, 1];
const LIMB: RGBA = [0.55, 0.8, 1, 1];
const SOFT: RGBA = [1, 0.62, 0.26, 1];
const IKC: RGBA = [1, 0.48, 0.35, 1];

const BONES: BoneSpec[] = [];
const WORLD = new Map<string, BoneSpec>();

function bone(name: string, parent: string | null, at: Pt | 'tip', angle: number, length: number, color: RGBA, inherit?: Inherit) {
  let x: number;
  let y: number;
  if (at === 'tip') {
    const p = WORLD.get(parent!)!;
    x = p.x + Math.cos(rad(p.angle)) * p.length;
    y = p.y + Math.sin(rad(p.angle)) * p.length;
  } else [x, y] = at;
  const spec: BoneSpec = { name, parent, x, y, angle, length, color, inherit };
  BONES.push(spec);
  WORLD.set(name, spec);
}

bone('root', null, [0, 0], 0, 0, SPINE);
bone('hip', 'root', [0, 96], 90, 40, SPINE);
bone('torso', 'hip', 'tip', 90, 64, SPINE);
bone('head', 'torso', 'tip', 78, 46, SPINE);
bone('ear near', 'head', [16, 268], 72, 36, SOFT);
bone('ear far', 'head', [-8, 268], 102, 34, SOFT);
bone('tail 1', 'hip', [-12, 104], 160, 50, SOFT);
bone('tail 2', 'tail 1', 'tip', 150, 50, SOFT);
bone('tail 3', 'tail 2', 'tip', 135, 46, SOFT);
bone('scarf 1', 'torso', [-12, 196], 200, 36, [0.2, 0.83, 0.66, 1]);
bone('scarf 2', 'scarf 1', 'tip', 215, 30, [0.2, 0.83, 0.66, 1]);
bone('arm near 1', 'torso', [8, 176], -90, 46, LIMB);
bone('arm near 2', 'arm near 1', 'tip', -90, 42, LIMB);
bone('hand near', 'arm near 2', 'tip', -90, 16, LIMB);
bone('arm far 1', 'torso', [-6, 176], -90, 46, LIMB);
bone('arm far 2', 'arm far 1', 'tip', -90, 42, LIMB);
bone('hand far', 'arm far 2', 'tip', -90, 16, LIMB);
// legs: the angles are the solution of the IK constraint for a foot at (6, 4): knees bend forward
bone('leg near 1', 'hip', [4, 92], -63.2, 50, LIMB);
bone('leg near 2', 'leg near 1', 'tip', -115.4, 48, LIMB);
bone('foot near', 'leg near 2', 'tip', 0, 28, LIMB, 'noRotationOrReflection');
bone('leg far 1', 'hip', [-6, 92], -63.2, 50, LIMB);
bone('leg far 2', 'leg far 1', 'tip', -115.4, 48, LIMB);
bone('foot far', 'leg far 2', 'tip', 0, 28, LIMB, 'noRotationOrReflection');
bone('ik near', 'root', [6, 4], 0, 0, IKC);
bone('ik far', 'root', [-4, 4], 0, 0, IKC);

/** A point given in the frame of a bone (x along the bone) as a point of the world. */
function fromBone(name: string, pts: Pt[]): Pt[] {
  const b = WORLD.get(name)!;
  const c = Math.cos(rad(b.angle));
  const s = Math.sin(rad(b.angle));
  return pts.map(([x, y]) => [b.x + x * c - y * s, b.y + x * s + y * c]);
}

export type ArtKind =
  'body' | 'head' | 'tail' | 'arm' | 'leg' | 'foot' | 'hand' | 'ear' | 'scarfTail' | 'scarfRing' | 'eyeOpen' | 'eyeClosed';

export interface PartDef {
  /** The picture: `fox-body`, `arctic-body`, or a shared one such as `scarf-ring`. */
  kind: ArtKind;
  /** The silhouette in world coordinates. */
  shape: Pt[];
  /** Extra outlines for the art (belly patch, inner ear, tail tip ...), world coordinates. */
  extra: Pt[][];
  /** Shared by both skins. */
  shared: boolean;
}

function centreLine(joints: Pt[], per = 8): Pt[] {
  return spline(joints, false, per);
}

export const tailJoints = (): Pt[] => {
  const t1 = WORLD.get('tail 1')!;
  const t2 = WORLD.get('tail 2')!;
  const t3 = WORLD.get('tail 3')!;
  const tip = (b: BoneSpec): Pt => [b.x + Math.cos(rad(b.angle)) * b.length, b.y + Math.sin(rad(b.angle)) * b.length];
  return [[t1.x, t1.y], [t2.x, t2.y], [t3.x, t3.y], tip(t3)];
};
const tailRadius = (t: number) =>
  t < 0.55 ? 11 + 15 * Math.sin((t / 0.55) * (Math.PI / 2)) : 26 * Math.max(0, 1 - Math.pow((t - 0.55) / 0.45, 1.7)) + 1.5;

const scarfJoints = (): Pt[] => {
  const s1 = WORLD.get('scarf 1')!;
  const s2 = WORLD.get('scarf 2')!;
  const tip = (b: BoneSpec): Pt => [b.x + Math.cos(rad(b.angle)) * b.length, b.y + Math.sin(rad(b.angle)) * b.length];
  return [[s1.x, s1.y], [s2.x, s2.y], tip(s2)];
};

const ARM_X = 8;
const FAR_DX = -14; // the far arm and leg are the near ones moved back
const LEG_DX = -10;

const legCentre = (): Pt[] =>
  centreLine(
    [
      [4, 92],
      [26.6, 47.4],
      [6, 4],
    ],
    10,
  );
const legRadius = (t: number) => 15 - 6 * t;
const armCentre = (): Pt[] =>
  centreLine(
    [
      [ARM_X, 178],
      [ARM_X, 130],
      [ARM_X, 90],
    ],
    8,
  );
const armRadius = (t: number) => 11 - 3 * t;

const HEAD_POINTS: Pt[] = [
  [-26, 232],
  [-24, 252],
  [-12, 268],
  [10, 276],
  [30, 270],
  [46, 256],
  [62, 241],
  [78, 232],
  [80, 224],
  [72, 217],
  [54, 214],
  [42, 208],
  [24, 203],
  [4, 204],
  [-14, 210],
  [-30, 222],
];

const earShape = (name: string): Pt[] =>
  fromBone(
    name,
    spline(
      [
        [-6, -13],
        [10, -14],
        [26, -9],
        [36, 0],
        [26, 9],
        [10, 14],
        [-6, 13],
      ],
      true,
      4,
    ),
  );
const earInner = (name: string): Pt[] =>
  fromBone(
    name,
    spline(
      [
        [2, -7],
        [14, -7],
        [26, -3],
        [31, 0],
        [26, 3],
        [14, 7],
        [2, 7],
      ],
      true,
      4,
    ),
  );

export const PARTS: Record<string, PartDef> = {
  tail: { kind: 'tail', shape: tube(centreLine(tailJoints(), 10), tailRadius), extra: [], shared: false },
  body: { kind: 'body', shape: ellipse(2, 141, 44, 72, 36), extra: [ellipse(14, 136, 25, 50, 28)], shared: false },
  head: { kind: 'head', shape: spline(HEAD_POINTS, true, 5), extra: [], shared: false },
  arm: { kind: 'arm', shape: tube(armCentre(), armRadius), extra: [], shared: false },
  leg: { kind: 'leg', shape: tube(legCentre(), legRadius), extra: [], shared: false },
  hand: { kind: 'hand', shape: ellipse(ARM_X, 80, 11, 12, 20), extra: [], shared: false },
  foot: {
    kind: 'foot',
    shape: translate(
      spline(
        [
          [-8, -4],
          [-9, 10],
          [2, 15],
          [18, 14],
          [30, 8],
          [35, 0],
          [32, -4],
        ],
        true,
        4,
      ),
      6,
      4,
    ),
    extra: [],
    shared: false,
  },
  'ear near': { kind: 'ear', shape: earShape('ear near'), extra: [earInner('ear near')], shared: false },
  'ear far': { kind: 'ear', shape: earShape('ear far'), extra: [earInner('ear far')], shared: false },
  'scarf tail': { kind: 'scarfTail', shape: tube(centreLine(scarfJoints(), 8), (t) => 11 - 3 * t, 0), extra: [], shared: true },
  'scarf ring': { kind: 'scarfRing', shape: ellipse(0, 198, 35, 15, 28), extra: [], shared: true },
  'eye open': { kind: 'eyeOpen', shape: ellipse(36, 246, 7, 9.5, 18), extra: [], shared: true },
  'eye closed': {
    kind: 'eyeClosed',
    shape: spline(
      [
        [28, 246],
        [36, 241],
        [44, 246],
        [36, 244.5],
      ],
      true,
      4,
    ),
    extra: [],
    shared: true,
  },
};

/** The picture box of a part (world coordinates; the picture is drawn into exactly this box). */
export function partBox(part: string) {
  const p = PARTS[part];
  return pictureBox([p.shape, ...p.extra], 4);
}

/** Every picture of the demo with its size: art.ts draws them, `loadSample` registers them, `buildDemoRig` refers to them. */
const SKINS = ['fox', 'arctic'] as const;
export type SkinName = (typeof SKINS)[number];
const imageName = (part: string, skin: SkinName) => (PARTS[part].shared ? part.replace(' ', '-') : `${skin}-${part.replace(' ', '-')}`);

export const DEMO_IMAGES: { name: string; part: string; skin: SkinName | null; width: number; height: number }[] = [];
for (const part of Object.keys(PARTS)) {
  const { width, height } = partBox(part);
  if (PARTS[part].shared) DEMO_IMAGES.push({ name: imageName(part, 'fox'), part, skin: null, width, height });
  else for (const skin of SKINS) DEMO_IMAGES.push({ name: imageName(part, skin), part, skin, width, height });
}

interface SlotSpec {
  name: string;
  bone: string;
  /** The part whose picture it shows; the geometry is moved by `offset` (the far limbs are the near ones moved back). */
  part: string;
  offset?: Pt;
  /** For a mesh: the bones that move it. */
  chain?: string[];
  spacing?: number;
  blend?: number;
  color?: RGBA;
}

const SHADE: RGBA = [0.8, 0.8, 0.88, 1];

const SLOTS: SlotSpec[] = [
  { name: 'ear far', bone: 'ear far', part: 'ear far', color: SHADE },
  {
    name: 'arm far',
    bone: 'arm far 1',
    part: 'arm',
    offset: [FAR_DX, 0],
    chain: ['arm far 1', 'arm far 2'],
    spacing: 12,
    blend: 10,
    color: SHADE,
  },
  { name: 'hand far', bone: 'hand far', part: 'hand', offset: [FAR_DX, 0], color: SHADE },
  // the tail is between the two arms: in front of the far one, behind the body and the near one
  { name: 'tail', bone: 'tail 1', part: 'tail', chain: ['tail 1', 'tail 2', 'tail 3'], spacing: 20, blend: 16 },
  {
    name: 'leg far',
    bone: 'leg far 1',
    part: 'leg',
    offset: [LEG_DX, 0],
    chain: ['leg far 1', 'leg far 2'],
    spacing: 12,
    blend: 12,
    color: SHADE,
  },
  { name: 'foot far', bone: 'foot far', part: 'foot', offset: [LEG_DX, 0], color: SHADE },
  { name: 'leg near', bone: 'leg near 1', part: 'leg', chain: ['leg near 1', 'leg near 2'], spacing: 12, blend: 12 },
  { name: 'foot near', bone: 'foot near', part: 'foot' },
  { name: 'body', bone: 'torso', part: 'body', chain: ['hip', 'torso'], spacing: 26, blend: 24 },
  { name: 'scarf tail', bone: 'scarf 1', part: 'scarf tail', chain: ['scarf 1', 'scarf 2'], spacing: 12, blend: 8 },
  { name: 'scarf', bone: 'torso', part: 'scarf ring' },
  { name: 'head', bone: 'head', part: 'head', chain: ['torso', 'head'], spacing: 22, blend: 14 },
  { name: 'ear near', bone: 'ear near', part: 'ear near' },
  { name: 'eye', bone: 'head', part: 'eye open' },
  { name: 'arm near', bone: 'arm near 1', part: 'arm', chain: ['arm near 1', 'arm near 2'], spacing: 12, blend: 10 },
  { name: 'hand near', bone: 'hand near', part: 'hand' },
];

interface Seg {
  id: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/**
 * Weights for a mesh moved by a chain of bones: a vertex takes the bone whose stretch of the chain it is nearest to; around a joint the two
 * bones blend over `blend` units, so a knee or an elbow bends smoothly and the rest stays rigid.
 */
function chainWeights(world: ArrayLike<number>, segs: Seg[], blend: number): { bone: string; w: number }[][] {
  const lens = segs.map((s) => Math.hypot(s.bx - s.ax, s.by - s.ay));
  const starts: number[] = [];
  let acc = 0;
  for (const l of lens) {
    starts.push(acc);
    acc += l;
  }
  const out: { bone: string; w: number }[][] = [];
  for (let i = 0; i < world.length / 2; i++) {
    const px = world[i * 2];
    const py = world[i * 2 + 1];
    // the position of the vertex along the chain: the closest point of any segment
    let best = Infinity;
    let at = 0;
    segs.forEach((s, k) => {
      const dx = s.bx - s.ax;
      const dy = s.by - s.ay;
      const l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((px - s.ax) * dx + (py - s.ay) * dy) / l2));
      const d = Math.hypot(px - (s.ax + dx * t), py - (s.ay + dy * t));
      if (d < best) {
        best = d;
        at = starts[k] + t * lens[k];
      }
    });
    const list: { bone: string; w: number }[] = [];
    segs.forEach((s, k) => {
      const lo = starts[k];
      const hi = starts[k] + lens[k];
      // 1 inside the bone's stretch, fading out over `blend` units on either side of it (the ends of the chain extend for ever)
      const before = k === 0 ? 1 : Math.max(0, Math.min(1, (at - (lo - blend / 2)) / blend));
      const after = k === segs.length - 1 ? 1 : Math.max(0, Math.min(1, (hi + blend / 2 - at) / blend));
      const w = Math.min(before, after);
      if (w > 1e-3) list.push({ bone: s.id, w });
    });
    const sum = list.reduce((a, e) => a + e.w, 0) || 1;
    out.push(list.map((e) => ({ bone: e.bone, w: e.w / sum })));
  }
  return out;
}

const EASE = [0.35, 0, 0.65, 1];
type KeyIn = [time: number, value: number[], ease?: boolean];

/** A timeline from [time, value, eased] rows; an eased key blends into the next one with a bezier (one copy of the curve per channel). */
function line(rows: KeyIn[], channels = 1): Timeline {
  return rows.map(([time, value, eased]) => ({
    time,
    value,
    ...(eased ? { curve: Array.from({ length: channels }, () => EASE).flat() } : {}),
  }));
}

export function buildDemoRig(images: Record<string, ImageRef>): Project {
  const project = emptyProject('kit');
  project.images = Object.values(images);
  const doc = project.skeleton;
  doc.fps = 30;
  doc.name = 'kit';

  // bones: local values from the world ones
  const made = new Map<string, Bone>();
  const root = doc.bones[0]; // emptyProject starts with a root
  root.name = 'root';
  made.set('root', root);
  for (const spec of BONES.slice(1)) {
    const parent = WORLD.get(spec.parent!)!;
    const pa = parent.angle;
    const dx = spec.x - parent.x;
    const dy = spec.y - parent.y;
    const lx = Math.cos(rad(pa)) * dx + Math.sin(rad(pa)) * dy;
    const ly = -Math.sin(rad(pa)) * dx + Math.cos(rad(pa)) * dy;
    const own = spec.inherit === 'noRotationOrReflection' ? spec.angle : spec.angle - pa;
    const b = newBone({
      name: spec.name,
      parent: made.get(spec.parent!)!.id,
      x: lx,
      y: ly,
      rotation: own,
      length: spec.length,
      color: spec.color,
      ...(spec.inherit ? { inherit: spec.inherit } : {}),
    });
    made.set(spec.name, b);
    doc.bones.push(b);
  }
  const id = (name: string) => made.get(name)!.id;

  // the legs
  const ik = (name: string, a: string, b: string, target: string): Constraint => ({
    id: uid(),
    type: 'ik',
    name,
    bones: [id(a), id(b)],
    target: id(target),
    mix: 1,
    softness: 0,
    bendPositive: false,
    compress: false,
    stretch: true,
    scaleY: 'none',
    skinRequired: false,
  });
  doc.constraints.push(ik('leg near', 'leg near 1', 'leg near 2', 'ik near'), ik('leg far', 'leg far 1', 'leg far 2', 'ik far'));

  // physics: the tail follows with a delay, the ears flick, the scarf flutters
  const physics = (
    name: string,
    boneName: string,
    p: { inertia: number; strength: number; damping: number; mass: number; wind?: number; gravity?: number },
  ) => newPhysicsConstraint({ name, bone: id(boneName), rotate: 1, x: 0, y: 0, scaleX: 0, shearX: 0, mix: 1, ...p });
  doc.constraints.push(
    physics('tail 1', 'tail 1', { inertia: 0.6, strength: 160, damping: 0.9, mass: 1.4 }),
    physics('tail 2', 'tail 2', { inertia: 0.7, strength: 110, damping: 0.88, mass: 1 }),
    physics('tail 3', 'tail 3', { inertia: 0.8, strength: 70, damping: 0.86, mass: 0.8 }),
    physics('ear near', 'ear near', { inertia: 0.8, strength: 120, damping: 0.7, mass: 0.6 }),
    physics('ear far', 'ear far', { inertia: 0.8, strength: 120, damping: 0.7, mass: 0.6 }),
    physics('scarf 1', 'scarf 1', { inertia: 0.7, strength: 60, damping: 0.82, mass: 0.8, wind: -6, gravity: 10 }),
    physics('scarf 2', 'scarf 2', { inertia: 0.75, strength: 40, damping: 0.8, mass: 0.7, wind: -6, gravity: 10 }),
  );

  // the setup pose with the constraints applied: what the meshes are bound to
  // compiled from a copy: the compile is memoised by document identity and `doc` gets slots and skins below
  const setup = createSkeleton(compileSkeleton(structuredClone(doc)));
  setup.updateWorldTransform('none');
  const mats: BoneMats = new Map();
  const tips = new Map<string, Seg>();
  for (const b of setup.bones) {
    mats.set(b.data.id, { a: b.a, b: b.b, c: b.c, d: b.d, x: b.worldX, y: b.worldY });
    tips.set(b.data.id, { id: b.data.id, ax: b.worldX, ay: b.worldY, bx: b.tipX, by: b.tipY });
  }
  const mat = (name: string) => mats.get(id(name))!;

  const regionOf = (slot: SlotSpec, imgName: string, partName: string): RegionAttachment => {
    const box = partBox(partName);
    const off = slot.offset ?? [0, 0];
    const m = mat(slot.bone);
    const cx = (box.x0 + box.x1) / 2 + off[0];
    const cy = (box.y0 + box.y1) / 2 + off[1];
    // the world point in the slot bone's frame; the picture is upright in the world, so it turns against the bone
    const det = m.a * m.d - m.b * m.c;
    const dx = cx - m.x;
    const dy = cy - m.y;
    const lx = (m.d * dx - m.b * dy) / det;
    const ly = (-m.c * dx + m.a * dy) / det;
    const angle = (-Math.atan2(m.c, m.a) * 180) / Math.PI;
    return {
      type: 'region',
      name: slot.name,
      path: imgName,
      x: lx,
      y: ly,
      rotation: angle,
      scaleX: 1,
      scaleY: 1,
      width: box.width,
      height: box.height,
      color: [1, 1, 1, 1],
    };
  };

  const meshOf = (slot: SlotSpec, imgName: string, partName: string): MeshAttachment => {
    const part = PARTS[partName];
    const box = partBox(partName);
    const off = slot.offset ?? [0, 0];
    const spacing = slot.spacing ?? 20;
    const hull = subdivideOutline(translate(part.shape, off[0], off[1]), spacing * 1.6);
    const inner = interiorPoints(hull, spacing);
    const pts = [...hull, ...inner];
    const world = pts.flatMap((p) => p);
    const triangles = triangulate(world, hull.length);
    const uvs: number[] = [];
    for (const [x, y] of pts) uvs.push((x - off[0] - box.x0) / box.width, (box.y1 - (y - off[1])) / box.height);
    const m = mat(slot.bone);
    const det = m.a * m.d - m.b * m.c;
    const vertices: number[] = [];
    for (const [x, y] of pts) {
      const dx = x - m.x;
      const dy = y - m.y;
      vertices.push((m.d * dx - m.b * dy) / det, (-m.c * dx + m.a * dy) / det);
    }
    const plain: MeshAttachment = {
      type: 'mesh',
      name: slot.name,
      path: imgName,
      color: [1, 1, 1, 1],
      width: box.width,
      height: box.height,
      uvs,
      triangles,
      hull: hull.length,
      edges: [],
      vertices,
      weights: null,
    };
    const segs = slot.chain!.map((n) => tips.get(id(n))!);
    let w = chainWeights(world, segs, slot.blend ?? 12);
    w = smoothWeights(w, adjacency(triangles, pts.length), 1, 0.35);
    return bindMesh(plain, m, mats, w);
  };

  const fox = doc.skins[0];
  const arctic = newSkin('arctic');
  doc.skins.push(arctic);
  for (const spec of SLOTS) {
    const slot = newSlot({ name: spec.name, bone: id(spec.bone), color: spec.color ?? [1, 1, 1, 1] });
    doc.slots.push(slot);
    const part = PARTS[spec.part];
    const attachmentFor = (skin: SkinName) => {
      const imgName = imageName(spec.part, skin);
      return spec.chain ? meshOf(spec, imgName, spec.part) : regionOf(spec, imgName, spec.part);
    };
    fox.attachments[slot.id] = {};
    if (spec.part === 'eye open') {
      // the eye has two pictures: open and closed; the blink swaps them
      const open = regionOf(spec, 'eye-open', 'eye open');
      open.name = 'open';
      const closed = regionOf(spec, 'eye-closed', 'eye closed');
      closed.name = 'closed';
      fox.attachments[slot.id] = { open, closed };
      slot.attachment = 'open';
      continue;
    }
    const att = attachmentFor('fox');
    fox.attachments[slot.id] = { [att.name]: att };
    slot.attachment = att.name;
    if (!part.shared) {
      const other = attachmentFor('arctic');
      arctic.attachments[slot.id] = { [other.name]: other };
    }
  }
  const slotId = (name: string) => doc.slots.find((s) => s.name === name)!.id;

  // events
  const ev = (name: string, extra: { int?: number; string?: string }) => {
    const e = { id: uid(), name, int: extra.int ?? 0, float: 0, string: extra.string ?? '' };
    doc.events.push(e);
    return e.id;
  };
  const stepEvent = ev('step', { int: 1 });
  const jumpEvent = ev('jump', {});
  const landEvent = ev('land', {});
  const waveEvent = ev('wave', { string: 'hello' });

  const rot = (a: Animation, boneName: string, rows: KeyIn[]) => ((a.bones[id(boneName)] ??= {}).rotate = line(rows));
  const move = (a: Animation, boneName: string, rows: KeyIn[]) => ((a.bones[id(boneName)] ??= {}).translate = line(rows, 2));
  const eye = (a: Animation, rows: [number, 'open' | 'closed'][]) =>
    ((a.slots[slotId('eye')] ??= {}).attachment = rows.map(([time, name]) => ({ time, name })));
  // ---- idle: breathing, a nod, an ear flick, two blinks
  const idle = newAnimation('idle', 2.4);
  move(idle, 'hip', [
    [0, [0, 0], true],
    [1.2, [0, -3], true],
    [2.4, [0, 0]],
  ]);
  rot(idle, 'torso', [
    [0, [0], true],
    [1.2, [-1.5], true],
    [2.4, [0]],
  ]);
  rot(idle, 'head', [
    [0, [0], true],
    [0.9, [2], true],
    [1.7, [-2.5], true],
    [2.4, [0]],
  ]);
  rot(idle, 'arm near 1', [
    [0, [0], true],
    [1.2, [2.5], true],
    [2.4, [0]],
  ]);
  rot(idle, 'arm near 2', [
    [0, [0], true],
    [1.2, [-4], true],
    [2.4, [0]],
  ]);
  rot(idle, 'arm far 1', [
    [0, [0], true],
    [1.2, [-2.5], true],
    [2.4, [0]],
  ]);
  rot(idle, 'arm far 2', [
    [0, [0], true],
    [1.2, [3], true],
    [2.4, [0]],
  ]);
  rot(idle, 'tail 1', [
    [0, [0], true],
    [1, [3], true],
    [2, [-3], true],
    [2.4, [0]],
  ]);
  rot(idle, 'ear near', [
    [0, [0]],
    [1.5, [0], true],
    [1.58, [-14], true],
    [1.72, [0], true],
    [2.4, [0]],
  ]);
  eye(idle, [
    [0, 'open'],
    [1.1, 'closed'],
    [1.2, 'open'],
    [1.9, 'closed'],
    [1.98, 'open'],
    [2.06, 'closed'],
    [2.14, 'open'],
  ]);

  // ---- walk: a loop of two steps; the feet are IK targets
  const walk = newAnimation('walk', 0.9);
  move(walk, 'hip', [
    [0, [0, -5], true],
    [0.225, [0, 3], true],
    [0.45, [0, -5], true],
    [0.675, [0, 3], true],
    [0.9, [0, -5]],
  ]);
  rot(walk, 'hip', [
    [0, [-2], true],
    [0.45, [2], true],
    [0.9, [-2]],
  ]);
  rot(walk, 'torso', [
    [0, [-3], true],
    [0.45, [1], true],
    [0.9, [-3]],
  ]);
  rot(walk, 'head', [
    [0, [3], true],
    [0.45, [-1], true],
    [0.9, [3]],
  ]);
  rot(walk, 'arm near 1', [
    [0, [-24], true],
    [0.45, [24], true],
    [0.9, [-24]],
  ]);
  rot(walk, 'arm near 2', [
    [0, [-6], true],
    [0.45, [28], true],
    [0.9, [-6]],
  ]);
  rot(walk, 'arm far 1', [
    [0, [24], true],
    [0.45, [-24], true],
    [0.9, [24]],
  ]);
  rot(walk, 'arm far 2', [
    [0, [28], true],
    [0.45, [-6], true],
    [0.9, [28]],
  ]);
  rot(walk, 'tail 1', [
    [0, [4], true],
    [0.45, [-4], true],
    [0.9, [4]],
  ]);
  move(walk, 'ik near', [
    [0, [22, 0]],
    [0.45, [-22, 0], true],
    [0.675, [0, 18], true],
    [0.9, [22, 0]],
  ]);
  move(walk, 'ik far', [
    [0, [-22, 0], true],
    [0.225, [0, 18], true],
    [0.45, [22, 0]],
    [0.9, [-22, 0]],
  ]);
  walk.events = [
    { time: 0, event: stepEvent, int: 1 },
    { time: 0.45, event: stepEvent, int: 2 },
  ];

  // ---- wave: the near arm waves, the far arm stays behind the body and only lifts a little, the eyes smile
  const wave = newAnimation('wave', 2);
  rot(wave, 'arm near 1', [
    [0, [0], true],
    [0.35, [125], true],
    [1.5, [125], true],
    [2, [0]],
  ]);
  rot(wave, 'arm near 2', [
    [0, [0], true],
    [0.35, [-12], true],
    [0.6, [26], true],
    [0.85, [-26], true],
    [1.1, [26], true],
    [1.35, [-26], true],
    [1.55, [-8], true],
    [2, [0]],
  ]);
  rot(wave, 'torso', [
    [0, [0], true],
    [0.35, [-3], true],
    [1.5, [-3], true],
    [2, [0]],
  ]);
  rot(wave, 'head', [
    [0, [0], true],
    [0.35, [6], true],
    [1.5, [6], true],
    [2, [0]],
  ]);
  rot(wave, 'ear near', [
    [0, [0], true],
    [0.4, [12], true],
    [0.8, [-4], true],
    [1.4, [8], true],
    [2, [0]],
  ]);
  rot(wave, 'arm far 1', [
    [0, [0], true],
    [0.3, [12], true],
    [1.7, [12], true],
    [2, [0]],
  ]);
  rot(wave, 'arm far 2', [
    [0, [0], true],
    [0.3, [8], true],
    [1.7, [8], true],
    [2, [0]],
  ]);
  eye(wave, [
    [0, 'open'],
    [0.5, 'closed'],
    [1.45, 'open'],
  ]);
  wave.events = [{ time: 0.45, event: waveEvent, string: 'hello' }];

  // ---- jump: crouch, spring, tuck, land; the tail, the ears and the scarf follow by physics
  const jump = newAnimation('jump', 1.3);
  move(jump, 'hip', [
    [0, [0, 0], true],
    [0.28, [0, -26], true],
    [0.46, [0, 12], true],
    [0.66, [0, 50], true],
    [0.86, [0, -14], true],
    [1.04, [0, -4], true],
    [1.3, [0, 0]],
  ]);
  rot(jump, 'torso', [
    [0, [0], true],
    [0.28, [10], true],
    [0.46, [-6], true],
    [0.66, [-4], true],
    [0.86, [8], true],
    [1.04, [2], true],
    [1.3, [0]],
  ]);
  rot(jump, 'head', [
    [0, [0], true],
    [0.28, [-6], true],
    [0.5, [5], true],
    [0.66, [6], true],
    [0.86, [-5], true],
    [1.3, [0]],
  ]);
  rot(jump, 'arm near 1', [
    [0, [0], true],
    [0.28, [-35], true],
    [0.5, [85], true],
    [0.66, [110], true],
    [0.86, [20], true],
    [1.3, [0]],
  ]);
  rot(jump, 'arm far 1', [
    [0, [0], true],
    [0.28, [-30], true],
    [0.5, [80], true],
    [0.66, [105], true],
    [0.86, [15], true],
    [1.3, [0]],
  ]);
  rot(jump, 'tail 1', [
    [0, [0], true],
    [0.28, [-8], true],
    [0.5, [14], true],
    [0.66, [10], true],
    [0.86, [-10], true],
    [1.3, [0]],
  ]);
  rot(jump, 'ear near', [
    [0, [0], true],
    [0.28, [6], true],
    [0.5, [-18], true],
    [0.66, [-10], true],
    [0.86, [14], true],
    [1.3, [0]],
  ]);
  const tuck = (dx: number): KeyIn[] => [
    [0, [0, 0]],
    [0.4, [0, 0], true],
    [0.5, [0, 10], true],
    [0.66, [dx, 44], true],
    [0.82, [0, 20], true],
    [0.88, [0, 0], true],
    [1.3, [0, 0]],
  ];
  move(jump, 'ik near', tuck(6));
  move(jump, 'ik far', tuck(-6));
  eye(jump, [
    [0, 'open'],
    [0.2, 'closed'],
    [0.42, 'open'],
    [0.84, 'closed'],
    [1, 'open'],
  ]);
  jump.events = [
    { time: 0.46, event: jumpEvent },
    { time: 0.84, event: landEvent },
  ];

  doc.animations.push(idle, walk, wave, jump);
  return project;
}
