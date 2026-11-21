/** The physics constraint: a spring simulation on one bone. */
import type { PhysicsParam } from '../model';
import { DEG2RAD, INV_PI2 } from '../math';
import type { PhysicsData } from './data';
import type { Bone } from './bone';
import { PI2 } from './transform';
import type { Skeleton } from './skeleton';

/** How a physics constraint is treated by `Skeleton.updateWorldTransform`: Spine's `Physics` enum. */
export type PhysicsMode = 'none' | 'reset' | 'update' | 'pose';

/**
 * Spine 4.3 physics constraint: a spring simulation that moves, rotates, scales or shears one bone, driven by the bone's own
 * movement. A statement by statement port of the official `PhysicsConstraint.update`; the state it keeps between calls
 * (`ux`, offsets, velocities...) is why it is only simulated while an animation plays.
 */
export class PhysicsConstraintRT {
  readonly kind = 'physics' as const;
  readonly data: PhysicsData;
  readonly skeleton: Skeleton;
  readonly bone: Bone;
  active = true;
  // the animatable parameters
  inertia: number;
  strength: number;
  damping: number;
  massInverse: number;
  wind: number;
  gravity: number;
  mix: number;
  // simulation state
  private isReset = true;
  private ux = 0;
  private uy = 0;
  private cx = 0;
  private cy = 0;
  private tx = 0;
  private ty = 0;
  private xOffset = 0;
  private xLag = 0;
  private xVelocity = 0;
  private yOffset = 0;
  private yLag = 0;
  private yVelocity = 0;
  private rotateOffset = 0;
  private rotateLag = 0;
  private rotateVelocity = 0;
  private scaleOffset = 0;
  private scaleLag = 0;
  private scaleVelocity = 0;
  private remaining = 0;
  private lastTime = 0;

  constructor(data: PhysicsData, skeleton: Skeleton) {
    this.data = data;
    this.skeleton = skeleton;
    this.bone = skeleton.bones[data.bone];
    this.inertia = data.inertia;
    this.strength = data.strength;
    this.damping = data.damping;
    this.massInverse = data.massInverse;
    this.wind = data.wind;
    this.gravity = data.gravity;
    this.mix = data.mix;
  }

  /** The animatable parameters; timelines and the editor see the mass, the simulation uses its inverse. */
  getParam(p: PhysicsParam): number {
    return p === 'mass' ? 1 / this.massInverse : this[p];
  }
  setParam(p: PhysicsParam, v: number) {
    if (p === 'mass') this.massInverse = 1 / v;
    else this[p] = v;
  }

  setToSetupPose() {
    const d = this.data;
    this.inertia = d.inertia;
    this.strength = d.strength;
    this.damping = d.damping;
    this.massInverse = d.massInverse;
    this.wind = d.wind;
    this.gravity = d.gravity;
    this.mix = d.mix;
  }

  sourceActive() {
    return this.bone.active;
  }

  sort(skeleton: Skeleton) {
    skeleton.sortBone(this.bone);
    skeleton.cache.push(this);
    skeleton.sortReset(this.bone.children);
  }

  /** Forgets everything the simulation has learned from movement: the next update starts from rest. */
  reset() {
    this.remaining = 0;
    this.lastTime = this.skeleton.time;
    this.isReset = true;
    this.xOffset = 0;
    this.xLag = 0;
    this.xVelocity = 0;
    this.yOffset = 0;
    this.yLag = 0;
    this.yVelocity = 0;
    this.rotateOffset = 0;
    this.rotateLag = 0;
    this.rotateVelocity = 0;
    this.scaleOffset = 0;
    this.scaleLag = 0;
    this.scaleVelocity = 0;
  }

  /** The next update reacts as if the bone had moved by an additional (x, y) in world space. */
  translate(x: number, y: number) {
    this.ux -= x;
    this.uy -= y;
    this.cx -= x;
    this.cy -= y;
  }

