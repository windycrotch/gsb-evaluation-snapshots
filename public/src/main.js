import * as THREE from '../vendor/three.module.js';
import { loadMesh } from './mesh.js';
import { dropletFragment, dropletVertex, fabricFragment, fabricVertex, outlineFragment, outlineVertex, stageFragment, stageVertex } from './shaders.js';
import { initUI } from './ui.js';
import { applyPose } from './pose.js';

const canvas = document.getElementById('view');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const mobilePointer = matchMedia('(pointer: coarse)').matches;
const lengths = {
  ankle: [.132, .022], crew: [.285, .034], knee: [.425, .04],
  over: [.545, .05], thigh: [.7, .05], tights: [1, .05],
};
const palette = {
  ink: '#141318', smoke: '#6c7381', ivory: '#f4f1f3', nude: '#dba585',
  coffee: '#5a3a2c', wine: '#6e1b2e', cherry: '#c22a3a', sakura: '#f3b3c6',
  taro: '#b49ad6', mist: '#8fb4de', navy: '#1f2a4d', forest: '#254a3c',
};
const backgrounds = {
  lilac: ['#f0edef', '#e3dae7'], sakura: ['#fbf1f3', '#f3d6dd'],
  mint: ['#f1f8f5', '#cfe7df'], cream: ['#fbf7ee', '#f0e3c8'],
  sky: ['#f0f6fc', '#cbdff3'], dusk: ['#4a4868', '#2a2944'],
};
const sceneKeys = ['studio', 'bath', 'street', 'pool'];
const scenicColors = {
  bath: ['#ccdfe2', '#bec7cd'],
  street: ['#303044', '#252a39'],
  pool: ['#bde9ea', '#e4dccc'],
};
const styles = ['sheer', 'matte', 'gloss', 'pearl', 'velvet', 'cotton', 'latex'];
const cuffs = ['plain', 'lace', 'stripes', 'rib', 'bow'];
const patterns = ['none', 'dots', 'argyle', 'net', 'hoops', 'pins', 'seam', 'hearts', 'stars', 'lace', 'fade', 'paws'];
const defaultLeg = { length: 'thigh', cuff: 'lace', material: 'sheer', denier: 40, color: 'ink' };
const restTarget = new THREE.Vector3(0, .43, .035);
const maxStains = 24;
const poses = ['single', 'together', 'step', 'crossed', 'tiptoe', 'point', 'pigeon'];

function createSound() {
  let context;
  let noise;
  let enabled = true;
  return {
    setEnabled(value) { enabled = value; },
    play(strength = 1) {
      if (!enabled || !window.AudioContext) return;
      context ??= new AudioContext();
      if (context.state === 'suspended') context.resume().catch(() => {});
      if (!noise) {
        noise = context.createBuffer(1, context.sampleRate * .55, context.sampleRate);
        const samples = noise.getChannelData(0);
        for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
      }
      const source = context.createBufferSource();
      const filter = context.createBiquadFilter();
      const gain = context.createGain();
      const now = context.currentTime;
      source.buffer = noise;
      source.playbackRate.value = .82 + Math.random() * .42;
      filter.type = 'bandpass';
      filter.Q.value = .56;
      filter.frequency.setValueAtTime(2900, now);
      filter.frequency.exponentialRampToValueAtTime(640, now + .29);
      gain.gain.setValueAtTime(.001, now);
      gain.gain.linearRampToValueAtTime(.22 * strength, now + .016);
      gain.gain.exponentialRampToValueAtTime(.001, now + .30);
      source.connect(filter).connect(gain).connect(context.destination);
      source.start();
      source.stop(now + .33);
    },
  };
}

function fabricMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      dye: { value: new THREE.Color(palette.ink) },
      wetDye: { value: new THREE.Color(0) },
      tint: { value: new THREE.Color(0xffffff) },
      lengthLimit: { value: .7 },
      band: { value: .05 },
      denier: { value: 40 },
      fabric: { value: 0 },
      cuff: { value: 1 },
      pattern: { value: 0 },
      secret: { value: 0 },
      garter: { value: 0 },
      skinOnly: { value: 0 },
      reflection: { value: 0 },
      time: { value: 0 },
      stains: { value: Array.from({ length: maxStains }, () => new THREE.Vector4(0, 0, 0, 0)) },
    },
    vertexShader: fabricVertex,
    fragmentShader: fabricFragment,
    transparent: true,
  });
}

