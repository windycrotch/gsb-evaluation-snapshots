import * as THREE from 'three';
import { buildClawd, buildCodex } from './models.js';
import { ST } from '../../sim/constants.js';
import { ULT } from '../../sim/moves.js';
import { Spring, sat, lerp, ease, pulse, noise1, damp, TAU } from '../../core/math.js';

// Procedural animation: every frame the fighter's sim state is turned into a target pose, and a
// handful of springs carry the body toward it so transitions overshoot and settle on their own.

const X = new THREE.Vector3(1, 0, 0), DOWN = new THREE.Vector3(0, -1, 0);
const _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _d = new THREE.Vector3();
const ph = (t, a, b) => sat((t - a) / (b - a));

export class Actor {
  constructor(kind, scene) {
    this.kind = kind;
    this.rig = kind === 'clawd' ? buildClawd() : buildCodex();
    const r = this.rig;
    // legs ride with the hips so tumbles carry them along
    for (const l of r.legs) { r.hips.add(l.hip); l.hip.position.y -= r.dims.LEG; l.y0 = l.hip.position.y; }
    scene.add(r.root);
    this.s = {
      pitch: new Spring(0, 520, 34), roll: new Spring(0, 420, 30), sy: new Spring(1, 620, 26), y: new Spring(0, 520, 36),
      twist: new Spring(0, 700, 44), z: new Spring(0, 700, 44),
    };
    this.arm = [{ dir: new THREE.Vector3(), ext: 0 }, { dir: new THREE.Vector3(), ext: 0 }];
    this.walk = 0;
    this.heat = 0;
    this.flash = 0;
    this.lastHit = -9;
    this.heatMin = 0; // staged glow floor (menu highlight, face-offs)
    this.stance = 0; // extra yaw (used by cinematic shots to open the bodies toward camera)
    this.spin = 0;
    this.tumble = 0;
    this.P = { armDir: [new THREE.Vector3(), new THREE.Vector3()], armExt: [0, 0] };
    this.tipW = [new THREE.Vector3(), new THREE.Vector3()];
    this.chest = new THREE.Vector3();
    this.wasAir = false;
    this.snapNext = true;
  }

  // Reset pose defaults for this frame.
  _defaults() {
    const P = this.P, c = this.kind === 'clawd';
    P.pitch = 0; P.roll = 0; P.twist = 0; P.sy = 1; P.sz = 1; P.y = 0; P.z = 0; P.spin = 0; P.rollSpin = 0;
    P.legSwing = 0; P.legTuck = 0; P.heat = 0; P.eye = 1; P.shake = 0; P.stiff = 1; P.headPitch = 0; P.headScale = 1;
    P.legKick = [0, 0]; P.face = 0; P.yawSpin = 0; P.lie = 0;
    if (c) {
      P.armDir[0].set(-1, 0.12, 0.3); P.armDir[1].set(1, 0.12, 0.3);
      P.armExt[0] = P.armExt[1] = 0;
    } else {
      P.armDir[0].set(-0.5, -0.85, 0.1); P.armDir[1].set(0.5, -0.85, 0.1);
      P.armExt[0] = P.armExt[1] = 0;
    }
    return P;
  }

