/** The path constraint: bones follow a path. */
import { DEG2RAD, EPS, SPINE_PI } from '../math';
import { computeWorldPositions, newPathScratch, setSize } from '../path';
import type { AttachmentData, PathConstraintData, SkinData } from './data';
import type { Bone, Slot } from './bone';
import { PI2 } from './transform';
import type { Skeleton } from './skeleton';
import { meshWorldVertices } from './geometry';

/**
 * Spine 4.3 path constraint: moves, rotates and (chainScale) stretches bones so they follow the path attachment that is
 * shown in a slot. A statement by statement port of the official `PathConstraint.update` / `sort`.
 */
export class PathConstraintRT {
  readonly kind = 'path' as const;
  readonly data: PathConstraintData;
  readonly skeleton: Skeleton;
  readonly bones: Bone[];
  readonly slot: Slot;
  position: number;
  spacing: number;
  /** mixRotate, mixX, mixY */
  mix: number[];
  active = true;
  /** True when a bone had to turn by exactly half a turn (the wrap of the angle decides which way): two runtimes can differ by float noise there. Read by the tests. */
  onBranchCut = false;
  private readonly scratch = newPathScratch();
  private readonly points: number[] = [];
  private lengths: number[] = [];

  constructor(data: PathConstraintData, skeleton: Skeleton) {
    this.data = data;
    this.skeleton = skeleton;
    this.bones = data.bones.map((i) => skeleton.bones[i]);
    this.slot = skeleton.slots[data.slot];
    this.position = data.position;
    this.spacing = data.spacing;
    this.mix = data.mix.slice();
  }

  setToSetupPose() {
    this.position = this.data.position;
    this.spacing = this.data.spacing;
    this.mix = this.data.mix.slice();
  }

  sourceActive() {
    return this.slot.bone.active;
  }

  sort(skeleton: Skeleton) {
    const slotIndex = this.slot.data.index;
    const slotBone = this.slot.bone;
    if (skeleton.skin) this.sortPathSlot(skeleton, skeleton.skin, slotIndex, slotBone);
    if (skeleton.data.defaultSkin !== skeleton.skin) this.sortPathSlot(skeleton, skeleton.data.defaultSkin, slotIndex, slotBone);
    this.sortPath(skeleton, skeleton.slotAttachment(this.slot), slotBone);
    for (const bone of this.bones) skeleton.sortBone(bone);
    skeleton.cache.push(this);
    for (const bone of this.bones) skeleton.sortReset(bone.children);
    for (const bone of this.bones) bone.sorted = true;
  }

  private sortPathSlot(skeleton: Skeleton, skin: SkinData, slotIndex: number, slotBone: Bone) {
    const entries = skin.attachments[slotIndex];
    if (entries) for (const att of entries.values()) this.sortPath(skeleton, att, slotBone);
  }

  /** Bones that move the path must be up to date before the constraint reads its points. */
  private sortPath(skeleton: Skeleton, att: AttachmentData | null, slotBone: Bone) {
    if (!att || att.kind !== 'path') return;
    const pathBones = att.bones;
    if (!pathBones) skeleton.sortBone(slotBone);
    else {
      const bones = skeleton.bones;
      for (let i = 0, n = pathBones.length; i < n;) {
        let nn = pathBones[i++];
        nn += i;
        while (i < nn) skeleton.sortBone(bones[pathBones[i++]]);
      }
    }
  }

