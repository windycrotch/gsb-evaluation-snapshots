/** The IK constraint: one and two bone solvers. */
import { EPS, RAD2DEG, SPINE_PI, atan2Deg, signum } from '../math';
import type { IkData } from './data';
import type { Bone } from './bone';
import type { Skeleton } from './skeleton';

export class IkConstraint {
  readonly kind = 'ik' as const;
  readonly data: IkData;
  readonly bones: Bone[];
  readonly target: Bone;
  mix: number;
  softness: number;
  bendDirection: number;
  compress: boolean;
  stretch: boolean;
  active = true;

  constructor(data: IkData, skeleton: Skeleton) {
    this.data = data;
    this.bones = data.bones.map((i) => skeleton.bones[i]);
    this.target = skeleton.bones[data.target];
    this.mix = data.mix;
    this.softness = data.softness;
    this.bendDirection = data.bendDirection;
    this.compress = data.compress;
    this.stretch = data.stretch;
  }

  setToSetupPose() {
    const d = this.data;
    this.mix = d.mix;
    this.softness = d.softness;
    this.bendDirection = d.bendDirection;
    this.compress = d.compress;
    this.stretch = d.stretch;
  }

  sourceActive() {
    return this.target.active;
  }

  sort(skeleton: Skeleton) {
    this.active = this.target.active;
    if (!this.active) return;
    skeleton.sortBone(this.target);
    const parent = this.bones[0];
    skeleton.sortBone(parent);
    skeleton.cache.push(this);
    // the constrained bones (and their descendants) are updated again after the constraint changed their local transforms
    parent.sorted = false;
    skeleton.sortReset(parent.children);
  }

  update() {
    if (this.mix === 0) return;
    const t = this.target;
    const sy = this.data.scaleY;
    if (this.bones.length === 1) apply1(this.bones[0], t.worldX, t.worldY, this.compress, this.stretch, sy, this.mix);
    else apply2(this.bones[0], this.bones[1], t.worldX, t.worldY, this.bendDirection, this.stretch, sy, this.softness, this.mix);
  }
}

function scaleYFactor(mode: IkData['scaleY'], s: number): number {
  if (mode === 'uniform') return s;
  if (mode === 'volume') return 1 / (s < 0.7 ? 0.25 + 0.642857 * s : s);
  return 1;
}

function apply1(
  bone: Bone,
  targetX: number,
  targetY: number,
  compress: boolean,
  stretch: boolean,
  scaleYMode: IkData['scaleY'],
  alpha: number,
) {
  bone.modifyLocal();
  const p = bone.parent;
  if (!p) return;
  const skeleton = bone.skeleton;
  const pa = p.a;
  let pb = p.b;
  const pc = p.c;
  let pd = p.d;
  let rotationIK = -bone.ashearX - bone.arotation;
  let tx = 0;
  let ty = 0;
  switch (bone.inherit) {
    case 'onlyTranslation':
      tx = (targetX - bone.worldX) * signum(skeleton.scaleX);
      ty = (targetY - bone.worldY) * signum(skeleton.scaleY);
      break;
    case 'noRotationOrReflection': {
      const s = Math.abs(pa * pd - pb * pc) / Math.max(EPS, pa * pa + pc * pc);
      const sa = pa / skeleton.scaleX;
      const sc = pc / skeleton.scaleY;
      pb = -sc * s * skeleton.scaleX;
      pd = sa * s * skeleton.scaleY;
      rotationIK += atan2Deg(sc, sa);
      const x = targetX - p.worldX;
      const y = targetY - p.worldY;
      const d = pa * pd - pb * pc;
      if (Math.abs(d) <= EPS) {
        tx = 0;
        ty = 0;
      } else {
        tx = (x * pd - y * pb) / d - bone.ax;
        ty = (y * pa - x * pc) / d - bone.ay;
      }
      break;
    }
    default: {
      const x = targetX - p.worldX;
      const y = targetY - p.worldY;
      const d = pa * pd - pb * pc;
      if (Math.abs(d) <= EPS) {
        tx = 0;
        ty = 0;
      } else {
        tx = (x * pd - y * pb) / d - bone.ax;
        ty = (y * pa - x * pc) / d - bone.ay;
      }
    }
  }
  rotationIK += atan2Deg(ty, tx);
  if (bone.ascaleX < 0) rotationIK += 180;
  if (rotationIK > 180) rotationIK -= 360;
  else if (rotationIK <= -180) rotationIK += 360;
  let sx = bone.ascaleX;
  let sy = bone.ascaleY;
  if (compress || stretch) {
    if (bone.inherit === 'noScale' || bone.inherit === 'noScaleOrReflection') {
      tx = targetX - bone.worldX;
      ty = targetY - bone.worldY;
    }
    const b = bone.data.length * sx;
    if (b > EPS) {
      const dd = tx * tx + ty * ty;
      if ((compress && dd < b * b) || (stretch && dd > b * b)) {
        const s = (Math.sqrt(dd) / b - 1) * alpha + 1;
        sx *= s;
        sy *= scaleYFactor(scaleYMode, s);
      }
    }
  }
  // the world transform is recomputed when the bone comes up in the update cache again
  bone.arotation += rotationIK * alpha;
  bone.ascaleX = sx;
  bone.ascaleY = sy;
}

