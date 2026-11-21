/** A deliberately nasty test rig: inherit modes, shear, IK (1 and 2 bone), weighted + unweighted meshes, every timeline kind. */
import {
  DEFAULT_BOUNDING_BOX_COLOR,
  DEFAULT_CLIPPING_COLOR,
  DEFAULT_POINT_COLOR,
  emptyProject,
  newAnimation,
  newBone,
  newSkin,
  newSliderConstraint,
  newSlot,
  newTransformConstraint,
} from '../src/core/model';
import type {
  Attachment,
  Bone,
  ClippingAttachment,
  Id,
  IkKey,
  Influence,
  MeshAttachment,
  Project,
  RegionAttachment,
  Timeline,
} from '../src/core/model';
import { compileSkeleton, createSkeleton } from '../src/core/skeleton';
import { uid } from '../src/core/ids';

export interface Fixture {
  project: Project;
  images: { name: string; width: number; height: number }[];
}

function region(name: string, x: number, y: number, w: number, h: number, rotation = 0): RegionAttachment {
  return { type: 'region', name, path: name, x, y, rotation, scaleX: 1, scaleY: 1, width: w, height: h, color: [1, 1, 1, 1] };
}

export function buildFixture(): Fixture {
  const project = emptyProject('fixture');
  const doc = project.skeleton;
  const root = doc.bones[0];
  const by: Record<string, Bone> = { root };
  const add = (name: string, parent: string, p: Partial<Bone> = {}) => {
    const b = newBone({ name, parent: by[parent].id, length: 40, ...p });
    by[name] = b;
    doc.bones.push(b);
    return b;
  };
  add('torso', 'root', { x: 0, y: 120, rotation: 90, length: 80 });
  add('head', 'torso', { x: 80, y: 0, length: 40 });
  add('armUpper', 'torso', { x: 70, y: 20, rotation: -30, length: 60, shearX: 6 });
  add('armLower', 'armUpper', { x: 60, y: 0, rotation: 20, length: 50 });
  add('hand', 'armLower', { x: 50, y: 0, length: 20 });
  add('legUpper', 'root', { x: -20, y: 100, rotation: -90, length: 60 });
  add('legLower', 'legUpper', { x: 60, y: 0, rotation: 10, length: 60 });
  add('footTarget', 'root', { x: -30, y: 0, length: 10 });
  add('handTarget', 'root', { x: 120, y: 160, length: 10 });
  add('tail', 'root', { x: -60, y: 60, rotation: 200, length: 70 });
  add('tailTarget', 'root', { x: -130, y: 30, length: 10 });
  add('mNoScale', 'torso', {
    x: 30,
    y: 30,
    rotation: 15,
    scaleX: 1.3,
    scaleY: 0.8,
    shearX: 10,
    shearY: -5,
    inherit: 'noScale',
    length: 30,
  });
  add('mOnlyTrans', 'torso', { x: 30, y: -30, rotation: 25, scaleX: 0.9, scaleY: 1.2, inherit: 'onlyTranslation', length: 30 });
  add('mNoRot', 'torso', {
    x: 10,
    y: 40,
    rotation: -20,
    scaleX: 1.1,
    scaleY: 1.4,
    shearY: 12,
    inherit: 'noRotationOrReflection',
    length: 30,
  });
  add('mNoScaleRefl', 'torso', { x: 10, y: -40, rotation: 40, scaleX: 0.7, scaleY: 1.1, inherit: 'noScaleOrReflection', length: 30 });
  add('child', 'mNoScale', { x: 30, y: 0, rotation: 30, length: 20 });
  // transform constraint rig
  add('gear', 'root', { x: 180, y: 80, length: 40 });
  add('driven', 'root', { x: 180, y: 180, length: 40, rotation: 20 });
  add('slider', 'root', { x: 250, y: 10, length: 20 });
  add('follower', 'root', { x: 250, y: 100, length: 30, scaleX: 1.2 });
  add('follower2', 'follower', { x: 30, y: 0, length: 20 });
  add('lflow', 'torso', { x: 20, y: 60, length: 25, rotation: 10 });

  doc.constraints.push({
    id: uid(),
    type: 'ik',
    name: 'leg ik',
    bones: [by.legUpper.id, by.legLower.id],
    target: by.footTarget.id,
    mix: 1,
    softness: 8,
    bendPositive: false,
    compress: false,
    stretch: true,
    scaleY: 'none',
    skinRequired: false,
  });
  doc.constraints.push({
    id: uid(),
    type: 'ik',
    name: 'arm ik',
    bones: [by.armUpper.id, by.armLower.id],
    target: by.handTarget.id,
    mix: 0.4,
    softness: 0,
    bendPositive: true,
    compress: false,
    stretch: false,
    scaleY: 'none',
    skinRequired: false,
  });
  doc.constraints.push({
    id: uid(),
    type: 'ik',
    name: 'tail ik',
    bones: [by.tail.id],
    target: by.tailTarget.id,
    mix: 1,
    softness: 0,
    bendPositive: true,
    compress: true,
    stretch: true,
    scaleY: 'uniform',
    skinRequired: false,
  });

  const allMix = { rotate: 1, x: 1, y: 1, scaleX: 1, scaleY: 1, shearY: 1 };
  // world -> world: gear rotation drives `driven` (reversed, doubled, offset)
  const gearDrive = newTransformConstraint({
    name: 'gear drive',
    bones: [by.driven.id],
    source: by.gear.id,
    properties: [{ prop: 'rotate', offset: 0, to: [{ prop: 'rotate', offset: 10, max: 1, scale: -2 }] }],
    mix: { ...allMix, rotate: 0.8 },
  });
  // local -> local, clamped: the slider's x drives a rotation (clamped) and a scale
  const slideFollow = newTransformConstraint({
    name: 'slide follow',
    bones: [by.follower.id],
    source: by.slider.id,
    localSource: true,
    localTarget: true,
    clamp: true,
    properties: [
      {
        prop: 'x',
        offset: 0,
        to: [
          { prop: 'rotate', offset: 0, max: 45, scale: 0.5 },
          { prop: 'scaleX', offset: 1, max: 2, scale: 0.01 },
        ],
      },
    ],
    mix: { ...allMix, scaleX: 0.7 },
  });
  // world source -> local target, additive, mixed property types
  const worldToLocal = newTransformConstraint({
    name: 'world to local',
    bones: [by.lflow.id],
    source: by.gear.id,
    localTarget: true,
    additive: true,
    properties: [
      {
        prop: 'rotate',
        offset: 0,
        to: [
          { prop: 'x', offset: 0, max: 1, scale: 0.3 },
          { prop: 'shearY', offset: 0, max: 1, scale: -0.2 },
        ],
      },
      { prop: 'scaleX', offset: 1, to: [{ prop: 'scaleY', offset: 1, max: 1, scale: 1 }] },
    ],
    offsets: { rotation: 5, x: 0, y: 0, scaleX: 0, scaleY: 0, shearY: 0 },
    mix: { ...allMix, x: 0.6 },
  });
  // world -> world additive with offsets
  const wtw = newTransformConstraint({
    name: 'world add',
    bones: [by.mOnlyTrans.id],
    source: by.slider.id,
    additive: true,
    properties: [
      {
        prop: 'y',
        offset: 0,
        to: [
          { prop: 'x', offset: 0, max: 1, scale: 0.2 },
          { prop: 'scaleY', offset: 0, max: 1, scale: 0.002 },
        ],
      },
    ],
    offsets: { rotation: 0, x: 3, y: -2, scaleX: 0, scaleY: 0, shearY: 0 },
    mix: allMix,
  });
  doc.constraints.push(gearDrive, slideFollow, worldToLocal, wtw);

  // slots + attachments
  const skin = doc.skins[0];
  const addSlot = (name: string, bone: string, att: string | null, extra: Partial<ReturnType<typeof newSlot>> = {}) => {
    const s = newSlot({ name, bone: by[bone].id, attachment: att, ...extra });
    doc.slots.push(s);
    skin.attachments[s.id] = {};
    return s;
  };
  const body = addSlot('body', 'torso', 'body');
  skin.attachments[body.id].body = region('body', 40, 0, 80, 60, 5);
  skin.attachments[body.id].bodyAlt = region('bodyAlt', 40, 0, 70, 50);
  const head = addSlot('head', 'head', 'head');
  const headMesh: MeshAttachment = {
    type: 'mesh',
    name: 'head',
    path: 'head',
    color: [1, 1, 1, 1],
    width: 64,
    height: 64,
    uvs: [0, 1, 0, 0, 1, 0, 1, 1],
    triangles: [0, 1, 2, 2, 3, 0],
    hull: 4,
    edges: [],
    vertices: [-10, -20, -10, 20, 30, 20, 30, -20],
    weights: null,
  };
  skin.attachments[head.id].head = headMesh;
  const flag = addSlot('flag', 'hand', 'flagA', { blend: 'additive', color: [1, 0.8, 0.6, 0.9] });
  skin.attachments[flag.id].flagA = region('flagA', 10, 0, 30, 20);
  skin.attachments[flag.id].flagB = region('flagB', 10, 0, 24, 24, 20);
  const front = addSlot('front', 'root', 'front');
  skin.attachments[front.id].front = region('front', 0, 40, 40, 40);

  // weighted arm mesh (bound after the setup world transforms are known)
  const armSlot = addSlot('arm', 'root', 'arm');
  // compileSkeleton memoizes per document object, and this fixture keeps mutating `doc` — compile a snapshot.
  const setup = createSkeleton(compileSkeleton(structuredClone(doc)));
  setup.setToSetupPose();
  setup.updateWorldTransform();
  const upper = setup.boneById(by.armUpper.id)!;
  const lower = setup.boneById(by.armLower.id)!;
  const pts = [
    { p: [-20, 160], w: [1, 0] },
    { p: [20, 175], w: [0.9, 0.1] },
    { p: [70, 170], w: [0.5, 0.5] },
    { p: [120, 150], w: [0.1, 0.9] },
    { p: [110, 120], w: [0, 1] },
    { p: [50, 130], w: [0.5, 0.5] },
  ];
  // map generic "setup" positions onto where the arm bones actually are in setup pose
  const base = upper.localToWorld(0, 0);
  const armMesh: MeshAttachment = {
    type: 'mesh',
    name: 'arm',
    path: 'arm',
    color: [1, 1, 1, 1],
    width: 100,
    height: 40,
    uvs: [0, 0, 0.5, 0, 1, 0, 1, 1, 0.5, 1, 0, 1],
    triangles: [0, 1, 5, 1, 4, 5, 1, 2, 4, 2, 3, 4],
    hull: 6,
    edges: [],
    vertices: [],
    weights: [],
  };
  pts.forEach((q, i) => {
    const wx = base[0] + (q.p[0] + 20) * 0.9;
    const wy = base[1] + (q.p[1] - 140) * 0.9 + (i % 2) * 6;
    const infl: [string, number, number, number][] = [];
    if (q.w[0] > 0) {
      const l = upper.worldToLocal(wx, wy);
      infl.push([by.armUpper.id, l[0], l[1], q.w[0]]);
    }
    if (q.w[1] > 0) {
      const l = lower.worldToLocal(wx, wy);
      infl.push([by.armLower.id, l[0], l[1], q.w[1]]);
    }
    armMesh.weights!.push(infl);
  });
  skin.attachments[armSlot.id].arm = armMesh;

  // two-color tinting: a slot with a dark color, keyed in rgba2 timelines (walk, and "pose" which a slider applies)
  const glow = addSlot('glow', 'head', 'glowImg', { color: [1, 1, 1, 0.8], dark: [0.1, 0.2, 0.3] });
  skin.attachments[glow.id].glowImg = region('glowImg', 10, 10, 30, 30);

  // ------------------------------------------------------------ animation
  const anim = newAnimation('walk', 1.2);
  const bez = (v: number[]) => v;
  const tl = (keys: [number, number[], (number[] | 'stepped')?][]): Timeline =>
    keys.map(([time, value, curve]) => ({ time, value, ...(curve ? { curve: curve } : {}) }));
  anim.bones[by.torso.id] = {
    rotate: tl([
      [0, [0], bez([0.3, 0, 0.7, 1])],
      [0.4, [25], 'stepped'],
      [0.7, [-15]],
      [1.2, [10]],
    ]),
    translate: tl([
      [0, [0, 0], bez([0.25, 0.1, 0.75, 0.9, 0.2, 0.5, 0.8, 0.5])],
      [0.6, [10, -8]],
      [1.2, [-5, 12]],
    ]),
    scale: tl([
      [0, [1, 1]],
      [0.5, [1.25, 0.8], bez([0.4, 0, 0.6, 1, 0.4, 0, 0.6, 1])],
      [1.2, [0.9, 1.1]],
    ]),
  };
  anim.bones[by.head.id] = {
    rotate: tl([
      [0.2, [0]],
      [0.6, [40], bez([0.5, 0.2, 0.5, 0.9])],
      [1, [-20]],
    ]),
    shear: tl([
      [0, [0, 0]],
      [0.8, [15, -10]],
    ]),
  };
  anim.bones[by.mNoScale.id] = {
    rotate: tl([
      [0, [0]],
      [1.2, [90]],
    ]),
    scale: tl([
      [0, [1, 1]],
      [1.2, [1.5, 0.7]],
    ]),
  };
  anim.bones[by.mOnlyTrans.id] = {
    rotate: tl([
      [0, [0]],
      [1.2, [-70]],
    ]),
  };
  anim.bones[by.mNoRot.id] = {
    rotate: tl([
      [0, [10]],
      [1.2, [50]],
    ]),
  };
  anim.bones[by.mNoScaleRefl.id] = {
    rotate: tl([
      [0, [0]],
      [1.2, [60]],
    ]),
    scale: tl([
      [0, [1, 1]],
      [1.2, [-1, 1]],
    ]),
  };
  anim.bones[by.footTarget.id] = {
    translate: tl([
      [0, [0, 0], bez([0.2, 0, 0.8, 1, 0.2, 0, 0.8, 1])],
      [0.6, [60, 50]],
      [1.2, [-10, 20]],
    ]),
  };
  anim.bones[by.handTarget.id] = {
    translate: tl([
      [0, [0, 0]],
      [0.6, [-40, -60]],
      [1.2, [30, -10]],
    ]),
  };
  anim.bones[by.tailTarget.id] = {
    translate: tl([
      [0, [0, 0]],
      [0.6, [40, 80]],
      [1.2, [-30, 40]],
    ]),
  };
  anim.bones[by.armUpper.id] = {
    rotate: tl([
      [0, [0]],
      [1.2, [30]],
    ]),
  };
  anim.slots[flag.id] = {
    attachment: [
      { time: 0, name: 'flagA' },
      { time: 0.5, name: 'flagB' },
      { time: 0.9, name: null },
    ],
    rgba: tl([
      [0, [1, 0.8, 0.6, 0.9], bez([0.3, 0, 0.7, 1, 0.3, 0, 0.7, 1, 0.3, 0, 0.7, 1, 0.3, 0, 0.7, 1])],
      [1.2, [0.2, 0.9, 0.4, 0.3]],
    ]),
  };
  anim.slots[body.id] = {
    attachment: [
      { time: 0.3, name: 'bodyAlt' },
      { time: 1.0, name: 'body' },
    ],
  };
  anim.slots[glow.id] = {
    rgba2: tl([
      [
        0,
        [1, 0.8, 0.6, 0.9, 0.1, 0.2, 0.05],
        bez([0.3, -0.8, 0.7, 1.6, 0.3, 0, 0.7, 1, 0.3, 0, 0.7, 1, 0.3, 0, 0.7, 1, 0.2, 0, 0.8, 2.2, 0.3, 0, 0.7, 1, 0.3, -2.5, 0.7, 1]),
      ],
      [0.6, [0.2, 0.9, 0.4, 0.3, 0.9, 0.5, 0.6], 'stepped'],
      [0.9, [0.6, 0.3, 1, 1, 0.2, 0.7, 0.8]],
      [1.2, [1, 1, 1, 0.5, 0, 0, 1]],
    ]),
  };
  const ikKeys: IkKey[] = [
    { time: 0, value: [0.4, 0], bendPositive: true, compress: false, stretch: false, curve: [0.3, 0, 0.7, 1, 0.3, 0, 0.7, 1] },
    { time: 0.8, value: [1, 15], bendPositive: false, compress: false, stretch: false },
  ];
  anim.ik[doc.constraints[1].id] = ikKeys;
  anim.deform[skin.id] = {
    [head.id]: {
      head: tl([
        [0, [0, 0, 0, 0, 0, 0, 0, 0], bez([0.3, 0, 0.7, 1])],
        [0.6, [5, 8, -3, 2, 0, 0, 12, -9]],
        [1.2, [0, 0, 0, 0, 0, 0, 0, 0]],
      ]),
    },
    [armSlot.id]: {
      arm: tl([
        [0, new Array(armMesh.weights!.reduce((n, l) => n + l.length, 0) * 2).fill(0)],
        [0.7, new Array(armMesh.weights!.reduce((n, l) => n + l.length, 0) * 2).fill(0).map((_, i) => (i % 3) - 1)],
      ]),
    },
  };
  anim.drawOrder = [
    { time: 0, order: doc.slots.map((s) => s.id) },
    { time: 0.5, order: [front.id, ...doc.slots.filter((s) => s.id !== front.id).map((s) => s.id)] },
  ];
  anim.bones[by.gear.id] = {
    rotate: tl([
      [0, [0]],
      [0.6, [90], bez([0.3, 0, 0.7, 1])],
      [1.2, [-60]],
    ]),
    scale: tl([
      [0, [1, 1]],
      [1.2, [1.6, 1.2]],
    ]),
  };
  anim.bones[by.slider.id] = {
    translate: tl([
      [0, [0, 0]],
      [0.6, [40, 25]],
      [1.2, [140, 60]],
    ]),
  };
  const six = (v: number[]) => v;
  anim.transform[gearDrive.id] = tl([
    [0, six([0.8, 1, 1, 1, 1, 1]), [0.3, 0, 0.7, 1, 0.3, 0, 0.7, 1, 0.3, 0, 0.7, 1, 0.3, 0, 0.7, 1, 0.3, 0, 0.7, 1, 0.3, 0, 0.7, 1]],
    [1.2, six([0.2, 1, 1, 1, 1, 1])],
  ]);
  const hit = { id: uid(), name: 'hit', int: 3, float: 1.5, string: 'ouch' };
  doc.events.push(hit);
  anim.events = [
    { time: 0.5, event: hit.id },
    { time: 0.9, event: hit.id, int: 7, string: 'again' },
  ];
  doc.animations.push(anim);

  // ------------------------------------------------------------ sliders (Spine 4.3) and the animations they apply
  const armIk = doc.constraints.find((c) => c.name === 'arm ik')!;
  const pose = newAnimation('pose', 1);
  pose.bones[by.head.id] = {
    rotate: tl([
      [0, [0]],
      [0.5, [35], bez([0.4, 0, 0.6, 1])],
      [1, [-10]],
    ]),
    translate: tl([
      [0, [0, 0]],
      [1, [6, -9]],
    ]),
    scale: tl([
      [0, [1, 1]],
      [1, [1.2, 0.9]],
    ]),
    shear: tl([
      [0, [0, 0]],
      [1, [12, -6]],
    ]),
  };
  pose.bones[by.mNoRot.id] = {
    rotate: tl([
      [0.2, [0]],
      [0.9, [70]],
    ]),
  };
  pose.slots[flag.id] = {
    rgba: tl([
      [0.2, [1, 0.5, 0.5, 1]],
      [1, [0.3, 1, 0.3, 0.7]],
    ]),
    attachment: [
      { time: 0.4, name: 'flagB' },
      { time: 0.9, name: 'flagA' },
    ],
  };
  pose.slots[body.id] = { attachment: [{ time: 0.6, name: 'bodyAlt' }] };
  pose.slots[glow.id] = {
    rgba2: tl([
      [0.2, [0.5, 0.5, 1, 1, 0.8, 0.1, 0.1]],
      [1, [0.1, 1, 0.3, 0.7, 0.2, 0.9, 0.5]],
    ]),
  };
  pose.ik[armIk.id] = [
    { time: 0, value: [0.9, 2], bendPositive: true, compress: false, stretch: true },
    { time: 1, value: [0.2, 0], bendPositive: false, compress: true, stretch: false },
  ];
  pose.transform[gearDrive.id] = tl([
    [0, [0.3, 1, 1, 1, 1, 1]],
    [1, [1, 0.5, 1, 1, 1, 1]],
  ]);
  pose.deform[skin.id] = {
    [head.id]: {
      head: tl([
        [0, [0, 0, 0, 0, 0, 0, 0, 0]],
        [1, [4, -3, 2, 6, -5, 1, 0, 8]],
      ]),
    },
  };
  pose.drawOrder = [{ time: 0.5, order: [doc.slots[1].id, doc.slots[0].id, ...doc.slots.slice(2).map((s) => s.id)] }];

  const pose2 = newAnimation('pose2', 0.8);
  pose2.bones[by.mNoScale.id] = {
    rotate: tl([
      [0, [0]],
      [0.8, [-35]],
    ]),
    scale: tl([
      [0, [1, 1]],
      [0.8, [1.4, 0.9]],
    ]),
  };
  pose2.bones[by.lflow.id] = {
    translate: tl([
      [0, [0, 0]],
      [0.8, [10, 5]],
    ]),
  };
  pose2.bones[by.torso.id] = {
    rotate: tl([
      [0, [0]],
      [0.8, [12]],
    ]),
  };

  // A: driven by the world x of the "slider" bone, replaces; first in the list so IK / transform mixes it keys are still to be used
  const sliderA = newSliderConstraint({
    name: 'pose slider',
    animation: pose.id,
    bone: by.slider.id,
    property: 'x',
    from: 250,
    to: 0,
    scale: 0.006,
    mix: 0.8,
  });
  // B: driven by the LOCAL rotation of the gear, looping and additive (negative times wrap around)
  const sliderB = newSliderConstraint({
    name: 'loop slider',
    animation: pose2.id,
    bone: by.gear.id,
    property: 'rotate',
    local: true,
    loop: true,
    additive: true,
    from: 0,
    to: 0.1,
    scale: 0.01,
    mix: 0.7,
  });
  // C: manual time + mix, both keyed in "walk"
  const sliderC = newSliderConstraint({ name: 'manual slider', animation: pose2.id, time: 0.3, mix: 0.6 });
  doc.constraints.unshift(sliderA);
  doc.constraints.push(sliderB, sliderC);
  pose.slider = {
    [sliderC.id]: {
      mix: tl([
        [0, [0.5]],
        [1, [1]],
      ]),
    },
  }; // A keys the mix of C (A runs first)
  anim.slider = {
    [sliderC.id]: {
      time: tl([
        [0, [0], bez([0.3, 0, 0.7, 1])],
        [0.6, [0.8]],
        [1.2, [0.1]],
      ]),
      mix: tl([
        [0, [1]],
        [1.2, [0.2]],
      ]),
    },
  };
  // the mixes of "slide follow" (rotate, scale x) are keyed in walk: bezier, stepped and linear segments
  anim.transform[slideFollow.id] = tl([
    [
      0,
      [0.9, 1, 1, 0.7, 1, 1],
      bez([0.25, 0.1, 0.75, 0.9, 0.3, 0, 0.7, 1, 0.3, 0, 0.7, 1, 0.3, -0.3, 0.7, 1.4, 0.3, 0, 0.7, 1, 0.3, 0, 0.7, 1]),
    ],
    [0.6, [0.2, 1, 1, 1, 1, 1], 'stepped'],
    [1.1, [1, 1, 1, 0.4, 1, 1]],
  ]);
  doc.animations.push(pose, pose2);

  // a second skin that swaps the flag image and moves it
  const alt = newSkin('alt');
  alt.attachments[flag.id] = {
    flagA: {
      type: 'region',
      name: 'flagA',
      path: 'flagB',
      x: 40,
      y: 10,
      rotation: 15,
      scaleX: 1.2,
      scaleY: 0.9,
      width: 30,
      height: 30,
      color: [1, 0.5, 0.5, 1],
    },
  };
  doc.skins.push(alt);

  const images = [
    { name: 'body', width: 64, height: 64 },
    { name: 'bodyAlt', width: 60, height: 60 },
    { name: 'head', width: 64, height: 64 },
    { name: 'flagA', width: 32, height: 24 },
    { name: 'flagB', width: 30, height: 30 },
    { name: 'front', width: 40, height: 40 },
    { name: 'arm', width: 100, height: 40 },
    { name: 'glowImg', width: 32, height: 32 },
  ];
  project.images = images.map((i) => ({ id: uid(), ...i }));
  return { project, images };
}

