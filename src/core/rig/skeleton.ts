/** The runtime skeleton instance: poses a compiled skeleton (setup, animation, constraints, world transforms) and wears skins. */
import type { Id, RGBA } from '../model';
import type { AttachmentData, SkeletonData, SkinData } from './data';
import { Bone, Slot } from './bone';
import { IkConstraint } from './ik';
import { TransformConstraintRT } from './transform';
import { SliderRT } from './slider';
import { PathConstraintRT } from './pathConstraint';
import { PhysicsConstraintRT } from './physics';
import type { PhysicsMode } from './physics';
import { meshWorldVertices, regionWorldVertices } from './geometry';

export class Skeleton {
  readonly data: SkeletonData;
  readonly bones: Bone[];
  readonly slots: Slot[];
  readonly constraints: Array<IkConstraint | TransformConstraintRT | SliderRT | PathConstraintRT | PhysicsConstraintRT>;
  drawOrder: Slot[];
  skin: SkinData | null = null;
  x = 0;
  y = 0;
  scaleX = 1;
  scaleY = 1;
  color: RGBA = [1, 1, 1, 1];
  /** Update order of bones and constraints. */
  cache: Array<Bone | IkConstraint | TransformConstraintRT | SliderRT | PathConstraintRT | PhysicsConstraintRT> = [];
  /** Seconds the skeleton has been advanced by `update`; the physics constraints measure their time with it. */
  time = 0;
  /** Directions of the wind and of gravity (the physics parameters of the constraints are their strengths). */
  windX = 1;
  windY = 0;
  gravityX = 0;
  gravityY = 1;
  /** What the next `updateWorldTransform` does with the physics constraints. */
  physicsMode: PhysicsMode = 'none';

  constructor(data: SkeletonData) {
    this.data = data;
    this.bones = data.bones.map((bd) => new Bone(bd, this));
    for (const bone of this.bones) {
      const p = bone.data.parent;
      if (p >= 0) {
        bone.parent = this.bones[p];
        this.bones[p].children.push(bone);
      }
    }
    this.slots = data.slots.map((sd) => new Slot(sd, this.bones[sd.bone]));
    this.drawOrder = this.slots.slice();
    this.constraints = data.constraints.map((cd) =>
      cd.kind === 'ik'
        ? new IkConstraint(cd, this)
        : cd.kind === 'transform'
          ? new TransformConstraintRT(cd, this)
          : cd.kind === 'path'
            ? new PathConstraintRT(cd, this)
            : cd.kind === 'physics'
              ? new PhysicsConstraintRT(cd, this)
              : new SliderRT(cd, this),
    );
    this.updateCache();
  }

  boneById(id: Id): Bone | undefined {
    const i = this.data.boneIndex.get(id);
    return i === undefined ? undefined : this.bones[i];
  }
  slotById(id: Id): Slot | undefined {
    const i = this.data.slotIndex.get(id);
    return i === undefined ? undefined : this.slots[i];
  }
  constraintById(id: Id): IkConstraint | TransformConstraintRT | SliderRT | PathConstraintRT | PhysicsConstraintRT | undefined {
    const i = this.data.constraintIndex.get(id);
    return i === undefined ? undefined : this.constraints[i];
  }

  physicsById(id: Id): PhysicsConstraintRT | undefined {
    const c = this.constraintById(id);
    return c && c.kind === 'physics' ? c : undefined;
  }

  /** The physics constraints of the skeleton, in update order. */
  get physicsConstraints(): PhysicsConstraintRT[] {
    return this.constraints.filter((c): c is PhysicsConstraintRT => c.kind === 'physics');
  }

  /** Advances the skeleton's time (what the physics constraints simulate against). */
  update(delta: number) {
    this.time += delta;
  }

  /** Restarts the simulation of every physics constraint: the next update starts from rest. */
  resetPhysics() {
    for (const c of this.physicsConstraints) c.reset();
  }

  physicsTranslate(x: number, y: number) {
    for (const c of this.physicsConstraints) c.translate(x, y);
  }

  physicsRotate(x: number, y: number, degrees: number) {
    for (const c of this.physicsConstraints) c.rotate(x, y, degrees);
  }

  pathById(id: Id): PathConstraintRT | undefined {
    const c = this.constraintById(id);
    return c && c.kind === 'path' ? c : undefined;
  }

  sliderById(id: Id): SliderRT | undefined {
    const c = this.constraintById(id);
    return c && c.kind === 'slider' ? c : undefined;
  }

  ikById(id: Id): IkConstraint | undefined {
    const c = this.constraintById(id);
    return c && c.kind === 'ik' ? c : undefined;
  }

  transformById(id: Id): TransformConstraintRT | undefined {
    const c = this.constraintById(id);
    return c && c.kind === 'transform' ? c : undefined;
  }

  setSkin(skin: SkinData | null) {
    this.skin = skin && skin !== this.data.defaultSkin ? skin : null;
    this.updateCache();
  }

  /** Resolves the attachment a slot would show: active skin first, then the default skin. */
  getAttachment(slotIndex: number, name: string | null): AttachmentData | null {
    if (name === null) return null;
    if (this.skin) {
      const a = this.skin.attachments[slotIndex]?.get(name);
      if (a) return a;
    }
    return this.data.defaultSkin.attachments[slotIndex]?.get(name) ?? null;
  }

  slotAttachment(slot: Slot): AttachmentData | null {
    return this.getAttachment(slot.data.index, slot.attachmentName);
  }

