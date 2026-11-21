/** The runtime bone (local pose, applied pose, world transform, inherit modes) and the runtime slot. */
import type { Inherit, RGB, RGBA } from '../model';
import { DEG2RAD, EPS2, atan2Deg } from '../math';
import type { BoneData, SlotData } from './data';
import type { Skeleton } from './skeleton';

export class Bone {
  readonly data: BoneData;
  readonly skeleton: Skeleton;
  parent: Bone | null = null;
  readonly children: Bone[] = [];

  /** Local pose (setup + animation). */
  x = 0;
  y = 0;
  rotation = 0;
  scaleX = 1;
  scaleY = 1;
  shearX = 0;
  shearY = 0;
  inherit: Inherit = 'normal';

  /** Applied local transform (matches the world transform after constraints). */
  ax = 0;
  ay = 0;
  arotation = 0;
  ascaleX = 1;
  ascaleY = 1;
  ashearX = 0;
  ashearY = 0;

  /** World transform: world = [a b; c d] * local + [worldX worldY]. */
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  worldX = 0;
  worldY = 0;

  /**
   * Spine 4.3's lazy transforms. `world === skeleton.updateId`: the world transform is current.
   * `local === skeleton.updateId`: the applied local transform is stale because the world transform was modified.
   * Constraints edit the applied local (`a*`) or world values and invalidate what depends on them; a bone that
   * shows up again in the update cache only recomputes its world transform if it was invalidated.
   */
  world = 0;
  local = 0;
  sorted = false;
  active = true;

  constructor(data: BoneData, skeleton: Skeleton) {
    this.data = data;
    this.skeleton = skeleton;
    this.setToSetupPose();
  }

  setToSetupPose() {
    const d = this.data;
    this.x = d.x;
    this.y = d.y;
    this.rotation = d.rotation;
    this.scaleX = d.scaleX;
    this.scaleY = d.scaleY;
    this.shearX = d.shearX;
    this.shearY = d.shearY;
    this.inherit = d.inherit;
  }

  /** Update cache entry: computes the world transform unless it is already current. */
  update() {
    if (this.world !== this.skeleton.updateId) this.updateWorldTransform();
  }

  /** World transform from the parent's world transform and this bone's applied local transform. Children are not updated. */
  updateWorldTransform() {
    const skeleton = this.skeleton;
    if (this.local === skeleton.updateId) this.updateAppliedTransform();
    else this.world = skeleton.updateId;
    this.updateWorldTransformWith(this.ax, this.ay, this.arotation, this.ascaleX, this.ascaleY, this.ashearX, this.ashearY);
  }

  /** Makes sure the applied local transform reflects the current world transform (needed before reading or editing it). */
  validateApplied() {
    if (this.local === this.skeleton.updateId) this.updateAppliedTransform();
  }

  /** A constraint is about to edit the applied LOCAL transform: the world transform of this bone and its descendants becomes stale. */
  modifyLocal() {
    this.validateApplied();
    this.world = 0;
    this.resetWorld();
  }

  /** A constraint is about to edit the WORLD transform: the applied local transform becomes stale, descendants are invalidated. */
  modifyWorld() {
    const id = this.skeleton.updateId;
    this.local = id;
    this.world = id;
    this.resetWorld();
  }

  private resetWorld() {
    const id = this.skeleton.updateId;
    for (const child of this.children) {
      if (child.world === id) {
        if (child.local === id) child.updateAppliedTransform();
        child.world = 0;
        child.resetWorld();
      }
    }
  }