function updateFabric(uniforms, clothes) {
  const config = { ...defaultLeg, ...clothes };
  const [limit, band] = lengths[config.length] ?? lengths.thigh;
  uniforms.dye.value.set(palette[config.color] ?? config.color ?? palette.ink);
  uniforms.wetDye.value.set(palette[config.wetColor] ?? (config.wetColor || 0));
  uniforms.lengthLimit.value = limit;
  uniforms.band.value = band;
  uniforms.denier.value = Number(config.denier) || 40;
  uniforms.fabric.value = Math.max(0, styles.indexOf(config.material));
  uniforms.cuff.value = config.length === 'tights' ? 0 : Math.max(0, cuffs.indexOf(config.cuff));
  uniforms.pattern.value = Math.max(0, patterns.indexOf(config.pattern));
  uniforms.secret.value = config.secret === 'words' ? 2 : Math.max(0, patterns.indexOf(config.secret));
  uniforms.garter.value = Number(Boolean(config.garter));
}

function radialShadow() {
  const image = document.createElement('canvas');
  image.width = image.height = 64;
  const ctx = image.getContext('2d');
  const gradient = ctx.createRadialGradient(32, 32, 1, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,.91)');
  gradient.addColorStop(.36, 'rgba(255,255,255,.54)');
  gradient.addColorStop(.70, 'rgba(255,255,255,.15)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(image);
}

function bakeFloorShadow(models) {
  const resolution = 384;
  const image = document.createElement('canvas');
  image.width = image.height = resolution;
  const raw = image.cloneNode();
  const outlines = raw.getContext('2d');
  const coordinates = new THREE.Vector3();
  const projected = [];
  for (const { group, cloth } of models) {
    if (!group.visible) continue;
    group.updateMatrixWorld(true);
    const geometry = cloth.geometry;
    const points = geometry.attributes.position;
    projected.length = points.count * 2;
    for (let index = 0; index < points.count; index++) {
      coordinates.fromBufferAttribute(points, index).applyMatrix4(cloth.matrixWorld);
      const x = coordinates.x + coordinates.y * .35;
      const z = coordinates.z - coordinates.y * 1.45;
      projected[index * 2] = (x + .50) * resolution / 1.85;
      projected[index * 2 + 1] = (z + 1.55) * resolution / 2;
    }

    outlines.beginPath();
    const faces = geometry.index.array;
    for (let index = 0; index < faces.length; index += 3) {
      const a = faces[index] * 2;
      const b = faces[index + 1] * 2;
      const c = faces[index + 2] * 2;
      const ax = projected[a];
      const ay = projected[a + 1];
      const bx = projected[b];
      const by = projected[b + 1];
      const cx = projected[c];
      const cy = projected[c + 1];
      const clockwise = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay) > 0;
      outlines.moveTo(ax, ay);
      outlines.lineTo(clockwise ? bx : cx, clockwise ? by : cy);
      outlines.lineTo(clockwise ? cx : bx, clockwise ? cy : by);
      outlines.closePath();
    }
    outlines.fillStyle = 'white';
    outlines.fill();
  }

  const ctx = image.getContext('2d');
  ctx.filter = 'blur(3px)';
  ctx.drawImage(raw, 0, 0);
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'destination-in';
  const falloff = ctx.createLinearGradient(0, resolution * .1, 0, resolution * .93);
  falloff.addColorStop(0, 'rgba(255,255,255,.22)');
  falloff.addColorStop(.52, 'rgba(255,255,255,.68)');
  falloff.addColorStop(1, 'rgba(255,255,255,.91)');
  ctx.fillStyle = falloff;
  ctx.fillRect(0, 0, resolution, resolution);
  return new THREE.CanvasTexture(image);
}