  update(f, world, dt, t) {
    const P = this._defaults();
    const st = f.st, m = f.move, s = f.state;
    const speed = Math.hypot(f.vx, f.vz);
    const sn = Math.sin(f.yaw), cs = Math.cos(f.yaw);
    const vf = f.vx * sn + f.vz * cs, vs = -f.vx * cs + f.vz * sn;
    this.walk += speed * dt * (this.kind === 'clawd' ? 2.6 : 2.1);
    const A = P.armDir, E = P.armExt;
    const clawd = this.kind === 'clawd';
    const idleBob = Math.sin(t * (clawd ? 2.4 : 2.0) + (clawd ? 0 : 1.3));

    // ---- locomotion base ---------------------------------------------------------------------
    const moving = sat(speed / 3);
    P.y += idleBob * (clawd ? 0.022 : 0.045) * (1 - moving);
    P.sy += idleBob * 0.012 * (1 - moving);
    P.pitch += 0.05 + sat(vf / 9) * 0.22 - sat(-vf / 9) * 0.16;
    P.roll += -vs * 0.028;
    P.legSwing = Math.sin(this.walk) * 0.75 * moving;
    P.y += Math.abs(Math.sin(this.walk)) * 0.07 * moving * (clawd ? 0.6 : 1);
    if (clawd) {
      // guard stance: claws up and forward, opening and closing a little
      const g = 0.5 + 0.08 * Math.sin(t * 3.1);
      A[0].set(-0.75, 0.25, g); A[1].set(0.75, 0.25, g);
    } else {
      const sw = Math.sin(this.walk) * 0.5 * moving;
      A[0].set(-0.42, -0.8, 0.25 - sw - moving * 0.5); A[1].set(0.42, -0.8, 0.25 + sw - moving * 0.5);
      P.headPitch = idleBob * 0.03;
    }

    // ---- state poses -------------------------------------------------------------------------
    switch (s) {
      case ST.AIR: {
        const up = sat(f.vy / 14), dn = sat(-f.vy / 18);
        P.sy = 1 + up * 0.14 - dn * 0.04;
        P.legTuck = 0.7 * up - 0.3 * dn;
        P.pitch = -0.1 * up + 0.18 * dn;
        if (clawd) { A[0].set(-0.9, 0.4 + dn * 0.5, 0.1); A[1].set(0.9, 0.4 + dn * 0.5, 0.1); }
        else { A[0].set(-0.8, 0.3 * dn - 0.4, 0); A[1].set(0.8, 0.3 * dn - 0.4, 0); }
        break;
      }
      case ST.DASH: {
        const k = 1 - ph(st, 0.12, 0.24);
        const df = f.dashX * sn + f.dashZ * cs, ds = -f.dashX * cs + f.dashZ * sn;
        P.pitch = 0.5 * df * k; P.roll = -0.5 * ds * k;
        P.sy = 1 - 0.2 * k; P.sz = 1 + 0.3 * Math.abs(df) * k;
        P.legTuck = 0.8 * k;
        if (clawd) { A[0].set(-0.7, -0.1, -0.7); A[1].set(0.7, -0.1, -0.7); }
        else { A[0].set(-0.3, -0.3, -0.9); A[1].set(0.3, -0.3, -0.9); }
        P.heat = 0.25 * k;
        break;
      }
      case ST.BLOCK: {
        P.pitch = -0.06; P.sy = 0.93; P.y = -0.04;
        const jolt = Math.exp(-Math.max(0, 0.2 - f.blockStun) * 14) * (f.blockStun > 0 ? 1 : 0);
        P.z = -0.12 * jolt;
        if (clawd) { A[0].set(-0.25, 0.35, 1); A[1].set(0.25, 0.35, 1); E[0] = E[1] = 0.22; }
        else { A[0].set(0.25, 0.45, 0.85); A[1].set(-0.25, 0.45, 0.85); }
        break;
      }
      case ST.HIT: {
        const k = Math.exp(-st * 7);
        P.pitch = -0.55 * k; P.sy = 1 - 0.14 * k; P.z = -0.15 * k;
        P.roll = 0.25 * k * Math.sin(f.moveSeq * 2.1 + world.time * 0.001 + f.comboCount * 2.4);
        P.eye = 0.35; P.face = 1; P.headPitch = -0.4 * k;
        if (clawd) { A[0].set(-1, 0.6, -0.2); A[1].set(1, 0.6, -0.2); }
        else { A[0].set(-0.9, 0.2, -0.2); A[1].set(0.9, 0.2, -0.2); }
        break;
      }
      case ST.LAUNCH:
      case ST.KO: {
        const grounded = f.grounded && s === ST.KO;
        if (grounded) { P.spin = -Math.PI / 2; P.lie = 1; }
        else { this.tumble += dt * (7 + Math.hypot(f.vx, f.vy, f.vz) * 0.35); P.spin = -this.tumble; P.y = 0.2; }
        P.eye = 0.25; P.face = s === ST.KO ? 2 : 1; P.legTuck = -0.5;
        if (clawd) { A[0].set(-1, 0.3, 0); A[1].set(1, 0.3, 0); }
        else { A[0].set(-1, 0.1, 0); A[1].set(1, 0.1, 0); }
        break;
      }
      case ST.DOWN: {
        P.spin = -Math.PI / 2; P.lie = 1; P.eye = 0.2; P.face = 1; P.legTuck = -0.4;
        P.sy = 1 - 0.18 * Math.exp(-st * 9);
        this.tumble = 0;
        if (clawd) { A[0].set(-1, 0.1, 0); A[1].set(1, 0.1, 0); }
        else { A[0].set(-1, 0, 0); A[1].set(1, 0, 0); }
        break;
      }
      case ST.GETUP: {
        const k = ease.outCubic(ph(st, 0, 0.26));
        P.spin = (-Math.PI / 2) * (1 - k);
        P.lie = 1;
        P.y = 0.35 * Math.sin(k * Math.PI);
        P.sy = 0.85 + 0.15 * k;
        break;
      }
      case ST.STUN: {
        P.roll = Math.sin(t * 9) * 0.16; P.pitch = -0.12 + Math.sin(t * 7) * 0.06; P.eye = 0.3; P.face = 1; P.sy = 0.94;
        if (clawd) { A[0].set(-1, -0.4, 0.1); A[1].set(1, -0.4, 0.1); }
        else { A[0].set(-0.5, -0.85, 0); A[1].set(0.5, -0.85, 0); P.headPitch = 0.25; }
        break;
      }
      case ST.WIN: {
        const hop = Math.abs(Math.sin(st * 5.2));
        P.y = hop * 0.55; P.sy = 1 + (hop - 0.5) * 0.14; P.legTuck = hop * 0.5;
        const snap = 0.2 * Math.sin(st * 16);
        if (clawd) { A[0].set(-0.6, 1, 0.1); A[1].set(0.6, 1, 0.1); E[0] = 0.3 + snap; E[1] = 0.3 - snap; }
        else { A[0].set(-0.5, 1, 0.1); A[1].set(0.5, 1, 0.1); }
        P.heat = 0.25;
        break;
      }
      case ST.CLASH:
        this._ultPose(P, f, ULT.charge + 0.5, t, 1.0);
        break;
      case ST.ATTACK:
        if (m) this._attackPose(P, f, m, st, t);
        break;
    }
    if (s !== ST.LAUNCH && s !== ST.KO && s !== ST.DOWN) this.tumble = 0;
    // leaving a tumble: fold the accumulated turns back into (-PI, PI] so the body takes the short way home
    if (!(s === ST.LAUNCH || (s === ST.KO && !f.grounded))) this.spin = this.spin - Math.round(this.spin / TAU) * TAU;
    // landing squash
    const air = !f.grounded;
    if (this.wasAir && !air && s !== ST.DOWN && s !== ST.KO) this.s.sy.v -= 5.5;
    this.wasAir = air;

    if (world.hitstop > 0 && world.time - f.lastHitT < 0.02) P.shake = Math.max(P.shake, 0.05); // impact judder during hitstop

    // ---- drive the rig -------------------------------------------------------------------------
    const r = this.rig, S = this.s, snap = this.snapNext;
    this.snapNext = false;
    const k = P.stiff;
    const pitch = snap ? (S.pitch.snap(P.pitch), P.pitch) : S.pitch.step(P.pitch, dt * k);
    const roll = snap ? (S.roll.snap(P.roll), P.roll) : S.roll.step(P.roll, dt * k);
    const sy = snap ? (S.sy.snap(P.sy), P.sy) : S.sy.step(P.sy, dt);
    const yy = snap ? (S.y.snap(P.y), P.y) : S.y.step(P.y, dt * k);
    const tw = snap ? (S.twist.snap(P.twist), P.twist) : S.twist.step(P.twist, dt * k);
    const zz = snap ? (S.z.snap(P.z), P.z) : S.z.step(P.z, dt * k);
    this.spin = snap ? P.spin : dampAngleFree(this.spin, P.spin, 22, dt);

    const shx = P.shake ? noise1(t * 47, 3) * P.shake : 0, shy = P.shake ? noise1(t * 53, 7) * P.shake : 0;
    r.root.position.set(f.x + shx * cs, f.y, f.z - shx * sn);
    r.root.rotation.y = f.yaw + this.stance + P.yawSpin;
    const LEG = r.dims.LEG;
    const crouch = Math.min(0, yy) + (Math.min(1, sy) - 1) * 0.25;
    const lie = P.lie ? Math.abs(Math.sin(this.spin)) : 0;
    r.hips.position.set(0, lerp(LEG + yy + shy, (clawd ? 0.67 : 0.5) + yy, lie), zz);
    r.hips.rotation.set(pitch + this.spin, tw, roll + P.rollSpin, 'YXZ');
    const syc = Math.max(0.45, sy), sxz = 1 / Math.sqrt(syc);
    r.body.scale.set(sxz, syc, sxz * P.sz);

    // legs
    const legLen = Math.max(0.3, (LEG + crouch) / LEG);
    r.legs.forEach((l, i) => {
      const phase = clawd ? [0, Math.PI, Math.PI, 0][i] : [0, Math.PI][i];
      const sw = Math.sin(this.walk + phase) * 0.75 * moving * (s === ST.IDLE || s === ST.BLOCK ? 1 : 0.3);
      l.hip.rotation.x = -sw + P.legTuck * (clawd ? (l.z > 0 ? -1 : 1) * 0.9 : 1.1) + (P.legKick[i % 2] || 0);
      l.hip.scale.y = f.grounded && Math.abs(this.spin) < 0.05 ? legLen : 1;
      l.hip.position.y = l.y0 + (f.grounded ? crouch * 0 : 0);
    });

    // arms
    for (let i = 0; i < 2; i++) {
      const a = r.arms[i], cur = this.arm[i];
      const kk = snap ? 1 : 1 - Math.exp(-dt * 34 * k);
      _d.copy(P.armDir[i]).normalize();
      if (cur.dir.lengthSq() < 0.01) cur.dir.copy(_d);
      cur.dir.lerp(_d, kk).normalize();
      cur.ext += (P.armExt[i] - cur.ext) * (snap ? 1 : 1 - Math.exp(-dt * 46 * k));
      if (clawd) {
        _v.set(a.side, 0, 0);
        a.shoulder.quaternion.setFromUnitVectors(_v, cur.dir);
        const L = Math.max(0, cur.ext) * 1.25;
        a.claw.position.x = a.side * (0.17 + L);
        a.claw.scale.setScalar(1 + sat(cur.ext) * 0.35);
        a.segs.forEach((sg, j) => {
          sg.visible = L > 0.06;
          sg.position.x = a.side * (0.08 + (L * (j + 0.5)) / 3);
          sg.scale.x = Math.max(0.2, L / 3 / 0.3);
        });
      } else {
        a.shoulder.quaternion.setFromUnitVectors(DOWN, cur.dir);
        a.shoulder.scale.y = 1 + Math.max(0, cur.ext) * 1.2;
      }
    }

    // character-specific extras
    const heatT = Math.max(P.heat, this.heatMin);
    this.heat = damp(this.heat, heatT, heatT > this.heat ? 18 : 5, dt);
    if (f.lastHitT !== this.lastHit) { this.lastHit = f.lastHitT; this.flash = 1; }
    this.flash = Math.max(0, this.flash - dt * 9);
    if (clawd) {
      const eye = damp(r.eyes[0].scale.y, P.eye, 30, dt);
      r.eyes.forEach((e) => { e.scale.y = eye; });
      for (const mt of [r.mats.body, r.mats.limb]) {
        mt.emissive.setRGB(1.0, lerp(0.17, 0.85, this.flash), lerp(0.02, 0.7, this.flash));
        mt.emissiveIntensity = 0.15 + this.heat * 0.85 + this.flash * 0.8;
      }
      r.mats.eye.emissiveIntensity = Math.max(0, this.heat - 0.5) * 16;
    } else {
      r.head.rotation.x = damp(r.head.rotation.x, P.headPitch, 26, dt);
      r.head.scale.setScalar(damp(r.head.scale.x, P.headScale, 26, dt));
      const glitch = this.flash > 0.05 || P.face === 1;
      const blink = (t * 1.6) % 1 < 0.62;
      r.ko.visible = P.face === 2;
      r.chevron.visible = P.face !== 2 && !(glitch && Math.sin(t * 90) > 0.3);
      r.cursor.visible = P.face !== 2 && blink && !glitch;
      r.face.position.x = glitch ? noise1(t * 60, 1) * 0.06 : 0;
      r.chevron.scale.set(1, 1 + this.heat * 0.25, 1);
      const gk = 1 + this.heat * 2.2 + this.flash * 2;
      r.mats.glyphs.forEach((g, i) => g.color.setRGB(0.42 * (i < 3 ? 3.2 : 2.2) * gk, 0.92 * (i < 3 ? 3.2 : 2.2) * gk, 1.0 * (i < 3 ? 3.2 : 2.2) * gk));
      for (const mt of [r.mats.skin, r.mats.skinDark]) {
        mt.emissive.setRGB(lerp(0.12, 0.8, this.flash), lerp(0.45, 0.9, this.flash), 1.0);
        mt.emissiveIntensity = 0.07 + this.heat * 0.6 + this.flash * 0.7;
      }
    }

    r.root.updateMatrixWorld(true);
    r.arms[0].tip.getWorldPosition(this.tipW[0]);
    r.arms[1].tip.getWorldPosition(this.tipW[1]);
    this.chest.set(f.x, f.y + r.dims.chest, f.z);
  }