  updateWorldTransformWith(x: number, y: number, rotation: number, scaleX: number, scaleY: number, shearX: number, shearY: number) {
    this.ax = x;
    this.ay = y;
    this.arotation = rotation;
    this.ascaleX = scaleX;
    this.ascaleY = scaleY;
    this.ashearX = shearX;
    this.ashearY = shearY;

    const skeleton = this.skeleton;
    const parent = this.parent;
    if (!parent) {
      const sx = skeleton.scaleX;
      const sy = skeleton.scaleY;
      const rx = (rotation + shearX) * DEG2RAD;
      const ry = (rotation + 90 + shearY) * DEG2RAD;
      this.a = Math.cos(rx) * scaleX * sx;
      this.b = Math.cos(ry) * scaleY * sx;
      this.c = Math.sin(rx) * scaleX * sy;
      this.d = Math.sin(ry) * scaleY * sy;
      this.worldX = x * sx + skeleton.x;
      this.worldY = y * sy + skeleton.y;
      return;
    }

    let pa = parent.a;
    let pb = parent.b;
    let pc = parent.c;
    let pd = parent.d;
    this.worldX = pa * x + pb * y + parent.worldX;
    this.worldY = pc * x + pd * y + parent.worldY;

    switch (this.inherit) {
      case 'normal': {
        const rx = (rotation + shearX) * DEG2RAD;
        const ry = (rotation + 90 + shearY) * DEG2RAD;
        const la = Math.cos(rx) * scaleX;
        const lb = Math.cos(ry) * scaleY;
        const lc = Math.sin(rx) * scaleX;
        const ld = Math.sin(ry) * scaleY;
        this.a = pa * la + pb * lc;
        this.b = pa * lb + pb * ld;
        this.c = pc * la + pd * lc;
        this.d = pc * lb + pd * ld;
        return;
      }
      case 'onlyTranslation': {
        const sx = skeleton.scaleX;
        const sy = skeleton.scaleY;
        const rx = (rotation + shearX) * DEG2RAD;
        const ry = (rotation + 90 + shearY) * DEG2RAD;
        this.a = Math.cos(rx) * scaleX * sx;
        this.b = Math.cos(ry) * scaleY * sx;
        this.c = Math.sin(rx) * scaleX * sy;
        this.d = Math.sin(ry) * scaleY * sy;
        break;
      }
      case 'noRotationOrReflection': {
        const sx = skeleton.scaleX;
        const sy = skeleton.scaleY;
        const sxi = 1 / sx;
        const syi = 1 / sy;
        pa *= sxi;
        pc *= syi;
        let s = pa * pa + pc * pc;
        let r = 0;
        if (s > EPS2) {
          s = Math.abs(pa * pd * syi - pb * sxi * pc) / s;
          pb = pc * s;
          pd = pa * s;
          r = rotation - atan2Deg(pc, pa);
        } else {
          pa = 0;
          pc = 0;
          r = rotation - 90 + atan2Deg(pd, pb);
        }
        const rx = (r + shearX) * DEG2RAD;
        const ry = (r + shearY + 90) * DEG2RAD;
        const la = Math.cos(rx) * scaleX;
        const lb = Math.cos(ry) * scaleY;
        const lc = Math.sin(rx) * scaleX;
        const ld = Math.sin(ry) * scaleY;
        this.a = (pa * la - pb * lc) * sx;
        this.b = (pa * lb - pb * ld) * sx;
        this.c = (pc * la + pd * lc) * sy;
        this.d = (pc * lb + pd * ld) * sy;
        break;
      }
      case 'noScale':
      case 'noScaleOrReflection': {
        const sx = skeleton.scaleX;
        const sy = skeleton.scaleY;
        const sxi = 1 / sx;
        const syi = 1 / sy;
        const r = rotation * DEG2RAD;
        const cos = Math.cos(r);
        const sin = Math.sin(r);
        let za = (pa * cos + pb * sin) * sxi;
        let zc = (pc * cos + pd * sin) * syi;
        const zl = Math.sqrt(za * za + zc * zc);
        const s = zl > 0 ? 1 / zl : 0; // zero only for a collapsed parent (the official code gets Infinity here)
        za *= s;
        zc *= s;
        let zb = -zc;
        let zd = za;
        if (this.inherit === 'noScale' && pa * pd - pb * pc < 0 !== (sx < 0 !== sy < 0)) {
          zb = -zb;
          zd = -zd;
        }
        const rx = shearX * DEG2RAD;
        const ry = (90 + shearY) * DEG2RAD;
        const la = Math.cos(rx) * scaleX;
        const lb = Math.cos(ry) * scaleY;
        const lc = Math.sin(rx) * scaleX;
        const ld = Math.sin(ry) * scaleY;
        this.a = (za * la + zb * lc) * sx;
        this.b = (za * lb + zb * ld) * sx;
        this.c = (zc * la + zd * lc) * sy;
        this.d = (zc * lb + zd * ld) * sy;
        break;
      }
    }
  }