// ------------------------------------------------------------------ clipping / bounding box / point attachments

export const POLYGON_SQUARE = [-40, -30, 40, -30, 40, 50, -40, 50];

export interface AttachmentRig {
  slotId: Record<string, Id>;
  boneId: Record<string, Id>;
}

/**
 * Adds one slot per new attachment kind to a fixture project: a clip on the torso right after the body that ends at
 * the flag, an unweighted and a weighted bounding box, a weighted clip (to the end of the draw order) and a point.
 * Every one sits on an animated bone. `clip` overrides parts of the first clipping attachment.
 */
export function addAttachmentRig(project: Project, clip: Partial<ClippingAttachment> & { vertices?: number[] } = {}): AttachmentRig {
  const doc = project.skeleton;
  const skin = doc.skins[0];
  const boneId: Record<string, Id> = {};
  for (const b of doc.bones) boneId[b.name] = b.id;
  const slotId: Record<string, Id> = {};
  for (const s of doc.slots) slotId[s.name] = s.id;
  const add = (name: string, bone: string, att: Attachment, at?: number) => {
    const s = newSlot({ name, bone: boneId[bone], attachment: att.name });
    if (at === undefined) doc.slots.push(s);
    else doc.slots.splice(at, 0, s);
    skin.attachments[s.id] = { [att.name]: att };
    slotId[name] = s.id;
  };
  const w = (...parts: [string, number, number, number][]): Influence[] => parts.map(([b, x, y, wt]) => [boneId[b], x, y, wt] as Influence);

  add(
    'clip',
    'torso',
    {
      type: 'clipping',
      name: 'clip',
      color: [...DEFAULT_CLIPPING_COLOR],
      vertices: POLYGON_SQUARE,
      weights: null,
      end: slotId.flag,
      convex: false,
      inverse: false,
      ...clip,
    },
    1,
  );
  add('box', 'head', {
    type: 'boundingbox',
    name: 'box',
    color: [...DEFAULT_BOUNDING_BOX_COLOR],
    vertices: [-20, -20, 40, -20, 40, 30, 10, 50, -20, 30],
    weights: null,
  });
  add('wbox', 'armUpper', {
    type: 'boundingbox',
    name: 'wbox',
    color: [...DEFAULT_BOUNDING_BOX_COLOR],
    vertices: [],
    weights: [
      w(['armUpper', 5, -10, 0.7], ['armLower', -55, -10, 0.3]),
      w(['armUpper', 55, -10, 1]),
      w(['armLower', 40, 20, 0.5], ['armUpper', 90, 20, 0.5]),
      w(['armUpper', 10, 25, 0.25], ['armLower', -50, 25, 0.75]),
    ],
  });
  add('wclip', 'armUpper', {
    type: 'clipping',
    name: 'wclip',
    color: [...DEFAULT_CLIPPING_COLOR],
    vertices: [],
    weights: [
      w(['armUpper', 0, -20, 1]),
      w(['armUpper', 60, -20, 0.6], ['armLower', 10, -20, 0.4]),
      w(['armLower', 50, 30, 1]),
      w(['armUpper', 0, 30, 0.5], ['hand', 0, 0, 0.5]),
    ],
    end: null,
    convex: false,
    inverse: false,
  });
  add('point', 'hand', { type: 'point', name: 'point', x: 10, y: -5, rotation: 30, color: [...DEFAULT_POINT_COLOR] });
  return { slotId, boneId };
}
