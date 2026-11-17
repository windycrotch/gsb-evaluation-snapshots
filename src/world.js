import * as THREE from 'three';
import { mulberry32, rand, fibonacciSphere, projectOnPlane, glowTexture, disposeObject } from './utils.js';

const HOVER = 0.95;

/** 微小行星地表起伏（无缝，无需 UV） */
function surfaceNoise(x, y, z) {
  return (
    (Math.sin(x * 1.7 + y * 2.3) * Math.cos(z * 1.9 + x * 0.7) + Math.sin(y * 3.1 + z * 1.3) * 0.8) * 0.5 +
    Math.sin(x * 4.3 + z * 3.7) * 0.15
  );
}

export class Level {
  constructor({ scene, palette, index, seed, particles }) {
    this.scene = scene;
    this.palette = palette;
    this.index = index;
    this.particles = particles;
    this.rng = mulberry32(seed);
    this.root = new THREE.Group();
    scene.add(this.root);

    this.bodies = [];
    this.shards = [];
    this.thorns = [];
    this.shades = [];
    this.gridMats = [];
    this.totalShards = 0;
    this.collected = 0;
    this.portal = null;
    this.portalUsed = false;
    this.onCollect = null;
    this.onPortal = null;
    this.onDamage = null;
    this.onShadeNear = null;
    this._accent = new THREE.Color(palette.accent);
    this._accent2 = new THREE.Color(palette.accent2);

    this.build();
  }

  // ---------------------------------------------------------------- build
  build() {
    const i = this.index;
    const mainRadius = 8.4 + i * 0.55;
    this.mainRadius = mainRadius;

    const mainBody = this._addBody(new THREE.Vector3(0, 0, 0), mainRadius, true);
    this.bodies.push(mainBody);

    // 小卫星
    const moonCount = i === 0 ? 1 : i === 1 ? 2 : 3;
    const moonRadiusBase = Math.max(2.2, mainRadius * 0.33);
    const usedDirs = [new THREE.Vector3(0, 1, 0)];
    for (let m = 0; m < moonCount; m++) {
      let dir = null;
      for (let attempt = 0; attempt < 40; attempt++) {
        const d = new THREE.Vector3(
          this.rng() * 2 - 1,
          this.rng() * 1.5 - 0.75,
          this.rng() * 2 - 1
        ).normalize();
        if (usedDirs.every((u) => u.dot(d) < 0.55)) {
          dir = d;
          break;
        }
      }
      if (!dir) dir = new THREE.Vector3(Math.cos(m * 2.1), 0.3, Math.sin(m * 2.1)).normalize();
      usedDirs.push(dir);

      const r = moonRadiusBase * rand(this.rng, 0.8, 1.25);
      const dist = mainRadius + r + rand(this.rng, 3.1, 4.4);
      const body = this._addBody(dir.clone().multiplyScalar(dist), r, false);
      this.bodies.push(body);
    }

    this._addMainRing(mainBody);
    this._addShards();
    this._addThorns();
    this._addShades();
    this._addPortal();
  }