function createEngine({ stocking }) {
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: false, preserveDrawingBuffer: true,
    powerPreference: mobilePointer ? 'default' : 'high-performance',
  });
  const world = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, .02, 12);
  const thumbCamera = new THREE.PerspectiveCamera(30, 3 / 4, .02, 12);
  const backdropMaterial = new THREE.ShaderMaterial({
    uniforms: {
      upper: { value: new THREE.Color() },
      lower: { value: new THREE.Color() },
      kind: { value: 0 },
      time: { value: 0 },
      aspect: { value: 1.6 },
    },
    vertexShader: stageVertex,
    fragmentShader: stageFragment,
    depthTest: false,
    depthWrite: false,
  });
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), backdropMaterial);
  backdrop.frustumCulled = false;
  backdrop.renderOrder = -10;
  world.add(backdrop);

  const contactTexture = radialShadow();
  const shadowGeometry = new THREE.PlaneGeometry(.31, .56);
  const shadowCache = new Map();
  const floorShade = new THREE.Mesh(new THREE.PlaneGeometry(1.85, 2), new THREE.MeshBasicMaterial({
    color: '#9a88a8', transparent: true, opacity: .52, depthWrite: false,
  }));
  floorShade.position.set(.425, .001, -.55);
  floorShade.rotation.x = -Math.PI / 2;
  floorShade.renderOrder = -3;
  world.add(floorShade);
  const legMeshes = [];
  const models = [0, 1].map(index => {
    const group = new THREE.Group();
    const geometry = stocking.clone();
    const cloth = new THREE.Mesh(geometry, fabricMaterial());
    cloth.userData.leg = index;
    cloth.renderOrder = 1;
    group.add(cloth);
    const outline = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
      uniforms: { lengthLimit: cloth.material.uniforms.lengthLimit },
      vertexShader: outlineVertex, fragmentShader: outlineFragment,
      transparent: true, side: THREE.BackSide,
    }));
    outline.renderOrder = 0;
    group.add(outline);
    const reflectionMaterial = new THREE.ShaderMaterial({
      uniforms: { ...cloth.material.uniforms, reflection: { value: 0 } },
      vertexShader: fabricVertex, fragmentShader: fabricFragment,
      transparent: true, depthWrite: false,
    });
    const reflection = new THREE.Mesh(geometry, reflectionMaterial);
    reflection.scale.set(index === 0 ? 1 : -1, -1, 1);
    reflection.renderOrder = -4;
    world.add(reflection);
    const contact = new THREE.Mesh(shadowGeometry, new THREE.MeshBasicMaterial({
      map: contactTexture, color: '#9581a7', transparent: true, opacity: .27, depthWrite: false,
    }));
    contact.position.set(.02, .002, .061);
    contact.rotation.x = -Math.PI / 2;
    contact.renderOrder = -2;
    group.add(contact);
    group.scale.x = index === 0 ? 1 : -1;
    world.add(group);
    legMeshes.push(cloth);
    return { group, cloth, reflection, nextStain: 0 };
  });

  const droplets = [];
  const ripples = [];
  const dropletGeometry = new THREE.IcosahedronGeometry(1, 1);
  const dropMaterial = new THREE.ShaderMaterial({
    vertexShader: dropletVertex, fragmentShader: dropletFragment, transparent: true, depthWrite: false,
  });
  const rimGeometry = new THREE.RingGeometry(.83, 1, 28);
  const ray = new THREE.Raycaster();
  const hitVector = new THREE.Vector2();
  const sound = createSound();
  const pointers = new Map();
  const view = { yaw: .62, pitch: .1, range: 2.50, target: restTarget.clone() };
  const liveView = { yaw: .62, pitch: .1, range: 2.50, target: restTarget.clone() };
  let environment = 'studio';
  let colorway = 'lilac';
  let wardrobe = [defaultLeg, defaultLeg];
  let pose = 'step';
  let mode = 'water';
  let rain = false;
  let slow = false;
  let rainClock = 0;
  let playClock = 0;
  let width = 1;
  let height = 1;
  let projectionLeft = 0;
  let sheetShift = 0;
  let lastTime = performance.now();
  let lastInput = lastTime;

  function setScene(sceneName, colorName) {
    environment = sceneName ?? environment;
    colorway = colorName ?? colorway;
    const colors = environment === 'studio'
      ? (Array.isArray(colorway) ? colorway : backgrounds[colorway] ?? backgrounds.lilac)
      : scenicColors[environment] ?? scenicColors.bath;
    const customColor = typeof colorway === 'string' && /^#[0-9a-f]{6}$/i.test(colorway);
    const settings = backdropMaterial.uniforms;
    settings.upper.value.set(customColor && environment === 'studio' ? colorway : colors[0]);
    settings.lower.value.set(colors[1]);
    if (customColor && environment === 'studio') settings.lower.value.copy(settings.upper.value).multiplyScalar(.79);
    settings.kind.value = Math.max(0, sceneKeys.indexOf(environment));
    const tint = environment === 'street' ? '#c1afd2' : '#ffffff';
    const reflectAmount = { bath: .22, street: .28, pool: .12 }[environment] ?? 0;
    models.forEach(({ group, cloth, reflection }) => {
      cloth.material.uniforms.tint.value.set(tint);
      reflection.material.uniforms.reflection.value = reflectAmount;
      reflection.visible = group.visible && reflectAmount > 0;
    });
    floorShade.material.color.set({bath: '#84929f', pool: '#8a877f', street: '#252333'}[environment] ?? '#9a88a8');
  }

  function setMaterial(config) {
    wardrobe = Array.isArray(config) ? config : config?.legs ?? [config, config];
    models.forEach(({ cloth }, index) => updateFabric(cloth.material.uniforms, wardrobe[index]));
  }

  function setPose(name) {
    const next = poses.includes(name) ? name : 'step';
    if (next === pose && models[0].cloth.geometry.hasAttribute('restPosition')) return;
    pose = next;
    models.forEach(({ group, cloth, reflection }, index) => {
      const { x, y, z, visible } = applyPose(cloth.geometry, stocking, pose, index);
      group.position.set(x, y, z);
      group.visible = visible;
      reflection.position.set(x, -y, z);
      reflection.visible = visible && reflection.material.uniforms.reflection.value > 0;
    });
    if (!shadowCache.has(pose)) shadowCache.set(pose, bakeFloorShadow(models));
    floorShade.material.map = shadowCache.get(pose);
    floorShade.material.needsUpdate = true;
  }

  function resetCamera() {
    view.yaw = .62;
    view.pitch = .10;
    view.range = pose === 'single' ? 1.95 : 2;
    view.target.copy(restTarget);
    lastInput = performance.now();
  }

  function orient(targetCamera, state) {
    const radius = Math.cos(state.pitch) * state.range;
    targetCamera.position.set(
      state.target.x + Math.sin(state.yaw) * radius,
      state.target.y + Math.sin(state.pitch) * state.range,
      state.target.z + Math.cos(state.yaw) * radius,
    );
    targetCamera.lookAt(state.target);
    targetCamera.updateMatrixWorld();
  }

  function zoom(step) {
    view.range = THREE.MathUtils.clamp(view.range * Math.exp(-step * .19), .23, 3.2);
    lastInput = performance.now();
  }

  function orbit(dx, dy) {
    view.yaw -= dx * .009;
    view.pitch = THREE.MathUtils.clamp(view.pitch - dy * .007, -.60, 1.25);
    lastInput = performance.now();
  }

  function resize() {
    width = Math.max(1, canvas.clientWidth);
    height = Math.max(1, canvas.clientHeight);
    const limit = mobilePointer ? 2200000 : 4200000;
    renderer.setPixelRatio(Math.min(devicePixelRatio, mobilePointer ? 2 : 1.75, Math.sqrt(limit / (width * height))));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    backdropMaterial.uniforms.aspect.value = camera.aspect;
    camera.fov = width / height < .75 ? 34 : 30;
    camera.updateProjectionMatrix();
  }

  function updateCamera(delta) {
    const follow = 1 - Math.exp(-delta * 9);
    if (!reducedMotion.matches && !pointers.size && mode !== 'view' && performance.now() - lastInput > 9000) {
      view.yaw += delta * .105;
    }
    liveView.yaw += (view.yaw - liveView.yaw) * follow;
    liveView.pitch += (view.pitch - liveView.pitch) * follow;
    liveView.range += (view.range - liveView.range) * follow;
    liveView.target.lerp(view.target, follow);
    orient(camera, liveView);
    const cssX = getComputedStyle(document.documentElement).getPropertyValue('--stage-x');
    const isWide = document.body.classList.contains('wide');
    const rightShift = isWide && cssX.includes('px') ? width / 2 - parseFloat(cssX) : 0;
    const sheetOpen = !isWide && document.body.classList.contains('sheet-open') ? 1 : 0;
    projectionLeft += (rightShift - projectionLeft) * follow;
    sheetShift += (sheetOpen - sheetShift) * follow;
    if (sheetShift > .005) {
      const factor = 1 + .75 * sheetShift;
      const virtualWidth = width / factor;
      camera.setViewOffset(virtualWidth, height / factor, -(width - virtualWidth) / 2, -height * .03 * sheetShift, width, height);
    } else if (Math.abs(projectionLeft) > .1) {
      camera.setViewOffset(width, height, projectionLeft, 0, width, height);
    } else if (camera.view?.enabled) camera.clearViewOffset();
  }

  function markWet(mesh, point, radius) {
    const index = mesh.userData.leg;
    const model = models[index];
    const local = mesh.worldToLocal(point.clone());
    const uniforms = mesh.material.uniforms;
    if (local.y >= uniforms.lengthLimit.value && uniforms.lengthLimit.value < .9) return;
    const stains = uniforms.stains.value;
    const close = stains.find(stain => stain.w > 0 && Math.hypot(stain.x - local.x, stain.y - local.y, stain.z - local.z) < .021);
    if (close) close.w = Math.min(.089, Math.max(close.w, radius) * 1.13);
    else {
      stains[model.nextStain].set(local.x, local.y, local.z, radius);
      model.nextStain = (model.nextStain + 1) % maxStains;
    }
  }

  function rippleAt(position) {
    if (ripples.length >= 28) return;
    const mesh = new THREE.Mesh(rimGeometry, new THREE.MeshBasicMaterial({
      color: '#f7f3fd', transparent: true, opacity: .60, depthWrite: false, side: THREE.DoubleSide,
    }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(position.x, .003, position.z);
    mesh.scale.setScalar(.013);
    world.add(mesh);
    ripples.push({ mesh, age: 0 });
  }

  function spawnDrops(point, amount, power, attached) {
    const count = Math.min(amount, 390 - droplets.length);
    for (let i = 0; i < count; i++) {
      const speed = .13 + Math.random() * power;
      const angle = Math.random() * Math.PI * 2;
      const radius = (.0008 + Math.pow(Math.random(), 2) * .0042) * (.64 + power * .33);
      const mesh = new THREE.Mesh(dropletGeometry, dropMaterial);
      mesh.position.copy(point);
      mesh.position.x += (Math.random() - .5) * .028;
      mesh.position.z += (Math.random() - .5) * .024;
      mesh.scale.set(radius, radius * (1.2 + Math.random() * .70), radius);
      mesh.renderOrder = 3;
      world.add(mesh);
      const bead = Boolean(attached) && i % 4 === 0;
      const velocity = new THREE.Vector3(
        Math.cos(angle) * speed, .12 + Math.random() * .76 * power, Math.sin(angle) * speed,
      );
      if (bead) velocity.set(0, -.01 - Math.random() * .07, 0);
      droplets.push({ mesh, velocity, bead, age: 0, life: bead ? 1.15 + Math.random() * 3.5 : 1.35 });
    }
  }

  function pickLeg(x, y) {
    const rect = canvas.getBoundingClientRect();
    hitVector.set((x - rect.left) / rect.width * 2 - 1, 1 - (y - rect.top) / rect.height * 2);
    ray.setFromCamera(hitVector, camera);
    return ray.intersectObjects(legMeshes.filter(mesh => mesh.parent.visible), false)[0];
  }

  function splash(x, y, quiet = false) {
    const hit = pickLeg(x, y);
    if (!hit) return false;
    const local = hit.object.worldToLocal(hit.point.clone());
    if (local.y > hit.object.material.uniforms.lengthLimit.value) return false;
    markWet(hit.object, hit.point, quiet ? .026 : .046);
    spawnDrops(hit.point, quiet ? 7 : 50, quiet ? .55 : 1.01, true);
    if (!quiet) sound.play(.6);
    return true;
  }

  function bucket() {
    const visibleLegs = models.filter(model => model.group.visible);
    for (const { group, cloth } of visibleLegs) {
      const center = group.position.clone();
      const towardEye = camera.position.clone().sub(center);
      towardEye.y = 0;
      towardEye.normalize();
      const across = new THREE.Vector3(towardEye.z, 0, -towardEye.x);
      for (let index = 0; index < 7; index++) {
        const foot = index > 3;
        const height = foot ? .020 + Math.random() * .060 : .27 + Math.random() * .12;
        const point = center.clone().addScaledVector(towardEye, .52);
        point.y = height;
        point.addScaledVector(across, (Math.random() - .5) * (foot ? .063 : .092));
        ray.set(point, towardEye.clone().negate());
        const hit = ray.intersectObject(cloth, false)[0];
        if (!hit) continue;
        markWet(cloth, hit.point, (foot ? .014 : .034) + Math.random() * .024);
        spawnDrops(hit.point, foot ? 7 : 14, .88, true);
      }
    }
    sound.play(1);
  }

  function dry() {
    for (const model of models) {
      for (const mark of model.cloth.material.uniforms.stains.value) mark.w = 0;
    }
    for (const { mesh } of droplets) world.remove(mesh);
    for (const { mesh } of ripples) {
      mesh.material.dispose();
      world.remove(mesh);
    }
    droplets.length = 0;
    ripples.length = 0;
  }

  function updateWater(delta) {
    rainClock += delta;
    if (rain && rainClock > .052) {
      rainClock = 0;
      for (const { group, cloth } of models.filter(model => model.group.visible)) {
        const x = (Math.random() - .5) * .18;
        const z = (Math.random() - .5) * .19;
        const point = group.localToWorld(new THREE.Vector3(x, .95 + Math.random() * .22, z));
        spawnDrops(point, 3, .45, false);
        if (Math.random() > .35) {
          const skin = group.localToWorld(new THREE.Vector3(x * .65, .11 + Math.random() * .54, z * .58));
          markWet(cloth, skin, .025 + Math.random() * .025);
        }
      }
    }
    for (let i = droplets.length - 1; i >= 0; i--) {
      const drop = droplets[i];
      drop.age += delta;
      if (drop.bead && drop.age > .40) drop.velocity.y -= delta * .13;
      if (!drop.bead) drop.velocity.y -= delta * 5.0;
      drop.mesh.position.addScaledVector(drop.velocity, delta);
      if (drop.mesh.position.y <= .002 || drop.age > drop.life) {
        if (drop.mesh.position.y <= .002 && Math.random() > .66) rippleAt(drop.mesh.position);
        world.remove(drop.mesh);
        droplets.splice(i, 1);
      }
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      const ring = ripples[i];
      ring.age += delta;
      ring.mesh.scale.setScalar(.012 + ring.age * .16);
      ring.mesh.material.opacity = .56 * Math.max(0, 1 - ring.age * 1.58);
      if (ring.age > .65) {
        world.remove(ring.mesh);
        ring.mesh.material.dispose();
        ripples.splice(i, 1);
      }
    }
  }

  function run(time) {
    requestAnimationFrame(run);
    const dt = Math.max(0, Math.min(.05, (time - lastTime) * .001));
    lastTime = time;
    playClock += dt * (slow ? .20 : 1);
    backdropMaterial.uniforms.time.value = playClock;
    updateCamera(dt);
    for (const pointer of pointers.values()) {
      if (!pointer.wet) continue;
      pointer.timer += dt;
      if (pointer.timer > .073) {
        pointer.timer = 0;
        splash(pointer.x, pointer.y, true);
      }
    }
    updateWater(dt * (slow ? .20 : 1));
    renderer.render(world, camera);
  }

  function photo() {
    renderer.render(world, camera);
    const result = document.createElement('canvas');
    result.width = canvas.width;
    result.height = canvas.height;
    const ctx = result.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    const scale = Math.max(.65, result.height / 900);
    const margin = 28 * scale;
    ctx.fillStyle = 'rgba(47,40,56,.86)';
    ctx.font = `${Math.round(34 * scale)}px "ZCOOL XiaoWei", "Songti SC", serif`;
    ctx.fillText('雨丝', margin, result.height - margin - 21 * scale);
    ctx.fillStyle = 'rgba(92,82,108,.82)';
    ctx.font = `${Math.round(13 * scale)}px system-ui, sans-serif`;
    ctx.fillText('WET DENIER LAB  ·  newtonquan-yusi.pages.dev', margin, result.height - margin);
    return result.toDataURL('image/jpeg', .93);
  }

  const thumbnailQueue = new Map();
  function thumbnail(target, config) {
    thumbnailQueue.set(target, config);
    if (thumbnailQueue.size === 1) requestAnimationFrame(drawThumbnail);
  }

  function drawThumbnail() {
    const next = thumbnailQueue.entries().next();
    if (next.done) return;
    const [target, config] = next.value;
    thumbnailQueue.delete(target);
    if (target.isConnected) {
      const current = { environment, colorway, wardrobe, pose };
      const cachedVisibility = [...droplets, ...ripples].map(({ mesh }) => [mesh, mesh.visible]);
      cachedVisibility.forEach(([mesh]) => { mesh.visible = false; });
      setScene(config?.scene ?? environment, config?.backdrop ?? colorway);
      if (config?.material) setMaterial(config.material);
      setPose(config?.pose ?? pose);
      const w = target.width;
      const h = target.height;
      thumbCamera.aspect = w / h;
      backdropMaterial.uniforms.aspect.value = thumbCamera.aspect;
      thumbCamera.updateProjectionMatrix();
      orient(thumbCamera, { yaw: .80, pitch: .12, range: 2.22, target: restTarget });
      const buffer = new THREE.WebGLRenderTarget(w, h);
      buffer.texture.colorSpace = THREE.SRGBColorSpace;
      renderer.setRenderTarget(buffer);
      renderer.render(world, thumbCamera);
      const pixels = new Uint8Array(w * h * 4);
      renderer.readRenderTargetPixels(buffer, 0, 0, w, h, pixels);
      renderer.setRenderTarget(null);
      backdropMaterial.uniforms.aspect.value = camera.aspect;
      buffer.dispose();
      const ctx = target.getContext('2d');
      const image = ctx.createImageData(w, h);
      for (let line = 0; line < h; line++) {
        image.data.set(pixels.subarray((h - line - 1) * w * 4, (h - line) * w * 4), line * w * 4);
      }
      ctx.putImageData(image, 0, 0);
      setScene(current.environment, current.colorway);
      setMaterial(current.wardrobe);
      setPose(current.pose);
      cachedVisibility.forEach(([mesh, visible]) => { mesh.visible = visible; });
    }
    if (thumbnailQueue.size) requestAnimationFrame(drawThumbnail);
  }

  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 && event.button !== 2) return;
    canvas.setPointerCapture(event.pointerId);
    lastInput = performance.now();
    const wet = mode === 'water' && event.button === 0 && pointers.size === 0 && splash(event.clientX, event.clientY);
    const tap = mode === 'view' && event.button === 0 && pointers.size === 0;
    for (const previous of pointers.values()) previous.tap = false;
    pointers.set(event.pointerId, {
      x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY,
      startedAt: lastInput, tap, wet, timer: -.06,
    });
  });
  canvas.addEventListener('pointermove', event => {
    const pointer = pointers.get(event.pointerId);
    if (!pointer) return;
    const previous = { x: pointer.x, y: pointer.y };
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) >= 6) pointer.tap = false;
    if (pointers.size >= 2) {
      const other = [...pointers.values()].find(member => member !== pointer);
      const before = Math.hypot(other.x - previous.x, other.y - previous.y);
      const after = Math.hypot(other.x - pointer.x, other.y - pointer.y);
      if (before > 1) {
        view.range = THREE.MathUtils.clamp(view.range * before / Math.max(1, after), .23, 3.2);
      }
      pointer.wet = other.wet = false;
    } else if (!pointer.wet) orbit(pointer.x - previous.x, pointer.y - previous.y);
  });
  canvas.addEventListener('pointerup', event => {
    const pointer = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);
    if (mode !== 'view' || !pointer?.tap || performance.now() - pointer.startedAt >= 350 ||
        Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) >= 6) return;
    const hit = pickLeg(event.clientX, event.clientY);
    if (!hit) return;
    view.target.copy(hit.point);
    view.range = Math.min(view.range, .65);
    lastInput = performance.now();
  });
  for (const type of ['pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(type, event => pointers.delete(event.pointerId));
  }
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    zoom(THREE.MathUtils.clamp(-event.deltaY * .008, -1.5, 1.5));
  }, { passive: false });
  new ResizeObserver(resize).observe(canvas);
  resize();
  setScene('studio', 'lilac');
  setPose('step');

  return {
    setScene, setMaterial, setPose, zoom, orbit, resetCamera, bucket, dry, photo, thumbnail,
    setMode(value) { mode = value; lastInput = performance.now(); },
    setRain(value) { rain = value; },
    setSlow(value) { slow = value; },
    async present() {
      updateCamera(.85);
      await renderer.compileAsync(world, camera);
      renderer.render(world, camera);
      renderer.getContext().finish();
      lastInput = lastTime = performance.now();
      requestAnimationFrame(run);
    },
    setSound(value) { sound.setEnabled(value); },
  };
}

try {
  const engine = createEngine(await loadMesh(THREE));
  initUI(engine);
  await engine.present();
  requestAnimationFrame(() => document.body.classList.add('ready'));
} catch (error) {
  console.error(error);
  document.getElementById('loading').textContent = '加载失败，请确认浏览器已启用 WebGL 后刷新。';
}
