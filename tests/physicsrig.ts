/** Spine's physics constraints on top of the fixture: a hanging chain with constraints of every flavour and animated parameters. */
import { GLOBAL_PHYSICS, newBone, newPhysicsConstraint } from '../src/core/model';
import type { Bone, Id, Project, Timeline } from '../src/core/model';

const key = (time: number, value: number[], curve?: 'stepped' | number[]) => ({ time, value, ...(curve !== undefined ? { curve } : {}) });

/**
 * Adds a chain `sw1 - sw2 - sw3` that hangs on the existing `torso` bone (else on the root) with physics constraints on the three
 * bones (rotate / x + y / scale + shear, with a limit, a different step and a global parameter), plus a loose bone with its own.
 * The first animation gets timelines for the parameters, the global ones and a reset.
 */
export function addPhysicsRig(project: Project): Record<string, Id> {
  const doc = project.skeleton;
  const byName = (n: string) => doc.bones.find((b) => b.name === n);
  const parent = (byName('torso') ?? doc.bones[0]).id;
  const ids: Record<string, Id> = {};
  const bone = (name: string, parentId: Id, p: Partial<Bone>) => {
    const b = newBone({ name, parent: parentId, length: 40, ...p });
    doc.bones.push(b);
    ids[name] = b.id;
  };
  bone('sw1', parent, { x: 70, y: 10 });
  bone('sw2', ids.sw1, { x: 40 });
  bone('sw3', ids.sw2, { x: 40, length: 30 });
  bone('swSide', parent, { x: 10, y: -30, rotation: -90 });
  const add = (bone: string, partial: Parameters<typeof newPhysicsConstraint>[0] extends infer T ? Partial<T> : never) => {
    const c = newPhysicsConstraint({ name: `${bone} physics`, bone: ids[bone], ...partial });
    doc.constraints.push(c);
    ids[c.name] = c.id;
  };
  add('sw1', {
    rotate: 1,
    gravity: 8,
    inertia: 0.7,
    global: { inertia: true, strength: false, damping: false, mass: false, wind: false, gravity: false, mix: false },
  });
  add('sw2', { x: 0.5, y: 1, rotate: 0.5, limit: 60, fps: 30, strength: 70, damping: 0.8 });
  add('sw3', { scaleX: 1, shearX: 0.6, rotate: 0.3, scaleY: 'volume', wind: 4 });
  add('swSide', { rotate: 1, mass: 2, mix: 0.8 });

  const a = doc.animations[0];
  if (a) {
    const tl = (a.physics[ids['sw1 physics']] ??= {});
    tl.strength = [key(0, [90]), key(Math.min(a.duration, 0.9), [40], [0.3, 0, 0.7, 1])] as Timeline;
    tl.wind = [key(0.1, [0]), key(Math.min(a.duration, 1), [20])] as Timeline;
    a.physics[ids['sw2 physics']] = {
      reset: [key(Math.min(a.duration, 0.4), [1])] as Timeline,
      mass: [key(0, [1]), key(Math.min(a.duration, 1), [3])] as Timeline,
    };
    a.physics[GLOBAL_PHYSICS] = { inertia: [key(0, [0.4]), key(Math.min(a.duration, 1.1), [0.9])] as Timeline };
  }
  return ids;
}