  _ultPose(P, f, st, t, extra = 0) {
    const clawd = this.kind === 'clawd', A = P.armDir, E = P.armExt;
    const c = ph(st, 0, ULT.charge), firing = st >= ULT.charge && st < ULT.charge + ULT.beam;
    if (st < ULT.charge) {
      const gather = ease.inOut(ph(st, 0.1, ULT.charge - 0.12));
      P.y = 0.3 * ease.outCubic(c); P.pitch = -0.28 * gather; P.sy = 1 + 0.08 * gather;
      P.shake = 0.03 + 0.07 * c; P.heat = 0.4 + c * 1.1;
      const spread = 1 - gather;
      if (clawd) { A[0].set(-0.4 - spread, 0.5 * spread + 0.1, 0.3 + gather); A[1].set(0.4 + spread, 0.5 * spread + 0.1, 0.3 + gather); E[0] = E[1] = 0.25 + 0.2 * spread; }
      else { A[0].set(-0.3 - spread, 0.7 * spread, 0.2 + gather); A[1].set(0.3 + spread, 0.7 * spread, 0.2 + gather); P.headPitch = -0.3 * gather; }
      P.eye = 1.25;
    } else if (firing || extra) {
      P.y = 0.06; P.pitch = -0.2; P.z = -0.22 - extra * 0.1; P.sy = 0.94;
      P.shake = 0.07 + extra * 0.07; P.heat = 1.5;
      if (clawd) { A[0].set(-0.42, 0.05, 1); A[1].set(0.42, 0.05, 1); E[0] = E[1] = 0.45; }
      else { A[0].set(-0.22, 0.12, 1); A[1].set(0.22, 0.12, 1); E[0] = E[1] = 0.3; P.headPitch = 0.1; P.headScale = 1.06; }
      P.eye = 0.7;
    } else {
      P.pitch = 0.18; P.sy = 0.95; P.heat = 0.5;
    }
  }

