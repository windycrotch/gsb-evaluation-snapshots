/** The transform constraint (Spine 4.3 mappings between bone properties). */
import type { TransformProp } from '../model';
import { DEG2RAD, RAD2DEG, SPINE_PI } from '../math';
import type { TransformData } from './data';
import type { Bone } from './bone';
import type { Skeleton } from './skeleton';

const MIX_INDEX: Record<TransformProp, number> = { rotate: 0, x: 1, y: 2, scaleX: 3, scaleY: 4, shearY: 5 };
export const PI2 = SPINE_PI * 2;

export function transformFrom(prop: TransformProp, sk: Skeleton, s: Bone, local: boolean, off: number[]): number {
  const sx = sk.scaleX;
  const sy = sk.scaleY;
  switch (prop) {
    case 'rotate': {
      if (local) return s.arotation + off[0];
      let v = Math.atan2(s.c / sy, s.a / sx) * RAD2DEG + ((s.a * s.d - s.b * s.c) * sx * sy > 0 ? off[0] : -off[0]);
      if (v < 0) v += 360;
      return v;
    }
    case 'x':
      return local ? s.ax + off[1] : (off[1] * s.a + off[2] * s.b + s.worldX) / sx;
    case 'y':
      return local ? s.ay + off[2] : (off[1] * s.c + off[2] * s.d + s.worldY) / sy;
    case 'scaleX': {
      if (local) return s.ascaleX + off[3];
      const a = s.a / sx;
      const c = s.c / sy;
      return Math.sqrt(a * a + c * c) + off[3];
    }
    case 'scaleY': {
      if (local) return s.ascaleY + off[4];
      const b = s.b / sx;
      const d = s.d / sy;
      return Math.sqrt(b * b + d * d) + off[4];
    }
    case 'shearY': {
      if (local) return s.ashearY + off[5];
      const ix = 1 / sx;
      const iy = 1 / sy;
      return (Math.atan2(s.d * iy, s.b * ix) - Math.atan2(s.c * iy, s.a * ix)) * RAD2DEG - 90 + off[5];
    }
  }
}

function transformTo(prop: TransformProp, sk: Skeleton, mix: number[], bone: Bone, value: number, local: boolean, additive: boolean) {
  const sx = sk.scaleX;
  const sy = sk.scaleY;
  const m = mix[MIX_INDEX[prop]];
  switch (prop) {
    case 'rotate': {
      if (local) {
        bone.arotation += (additive ? value : value - bone.arotation) * m;
        return;
      }
      const ix = 1 / sx;
      const iy = 1 / sy;
      const a = bone.a * ix;
      const b = bone.b * ix;
      const c = bone.c * iy;
      const d = bone.d * iy;
      value *= DEG2RAD;
      if (!additive) value -= Math.atan2(c, a);
      if (value > SPINE_PI) value -= PI2;
      else if (value < -SPINE_PI) value += PI2;
      value *= m;
      const cos = Math.cos(value);
      const sin = Math.sin(value);
      bone.a = (cos * a - sin * c) * sx;
      bone.b = (cos * b - sin * d) * sx;
      bone.c = (sin * a + cos * c) * sy;
      bone.d = (sin * b + cos * d) * sy;
      return;
    }
    case 'x':
      if (local) bone.ax += (additive ? value : value - bone.ax) * m;
      else {
        if (!additive) value -= bone.worldX / sx;
        bone.worldX += value * m * sx;
      }
      return;
    case 'y':
      if (local) bone.ay += (additive ? value : value - bone.ay) * m;
      else {
        if (!additive) value -= bone.worldY / sy;
        bone.worldY += value * m * sy;
      }
      return;
    case 'scaleX':
      if (local) {
        if (additive) bone.ascaleX *= 1 + (value - 1) * m;
        else if (bone.ascaleX !== 0) bone.ascaleX += (value - bone.ascaleX) * m;
      } else if (additive) {
        const s = 1 + (value - 1) * m;
        bone.a *= s;
        bone.c *= s;
      } else {
        const a = bone.a / sx;
        const c = bone.c / sy;
        let s = Math.sqrt(a * a + c * c);
        if (s !== 0) {
          s = 1 + ((value - s) * m) / s;
          bone.a *= s;
          bone.c *= s;
        }
      }
      return;
    case 'scaleY':
      if (local) {
        if (additive) bone.ascaleY *= 1 + (value - 1) * m;
        else if (bone.ascaleY !== 0) bone.ascaleY += (value - bone.ascaleY) * m;
      } else if (additive) {
        const s = 1 + (value - 1) * m;
        bone.b *= s;
        bone.d *= s;
      } else {
        const b = bone.b / sx;
        const d = bone.d / sy;
        let s = Math.sqrt(b * b + d * d);
        if (s !== 0) {
          s = 1 + ((value - s) * m) / s;
          bone.b *= s;
          bone.d *= s;
        }
      }
      return;
    case 'shearY': {
      if (local) {
        if (!additive) value -= bone.ashearY;
        bone.ashearY += value * m;
        return;
      }
      const b = bone.b / sx;
      const d = bone.d / sy;
      const by = Math.atan2(d, b);
      value = (value + 90) * DEG2RAD;
      if (additive) value -= SPINE_PI / 2;
      else {
        value -= by - Math.atan2(bone.c / sy, bone.a / sx);
        if (value > SPINE_PI) value -= PI2;
        else if (value < -SPINE_PI) value += PI2;
      }
      value = by + value * m;
      const s = Math.sqrt(b * b + d * d);
      bone.b = Math.cos(value) * s * sx;
      bone.d = Math.sin(value) * s * sy;
    }
  }
}