  update() {
    const skeleton = this.skeleton;
    const att = skeleton.slotAttachment(this.slot);
    if (!att || att.kind !== 'path') return;
    const mixRotate = this.mix[0];
    const mixX = this.mix[1];
    const mixY = this.mix[2];
    if (mixRotate === 0 && mixX === 0 && mixY === 0) return;
    this.onBranchCut = false;
    const data = this.data;
    const tangents = data.rotateMode === 'tangent';
    const scale = data.rotateMode === 'chainScale';
    const bones = this.bones;
    const boneCount = bones.length;
    const spacesCount = tangents ? boneCount : boneCount + 1;
    const spaces = setSize(this.scratch.spaces, spacesCount);
    const lengths = scale ? (this.lengths = setSize(this.lengths, boneCount)) : [];
    const spacing = this.spacing;
    switch (data.spacingMode) {
      case 'percent':
        if (scale) {
          for (let i = 0, n = spacesCount - 1; i < n; i++) {
            const bone = bones[i];
            const setupLength = bone.data.length;
            const x = setupLength * bone.a;
            const y = setupLength * bone.c;
            lengths[i] = Math.sqrt(x * x + y * y);
          }
        }
        for (let i = 1; i < spacesCount; i++) spaces[i] = spacing;
        break;
      case 'proportional': {
        let sum = 0;
        for (let i = 0, n = spacesCount - 1; i < n;) {
          const bone = bones[i];
          const setupLength = bone.data.length;
          if (setupLength < EPS) {
            if (scale) lengths[i] = 0;
            spaces[++i] = spacing;
          } else {
            const x = setupLength * bone.a;
            const y = setupLength * bone.c;
            const length = Math.sqrt(x * x + y * y);
            if (scale) lengths[i] = length;
            spaces[++i] = length;
            sum += length;
          }
        }
        if (sum > 0) {
          sum = (spacesCount / sum) * spacing;
          for (let i = 1; i < spacesCount; i++) spaces[i] *= sum;
        }
        break;
      }
      default: {
        const lengthSpacing = data.spacingMode === 'length';
        for (let i = 0, n = spacesCount - 1; i < n;) {
          const bone = bones[i];
          const setupLength = bone.data.length;
          if (setupLength < EPS) {
            if (scale) lengths[i] = 0;
            spaces[++i] = spacing;
          } else {
            const x = setupLength * bone.a;
            const y = setupLength * bone.c;
            const length = Math.sqrt(x * x + y * y);
            if (scale) lengths[i] = length;
            spaces[++i] = ((lengthSpacing ? Math.max(0, setupLength + spacing) : spacing) * length) / setupLength;
          }
        }
      }
    }

    // the path's points in world space (with the slot's deformation and the bones it is skinned to)
    const slot = this.slot;
    meshWorldVertices(skeleton, slot, att, slot.deform.length ? slot.deform : null, this.points);
    const positions = computeWorldPositions(
      {
        points: this.points,
        verticesLength: att.vertexCount * 2,
        closed: att.closed,
        constantSpeed: att.constantSpeed,
        lengths: att.lengths,
        position: this.position,
        positionMode: data.positionMode,
        spacingMode: data.spacingMode,
      },
      this.scratch,
      spacesCount,
      tangents,
    );
    let boneX = positions[0];
    let boneY = positions[1];
    let offsetRotation = data.offsetRotation;
    let tip = false;
    if (offsetRotation === 0) tip = data.rotateMode === 'chain';
    else {
      tip = false;
      const bone = slot.bone;
      offsetRotation *= bone.a * bone.d - bone.b * bone.c > 0 ? DEG2RAD : -DEG2RAD;
    }
    for (let i = 0, ip = 3; i < boneCount; i++, ip += 3) {
      const bone = bones[i];
      bone.modifyWorld();
      bone.worldX += (boneX - bone.worldX) * mixX;
      bone.worldY += (boneY - bone.worldY) * mixY;
      const x = positions[ip];
      const y = positions[ip + 1];
      const dx = x - boneX;
      const dy = y - boneY;
      if (scale) {
        const length = lengths[i];
        if (length !== 0) {
          const s = (Math.sqrt(dx * dx + dy * dy) / length - 1) * mixRotate + 1;
          bone.a *= s;
          bone.c *= s;
        }
      }
      boneX = x;
      boneY = y;
      if (mixRotate > 0) {
        const a = bone.a;
        const b = bone.b;
        const c = bone.c;
        const d = bone.d;
        let r = 0;
        if (tangents) r = positions[ip - 1];
        else if (spaces[i + 1] === 0) r = positions[ip + 2];
        else r = Math.atan2(dy, dx);
        r -= Math.atan2(c, a);
        if (tip) {
          const cos = Math.cos(r);
          const sin = Math.sin(r);
          const length = bone.data.length;
          boneX += (length * (cos * a - sin * c) - dx) * mixRotate;
          boneY += (length * (sin * a + cos * c) - dy) * mixRotate;
        } else r += offsetRotation;
        if (Math.abs(Math.abs(r) - SPINE_PI) < 1e-6) this.onBranchCut = true;
        if (r > SPINE_PI) r -= PI2;
        else if (r < -SPINE_PI) r += PI2;
        r *= mixRotate;
        const cos = Math.cos(r);
        const sin = Math.sin(r);
        bone.a = cos * a - sin * c;
        bone.b = cos * b - sin * d;
        bone.c = sin * a + cos * c;
        bone.d = sin * b + cos * d;
      }
    }
  }
}