  /** Recomputes the applied local transform from the (possibly modified) world transform. */
  updateAppliedTransform() {
    const skeleton = this.skeleton;
    this.local = 0;
    this.world = skeleton.updateId;
    const sx = skeleton.scaleX;
    const sy = skeleton.scaleY;
    const parent = this.parent;
    if (!parent) {
      const sxi = 1 / sx;
      const syi = 1 / sy;
      this.ax = (this.worldX - skeleton.x) * sxi;
      this.ay = (this.worldY - skeleton.y) * syi;
      this.set5(this.a * sxi, this.b * sxi, this.c * syi, this.d * syi, 0);
      return;
    }
    let pa = parent.a;
    const pb = parent.b;
    let pc = parent.c;
    const pd = parent.d;
    const pad = pa * pd - pb * pc;
    // a singular parent (a bone scaled to 0, say) has no inverse; the official code divides by zero here and produces NaN
    // for the whole subtree, we keep every transform finite instead
    const pid = pad === 0 || !Number.isFinite(1 / pad) ? 0 : 1 / pad;
    const ia = pd * pid;
    const ib = pb * pid;
    const ic = pc * pid;
    const id = pa * pid;
    const dx = this.worldX - parent.worldX;
    const dy = this.worldY - parent.worldY;
    this.ax = dx * ia - dy * ib;
    this.ay = dy * id - dx * ic;

    switch (this.inherit) {
      case 'normal':
        this.set5(ia * this.a - ib * this.c, ia * this.b - ib * this.d, id * this.c - ic * this.a, id * this.d - ic * this.b, 0);
        break;
      case 'onlyTranslation': {
        const sxi = 1 / sx;
        const syi = 1 / sy;
        this.set5(this.a * sxi, this.b * sxi, this.c * syi, this.d * syi, 0);
        break;
      }
      case 'noRotationOrReflection': {
        const sxi = 1 / sx;
        const syi = 1 / sy;
        pa *= sxi;
        pc *= syi;
        const wa = this.a * sxi;
        const wb = this.b * sxi;
        const wc = this.c * syi;
        const wd = this.d * syi;
        // a collapsed parent (first column 0) has no rotation to undo: the official code divides by zero, we stay finite
        const sd = pa * pa + pc * pc;
        const s = sd > 0 ? 1 / sd : 0;
        const dd = Math.abs(pad * sxi * syi);
        const det = dd > 0 ? 1 / dd : 0;
        this.set5((pa * wa + pc * wc) * s, (pa * wb + pc * wd) * s, (pa * wc - pc * wa) * det, (pa * wd - pc * wb) * det, atan2Deg(pc, pa));
        break;
      }
      case 'noScale':
      case 'noScaleOrReflection': {
        const sxi = 1 / sx;
        const syi = 1 / sy;
        const wa = this.a * sxi;
        const wb = this.b * sxi;
        const wc = this.c * syi;
        const wd = this.d * syi;
        let tx = pd * this.a - pb * this.c;
        let ty = pa * this.c - pc * this.a;
        if (pad < 0) {
          tx = -tx;
          ty = -ty;
        }
        let r = atan2Deg(ty, tx);
        this.arotation = r;
        r *= DEG2RAD;
        const cos = Math.cos(r);
        const sin = Math.sin(r);
        let za = (pa * cos + pb * sin) * sxi;
        let zc = (pc * cos + pd * sin) * syi;
        const zl = Math.sqrt(za * za + zc * zc);
        const s = zl > 0 ? 1 / zl : 0; // zero only for a collapsed parent (the official code gets Infinity here)
        za *= s;
        zc *= s;
        const si = this.inherit === 'noScale' && pad < 0 !== (sx < 0 !== sy < 0) ? -1 : 1;
        this.set4(za * wa + zc * wc, za * wb + zc * wd, (za * wc - zc * wa) * si, (za * wd - zc * wb) * si);
      }
    }
  }