  updateCache() {
    this.cache.length = 0;
    const bones = this.bones;
    for (const bone of bones) {
      bone.sorted = bone.data.skinRequired;
      bone.active = !bone.sorted;
    }
    if (this.skin) {
      for (const idx of this.skin.bones) {
        let bone: Bone | null = bones[idx];
        while (bone) {
          bone.sorted = false;
          bone.active = true;
          bone = bone.parent;
        }
      }
    }
    for (const c of this.constraints) {
      const wasActive = c.active;
      c.active = c.sourceActive() && (!c.data.skinRequired || (this.skin !== null && this.skin.constraints.includes(c.data.index)));
      // a physics constraint the skin switches off or on starts from rest: it neither keeps simulating while hidden nor
      // resumes with the velocity (and the clock) it had when it was hidden
      if (c.kind === 'physics' && c.active !== wasActive) c.reset();
      if (c.active) c.sort(this);
    }
    for (const bone of bones) this.sortBone(bone);
  }

  sortBone(bone: Bone) {
    // a bone that a skin does not list stays out of the update order (a constraint can clear its `sorted` mark, so check `active` too)
    if (bone.sorted || !bone.active) return;
    if (bone.parent) this.sortBone(bone.parent);
    bone.sorted = true;
    this.cache.push(bone);
  }

  sortReset(bones: Bone[]) {
    for (const bone of bones) {
      if (!bone.active) continue;
      if (bone.sorted) this.sortReset(bone.children);
      bone.sorted = false;
    }
  }

  setToSetupPose() {
    for (const b of this.bones) b.setToSetupPose();
    for (const s of this.slots) s.setToSetupPose();
    for (const c of this.constraints) c.setToSetupPose();
    this.drawOrder = this.slots.slice();
  }

  /** Increments on every `updateWorldTransform`; bones compare their `world` / `local` stamps against it. */
  updateId = 0;

  /**
   * Computes every world transform and applies the constraints. Constraints work on the *applied* local transform
   * (`a*` fields), which starts each update as a copy of the animated pose â€” the pose itself is never modified.
   */
  updateWorldTransform(physics: PhysicsMode = 'none', probe?: (item: Skeleton['cache'][number], after: boolean) => void) {
    this.physicsMode = physics;
    this.updateId++;
    for (const b of this.bones) {
      b.ax = b.x;
      b.ay = b.y;
      b.arotation = b.rotation;
      b.ascaleX = b.scaleX;
      b.ascaleY = b.scaleY;
      b.ashearX = b.shearX;
      b.ashearY = b.shearY;
    }
    if (!probe) {
      for (const item of this.cache) item.update();
      return;
    }
    // a caller that wants to look between the steps (the constraint numbers of a bone) is told before and after every item
    for (const item of this.cache) {
      probe(item, false);
      item.update();
      probe(item, true);
    }
  }

  /** World AABB of visible region/mesh attachments in the current pose: [x, y, width, height]. */
  getBounds(): [number, number, number, number] | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const tmp = new Float32Array(2048);
    for (const slot of this.drawOrder) {
      const att = this.slotAttachment(slot);
      if (!att || (att.kind !== 'region' && att.kind !== 'mesh')) continue; // outlines and points are not part of the image bounds
      let n = 0;
      let buf: Float32Array = tmp;
      if (att.kind === 'region') {
        regionWorldVertices(att, slot.bone, tmp);
        n = 4;
      } else {
        n = att.vertexCount;
        if (n * 2 > tmp.length) buf = new Float32Array(n * 2);
        meshWorldVertices(this, slot, att, slot.deform.length ? slot.deform : null, buf);
      }
      for (let i = 0; i < n; i++) {
        const x = buf[i * 2];
        const y = buf[i * 2 + 1];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    return minX === Infinity ? null : [minX, minY, maxX - minX, maxY - minY];
  }
}

export function createSkeleton(data: SkeletonData, skinId?: Id | null, mix: readonly Id[] = []): Skeleton {
  const s = new Skeleton(data);
  const ids = mix.length ? [...(skinId ? [skinId] : []), ...mix] : skinId ? [skinId] : [];
  if (ids.length) s.setSkin(composeSkins(data, ids));
  return s;
}

/** The skin an attachment shown by a skin mix comes from: the last of the worn skins that has it, else the default skin. */
export function skinHolding(data: SkeletonData, worn: readonly Id[], slotIndex: number, name: string): Id {
  for (let i = worn.length - 1; i >= 0; i--) {
    const skin = data.skinById.get(worn[i]);
    if (skin && skin !== data.defaultSkin && skin.attachments[slotIndex]?.has(name)) return skin.id;
  }
  return data.defaultSkin.id;
}

/**
 * Several skins worn at once (the runtime's Skin.addSkin): a later skin's attachment replaces an earlier one at the same slot and name, and the
 * bones and constraints that any of them lists are active. The default skin is always the base and unknown ids are skipped. Returns the one
 * skin when only one is left, and null when none is.
 */
export function composeSkins(data: SkeletonData, ids: readonly Id[]): SkinData | null {
  const skins: SkinData[] = [];
  for (const id of ids) {
    const skin = data.skinById.get(id);
    if (skin && skin !== data.defaultSkin && !skins.includes(skin)) skins.push(skin);
  }
  if (skins.length < 2) return skins[0] ?? null;
  const attachments = data.slots.map(() => new Map<string, AttachmentData>());
  for (const skin of skins) skin.attachments.forEach((entries, slot) => entries.forEach((att, name) => attachments[slot].set(name, att)));
  return {
    id: skins.map((k) => k.id).join('+'),
    name: skins.map((k) => k.name).join(' + '),
    attachments,
    bones: [...new Set(skins.flatMap((k) => k.bones))],
    constraints: [...new Set(skins.flatMap((k) => k.constraints))],
  };
}
