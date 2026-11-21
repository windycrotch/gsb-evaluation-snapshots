/** Spine's path feature on top of the fixture: path attachments (open, closed, weighted), path constraints in every mode, animated. */
import { newBone, newPathConstraint, newSlot } from '../src/core/model';
import type { Attachment, Bone, Id, Influence, Project, Timeline } from '../src/core/model';

export interface PathRig {
  slotId: Record<string, Id>;
  boneId: Record<string, Id>;
  constraintId: Record<string, Id>;
}

/**
 * Adds Spine's path feature to a fixture project: an open path (constant speed) on a moved / rotated / non-uniformly scaled bone,
 * a closed one (setup lengths) on the root, a weighted one skinned to two animated bones, a different path of the same name in the
 * "alt" skin, and six constraints that cover every rotate / position / spacing mode with animated position, spacing and mixes.
 */
export function addPathRig(project: Project): PathRig {
  const doc = project.skeleton;
  const skin = doc.skins[0];
  const boneId: Record<string, Id> = {};
  for (const b of doc.bones) boneId[b.name] = b.id;
  const slotId: Record<string, Id> = {};
  const constraintId: Record<string, Id> = {};
  const bone = (name: string, parent: string, p: Partial<Bone> = {}) => {
    const b = newBone({ name, parent: boneId[parent], length: 30, ...p });
    doc.bones.push(b);
    boneId[name] = b.id;
  };
  const chain = (prefix: string, parent: string, count: number, length: number, p: Partial<Bone> = {}) => {
    for (let i = 1; i <= count; i++)
      bone(`${prefix}${i}`, i === 1 ? parent : `${prefix}${i - 1}`, i === 1 ? { length, ...p } : { length, x: length });
  };
  bone('pathHolder', 'root', { x: -200, y: 40, rotation: 15, scaleX: 1.2, scaleY: 0.9, length: 10 });
  bone('wA', 'root', { x: -350, y: 120, length: 20 });
  bone('wB', 'root', { x: -150, y: 120, length: 20 });
  chain('rp', 'root', 4, 30, { x: -300, y: -150 });
  chain('tn', 'root', 3, 25, { x: -300, y: -220 });
  chain('lp', 'root', 3, 40, { x: 250, y: -100 });
  chain('pr', 'root', 3, 35, { x: 250, y: -170 });
  chain('wf', 'root', 3, 30, { x: -100, y: -250 });
  chain('wp', 'root', 2, 30, { x: -100, y: -320, rotation: 25 });

  const slot = (name: string, boneName: string, att: Attachment) => {
    const s = newSlot({ name, bone: boneId[boneName], attachment: att.name });
    doc.slots.push(s);
    skin.attachments[s.id] = { [att.name]: att };
    slotId[name] = s.id;
    return s;
  };
  const ropeA: Attachment = {
    type: 'path',
    name: 'ropeA',
    color: [1, 0.5, 0, 1],
    closed: false,
    constantSpeed: true,
    weights: null,
    vertices: [0, 0, 0, 0, 40, 60, 60, 90, 100, 80, 140, 70, 170, 30, 200, -20, 230, -70, 270, -40, 300, 0, 300, 0],
  };
  const loopB: Attachment = {
    type: 'path',
    name: 'loopB',
    color: [0.2, 0.8, 1, 1],
    closed: true,
    constantSpeed: false,
    weights: null,
    vertices: [-20, 250, 0, 200, 30, 150, 110, 140, 150, 180, 190, 220, 140, 330, 80, 320, 20, 310],
  };
  // weighted open path: every point follows wA, wB or both (bind positions are relative to the bones' setup positions)
  const pts: [number, number, number, number][] = [
    [-350, 200, 1, 0],
    [-350, 200, 1, 0],
    [-320, 240, 0.8, 0.2],
    [-290, 250, 0.6, 0.4],
    [-250, 260, 0.5, 0.5],
    [-210, 270, 0.3, 0.7],
    [-180, 240, 0.2, 0.8],
    [-150, 200, 0, 1],
    [-150, 200, 0, 1],
  ];
  const weights = pts.map(([x, y, a, b]) => {
    const list: Influence[] = [];
    if (a > 0) list.push([boneId.wA, x + 350, y - 120, a]);
    if (b > 0) list.push([boneId.wB, x + 150, y - 120, b]);
    return list;
  });
  const wpath: Attachment = {
    type: 'path',
    name: 'wpath',
    color: [0.7, 1, 0.3, 1],
    closed: false,
    constantSpeed: false,
    vertices: [],
    weights,
  };
  const ropeSlot = slot('ropePath', 'pathHolder', ropeA);
  const loopSlot = slot('loopPath', 'root', loopB);
  const wSlot = slot('wPath', 'root', wpath);

  const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => boneId[`${prefix}${i + 1}`]);
  const add = (key: string, c: ReturnType<typeof newPathConstraint>) => {
    constraintId[key] = c.id;
    doc.constraints.push(c);
    return c;
  };
  const c1 = add(
    'rope',
    newPathConstraint({
      name: 'rope follow',
      bones: ids('rp', 4),
      target: ropeSlot.id,
      positionMode: 'percent',
      spacingMode: 'length',
      rotateMode: 'chain',
      position: 0.05,
      spacing: 4,
    }),
  );
  const c2 = add(
    'tangent',
    newPathConstraint({
      name: 'rope tangent',
      bones: ids('tn', 3),
      target: ropeSlot.id,
      positionMode: 'fixed',
      spacingMode: 'fixed',
      rotateMode: 'tangent',
      position: 20,
      spacing: 35,
      offsetRotation: 10,
      mix: { rotate: 0.9, x: 0.9, y: 1 },
    }),
  );
  const c3 = add(
    'scale',
    newPathConstraint({
      name: 'loop scale',
      bones: ids('lp', 3),
      target: loopSlot.id,
      positionMode: 'percent',
      spacingMode: 'percent',
      rotateMode: 'chainScale',
      position: 0.1,
      spacing: 0.12,
    }),
  );
  const c4 = add(
    'proportional',
    newPathConstraint({
      name: 'loop proportional',
      bones: ids('pr', 3),
      target: loopSlot.id,
      positionMode: 'percent',
      spacingMode: 'proportional',
      rotateMode: 'chain',
      position: 0.3,
      spacing: 1.2,
      offsetRotation: 20,
    }),
  );
  const c5 = add(
    'weighted',
    newPathConstraint({
      name: 'weighted follow',
      bones: ids('wf', 3),
      target: wSlot.id,
      positionMode: 'fixed',
      spacingMode: 'length',
      rotateMode: 'chain',
      position: 15,
      spacing: 5,
    }),
  );
  const c6 = add(
    'partial',
    newPathConstraint({
      name: 'weighted partial',
      bones: ids('wp', 2),
      target: wSlot.id,
      positionMode: 'percent',
      spacingMode: 'percent',
      rotateMode: 'tangent',
      position: 0.2,
      spacing: 0.25,
      mix: { rotate: 0.6, x: 0.8, y: 0.5 },
    }),
  );

  // a different path under the same name in the "alt" skin
  const alt = doc.skins.find((s) => s.name === 'alt');
  if (alt) {
    alt.attachments[ropeSlot.id] = {
      ropeA: {
        type: 'path',
        name: 'ropeA',
        color: [1, 0, 0.5, 1],
        closed: false,
        constantSpeed: false,
        weights: null,
        vertices: [0, 0, 0, 0, -30, 80, -40, 40, 60, 30, 120, 20, 130, 90, 200, 70, 260, 60, 300, 0, 320, -60, 320, -60],
      },
    };
  }

  const tl = (keys: [number, number[], (number[] | 'stepped')?][]): Timeline =>
    keys.map(([time, value, curve]) => ({ time, value, ...(curve ? { curve: curve } : {}) }));
  const anim = doc.animations.find((a) => a.name === 'walk') ?? doc.animations[0];
  anim.bones[boneId.pathHolder] = {
    rotate: tl([
      [0, [0]],
      [1.2, [35]],
    ]),
  };
  anim.bones[boneId.wA] = {
    rotate: tl([
      [0, [0]],
      [0.6, [25], [0.3, 0, 0.7, 1]],
      [1.2, [-10]],
    ]),
  };
  anim.bones[boneId.wB] = {
    translate: tl([
      [0, [0, 0]],
      [1.2, [30, 40]],
    ]),
  };
  anim.path[c1.id] = {
    position: tl([
      [0, [0.05], [0.3, 0, 0.7, 1]],
      [0.6, [0.5]],
      [1.2, [0.9]],
    ]),
    spacing: tl([
      [0, [4]],
      [1.2, [30]],
    ]),
    mix: tl([
      [0, [1, 1, 1], [0.3, 0, 0.7, 1, 0.3, 0, 0.7, 1, 0.3, 0, 0.7, 1]],
      [1.2, [0.5, 1, 0.3]],
    ]),
  };
  anim.path[c2.id] = {
    position: tl([
      [0, [20]],
      [1.2, [-30]],
    ]),
    spacing: tl([
      [0, [35]],
      [0.6, [10], 'stepped'],
      [1.2, [60]],
    ]),
  };
  anim.path[c3.id] = {
    position: tl([
      [0, [0.1], 'stepped'],
      [0.5, [0.4]],
      [1.2, [0.7]],
    ]),
  };
  anim.path[c4.id] = {
    spacing: tl([
      [0, [1.2]],
      [1.2, [0.4]],
    ]),
    mix: tl([
      [0, [1, 1, 1]],
      [1.2, [0.3, 0.5, 1]],
    ]),
  };
  anim.path[c5.id] = {
    position: tl([
      [0, [15]],
      [1.2, [200]],
    ]),
  };
  anim.path[c6.id] = {
    mix: tl([
      [0, [0.6, 0.8, 0.5]],
      [0.6, [1, 1, 1]],
      [1.2, [0, 0.5, 0.2]],
    ]),
  };
  anim.slots[loopSlot.id] = {
    attachment: [
      { time: 0, name: 'loopB' },
      { time: 0.9, name: null },
      { time: 1.0, name: 'loopB' },
    ],
  };
  const zeros = (n: number) => new Array<number>(n).fill(0);
  const wDeform = weights.reduce((n, l) => n + l.length, 0) * 2;
  anim.deform[skin.id] = {
    ...anim.deform[skin.id],
    [ropeSlot.id]: {
      ropeA: tl([
        [0, zeros(24), [0.3, 0, 0.7, 1]],
        [0.6, [0, 0, 0, 0, 12, -9, 0, 0, 5, 14, -6, 4, 0, 0, -10, 7, 0, 0, 3, 3, 0, 0, 0, 0]],
        [1.2, zeros(24)],
      ]),
    },
    [wSlot.id]: {
      wpath: tl([
        [0, zeros(wDeform)],
        [0.8, zeros(wDeform).map((_, i) => ((i * 7) % 11) - 5)],
      ]),
    },
  };
  return { slotId, boneId, constraintId };
}