function apply2(
  parent: Bone,
  child: Bone,
  targetX: number,
  targetY: number,
  bendDir: number,
  stretch: boolean,
  scaleYMode: IkData['scaleY'],
  softness: number,
  alpha: number,
) {
  if (parent.inherit !== 'normal' || child.inherit !== 'normal') return;
  parent.modifyLocal();
  child.modifyLocal();
  const pp = parent.parent;
  if (!pp) return;
  const px = parent.ax;
  const py = parent.ay;
  let psx = parent.ascaleX;
  let psy = parent.ascaleY;
  let sx = psx;
  let sy = psy;
  let csx = child.ascaleX;
  let os1 = 0;
  let os2 = 0;
  let s2 = 0;
  if (psx < 0) {
    psx = -psx;
    os1 = 180;
    s2 = -1;
  } else {
    os1 = 0;
    s2 = 1;
  }
  if (psy < 0) {
    psy = -psy;
    s2 = -s2;
  }
  if (csx < 0) {
    csx = -csx;
    os2 = 180;
  } else os2 = 0;
  const cx = child.ax;
  let cy = 0;
  let cwx = 0;
  let cwy = 0;
  let a = parent.a;
  let b = parent.b;
  let c = parent.c;
  let d = parent.d;
  const u = Math.abs(psx - psy) <= EPS;
  if (!u || stretch) {
    cy = 0;
    cwx = a * cx + parent.worldX;
    cwy = c * cx + parent.worldY;
  } else {
    cy = child.ay;
    cwx = a * cx + b * cy + parent.worldX;
    cwy = c * cx + d * cy + parent.worldY;
  }
  a = pp.a;
  b = pp.b;
  c = pp.c;
  d = pp.d;
  let id = a * d - b * c;
  let x = cwx - pp.worldX;
  let y = cwy - pp.worldY;
  id = Math.abs(id) <= EPS ? 0 : 1 / id;
  const dx = (x * d - y * b) * id - px;
  const dy = (y * a - x * c) * id - py;
  const l1 = Math.sqrt(dx * dx + dy * dy);
  let l2 = child.data.length * csx;
  let a1 = 0;
  let a2 = 0;
  if (l1 < EPS) {
    apply1(parent, targetX, targetY, false, stretch, 'none', alpha);
    child.ay = cy;
    child.arotation = 0;
    return;
  }
  x = targetX - pp.worldX;
  y = targetY - pp.worldY;
  let tx = (x * d - y * b) * id - px;
  let ty = (y * a - x * c) * id - py;
  let dd = tx * tx + ty * ty;
  if (softness !== 0) {
    softness *= psx * (csx + 1) * 0.5;
    const td = Math.sqrt(dd);
    const sd = td - l1 - l2 * psx + softness;
    if (sd > 0) {
      let p = Math.min(1, sd / (softness * 2)) - 1;
      p = (sd - softness * (1 - p * p)) / td;
      tx -= p * tx;
      ty -= p * ty;
      dd = tx * tx + ty * ty;
    }
  }
  let solved = false;
  if (u) {
    l2 *= psx;
    let cos = (dd - l1 * l1 - l2 * l2) / (2 * l1 * l2);
    if (cos < -1) {
      cos = -1;
      a2 = Math.PI * bendDir;
    } else if (cos > 1) {
      cos = 1;
      a2 = 0;
      if (stretch) {
        a = (Math.sqrt(dd) / (l1 + l2) - 1) * alpha + 1;
        sx *= a;
        sy *= scaleYFactor(scaleYMode, a);
      }
    } else a2 = Math.acos(cos) * bendDir;
    a = l1 + l2 * cos;
    b = l2 * Math.sin(a2);
    a1 = Math.atan2(ty * a - tx * b, tx * a + ty * b);
    solved = true;
  } else {
    a = psx * l2;
    b = psy * l2;
    const aa = a * a;
    const bb = b * b;
    const ta = Math.atan2(ty, tx);
    c = bb * l1 * l1 + aa * dd - aa * bb;
    const c1 = -2 * bb * l1;
    const c2 = bb - aa;
    d = c1 * c1 - 4 * c2 * c;
    if (d >= 0) {
      let q = Math.sqrt(d);
      if (c1 < 0) q = -q;
      q = -(c1 + q) * 0.5;
      const r0 = q / c2;
      const r1 = c / q;
      const r = Math.abs(r0) < Math.abs(r1) ? r0 : r1;
      const r2 = dd - r * r;
      if (r2 >= 0) {
        y = Math.sqrt(r2) * bendDir;
        a1 = ta - Math.atan2(y, r);
        a2 = Math.atan2(y / psy, (r - l1) / psx);
        solved = true;
      }
    }
    if (!solved) {
      let minAngle = SPINE_PI;
      let minX = l1 - a;
      let minDist = minX * minX;
      let minY = 0;
      let maxAngle = 0;
      let maxX = l1 + a;
      let maxDist = maxX * maxX;
      let maxY = 0;
      c = (-a * l1) / (aa - bb);
      if (c >= -1 && c <= 1) {
        c = Math.acos(c);
        x = a * Math.cos(c) + l1;
        y = b * Math.sin(c);
        d = x * x + y * y;
        if (d < minDist) {
          minAngle = c;
          minDist = d;
          minX = x;
          minY = y;
        }
        if (d > maxDist) {
          maxAngle = c;
          maxDist = d;
          maxX = x;
          maxY = y;
        }
      }
      if (dd <= (minDist + maxDist) * 0.5) {
        a1 = ta - Math.atan2(minY * bendDir, minX);
        a2 = minAngle * bendDir;
      } else {
        a1 = ta - Math.atan2(maxY * bendDir, maxX);
        a2 = maxAngle * bendDir;
      }
    }
  }
  const os = Math.atan2(cy, cx) * s2;
  let rotation = parent.arotation;
  a1 = (a1 - os) * RAD2DEG + os1 - rotation;
  if (a1 > 180) a1 -= 360;
  else if (a1 <= -180) a1 += 360;
  parent.arotation = rotation + a1 * alpha;
  parent.ascaleX = sx;
  parent.ascaleY = sy;
  rotation = child.arotation;
  a2 = ((a2 + os) * RAD2DEG - child.ashearX) * s2 + os2 - rotation;
  if (a2 > 180) a2 -= 360;
  else if (a2 <= -180) a2 += 360;
  child.ay = cy;
  child.arotation = rotation + a2 * alpha;
}