  _attackPose(P, f, m, st, t) {
    const clawd = this.kind === 'clawd', A = P.armDir, E = P.armExt;
    const h = m.hits ? m.hits[0] : null;
    const t0 = h ? h.t0 : 0.2, t1 = h ? h.t1 : 0.3;
    const wind = ease.outCubic(ph(st, 0, t0 * 0.8));
    const hitK = pulse(st, t0 * 0.75, t0 + 0.015, Math.max(t1 + 0.14, t0 + 0.2));
    const strike = ph(st, t0 * 0.75, t0 + 0.02);
    const rec = ph(st, t1, m.dur);
    P.stiff = 1.6;
    switch (m.id) {
      case 'L1':
      case 'L2':
      case 'DA': {
        const i = m.id === 'L2' ? 0 : 1, o = 1 - i, sgn = i === 1 ? 1 : -1;
        P.twist = -sgn * (0.55 * hitK - 0.3 * wind * (1 - strike));
        P.pitch = 0.2 * hitK + (m.id === 'DA' ? 0.3 : 0);
        P.z = 0.18 * hitK;
        A[i].set(sgn * 0.12, 0.05, 1).lerp(_v.set(sgn * 0.6, 0.1, -0.8), (1 - strike) * wind);
        E[i] = clawd ? 0.95 * hitK : 0.8 * hitK;
        if (clawd) A[o].set(-sgn * 0.8, 0.1, -0.2); else A[o].set(-sgn * 0.5, -0.4, -0.6);
        P.heat = 0.3 * hitK;
        if (m.id === 'DA') { P.sz = 1.2; P.legTuck = 0.6; P.heat = 0.5; }
        break;
      }
      case 'L3': {
        // spinning double swipe
        const sp = ease.inOut(ph(st, t0 * 0.55, t1 + 0.05));
        P.yawSpin = -sp * TAU;
        P.sy = 0.92; P.pitch = 0.08;
        A[0].set(-1, 0.05, 0.15); A[1].set(1, 0.05, 0.15);
        E[0] = E[1] = (clawd ? 0.8 : 0.65) * Math.sin(sp * Math.PI);
        if (!clawd) { P.legKick[1] = -1.3 * Math.sin(sp * Math.PI); }
        P.heat = 0.35 * Math.sin(sp * Math.PI);
        break;
      }
      case 'L4': {
        // rising launcher
        const up = ease.outCubic(strike);
        P.sy = 1 - 0.25 * wind * (1 - strike) + 0.2 * hitK;
        P.y = -0.12 * wind * (1 - strike) + 0.5 * hitK;
        P.pitch = 0.25 * (1 - up) - 0.3 * hitK;
        if (clawd) {
          A[0].set(-0.35, lerp(-0.7, 1, up), lerp(0.9, 0.45, up)); A[1].set(0.35, lerp(-0.7, 1, up), lerp(0.9, 0.45, up));
          E[0] = E[1] = 0.25 + 0.6 * hitK;
        } else {
          A[0].set(-0.6, -0.5, -0.6); A[1].set(0.6, -0.5, -0.6);
          P.headPitch = -0.5 * hitK; P.headScale = 1 + 0.22 * hitK;
        }
        P.heat = 0.55 * hitK;
        break;
      }
      case 'H': {
        const charge = ph(st, 0, t0 * 0.9), go = ease.outCubic(ph(st, t0 * 0.9, t0 + 0.05));
        P.sy = 1 - 0.24 * charge * (1 - go); P.y = -0.1 * charge * (1 - go);
        P.z = -0.35 * charge * (1 - go) + 0.3 * go * (1 - rec);
        P.pitch = -0.2 * charge * (1 - go) + 0.5 * go * (1 - rec);
        P.sz = 1 + 0.3 * go * (1 - rec);
        P.shake = 0.03 * charge * (1 - go);
        if (clawd) {
          A[0].set(-0.4, 0.1, lerp(-0.9, 1, go)); A[1].set(0.4, 0.1, lerp(-0.9, 1, go));
          E[0] = E[1] = 0.15 + 0.85 * go * (1 - rec);
        } else {
          A[1].set(0.2, 0.1, lerp(-1, 1, go)); A[0].set(-0.6, -0.3, -0.5);
          E[1] = 1.2 * go * (1 - rec);
          P.twist = -0.6 * go * (1 - rec) + 0.5 * charge * (1 - go);
        }
        P.heat = 0.5 * charge + 0.6 * go * (1 - rec);
        break;
      }
      case 'AL': {
        const i = f.airLights % 2, sgn = i === 1 ? 1 : -1;
        P.twist = -sgn * (0.9 * hitK - 0.4 * (1 - strike));
        P.roll = sgn * 0.35 * hitK; P.pitch = 0.25;
        if (clawd) { A[i].set(sgn * 0.3, -0.1, 1); E[i] = 0.85 * hitK; A[1 - i].set(-sgn, 0.3, -0.3); }
        else { P.legKick[i] = -1.5 * hitK; P.pitch = -0.35 * hitK; A[0].set(-0.8, 0.2, -0.3); A[1].set(0.8, 0.2, -0.3); }
        P.heat = 0.3 * hitK;
        break;
      }
      case 'AH': {
        const div = ph(st, m.dive - 0.04, m.dive + 0.06), landed = f.landed ? 1 : 0;
        if (!landed) {
          P.spin = lerp(-0.9 * ph(st, 0, m.dive), clawd ? 0.9 : 1.5, ease.outCubic(div));
          P.sy = 1 + 0.18 * div; P.legTuck = 0.6;
          if (clawd) { A[0].set(-0.4, -0.5, 0.9); A[1].set(0.4, -0.5, 0.9); E[0] = E[1] = 0.5 * div; }
          else { A[0].set(-0.3, -0.2, -1); A[1].set(0.3, -0.2, -1); P.yawSpin = st * 18 * div; }
          P.heat = 0.9 * div;
        } else {
          const lt = st - (m.dur - m.landRecover);
          P.sy = 1 - 0.38 * Math.exp(-lt * 9); P.y = -0.12 * Math.exp(-lt * 9);
          if (clawd) { A[0].set(-0.8, -0.8, 0.3); A[1].set(0.8, -0.8, 0.3); E[0] = E[1] = 0.3; }
          else { A[0].set(-0.9, -0.5, 0.2); A[1].set(0.9, -0.5, 0.2); }
          P.heat = 0.7 * Math.exp(-lt * 4);
        }
        break;
      }
      case 'S1': {
        // ranged volley: recoil on every shot
        let kick = 0, shot = -1;
        m.ev.forEach((e, i) => { const d = st - e.t; if (d >= 0) { kick = Math.max(kick, Math.exp(-d * 16)); shot = i; } });
        const aim = ease.outCubic(ph(st, 0, 0.16)) * (1 - ph(st, m.dur - 0.2, m.dur));
        P.pitch = -0.1 * aim - 0.16 * kick; P.z = -0.16 * kick; P.sy = 1 - 0.05 * kick;
        if (clawd) {
          A[0].set(-0.4, 0.15, 1).lerp(_v.set(-0.75, 0.25, 0.5), 1 - aim); A[1].set(0.4, 0.15, 1).lerp(_v.set(0.75, 0.25, 0.5), 1 - aim);
          E[0] = 0.3 * aim + (shot % 2 === 0 ? 0.4 * kick : 0); E[1] = 0.3 * aim + (shot % 2 === 1 ? 0.4 * kick : 0);
        } else {
          A[1].set(0.15, 0.1, 1).lerp(_v.set(0.5, -0.85, 0.1), 1 - aim); E[1] = 0.5 * aim - 0.2 * kick;
          A[0].set(-0.55, -0.6, -0.4);
          P.twist = -0.45 * aim;
        }
        P.heat = 0.45 * aim + 0.5 * kick;
        break;
      }
      case 'S2': {
        if (clawd) {
          const raise = ease.outCubic(ph(st, 0, 0.28)), slam = ease.inQuad(ph(st, 0.28, 0.36)), hold = 1 - ph(st, 0.7, m.dur);
          P.y = 0.35 * raise * (1 - slam) - 0.16 * slam * hold; P.sy = 1 + 0.12 * raise * (1 - slam) - 0.3 * slam * hold;
          P.pitch = -0.3 * raise * (1 - slam) + 0.4 * slam * hold;
          const dy = lerp(1, -0.9, slam);
          A[0].set(-0.35, dy, 0.6); A[1].set(0.35, dy, 0.6);
          E[0] = E[1] = (0.5 * raise + 0.3 * slam) * hold;
          P.heat = 0.6 * raise + 0.5 * slam * hold; P.shake = 0.04 * raise * (1 - slam);
        } else {
          const raise = ease.outCubic(ph(st, 0, 0.26)) * (1 - ph(st, m.dur - 0.22, m.dur));
          P.y = 0.22 * raise; P.pitch = -0.22 * raise; P.headPitch = -0.35 * raise;
          A[1].set(0.2, 1, 0.15).lerp(_v.set(0.5, -0.85, 0.1), 1 - raise); E[1] = 0.35 * raise;
          A[0].set(-0.7, -0.3, 0.2);
          P.heat = 0.9 * raise; P.shake = 0.03 * raise;
        }
        break;
      }
      case 'ULT':
        this._ultPose(P, f, st, t, 0);
        break;
    }
  }

  place(x, y, z, yaw) {
    this.rig.root.position.set(x, y, z);
    this.rig.root.rotation.y = yaw;
  }
}

// Like dampAngle but without wrapping: tumbles accumulate full turns.
function dampAngleFree(a, b, lambda, dt) {
  if (Math.abs(b - a) > 12) return b;
  return a + (b - a) * (1 - Math.exp(-lambda * dt));
}