/** Spine 4.3 transform constraint: maps properties of a source bone onto constrained bones. */
export class TransformConstraintRT {
  readonly kind = 'transform' as const;
  readonly data: TransformData;
  readonly skeleton: Skeleton;
  readonly bones: Bone[];
  readonly source: Bone;
  mix: number[];
  active = true;
  /** The world rotation the source had when the constraint last read it (0..360), NaN before; lets the tests spot a read on the 0/360 wrap. */
  lastSourceRotation = Number.NaN;

  constructor(data: TransformData, skeleton: Skeleton) {
    this.data = data;
    this.skeleton = skeleton;
    this.bones = data.bones.map((i) => skeleton.bones[i]);
    this.source = skeleton.bones[data.source];
    this.mix = data.mix.slice();
  }

  setToSetupPose() {
    this.mix = this.data.mix.slice();
  }

  sourceActive() {
    return this.source.active;
  }

  sort(skeleton: Skeleton) {
    const d = this.data;
    if (!d.localSource) skeleton.sortBone(this.source);
    const worldTarget = !d.localTarget;
    if (worldTarget) for (const b of this.bones) skeleton.sortBone(b);
    skeleton.cache.push(this);
    for (const b of this.bones) skeleton.sortReset(b.children);
    for (const b of this.bones) b.sorted = worldTarget;
  }

  update() {
    const m = this.mix;
    if (m[0] === 0 && m[1] === 0 && m[2] === 0 && m[3] === 0 && m[4] === 0 && m[5] === 0) return;
    const d = this.data;
    const sk = this.skeleton;
    const source = this.source;
    if (d.localSource) source.validateApplied();
    for (const bone of this.bones) {
      if (d.localTarget) bone.modifyLocal();
      else bone.modifyWorld();
      for (const from of d.properties) {
        const raw = transformFrom(from.prop, sk, source, d.localSource, d.offsets);
        if (from.prop === 'rotate' && !d.localSource) this.lastSourceRotation = raw;
        const value = raw - from.offset;
        for (const to of from.to) {
          if (m[MIX_INDEX[to.prop]] === 0) continue;
          let clamped = to.offset + value * to.scale;
          if (d.clamp) {
            clamped = to.offset < to.max ? Math.min(to.max, Math.max(to.offset, clamped)) : Math.min(to.offset, Math.max(to.max, clamped));
          }
          transformTo(to.prop, sk, m, bone, clamped, d.localTarget, d.additive);
        }
      }
    }
  }
}

export const NO_OFFSETS = [0, 0, 0, 0, 0, 0];
