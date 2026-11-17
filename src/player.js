import * as THREE from 'three';
import { clamp, damp, projectOnPlane } from './utils.js';

const UP = new THREE.Vector3(0, 1, 0);
const HOVER = 0.95;
const GRAVITY = 26;
const JUMP_V = 15.5;
const AIR_JUMP_V = 13.2;
const MAX_SPEED = 9.6;
const DASH_SPEED = 27;
const DASH_TIME = 0.2;
const DASH_COOLDOWN = 1.05;
const TRAIL_N = 34;

export class Player {
  constructor(scene, palette) {
    this.group = new THREE.Group();
    scene.add(this.group);

    this.coreMat = new THREE.MeshStandardMaterial({
      color: 0xe8f6ff,
      emissive: new THREE.Color(palette.accent),
      emissiveIntensity: 1.7,
      roughness: 0.25,
      metalness: 0.4,
      flatShading: true,
    });
    this.core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.52, 1), this.coreMat);
    this.group.add(this.core);

    this.shellMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(palette.accent2),
      wireframe: true,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.shell = new THREE.Mesh(new THREE.IcosahedronGeometry(0.82, 1), this.shellMat);
    this.group.add(this.shell);

    this.ringMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(palette.accent),
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.ring1 = new THREE.Mesh(new THREE.TorusGeometry(1.02, 0.028, 8, 48), this.ringMat);
    this.ring1.rotation.x = Math.PI * 0.5;
    this.ring2 = new THREE.Mesh(new THREE.TorusGeometry(1.22, 0.018, 8, 48), this.ringMat);
    this.ring2.rotation.set(Math.PI * 0.34, 0.4, 0);
    this.group.add(this.ring1, this.ring2);

    const glow = (() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 128;
      const ctx = canvas.getContext('2d');
      const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.28, 'rgba(200,240,255,0.4)');
      g.addColorStop(1, 'rgba(160,220,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    })();
    this.halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glow,
        color: new THREE.Color(palette.accent),
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.halo.scale.set(4.4, 4.4, 1);
    this.group.add(this.halo);

    this.light = new THREE.PointLight(new THREE.Color(palette.accent), 22, 22, 2);
    this.group.add(this.light);

    // 拖尾
    this.history = [];
    for (let i = 0; i < TRAIL_N; i++) this.history.push(new THREE.Vector3());
    this.trailPositions = new Float32Array(TRAIL_N * 3);
    const alphas = new Float32Array(TRAIL_N);
    const sizes = new Float32Array(TRAIL_N);
    for (let i = 0; i < TRAIL_N; i++) {
      const t = 1 - i / TRAIL_N;
      alphas[i] = Math.pow(t, 1.8) * 0.8;
      sizes[i] = 0.14 + t * 0.95;
    }
    const tgeo = new THREE.BufferGeometry();
    tgeo.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
    tgeo.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
    tgeo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    tgeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.trailMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color(palette.accent) }, uDpr: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aAlpha; attribute float aSize;
        uniform float uDpr; uniform vec3 uColor;
        varying float vAlpha; varying vec3 vColor;
        void main(){
          vAlpha = aAlpha; vColor = uColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uDpr * (300.0 / max(1.0, -mv.z));
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha; varying vec3 vColor;
        void main(){
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(vColor, a * vAlpha);
        }
      `,
    });
    this.trail = new THREE.Points(tgeo, this.trailMat);
    this.trail.frustumCulled = false;
    scene.add(this.trail);

    this.position = new THREE.Vector3(0, 10, 0);
    this.normal = new THREE.Vector3(0, 1, 0);
    this.velocity = new THREE.Vector3();
    this.facing = new THREE.Vector3(1, 0, 0);
    this.vRadial = 0;
    this.grounded = true;
    this.jumpsLeft = 1;
    this.dashTimer = 0;
    this.dashCooldown = 0;
    this.body = null;
    this.invuln = 0;
    this.health = 3;
    this.maxHealth = 3;
    this.hitPulse = 0;
    this.airTime = 0;
    this.sampleTimer = 0;
    this.alive = true;
  }

  setPalette(palette) {
    this.coreMat.emissive.set(palette.accent);
    this.shellMat.color.set(palette.accent2);
    this.ringMat.color.set(palette.accent);
    this.halo.material.color.set(palette.accent);
    this.light.color.set(palette.accent);
    this.trailMat.uniforms.uColor.value.set(palette.accent);
  }

  setDpr(dpr) {
    this.trailMat.uniforms.uDpr.value = dpr;
  }

  /** 掉入虚空后返回主星北极，保留能量 */
  respawn(bodies) {
    const body = bodies[0];
    this.body = body;
    this.normal.set(0, 1, 0);
    this.position.copy(body.center).addScaledVector(this.normal, body.radius + HOVER);
    this.velocity.set(0, 0, 0);
    this.vRadial = 0;
    this.grounded = true;
    this.jumpsLeft = 1;
    this.invuln = 1.8;
    this.airTime = 0;
    for (let i = 0; i < TRAIL_N; i++) this.history[i].copy(this.position);
    this.group.position.copy(this.position);
  }

  /** 菜单 / 过场中的待机动画 */
  idle(dt, t) {
    this.core.rotation.y += dt * 0.7;
    this.core.rotation.x += dt * 0.35;
    this.shell.rotation.y -= dt * 0.5;
    this.ring1.rotation.z += dt * 1.1;
    this.ring2.rotation.y += dt * 0.7;
    const s = 1 + Math.sin(t * 2.4) * 0.04;
    this.core.scale.setScalar(s);
    this.halo.material.opacity = 0.5 + Math.sin(t * 2.2) * 0.1;
    this.halo.scale.setScalar(4.3 + Math.sin(t * 1.8) * 0.2);
    this.light.intensity = 20 + Math.sin(t * 2.2) * 4;
    this.group.position.copy(this.position);
    this.group.quaternion.slerp(new THREE.Quaternion().setFromUnitVectors(UP, this.normal), 1 - Math.exp(-8 * dt));
  }

  reset(bodies, spawnDir = UP) {
    const body = bodies[0];
    this.body = body;
    this.normal.copy(spawnDir).normalize();
    this.position.copy(body.center).addScaledVector(this.normal, body.radius + HOVER);
    this.velocity.set(0, 0, 0);
    this.vRadial = 0;
    this.grounded = true;
    this.jumpsLeft = 1;
    this.health = this.maxHealth;
    this.alive = true;
    this.hitPulse = 0;
    this.invuln = 1.2;
    this.dashTimer = 0;
    this.dashCooldown = 0;
    this.airTime = 0;
    this.group.position.copy(this.position);
    this.group.visible = true;
    for (let i = 0; i < TRAIL_N; i++) this.history[i].copy(this.position);
    this._syncVisual(0, 0);
  }

  _nearestBody(bodies) {
    let best = bodies[0];
    let bestD = Infinity;
    for (const b of bodies) {
      const d = this.position.distanceTo(b.center) - b.radius;
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  takeDamage() {
    if (this.invuln > 0 || !this.alive) return false;
    this.health -= 1;
    this.invuln = 1.6;
    this.hitPulse = 1;
    if (this.health <= 0) this.alive = false;
    return true;
  }

  update(dt, input, camera, bodies, events) {
    const camDir = camera.getWorldDirection(new THREE.Vector3());
    const body = this.grounded ? this.body : this._nearestBody(bodies);
    this.body = body;

    const toCenter = new THREE.Vector3().subVectors(body.center, this.position);
    const dist = toCenter.length();
    const out = new THREE.Vector3().subVectors(this.position, body.center).normalize();
    this.normal.copy(out);

    // --- 切线输入方向（相机相对）---
    const camFlat = projectOnPlane(camDir, out);
    if (camFlat.lengthSq() < 1e-6) camFlat.set(0, 0, -1);
    camFlat.normalize();
    const right = new THREE.Vector3().crossVectors(camFlat, out).normalize();
    const move = new THREE.Vector3()
      .addScaledVector(camFlat, input.axis.z)
      .addScaledVector(right, input.axis.x);
    const hasInput = move.lengthSq() > 1e-4;
    if (hasInput) move.normalize();

    // --- 跳跃 ---
    if (input.consumeJump() && this.alive) {
      if (this.grounded) {
        this.vRadial = JUMP_V;
        this.grounded = false;
        this.jumpsLeft = 1;
        events.onJump(false, this.position.clone(), out.clone());
      } else if (this.jumpsLeft > 0) {
        this.jumpsLeft--;
        this.vRadial = AIR_JUMP_V;
        events.onJump(true, this.position.clone(), out.clone());
      }
    }

    // --- 冲刺 ---
    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    if (input.consumeDash() && this.dashCooldown <= 0 && this.alive) {
      this.dashTimer = DASH_TIME;
      this.dashCooldown = DASH_COOLDOWN;
      const dir = hasInput ? move.clone() : this.facing.clone();
      this.velocity.copy(dir).multiplyScalar(DASH_SPEED);
      this.facing.copy(dir);
      events.onDash(this.position.clone(), dir.clone(), out.clone());
    }

    if (this.dashTimer > 0) {
      this.dashTimer -= dt;
    } else {
      const targetSpeed = MAX_SPEED * (this.grounded ? 1 : 0.9);
      const rate = this.grounded ? 11 : 3.4;
      const tvx = hasInput ? move.x * targetSpeed : 0;
      const tvz = hasInput ? move.z * targetSpeed : 0;
      this.velocity.x = damp(this.velocity.x, tvx, rate, dt);
      this.velocity.z = damp(this.velocity.z, tvz, rate, dt);
      const ty = hasInput ? move.y * targetSpeed : 0;
      this.velocity.y = damp(this.velocity.y, ty, rate, dt);
    }

    // --- 位移 ---
    this.position.addScaledVector(this.velocity, dt);

    if (!this.grounded) {
      this.airTime += dt;
      this.vRadial -= GRAVITY * dt;
      this.position.addScaledVector(this.normal, this.vRadial * dt);
    }

    // --- 落地判定 ---
    const nb = this._nearestBody(bodies);
    const nbOut = new THREE.Vector3().subVectors(this.position, nb.center);
    const nbDist = nbOut.length();
    const h = nbDist - nb.radius;
    nbOut.normalize();

    if (!this.grounded) {
      if (h <= HOVER && this.vRadial <= 0) {
        this.grounded = true;
        this.body = nb;
        this.normal.copy(nbOut);
        this.velocity.copy(projectOnPlane(this.velocity, nbOut));
        this.vRadial = 0;
        this.jumpsLeft = 1;
        this.airTime = 0;
        this.position.copy(nb.center).addScaledVector(nbOut, nb.radius + HOVER);
        events.onLand(this.position.clone(), nbOut.clone());
      }
    } else {
      const gOut = new THREE.Vector3().subVectors(this.position, body.center).normalize();
      this.position.copy(body.center).addScaledVector(gOut, body.radius + HOVER);
      this.normal.copy(gOut);
      this.velocity.addScaledVector(gOut, -this.velocity.dot(gOut));
    }

    // --- 朝向 ---
    const horiz = new THREE.Vector3(this.velocity.x, this.velocity.y, this.velocity.z);
    const flatV = projectOnPlane(horiz, this.normal);
    if (flatV.lengthSq() > 0.36) {
      flatV.normalize();
      this.facing.lerp(flatV, 1 - Math.exp(-9 * dt));
      this.facing.addScaledVector(this.normal, -this.facing.dot(this.normal)).normalize();
    }

    // --- 掉出世界 ---
    let minDist = Infinity;
    for (const b of bodies) minDist = Math.min(minDist, this.position.distanceTo(b.center) - b.radius);
    if (minDist > 42) {
      events.onFall();
    }

    this.invuln = Math.max(0, this.invuln - dt);
    this.hitPulse = Math.max(0, this.hitPulse - dt * 2.4);

    this._syncVisual(dt, dist);

    // 拖尾采样
    this.sampleTimer += dt;
    if (this.sampleTimer > 0.018) {
      this.sampleTimer = 0;
      for (let i = TRAIL_N - 1; i > 0; i--) this.history[i].copy(this.history[i - 1]);
      this.history[0].copy(this.position);
    }
    for (let i = 0; i < TRAIL_N; i++) {
      this.trailPositions[i * 3] = this.history[i].x;
      this.trailPositions[i * 3 + 1] = this.history[i].y;
      this.trailPositions[i * 3 + 2] = this.history[i].z;
    }
    this.trail.geometry.attributes.position.needsUpdate = true;
  }

  _syncVisual(dt, dist) {
    const t = performance.now() / 1000;
    this.group.position.copy(this.position);
    const q = new THREE.Quaternion().setFromUnitVectors(UP, this.normal);
    this.group.quaternion.slerp(q, dt > 0 ? 1 - Math.exp(-14 * dt) : 1);

    this.core.rotation.y += dt * 1.1;
    this.core.rotation.x += dt * 0.6;
    this.shell.rotation.y -= dt * 0.8;
    this.ring1.rotation.z += dt * 1.4;
    this.ring2.rotation.y += dt * 0.9;
    const pulse = 1 + Math.sin(t * 3.2) * 0.035 + this.hitPulse * 0.25;
    this.core.scale.setScalar(pulse);
    this.halo.material.opacity = 0.42 + Math.sin(t * 2.6) * 0.07 + this.hitPulse * 0.3;
    this.halo.scale.setScalar(3.6 + Math.sin(t * 2.2) * 0.16);

    const flicker = this.invuln > 0 && Math.sin(t * 30) > 0 ? 0.35 : 1;
    this.coreMat.emissiveIntensity = (1.7 + this.hitPulse * 2) * flicker;
    this.shellMat.opacity = 0.45 * flicker;
    this.light.intensity = (20 + Math.sin(t * 2.4) * 3 + this.hitPulse * 22) * flicker;
  }
}