  /** The next update reacts as if the bone had rotated around (x, y) in world space. */
  rotate(x: number, y: number, degrees: number) {
    const r = degrees * DEG2RAD;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const dx = this.cx - x;
    const dy = this.cy - y;
    this.translate(dx * cos - dy * sin - dx, dx * sin + dy * cos - dy);
  }

  update() {
    const skeleton = this.skeleton;
    const mix = this.mix;
    if (mix === 0) return;
    const d = this.data;
    const x = d.x > 0;
    const y = d.y > 0;
    const rotateOrShearX = d.rotate > 0 || d.shearX > 0;
    const scaleX = d.scaleX > 0;
    const bone = this.bone;
    const l = bone.data.length;
    const t = d.step;
    let z = 0;
    const physics = skeleton.physicsMode;
    if (physics === 'none') return;
    bone.modifyWorld();
    if (physics === 'reset') this.reset();
    if (physics === 'reset' || physics === 'update') {
      const delta = Math.max(skeleton.time - this.lastTime, 0);
      const aa = this.remaining;
      this.remaining += delta;
      this.lastTime = skeleton.time;
      const bx = bone.worldX;
      const by = bone.worldY;
      if (this.isReset) {
        this.isReset = false;
        this.ux = bx;
        this.uy = by;
      } else {
        let a = this.remaining;
        const i = this.inertia;
        const f = skeleton.data.referenceScale;
        let dd = -1; // the official runtime calls this "d"; it is only computed when a step is due
        let m = 0;
        let e = 0;
        let qx = d.limit * delta;
        const qy = qx * Math.abs(skeleton.scaleY);
        qx *= Math.abs(skeleton.scaleX);
        if (x || y) {
          if (x) {
            const u = (this.ux - bx) * i;
            this.xOffset += u > qx ? qx : u < -qx ? -qx : u;
            this.ux = bx;
          }
          if (y) {
            const u = (this.uy - by) * i;
            this.yOffset += u > qy ? qy : u < -qy ? -qy : u;
            this.uy = by;
          }
          if (a >= t) {
            const xs = this.xOffset;
            const ys = this.yOffset;
            dd = this.damping ** (60 * t);
            m = t * this.massInverse;
            e = this.strength;
            const w = f * this.wind;
            const g = f * this.gravity;
            const ax = (w * skeleton.windX + g * skeleton.gravityX) * skeleton.scaleX;
            const ay = (w * skeleton.windY + g * skeleton.gravityY) * skeleton.scaleY;
            do {
              if (x) {
                this.xVelocity += (ax - this.xOffset * e) * m;
                this.xOffset += this.xVelocity * t;
                this.xVelocity *= dd;
              }
              if (y) {
                this.yVelocity -= (ay + this.yOffset * e) * m;
                this.yOffset += this.yVelocity * t;
                this.yVelocity *= dd;
              }
              a -= t;
            } while (a >= t);
            this.xLag = this.xOffset - xs;
            this.yLag = this.yOffset - ys;
          }
          z = Math.max(0, 1 - a / t);
          if (x) bone.worldX += (this.xOffset - this.xLag * z) * mix * d.x;
          if (y) bone.worldY += (this.yOffset - this.yLag * z) * mix * d.y;
        }
        if (rotateOrShearX || scaleX) {
          const ca = Math.atan2(bone.c, bone.a);
          let c = 0;
          let s = 0;
          let mr = 0;
          let dx = this.cx - bone.worldX;
          let dy = this.cy - bone.worldY;
          if (dx > qx) dx = qx;
          else if (dx < -qx) dx = -qx;
          if (dy > qy) dy = qy;
          else if (dy < -qy) dy = -qy;
          a = this.remaining;
          if (rotateOrShearX) {
            mr = (d.rotate + d.shearX) * mix;
            z = this.rotateLag * Math.max(0, 1 - aa / t);
            let r = Math.atan2(dy + this.ty, dx + this.tx) - ca - (this.rotateOffset - z) * mr;
            this.rotateOffset += (r - Math.ceil(r * INV_PI2 - 0.5) * PI2) * i;
            r = (this.rotateOffset - z) * mr + ca;
            c = Math.cos(r);
            s = Math.sin(r);
            if (scaleX) {
              r = l * bone.worldScaleX;
              if (r > 0) this.scaleOffset += ((dx * c + dy * s) * i) / r;
            }
          } else {
            c = Math.cos(ca);
            s = Math.sin(ca);
            const r = l * bone.worldScaleX - this.scaleLag * Math.max(0, 1 - aa / t);
            if (r > 0) this.scaleOffset += ((dx * c + dy * s) * i) / r;
          }
          if (a >= t) {
            if (dd === -1) {
              dd = this.damping ** (60 * t);
              m = t * this.massInverse;
              e = this.strength;
            }
            const ax = this.wind * skeleton.windX + this.gravity * skeleton.gravityX;
            const ay = (this.wind * skeleton.windY + this.gravity * skeleton.gravityY) * 1; // Skeleton.yDir: y points up
            const rs = this.rotateOffset;
            const ss = this.scaleOffset;
            const h = l / f;
            for (;;) {
              a -= t;
              if (scaleX) {
                this.scaleVelocity += (ax * c - ay * s - this.scaleOffset * e) * m;
                this.scaleOffset += this.scaleVelocity * t;
                this.scaleVelocity *= dd;
              }
              if (rotateOrShearX) {
                this.rotateVelocity -= ((ax * s + ay * c) * h + this.rotateOffset * e) * m;
                this.rotateOffset += this.rotateVelocity * t;
                this.rotateVelocity *= dd;
                if (a < t) break;
                const r = this.rotateOffset * mr + ca;
                c = Math.cos(r);
                s = Math.sin(r);
              } else if (a < t) break;
            }
            this.rotateLag = this.rotateOffset - rs;
            this.scaleLag = this.scaleOffset - ss;
          }
          z = Math.max(0, 1 - a / t);
        }
        this.remaining = a;
      }
      this.cx = bone.worldX;
      this.cy = bone.worldY;
    } else {
      // 'pose': the simulation is not advanced, what it has computed so far is applied again
      z = Math.max(0, 1 - this.remaining / t);
      if (x) bone.worldX += (this.xOffset - this.xLag * z) * mix * d.x;
      if (y) bone.worldY += (this.yOffset - this.yLag * z) * mix * d.y;
    }
    if (rotateOrShearX) {
      let o = (this.rotateOffset - this.rotateLag * z) * mix;
      let s = 0;
      let c = 0;
      let a = 0;
      if (d.shearX > 0) {
        let r = 0;
        if (d.rotate > 0) {
          r = o * d.rotate;
          s = Math.sin(r);
          c = Math.cos(r);
          a = bone.b;
          bone.b = c * a - s * bone.d;
          bone.d = s * a + c * bone.d;
        }
        r += o * d.shearX;
        s = Math.sin(r);
        c = Math.cos(r);
        a = bone.a;
        bone.a = c * a - s * bone.c;
        bone.c = s * a + c * bone.c;
      } else {
        o *= d.rotate;
        s = Math.sin(o);
        c = Math.cos(o);
        a = bone.a;
        bone.a = c * a - s * bone.c;
        bone.c = s * a + c * bone.c;
        a = bone.b;
        bone.b = c * a - s * bone.d;
        bone.d = s * a + c * bone.d;
      }
    }
    if (scaleX) {
      let s = 1 + (this.scaleOffset - this.scaleLag * z) * mix * d.scaleX;
      bone.a *= s;
      bone.c *= s;
      if (d.scaleY === 'uniform') {
        bone.b *= s;
        bone.d *= s;
      } else if (d.scaleY === 'volume') {
        s = Math.abs(s);
        s = s >= 0.7 ? 1 / s : 4 - 3.67347 * s;
        bone.b *= s;
        bone.d *= s;
      }
    }
    if (physics !== 'pose') {
      this.tx = l * bone.a;
      this.ty = l * bone.c;
    }
  }
}
