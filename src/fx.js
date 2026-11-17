import * as THREE from 'three';
import { rand } from './utils.js';

/**
 * 单 draw call 的 GPU 粒子池：用于收集星屑 / 击打 / 星门喷发等特效
 */
export class ParticleSystem {
  constructor(scene, capacity = 600) {
    this.capacity = capacity;
    this.cursor = 0;
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.alphas = new Float32Array(capacity);
    this.vels = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.grow = new Float32Array(capacity);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    geo.setDrawRange(0, capacity);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uDpr: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        uniform float uDpr;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uDpr * (320.0 / max(0.001, -mv.z));
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          float a = smoothstep(0.5, 0.0, d);
          a = pow(a, 2.0);
          if (a <= 0.002) discard;
          gl_FragColor = vec4(vColor, a * vAlpha);
        }
      `,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    scene.add(this.points);

    for (let i = 0; i < capacity; i++) this.life[i] = 0;
  }

  setDpr(dpr) {
    this.points.material.uniforms.uDpr.value = dpr;
  }

  burst(origin, colorHex, opts = {}) {
    const {
      count = 14,
      speed = 4.5,
      spread = 1,
      size = 0.55,
      life = 0.75,
      drag = 2.2,
      grow = -0.2,
      color2 = null,
      up = null,
      bias = 0,
    } = opts;

    const c1 = new THREE.Color(colorHex);
    const c2 = color2 != null ? new THREE.Color(color2) : c1;
    const tmp = new THREE.Color();

    for (let k = 0; k < count; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;
      const i3 = i * 3;

      this.positions[i3] = origin.x;
      this.positions[i3 + 1] = origin.y;
      this.positions[i3 + 2] = origin.z;

      let vx = (Math.random() * 2 - 1) * spread;
      let vy = (Math.random() * 2 - 1) * spread;
      let vz = (Math.random() * 2 - 1) * spread;
      const l = Math.hypot(vx, vy, vz) || 1;
      vx /= l;
      vy /= l;
      vz /= l;
      if (up && bias) {
        vx += up.x * bias;
        vy += up.y * bias;
        vz += up.z * bias;
      }
      const sp = speed * (0.45 + Math.random() * 0.9);
      this.vels[i3] = vx * sp;
      this.vels[i3 + 1] = vy * sp;
      this.vels[i3 + 2] = vz * sp;

      tmp.copy(c1).lerp(c2, Math.random());
      this.colors[i3] = tmp.r;
      this.colors[i3 + 1] = tmp.g;
      this.colors[i3 + 2] = tmp.b;

      this.sizes[i] = size * (0.6 + Math.random() * 0.9);
      this.alphas[i] = 1;
      this.life[i] = life * (0.7 + Math.random() * 0.6);
      this.maxLife[i] = this.life[i];
      this.drag[i] = drag;
      this.grow[i] = grow;
    }

    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.aColor.needsUpdate = true;
    this.points.geometry.attributes.aSize.needsUpdate = true;
    this.points.geometry.attributes.aAlpha.needsUpdate = true;
  }

  trailDust(pos, colorHex) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const i3 = i * 3;
    this.positions[i3] = pos.x + rand(Math.random, -0.2, 0.2);
    this.positions[i3 + 1] = pos.y + rand(Math.random, -0.2, 0.2);
    this.positions[i3 + 2] = pos.z + rand(Math.random, -0.2, 0.2);
    const c = new THREE.Color(colorHex);
    this.colors[i3] = c.r;
    this.colors[i3 + 1] = c.g;
    this.colors[i3 + 2] = c.b;
    this.vels[i3] = rand(Math.random, -0.3, 0.3);
    this.vels[i3 + 1] = rand(Math.random, -0.1, 0.5);
    this.vels[i3 + 2] = rand(Math.random, -0.3, 0.3);
    this.sizes[i] = 0.18;
    this.alphas[i] = 0.5;
    this.life[i] = 0.75;
    this.maxLife[i] = 0.75;
    this.drag[i] = 1;
    this.grow[i] = -0.4;
  }

  update(dt) {
    let any = false;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) {
        if (this.alphas[i] !== 0) {
          this.alphas[i] = 0;
          any = true;
        }
        continue;
      }
      any = true;
      this.life[i] -= dt;
      const i3 = i * 3;
      const d = Math.exp(-this.drag[i] * dt);
      this.vels[i3] *= d;
      this.vels[i3 + 1] *= d;
      this.vels[i3 + 2] *= d;
      this.positions[i3] += this.vels[i3] * dt;
      this.positions[i3 + 1] += this.vels[i3 + 1] * dt;
      this.positions[i3 + 2] += this.vels[i3 + 2] * dt;

      const t = Math.max(0, this.life[i] / this.maxLife[i]);
      this.alphas[i] = t * t;
      this.sizes[i] = Math.max(0.02, this.sizes[i] + this.grow[i] * dt);
    }
    if (any) {
      const a = this.points.geometry.attributes;
      a.position.needsUpdate = true;
      a.aAlpha.needsUpdate = true;
      a.aSize.needsUpdate = true;
      a.aColor.needsUpdate = true;
    }
  }
}
