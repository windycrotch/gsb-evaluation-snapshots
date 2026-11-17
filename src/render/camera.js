import * as THREE from 'three';
import { damp, dampAngle, noise1, clamp, lerp, ease } from '../core/math.js';
import { ULT } from '../sim/moves.js';

// Fight camera: sits behind the player's fighter on the lock-on axis, keeps both fighters framed,
// and hands over to short scripted moves for ultimates, clashes and KOs. The showcase director
// can also drive it directly through `cine`.

const _p = new THREE.Vector3(), _t = new THREE.Vector3();

export class CameraRig {
  constructor(camera) {
    this.cam = camera;
    this.pos = new THREE.Vector3(0, 6, 16);
    this.tgt = new THREE.Vector3(0, 1.2, 0);
    this.yaw = 0;
    this.fov = 50;
    this.roll = 0;
    this.cine = null; // { pos, target, fov, roll } set every frame by a director → bypasses fight logic
    this.special = null;
    this.snap = true;
    this.shakeScale = 1;
    this.t = 0;
  }

  onEvent(e, world, player) {
    if (e.type === 'ult_start' && !e.fast) this.special = { type: 'ult', f: e.f, t: 0, dur: ULT.charge - 0.08, side: e.f === player ? 1 : -1 };
    if (e.type === 'ko') this.special = { type: 'ko', f: e.f, t: 0, dur: 2.6 };
  }

  update(dt, t, world, player, vfx) {
    this.t = t;
    const cam = this.cam;
    const me = world.fighters[player], op = world.fighters[1 - player];
    let fovT = 50, posL = 5.5, tgtL = 9;
    if (this.cine) {
      this.pos.copy(this.cine.pos);
      this.tgt.copy(this.cine.target);
      this.fov = this.cine.fov ?? 40;
      this.roll = this.cine.roll ?? 0;
    } else {
      const dx = op.x - me.x, dz = op.z - me.z, dist = Math.hypot(dx, dz) || 1e-3;
      const ax = dx / dist, az = dz / dist;
      const yawT = Math.atan2(ax, az);
      if (this.snap) this.yaw = yawT;
      // turn rate is deliberately slow so cross-ups swing the view around instead of snapping it
      this.yaw = dampAngle(this.yaw, yawT, 3.2, dt);
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      const back = 8.6 + dist * 0.4, high = 4.3 + dist * 0.14 + Math.max(me.y, op.y) * 0.35;
      // behind the player, shifted to their right-hand side ((-fz, fx) is "right")
      _p.set(me.x - fx * back - fz * 3.4, high, me.z - fz * back + fx * 3.4);
      _t.set(me.x + dx * 0.5, 1.1 + (me.y + op.y) * 0.32, me.z + dz * 0.5);
      fovT = clamp(44 + dist * 0.5, 44, 56);
      const C = world.clash;
      const sp = this.special;
      if (C.on) {
        // beam struggle: swing out to a wide side-on view of both beams
        const mx = (me.x + op.x) / 2, mz = (me.z + op.z) / 2;
        const d = dist * 0.62 + 7;
        _p.set(mx - az * d - ax * 2, 2.4, mz + ax * d - az * 2);
        _t.set(C.x * 0.6 + mx * 0.4, 1.5, C.z * 0.6 + mz * 0.4);
        fovT = 46;
        posL = 3.2;
      } else if (sp && sp.type === 'ult') {
        sp.t += dt;
        const f = world.fighters[sp.f], k = sp.t / sp.dur;
        const ang = f.yaw + sp.side * (0.5 + 0.75 * ease.inOut(k));
        const d = 4.6 - 1.2 * k;
        _p.set(f.x + Math.sin(ang) * d, 1.05 + 0.5 * k, f.z + Math.cos(ang) * d);
        _t.set(f.x, 1.25, f.z);
        fovT = 36;
        posL = 14;
        tgtL = 16;
        if (sp.t >= sp.dur) this.special = null;
      } else if (sp && sp.type === 'ko') {
        sp.t += dt;
        const f = world.fighters[sp.f], w = world.fighters[1 - sp.f];
        const k = Math.min(1, sp.t / sp.dur);
        const mx = (f.x + w.x) / 2, mz = (f.z + w.z) / 2;
        const ang = this.yaw + 1.2 + k * 0.6;
        const d = 9 + dist * 0.35;
        _p.set(mx - Math.sin(ang) * d, 1.6 + k * 1.4, mz - Math.cos(ang) * d);
        _t.set(lerp(f.x, mx, 0.4), 1.2 + f.y * 0.5, lerp(f.z, mz, 0.4));
        fovT = 40;
        posL = 3;
        if (sp.t >= sp.dur) this.special = null;
      }
      if (this.snap) { this.pos.copy(_p); this.tgt.copy(_t); this.fov = fovT; }
      this.pos.x = damp(this.pos.x, _p.x, posL, dt);
      this.pos.y = damp(this.pos.y, _p.y, posL, dt);
      this.pos.z = damp(this.pos.z, _p.z, posL, dt);
      this.tgt.x = damp(this.tgt.x, _t.x, tgtL, dt);
      this.tgt.y = damp(this.tgt.y, _t.y, tgtL, dt);
      this.tgt.z = damp(this.tgt.z, _t.z, tgtL, dt);
      this.fov = damp(this.fov, fovT, 4, dt);
      this.roll = damp(this.roll, 0, 6, dt);
      this.pos.y = Math.max(0.35, this.pos.y);
    }
    this.snap = false;
    // trauma shake: squared falloff, smooth noise so it reads as a camera operator being rocked
    const tr = vfx ? Math.min(1, vfx.trauma) : 0, k = tr * tr * this.shakeScale;
    t = Math.floor(t * 60 + 1e-4) / 60;
    const sx = noise1(t * 27, 1) * 0.2 * k, sy = noise1(t * 25, 2) * 0.16 * k, sr = noise1(t * 21, 3) * 0.026 * k;
    cam.position.copy(this.pos);
    if (vfx) cam.position.addScaledVector(vfx.kick, 1);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.tgt);
    cam.translateX(sx);
    cam.translateY(sy);
    cam.rotateZ(this.roll + sr);
    cam.rotateX(noise1(t * 37, 4) * 0.012 * k);
    cam.rotateY(noise1(t * 41, 5) * 0.012 * k);
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld(true);
  }
}