  _addBody(center, radius, isMain) {
    const group = new THREE.Group();
    group.position.copy(center);
    this.root.add(group);

    const seg = isMain ? 96 : 64;
    const geo = new THREE.SphereGeometry(radius, seg, Math.round(seg * 0.66));
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const base = new THREE.Color(this.palette.base);
    const hi = new THREE.Color(this.palette.base).lerp(this._accent, isMain ? 0.22 : 0.3);
    const v = new THREE.Vector3();
    const c = new THREE.Color();
    const amp = radius * 0.028;
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k);
      const n = surfaceNoise(v.x * 0.9, v.y * 0.9, v.z * 0.9);
      const d = 1 + (n * amp) / radius;
      v.multiplyScalar(d);
      pos.setXYZ(k, v.x, v.y, v.z);
      const t = THREE.MathUtils.clamp(n * 0.5 + 0.5, 0, 1);
      c.copy(base).lerp(hi, Math.pow(t, 2.2) * 0.85);
      colors[k * 3] = c.r;
      colors[k * 3 + 1] = c.g;
      colors[k * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.88,
      metalness: 0.16,
      emissive: this._accent.clone().multiplyScalar(isMain ? 0.04 : 0.08),
    });
    const mesh = new THREE.Mesh(geo, mat);
    group.add(mesh);

    // 能量网格
    const gridMat = new THREE.MeshBasicMaterial({
      color: this._accent.clone(),
      wireframe: true,
      transparent: true,
      opacity: isMain ? 0.085 : 0.06,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const grid = new THREE.Mesh(new THREE.IcosahedronGeometry(radius * 1.014, 3), gridMat);
    grid.rotation.y = this.rng() * Math.PI;
    group.add(grid);
    this.gridMats.push({ mat: gridMat, base: gridMat.opacity });

    // 大气辉光
    const atmoMat = new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uColor: { value: this._accent.clone().lerp(this._accent2, 0.4) },
        uPower: { value: 3.1 },
        uStrength: { value: isMain ? 0.6 : 0.5 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV;
        void main(){
          vN = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV;
        uniform vec3 uColor; uniform float uPower; uniform float uStrength;
        void main(){
          float f = pow(1.0 - abs(dot(vN, vV)), uPower);
          gl_FragColor = vec4(uColor, f * uStrength);
        }
      `,
    });
    const atmo = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.14, 48, 32), atmoMat);
    group.add(atmo);

    const body = { center: center.clone(), radius, group, grid, atmoMat, isMain };
    this._addDecor(body);
    return body;
  }

  _addDecor(body) {
    const isMain = body.isMain;
    const N = isMain ? 92 : 26;
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const m = new THREE.Matrix4();
    const s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const dirs = fibonacciSphere(N, 0.5);
    const randQ = new THREE.Quaternion();
    const axis = new THREE.Vector3();

    // 发光晶簇
    const crystalGeo = new THREE.ConeGeometry(0.3, 1.5, 5);
    crystalGeo.translate(0, 0.75, 0);
    const crystalMat = new THREE.MeshStandardMaterial({
      color: 0x0a1018,
      emissive: this._accent2.clone(),
      emissiveIntensity: 1.5,
      roughness: 0.25,
      metalness: 0.55,
      flatShading: true,
    });
    const crystals = new THREE.InstancedMesh(crystalGeo, crystalMat, N);
    crystals.frustumCulled = false;
    for (let k = 0; k < N; k++) {
      const d = dirs[k].clone();
      if (isMain && d.y > 0.93) d.y -= 0.35, d.normalize();
      p.copy(body.center).addScaledVector(d, body.radius * 0.985);
      q.setFromUnitVectors(up, d);
      axis.set(this.rng() - 0.5, this.rng() - 0.5, this.rng() - 0.5).normalize();
      randQ.setFromAxisAngle(axis, rand(this.rng, -0.25, 0.25));
      q.multiply(randQ);
      const sc = rand(this.rng, 0.35, 1.15) * (body.radius / 8.5);
      s.set(sc * rand(this.rng, 0.7, 1.3), sc * rand(this.rng, 0.8, 1.8), sc * rand(this.rng, 0.7, 1.3));
      m.compose(p, q, s);
      crystals.setMatrixAt(k, m);
      crystals.setColorAt(k, new THREE.Color(this.palette.accent).lerp(new THREE.Color(0xffffff), this.rng() * 0.7));
    }
    crystals.instanceMatrix.needsUpdate = true;
    if (crystals.instanceColor) crystals.instanceColor.needsUpdate = true;
    body.group.add(crystals);

    // 岩石
    const rockGeo = new THREE.IcosahedronGeometry(0.55, 0);
    const rockMat = new THREE.MeshStandardMaterial({
      color: this.palette.rock,
      roughness: 0.98,
      metalness: 0.08,
      flatShading: true,
    });
    const rockDirs = fibonacciSphere(Math.round(N * 0.65), 0.2);
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockDirs.length);
    rocks.frustumCulled = false;
    for (let k = 0; k < rockDirs.length; k++) {
      const d = rockDirs[k].clone().add(new THREE.Vector3(this.rng() - 0.5, this.rng() - 0.5, this.rng() - 0.5).multiplyScalar(0.12)).normalize();
      p.copy(body.center).addScaledVector(d, body.radius * 0.97);
      q.setFromEuler(new THREE.Euler(this.rng() * 6.28, this.rng() * 6.28, this.rng() * 6.28));
      const sc = rand(this.rng, 0.4, 1.7) * (body.radius / 8.5);
      s.set(sc, sc * rand(this.rng, 0.6, 1.2), sc);
      m.compose(p, q, s);
      rocks.setMatrixAt(k, m);
    }
    rocks.instanceMatrix.needsUpdate = true;
    body.group.add(rocks);
  }

  _addMainRing(body) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 8;
    const ctx = canvas.getContext('2d');
    const grd = ctx.createLinearGradient(0, 0, 512, 0);
    for (let k = 0; k <= 32; k++) {
      const t = k / 32;
      const a = Math.max(0, Math.sin(t * Math.PI) * (0.35 + 0.65 * Math.abs(Math.sin(t * 19.0)))) * (1 - t * 0.25);
      grd.addColorStop(t, `rgba(255,255,255,${a.toFixed(3)})`);
    }
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 512, 8);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;

    const inner = body.radius * 1.5;
    const outer = body.radius * 2.55;
    const geo = new THREE.RingGeometry(inner, outer, 128, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      color: this._accent.clone().lerp(this._accent2, 0.5),
      transparent: true,
      opacity: 0.32,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(geo, mat);
    ring.rotation.x = Math.PI * 0.5 - 0.34;
    ring.rotation.z = 0.2;
    body.group.add(ring);
    body.ring = ring;
  }

  _randomSurfaceDir(body, avoid = [], minDot = 0.93) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const d = new THREE.Vector3(
        this.rng() * 2 - 1,
        this.rng() * 2 - 1,
        this.rng() * 2 - 1
      ).normalize();
      if (avoid.every((a) => a.dot(d) < minDot)) return d;
    }
    return new THREE.Vector3(0, 1, 0);
  }

  _addShards() {
    const count = 6 + this.index * 2;
    const perBody = [];
    let remaining = count;
    // 每颗卫星至少 1 个
    for (let b = 0; b < this.bodies.length; b++) {
      perBody.push(0);
    }
    for (let b = 1; b < this.bodies.length; b++) {
      perBody[b] = 1;
      remaining--;
    }
    perBody[0] += remaining;

    const shardGeo = new THREE.OctahedronGeometry(0.44, 0);
    const ringGeo = new THREE.TorusGeometry(0.78, 0.035, 6, 32);
    const glowTex = glowTexture(128);

    this.bodies.forEach((body, bi) => {
      const usedDirs = [new THREE.Vector3(0, 1, 0)];
      for (let k = 0; k < perBody[bi]; k++) {
        const dir = this._randomSurfaceDir(body, usedDirs, 0.82);
        if (bi === 0 && dir.y > 0.55) {
          dir.y = -0.1 - this.rng() * 0.4;
          dir.normalize();
        }
        usedDirs.push(dir);

        const group = new THREE.Group();
        const shardMat = new THREE.MeshStandardMaterial({
          color: 0x0a0f18,
          emissive: this._accent2.clone(),
          emissiveIntensity: 2.1,
          metalness: 0.7,
          roughness: 0.18,
          flatShading: true,
        });
        const mesh = new THREE.Mesh(shardGeo, shardMat);
        group.add(mesh);

        const ringMat = new THREE.MeshBasicMaterial({
          color: this._accent.clone(),
          transparent: true,
          opacity: 0.55,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = Math.PI * 0.42;
        group.add(ring);

        const halo = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: glowTex,
            color: this._accent2.clone(),
            transparent: true,
            opacity: 0.38,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          })
        );
        halo.scale.set(2.5, 2.5, 1);
        group.add(halo);

        const basePos = body.center.clone().addScaledVector(dir, body.radius + 1.25);
        group.position.copy(basePos);
        this.root.add(group);

        this.shards.push({
          body,
          dir,
          group,
          mesh,
          ring,
          halo,
          basePos,
          pos: basePos.clone(),
          phase: this.rng() * Math.PI * 2,
          taken: false,
        });
      }
    });

    this.totalShards = this.shards.length;
  }

  _addThorns() {
    const clusterCount = 2 + this.index * 4;
    const spikes = [];
    const dirsByBody = new Map();
    this.bodies.forEach((b) => dirsByBody.set(b, [new THREE.Vector3(0, 1, 0)]));

    for (let c = 0; c < clusterCount; c++) {
      const body = this.bodies[c % this.bodies.length];
      const used = dirsByBody.get(body);
      let dir = this._randomSurfaceDir(body, used, 0.9);
      if (body.isMain && dir.y > 0.2) {
        dir.y = -0.25 - this.rng() * 0.5;
        dir.normalize();
      }
      used.push(dir);

      const basePos = body.center.clone().addScaledVector(dir, body.radius);
      this.thorns.push({ body, dir, pos: basePos, radius: 1.5 });

      const tangentA = projectOnPlane(new THREE.Vector3(0, 1, 0), dir);
      if (tangentA.lengthSq() < 1e-4) tangentA.set(1, 0, 0);
      tangentA.normalize();
      const tangentB = new THREE.Vector3().crossVectors(dir, tangentA).normalize();

      const n = 4;
      for (let k = 0; k < n; k++) {
        const ang = (k / n) * Math.PI * 2 + this.rng();
        const off = 0.42;
        const d = dir
          .clone()
          .addScaledVector(tangentA, Math.cos(ang) * off * 0.5)
          .addScaledVector(tangentB, Math.sin(ang) * off * 0.5)
          .normalize();
        const h = rand(this.rng, 1.1, 2.2);
        spikes.push({ dir: d, height: h, pos: body.center.clone().addScaledVector(d, body.radius - 0.1) });
      }
    }

    const spikeGeo = new THREE.ConeGeometry(0.26, 1, 4);
    spikeGeo.translate(0, 0.5, 0);
    const spikeMat = new THREE.MeshStandardMaterial({
      color: 0x140a14,
      emissive: new THREE.Color(0xff2255),
      emissiveIntensity: 0.55,
      roughness: 0.35,
      metalness: 0.6,
      flatShading: true,
    });
    const inst = new THREE.InstancedMesh(spikeGeo, spikeMat, spikes.length);
    inst.frustumCulled = false;
    const q = new THREE.Quaternion();
    const m = new THREE.Matrix4();
    const s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    spikes.forEach((sp, k) => {
      q.setFromUnitVectors(up, sp.dir);
      s.set(1, sp.height, 1);
      m.compose(sp.pos, q, s);
      inst.setMatrixAt(k, m);
    });
    inst.instanceMatrix.needsUpdate = true;
    this.root.add(inst);
    this.spikeMat = spikeMat;

    // 顶端红光
    const tipGeo = new THREE.SphereGeometry(0.14, 8, 6);
    const tipMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3d6e) });
    const tips = new THREE.InstancedMesh(tipGeo, tipMat, spikes.length);
    tips.frustumCulled = false;
    spikes.forEach((sp, k) => {
      q.setFromUnitVectors(up, sp.dir);
      s.set(1, 1, 1);
      m.compose(sp.pos.clone().addScaledVector(sp.dir, sp.height), q, s);
      tips.setMatrixAt(k, m);
    });
    tips.instanceMatrix.needsUpdate = true;
    this.root.add(tips);
  }

  _addShades() {
    const count = this.index >= 3 ? 2 : this.index >= 1 ? 1 : 0;
    const glowTex = glowTexture(128);
    for (let k = 0; k < count; k++) {
      const body = this.bodies[0];
      const dir = this._randomSurfaceDir(body, [new THREE.Vector3(0, 1, 0)], 0.5);
      dir.y = -0.2 - this.rng() * 0.4;
      dir.normalize();
      const group = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({
        color: 0x0a0510,
        emissive: new THREE.Color(0x8b1fff),
        emissiveIntensity: 1.1,
        roughness: 0.4,
        metalness: 0.5,
        flatShading: true,
      });
      const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.95, 1), mat);
      group.add(core);
      const wire = new THREE.Mesh(
        new THREE.IcosahedronGeometry(1.25, 1),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(0xff2d7a),
          wireframe: true,
          transparent: true,
          opacity: 0.45,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      group.add(wire);
      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTex,
          color: new THREE.Color(0xff2d7a),
          transparent: true,
          opacity: 0.5,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      halo.scale.set(5.2, 5.2, 1);
      group.add(halo);
      const pos = body.center.clone().addScaledVector(dir, body.radius + 1.3);
      group.position.copy(pos);
      this.root.add(group);
      this.shades.push({ group, core, wire, halo, pos, body, speed: 2.5 + this.index * 0.35, phase: this.rng() * 6.28 });
    }
  }

  _addPortal() {
    const body = this.bodies[0];
    const dir = this._randomSurfaceDir(body, [new THREE.Vector3(0, 1, 0)], 0.35);
    dir.y = -0.05 - this.rng() * 0.35;
    dir.normalize();
    const basePos = body.center.clone().addScaledVector(dir, body.radius + 0.05);

    const group = new THREE.Group();
    group.position.copy(basePos);
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    this.root.add(group);

    const ringMat = new THREE.MeshBasicMaterial({
      color: this._accent.clone(),
      transparent: true,
      opacity: 0.18,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const ring1 = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.11, 10, 64), ringMat);
    ring1.rotation.x = Math.PI * 0.5;
    group.add(ring1);
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(1.35, 0.05, 8, 48), ringMat);
    ring2.rotation.x = Math.PI * 0.5;
    group.add(ring2);

    const beamMat = new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
      uniforms: {
        uColor: { value: this._accent.clone() },
        uTime: { value: 0 },
        uActive: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform vec3 uColor; uniform float uTime; uniform float uActive;
        void main(){
          float band = 0.6 + 0.4 * sin(vUv.y * 26.0 - uTime * 5.0);
          float a = pow(1.0 - vUv.y, 1.6) * band * 0.42 * uActive;
          gl_FragColor = vec4(uColor, a);
        }
      `,
    });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.45, 1.15, 15, 32, 1, true), beamMat);
    beam.position.y = 7.5;
    group.add(beam);

    // 上升光点
    const pCount = 70;
    const pPos = new Float32Array(pCount * 3);
    const pSeed = new Float32Array(pCount);
    for (let k = 0; k < pCount; k++) {
      pSeed[k] = this.rng();
      const a = this.rng() * Math.PI * 2;
      const r = Math.sqrt(this.rng()) * 1.3;
      pPos[k * 3] = Math.cos(a) * r;
      pPos[k * 3 + 1] = this.rng() * 15;
      pPos[k * 3 + 2] = Math.sin(a) * r;
    }
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    pGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 7, 0), 20);
    const pMat = new THREE.PointsMaterial({
      size: 0.22,
      map: glowTexture(64),
      color: this._accent.clone(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    const sparks = new THREE.Points(pGeo, pMat);
    group.add(sparks);

    const light = new THREE.PointLight(this._accent.clone(), 0, 26, 2);
    light.position.y = 1.4;
    group.add(light);

    this.portal = {
      group,
      ring1,
      ring2,
      ringMat,
      beam,
      beamMat,
      sparks,
      pMat,
      pPos,
      pSeed,
      light,
      dir,
      pos: basePos,
      active: false,
      amount: 0,
    };
  }

  setPortalActive(v) {
    if (!this.portal) return;
    this.portal.active = v;
  }

  // ---------------------------------------------------------------- update
  update(dt, t, player) {
    const accent = this._accent;
    const ratio = this.totalShards > 0 ? this.collected / this.totalShards : 1;
    this.gridMats.forEach((g) => {
      g.mat.opacity = g.base * (1 + ratio * 3.4);
    });

    // 星屑
    for (const s of this.shards) {
      if (s.taken) continue;
      const bob = Math.sin(t * 2.1 + s.phase) * 0.22;
      const base = s.basePos.clone().addScaledVector(s.dir, bob);
      s.pos.lerp(base, 1 - Math.exp(-6 * dt));
      const d = s.pos.distanceTo(player.position);
      if (d < 3.4) {
        s.pos.lerp(player.position, 1 - Math.exp(-9 * dt));
      }
      s.group.position.copy(s.pos);
      s.mesh.rotation.y += dt * 1.7;
      s.mesh.rotation.x += dt * 0.9;
      s.ring.rotation.z += dt * 2.2;
      s.halo.material.opacity = 0.28 + Math.sin(t * 3 + s.phase) * 0.1;
      if (d < 1.15) this._collect(s);
    }

    // 荆棘脉冲
    if (this.spikeMat) {
      this.spikeMat.emissiveIntensity = 0.45 + Math.sin(t * 3.4) * 0.25;
      for (const th of this.thorns) {
        if (player.invuln <= 0 && player.alive && player.position.distanceTo(th.pos) < th.radius + 0.55) {
          this._damage(th.pos);
          break;
        }
      }
    }

    // 暗影
    for (const sh of this.shades) {
      const toPlayer = new THREE.Vector3().subVectors(player.position, sh.pos);
      const n = new THREE.Vector3().subVectors(sh.pos, sh.body.center).normalize();
      const tangent = projectOnPlane(toPlayer, n);
      const dist = tangent.length();
      const onSameBody = player.position.distanceTo(player.body.center) < player.body.radius + 3;
      if (dist > 0.4) {
        tangent.normalize();
        const speed = onSameBody ? sh.speed * 1.35 : sh.speed * 0.7;
        sh.pos.addScaledVector(tangent, speed * dt);
      }
      const out = new THREE.Vector3().subVectors(sh.pos, sh.body.center).normalize();
      sh.pos.copy(sh.body.center).addScaledVector(out, sh.body.radius + 1.35 + Math.sin(t * 2 + sh.phase) * 0.12);
      sh.group.position.copy(sh.pos);
      sh.core.rotation.y += dt * 0.8;
      sh.core.rotation.z += dt * 0.5;
      sh.wire.rotation.y -= dt * 1.3;
      const pulse = 0.9 + Math.sin(t * 4 + sh.phase) * 0.12;
      sh.halo.scale.setScalar(5.2 * pulse);
      sh.halo.material.opacity = 0.35 + Math.sin(t * 5 + sh.phase) * 0.12;

      if (player.alive && player.invuln <= 0 && player.position.distanceTo(sh.pos) < 1.75) {
        this._damage(sh.pos);
        const away = projectOnPlane(player.position.clone().sub(sh.pos), player.normal).normalize();
        player.velocity.addScaledVector(away, 12);
        player.vRadial = Math.max(player.vRadial, 6);
        player.grounded = false;
      }
    }

    // 星门
    const p = this.portal;
    if (p) {
      p.amount += ((p.active ? 1 : 0) - p.amount) * (1 - Math.exp(-3.2 * dt));
      p.ring1.rotation.z += dt * (0.5 + p.amount * 2.4);
      p.ring2.rotation.z -= dt * (0.8 + p.amount * 3.4);
      p.ringMat.opacity = 0.16 + p.amount * 0.85;
      p.beamMat.uniforms.uTime.value = t;
      p.beamMat.uniforms.uActive.value = p.amount;
      p.light.intensity = p.amount * 45 + Math.sin(t * 4) * p.amount * 8;
      p.pMat.opacity = p.amount * 0.9;
      if (p.amount > 0.02) {
        const arr = p.pPos;
        for (let k = 0; k < p.pSeed.length; k++) {
          arr[k * 3 + 1] += dt * (1.8 + p.pSeed[k] * 2.2);
          if (arr[k * 3 + 1] > 15) arr[k * 3 + 1] = 0;
          const ang = t * 0.8 + p.pSeed[k] * 6.28;
          const rad = 0.55 + p.pSeed[k] * 0.7;
          arr[k * 3] = Math.cos(ang) * rad;
          arr[k * 3 + 2] = Math.sin(ang) * rad;
        }
        p.sparks.geometry.attributes.position.needsUpdate = true;
      }
      if (p.active && !this.portalUsed && player.alive && player.position.distanceTo(p.pos) < 2.3) {
        this.portalUsed = true;
        if (this.onPortal) this.onPortal();
      }
    }
  }

  _collect(s) {
    s.taken = true;
    this.root.remove(s.group);
    s.mesh.material.dispose();
    s.ring.material.dispose();
    s.halo.material.dispose();
    this.collected++;
    this.particles.burst(s.pos, this.palette.accent2, {
      count: 26,
      speed: 6,
      size: 0.5,
      life: 0.9,
      color2: 0xffffff,
      drag: 3,
    });
    this.particles.burst(s.pos, this.palette.accent, {
      count: 12,
      speed: 2.4,
      size: 0.9,
      life: 1.3,
      drag: 1.6,
      grow: 0.4,
    });
    if (this.onCollect) this.onCollect(this.collected, this.totalShards, s.pos.clone());
    if (this.collected >= this.totalShards) this.setPortalActive(true);
  }

  _damage(pos) {
    this.particles.burst(pos, 0xff3d6e, { count: 18, speed: 7, size: 0.45, life: 0.6, drag: 3 });
    if (this.onDamage) this.onDamage(pos);
  }

  dispose() {
    this.scene.remove(this.root);
    disposeObject(this.root);
    this.shards = [];
    this.thorns = [];
    this.shades = [];
  }
}