  private set4(ra: number, rb: number, rc: number, rd: number) {
    const x = ra * ra + rc * rc;
    const y = rb * rb + rd * rd;
    if (x > EPS2) {
      this.ashearX = atan2Deg(rc, ra);
      this.ascaleX = Math.sqrt(x);
    } else {
      this.ashearX = 0;
      this.ascaleX = 0;
    }
    this.ascaleY = Math.sqrt(y);
    if (y > EPS2) {
      this.ashearY = atan2Deg(rd, rb);
      if (ra * rd - rb * rc < 0) {
        this.ascaleY = -this.ascaleY;
        this.ashearY += 90;
      } else this.ashearY -= 90;
      if (this.ashearY > 180) this.ashearY -= 360;
      else if (this.ashearY <= -180) this.ashearY += 360;
    } else this.ashearY = 0;
  }

  private set5(ra: number, rb: number, rc: number, rd: number, ro: number) {
    this.ashearX = 0;
    const x = ra * ra + rc * rc;
    const y = rb * rb + rd * rd;
    if (x > EPS2) {
      const r = atan2Deg(rc, ra);
      this.arotation = r + ro;
      this.ascaleX = Math.sqrt(x);
      this.ascaleY = Math.sqrt(y);
      if (y > EPS2) {
        this.ashearY = atan2Deg(rd, rb);
        if (ra * rd - rb * rc < 0) {
          this.ascaleY = -this.ascaleY;
          this.ashearY += 90 - r;
        } else this.ashearY -= 90 + r;
        if (this.ashearY > 180) this.ashearY -= 360;
        else if (this.ashearY <= -180) this.ashearY += 360;
      } else this.ashearY = 0;
    } else {
      this.ascaleX = 0;
      this.ascaleY = Math.sqrt(y);
      this.ashearY = 0;
      this.arotation = y > EPS2 ? atan2Deg(rd, rb) - 90 + ro : ro;
    }
  }

  worldToLocal(wx: number, wy: number, out: [number, number] = [0, 0]): [number, number] {
    const det = this.a * this.d - this.b * this.c;
    if (!(Math.abs(det) > 1e-12)) {
      // a collapsed bone (scaled to 0) has no inverse: its origin is the closest local position
      out[0] = 0;
      out[1] = 0;
      return out;
    }
    const x = wx - this.worldX;
    const y = wy - this.worldY;
    out[0] = (x * this.d - y * this.b) / det;
    out[1] = (y * this.a - x * this.c) / det;
    return out;
  }

  localToWorld(lx: number, ly: number, out: [number, number] = [0, 0]): [number, number] {
    out[0] = lx * this.a + ly * this.b + this.worldX;
    out[1] = lx * this.c + ly * this.d + this.worldY;
    return out;
  }

  get worldRotationX(): number {
    return atan2Deg(this.c, this.a);
  }
  get worldRotationY(): number {
    return atan2Deg(this.d, this.b);
  }
  get worldScaleX(): number {
    return Math.sqrt(this.a * this.a + this.c * this.c);
  }
  get worldScaleY(): number {
    return Math.sqrt(this.b * this.b + this.d * this.d);
  }
  /** Tip of the bone in world space. */
  get tipX(): number {
    return this.worldX + this.a * this.data.length;
  }
  get tipY(): number {
    return this.worldY + this.c * this.data.length;
  }
}

export class Slot {
  readonly data: SlotData;
  readonly bone: Bone;
  color: RGBA = [1, 1, 1, 1];
  dark: RGB | null = null;
  attachmentName: string | null = null;
  /** Deform deltas for the current attachment (empty = none). */
  deform: number[] = [];
  /** The frame of the current attachment's sequence that a sequence timeline chose; -1 = none (the setup frame shows). */
  sequenceIndex = -1;

  constructor(data: SlotData, bone: Bone) {
    this.data = data;
    this.bone = bone;
    this.setToSetupPose();
  }

  setToSetupPose() {
    const d = this.data;
    this.color = [d.color[0], d.color[1], d.color[2], d.color[3]];
    this.dark = d.dark ? [d.dark[0], d.dark[1], d.dark[2]] : null;
    this.attachmentName = d.attachment;
    this.deform = [];
    this.sequenceIndex = -1;
  }
}
