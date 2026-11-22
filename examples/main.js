import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { loadClod, loadClodStream, updateStreaming, loadClodMaterial, ClodBatch, ClodSelector, DiscreteLodSet, patchDebug, debugUniform } from 'three-nanite';

// Demo and benchmark page. Query parameters:
//   data=/data            folder with built assets          assets=a,b   names to load (default: data/assets.json)
//   count, mode, dbg      initial UI state                  res=1920x1080 fixed canvas size
//   stream=1              load geometry on demand           netdelay=350  extra ms per streaming request
//   occ=1&walls=1         instance occlusion culling        mat=basic|lambert  cheaper material
//   auto=<name>           run the unattended benchmark suite and save out/bench/<name>.json

const q = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const msg = (t) => { $('msg').textContent = t; };
const DATA = (q.get('data') || '/data').replace(/\/$/, '');
const ASSETS = q.get('assets') ? q.get('assets').split(',') : await fetch(`${DATA}/assets.json`).then((r) => r.json()).catch(() => []);
if (!ASSETS.length) { msg(`no assets in ${DATA}: run "npm run dev" (builds the samples) or "npx three-nanite build model.glb examples/public/data"`); throw new Error('no assets'); }
const NET_DELAY = +(q.get('netdelay') || 0);
const STREAM = q.get('stream') === '1'; // geometry fetched on demand by level prefix; cluster LOD mode only
const fixedRes = q.get('res')?.split('x').map(Number);

const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const gl = renderer.getContext();
const dbgInfo = gl.getExtension('WEBGL_debug_renderer_info');
const gpuName = dbgInfo ? gl.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL) : 'unknown';
const hasMultiDraw = !!gl.getExtension('WEBGL_multi_draw');
let contextLostAt = null;
canvas.addEventListener('webglcontextrestored', () => { contextLostAt += ' restored@' + Math.round(performance.now()) + 'ms'; });
canvas.addEventListener('webglcontextlost', () => { contextLostAt = contextLostAt || document.getElementById('msg').textContent + ' @' + Math.round(performance.now()) + 'ms'; });

// With ANGLE on Vulkan and a preferred-device override the context is lost and restored once,
// roughly 0.7 s after creation. Create no GPU resources until it has settled.
if (q.get('auto') || q.get('settle')) {
  await new Promise((r) => setTimeout(r, 2500));
  for (let i = 0; i < 100 && gl.isContextLost(); i++) await new Promise((r) => setTimeout(r, 100));
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fa3b8);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.7;
const sun = new THREE.DirectionalLight(0xfff1dd, 2.5); sun.position.set(30, 60, 20); scene.add(sun);
sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 200 }); sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.02;
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 3000);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: 0x5b5f58, roughness: 1, metalness: 0 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

function resize() {
  const [w, h] = fixedRes || [window.innerWidth, window.innerHeight];
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize); resize();

// ------------------------------------------------------------------ assets
const assets = [];
for (const name of ASSETS) {
  msg(`loading ${name}…`);
  const a = STREAM ? await loadClodStream(DATA, name, { delayMs: NET_DELAY }) : await loadClod(DATA, name);
  const std = loadClodMaterial(DATA, a); // MeshStandardMaterial with the textures the preprocessor copied out of the GLB
  const mk = () => q.get('mat') === 'basic' ? new THREE.MeshBasicMaterial({ color: 0x999999 }) : q.get('mat') === 'lambert' ? new THREE.MeshLambertMaterial({ map: std.map }) : std.clone();
  a.matClod = patchDebug(mk()); a.matPlain = mk();
  // models come in any size: the demo scales every asset so that its largest dimension is about one unit
  a.unit = 1 / Math.max(a.meta.bbMax[0] - a.meta.bbMin[0], a.meta.bbMax[1] - a.meta.bbMin[1], a.meta.bbMax[2] - a.meta.bbMin[2]);
  assets.push(a);
}

// ------------------------------------------------------------------ scene of instances
const SPACING = 4;
let batches = [], lodSets = [], selector = null, fieldR = 10, state = { count: 0, mode: '' };
const root = new THREE.Group(); scene.add(root);
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }

function buildScene(count, mode) {
  if (STREAM) mode = 'clod';
  for (const a of assets) if (a.batches) a.batches.length = 0;
  root.clear(); batches = []; lodSets = [];
  const side = Math.ceil(Math.sqrt(count)), rnd = rng(7), per = assets.map(() => []);
  fieldR = Math.max(4, side * SPACING / 2);
  for (let k = 0; k < count; k++) {
    const ai = k % assets.length, a = assets[ai], s = (count === 1 ? 2 : 1.6 + rnd() * 1.2) * a.unit;
    const x = count === 1 ? 0 : (k % side - (side - 1) / 2) * SPACING + (rnd() - 0.5), z = count === 1 ? 0 : (Math.floor(k / side) - (side - 1) / 2) * SPACING + (rnd() - 0.5);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, -a.meta.bbMin[1] * s, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), count === 1 ? 0.6 : rnd() * 6.283), new THREE.Vector3(s, s, s));
    per[ai].push(m); instPos[k] = new THREE.Vector3(x, 0, z);
  }
  assets.forEach((a, ai) => {
    if (!per[ai].length) return;
    { const b = new ClodBatch(a, a.matClod, per[ai]); b.castShadow = b.receiveShadow = true; batches.push(b); root.add(b); }
    if (!STREAM) { const l = new DiscreteLodSet(a, a.matPlain, per[ai]); l.levels.forEach((im) => { im.castShadow = im.receiveShadow = true; }); lodSets.push(l); root.add(l); }
  });
  if (q.get('walls') === '1') { // a few building-sized blocks so that there is something to hide behind
    const wm = new THREE.MeshStandardMaterial({ color: 0x8a8378, roughness: 0.9, metalness: 0 });
    const wr = rng(11), R = fieldR;
    for (let k = 0; k < Math.max(4, Math.round(count / 12)); k++) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(6 + wr() * 8, 5 + wr() * 3, 1.2), wm);
      wall.position.set((wr() - 0.5) * 1.8 * R, wall.geometry.parameters.height / 2, (wr() - 0.5) * 1.8 * R); wall.rotation.y = wr() < 0.5 ? 0 : Math.PI / 2;
      wall.castShadow = wall.receiveShadow = true; root.add(wall);
    }
  }
  const prevSel = selector;
  selector = new ClodSelector(batches); if (prevSel) selector._hzbLatest = prevSel._hzbLatest;
  state = { count, mode }; applyMode(mode);
  sourceTris = 0; assets.forEach((a, ai) => { sourceTris += a.meta.sourceTris * per[ai].length; });
}
let sourceTris = 0;
const instPos = [];
function applyMode(mode) { if (STREAM) mode = 'clod'; state.mode = mode; for (const b of batches) b.visible = mode === 'clod'; for (const l of lodSets) l.visible = mode !== 'clod'; }

// ------------------------------------------------------------------ controls
const ui = { errorPx: 1, budget: 0, freeze: false };
const sync = () => {
  ui.errorPx = 2 ** +$('err').value; $('errV').textContent = ui.errorPx.toFixed(2) + ' px';
  const b = +$('bud').value; ui.budget = b === 0 ? 0 : Math.round(10 ** (4 + b * 0.03)); $('budV').textContent = b === 0 ? 'off' : fmt(ui.budget);
  ui.freeze = $('freeze').checked; debugUniform.value = +$('dbg').value;
  if (selector) selector.frustumCull = $('cull').checked;
  const sh = $('shadow').checked;
  if (renderer.shadowMap.enabled !== sh) { renderer.shadowMap.enabled = sh; sun.castShadow = sh; scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; }); }
  if (state.count !== +$('count').value) { buildScene(+$('count').value, $('mode').value); selector.frustumCull = $('cull').checked; }
  else if (state.mode !== $('mode').value) applyMode($('mode').value);
};
const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
for (const id of ['mode', 'count', 'err', 'bud', 'dbg', 'freeze', 'cull', 'shadow']) $(id).addEventListener('input', sync);
if (q.get('count')) $('count').value = q.get('count');
if (q.get('mode')) $('mode').value = q.get('mode');
if (q.get('dbg')) $('dbg').value = q.get('dbg');
sync();

// fly camera
const keys = new Set(); let yaw = 0, pitch = -0.3, drag = false;
window.addEventListener('keydown', (e) => keys.add(e.code)); window.addEventListener('keyup', (e) => keys.delete(e.code));
canvas.addEventListener('mousedown', () => { drag = true; touring = false; }); window.addEventListener('mouseup', () => { drag = false; });
window.addEventListener('mousemove', (e) => { if (drag) { yaw -= e.movementX * 0.004; pitch = Math.max(-1.5, Math.min(1.5, pitch - e.movementY * 0.004)); } });
function setPose(pos, target) {
  camera.position.copy(pos); camera.lookAt(target);
  const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ'); yaw = e.y; pitch = e.x;
}
function fly(dt) {
  const sp = (keys.has('ShiftLeft') ? 30 : 6) * dt, f = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ')), r = new THREE.Vector3().crossVectors(f, camera.up).normalize();
  if (keys.has('KeyW')) camera.position.addScaledVector(f, sp); if (keys.has('KeyS')) camera.position.addScaledVector(f, -sp);
  if (keys.has('KeyD')) camera.position.addScaledVector(r, sp); if (keys.has('KeyA')) camera.position.addScaledVector(r, -sp);
  if (keys.has('KeyE')) camera.position.y += sp; if (keys.has('KeyQ')) camera.position.y -= sp;
  camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
}

// scripted tour: far overview -> dive in -> skim along a row -> close-up
let touring = false, tourT = 0;
function tourPose(u) {
  const R = fieldR, P = (x, y, z) => new THREE.Vector3(x, y, z);
  const pos = new THREE.CatmullRomCurve3([P(R * 4, R * 2.2, R * 4), P(R * 2, R * 0.9, R * 2.4), P(R * 0.9, 5, R * 1.1), P(0, 2.2, R * 0.55), P(-R * 0.5, 1.8, 0), P(-2.5, 1.6, -3), P(0.6, 1.5, -0.2 * R), P(SPACING * 0.5 + 1.2, 1.3, SPACING * 0.5 + 1.6)]);
  const tgt = new THREE.CatmullRomCurve3([P(0, 0, 0), P(0, 0, 0), P(0, 0.5, 0), P(-R * 0.3, 1, -R * 0.2), P(-R * 0.2, 1, -R * 0.6), P(R * 0.3, 1, -R * 0.3), P(SPACING * 0.5, 1, SPACING * 0.5), P(SPACING * 0.5, 1, SPACING * 0.5)]);
  const s = u * u * (3 - 2 * u);
  return [pos.getPoint(s), tgt.getPoint(s)];
}
$('tour').onclick = () => { touring = !touring; tourT = 0; };

// ------------------------------------------------------------------ frame
const frustum = new THREE.Frustum(), pm = new THREE.Matrix4();
let sel = { tris: 0, clusters: 0, ms: 0, visited: 0, threshold: 0 };
function select() {
  const h = renderer.domElement.height;
  if (state.mode === 'clod') { const s = selector.select(camera, h, ui); sel = { ...s }; }
  else {
    const t0 = performance.now();
    camera.updateMatrixWorld(); pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); frustum.setFromProjectionMatrix(pm);
    const K = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    let tris = 0, drawn = 0;
    for (const l of lodSets) { const r = l.select(camera.position, frustum, K, ui.errorPx, state.mode === 'full'); tris += r.tris; drawn += r.drawn; }
    sel = { tris, clusters: drawn, ms: performance.now() - t0, visited: 0, threshold: ui.errorPx };
  }
}
// streaming: every asset reports the finest level the last selection wanted but did not have
let streamPending = [];
function pumpStreaming() {
  if (!STREAM) return;
  streamPending = updateStreaming(assets); // in-flight loads are re-reported each frame; no accumulation
}
const residentMB = () => assets.reduce((x, a) => x + a.residentBytes, 0) / 1048576, fullMB = () => assets.reduce((x, a) => x + a.fullBytes, 0) / 1048576;
// ---- occlusion (?occ=1): render into a target with a depth texture, reduce depth to a 64x36
// farthest-depth map, read it back asynchronously and use it for instance culling a few frames later.
const OCC = q.get('occ') === '1';
let occEnabled = OCC, rt = null, hzbRT = null, blitScene = null, blitCam = null, hzbScene = null, hzbMat = null, hzbBusy = false, hzbAge = 0;
const HW = 64, HH = 36;
function setupOcc() {
  const w = renderer.domElement.width, h = renderer.domElement.height;
  rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(w, h, THREE.UnsignedIntType) });
  hzbRT = new THREE.WebGLRenderTarget(HW, HH, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
  blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  blitScene = new THREE.Scene(); blitScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: rt.texture, depthTest: false, depthWrite: false })));
  hzbMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
    uniforms: { tDepth: { value: rt.depthTexture }, uBlock: { value: new THREE.Vector2(Math.ceil(w / HW), Math.ceil(h / HH)) } },
    vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'precision highp float; uniform highp sampler2D tDepth; uniform vec2 uBlock; out vec4 o; void main(){ ivec2 sz = textureSize(tDepth, 0); ivec2 b = ivec2(gl_FragCoord.xy) * ivec2(uBlock); float m = 0.0; for (int y = 0; y < 34; y++) { if (y >= int(uBlock.y)) break; for (int x = 0; x < 34; x++) { if (x >= int(uBlock.x)) break; m = max(m, texelFetch(tDepth, min(b + ivec2(x, y), sz - 1), 0).r); } } o = vec4(m, 0.0, 0.0, 1.0); }',
  });
  hzbScene = new THREE.Scene(); hzbScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), hzbMat));
}
const _vp = new THREE.Matrix4();
function renderFrame() {
  if (!OCC) { renderer.render(scene, camera); return; }
  if (!rt) setupOcc();
  renderer.setRenderTarget(rt); renderer.render(scene, camera);
  renderer.setRenderTarget(null); renderer.render(blitScene, blitCam);
  if (!hzbBusy) { // one readback in flight at a time; the result is used whenever it arrives
    renderer.setRenderTarget(hzbRT); renderer.render(hzbScene, blitCam); renderer.setRenderTarget(null);
    _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const snap = { data: new Float32Array(HW * HH * 4), w: HW, h: HH, vp: Float32Array.from(_vp.elements), near: camera.near, far: camera.far, px: camera.projectionMatrix.elements[0], py: camera.projectionMatrix.elements[5], frame: frameNo };
    hzbBusy = true;
    renderer.readRenderTargetPixelsAsync(hzbRT, 0, 0, HW, HH, snap.data).then(() => { hzbBusy = false; hzbAge = frameNo - snap.frame; if (selector) selector._hzbLatest = snap; }, () => { hzbBusy = false; });
  }
}
let frameNo = 0;
function step() {
  frameNo++;
  if (selector) selector.hzb = OCC && occEnabled ? selector._hzbLatest || null : null;
  if (!ui.freeze) { select(); pumpStreaming(); }
  renderFrame();
}

let last = performance.now(), ema = 16, emaSel = 0, paused = false;
setPose(...tourPose(0.35));
function loop(now) {
  requestAnimationFrame(loop);
  if (paused) return;
  const dt = Math.min(0.1, (now - last) / 1000); last = now; ema += (dt * 1000 - ema) * 0.1;
  if (touring) { tourT += dt / 24; if (tourT >= 1) { tourT = 1; touring = false; } setPose(...tourPose(tourT)); } else fly(dt);
  const t0 = performance.now(); step(); const cpu = performance.now() - t0;
  emaSel += (sel.ms - emaSel) * 0.1;
  const i = renderer.info.render;
  $('stats').textContent =
    `source tris   ${fmt(sourceTris)}\n` +
    `drawn tris    ${fmt(sel.tris)}  (${(sel.tris / sourceTris * 100).toFixed(2)}%)\n` +
    `${state.mode === 'clod' ? 'clusters     ' : 'instances    '} ${fmt(sel.clusters)}\n` +
    `GL draw calls ${i.calls}\n` +
    `eff. error    ${sel.threshold === Infinity ? 'inf' : sel.threshold.toFixed(2)} px\n` +
    `select        ${emaSel.toFixed(2)} ms\n` +
    `cpu frame     ${cpu.toFixed(2)} ms\n` +
    `frame (rAF)   ${ema.toFixed(1)} ms\n` +
    `${renderer.domElement.width}x${renderer.domElement.height}  multi_draw ${hasMultiDraw ? 'yes' : 'NO'}` +
    (OCC ? `\noccluded props ${sel.occluded || 0}  (depth ${hzbAge} frames old)` : '') +
    (STREAM ? `\nresident      ${residentMB().toFixed(1)} of ${fullMB().toFixed(0)} MB\nlevels loaded ${assets.map((a) => a.loadedLevel).join(' ')}` : '');
}
msg(gpuName);
requestAnimationFrame(loop);

// ------------------------------------------------------------------ automation hooks (bench / capture)
const px = new Uint8Array(4);
const post = (name, body) => fetch(`/__save?name=${encodeURIComponent(name)}`, { method: 'POST', body });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function orbitPose(d, elevDeg = 20, target = new THREE.Vector3(0, 1, 0)) {
  const e = THREE.MathUtils.degToRad(elevDeg);
  return [new THREE.Vector3(Math.sin(0.5) * Math.cos(e) * d, target.y + Math.sin(e) * d, Math.cos(0.5) * Math.cos(e) * d).add(new THREE.Vector3(target.x, 0, target.z)), target];
}
window.demo = {
  gpuName, assets, renderer, camera, scene, sun, ui, setOcc: (v) => { occEnabled = v; }, sel: () => sel, setPose, tourPose, orbitPose,
  set(o) { for (const [k, v] of Object.entries(o)) { $(k).type === 'checkbox' ? ($(k).checked = v) : ($(k).value = v); } sync(); },
  // timed frames at fixed poses; readPixels forces the GPU to finish, so ms is whole-frame cost
  async bench({ mode = 'clod', count = 96, errorPx = 1, budget = 0, distances = [3, 8, 20, 50, 120, 300], frames = 30, dbg = 0, cull = true, label = '', occ = true, elev = 20 } = {}) {
    occEnabled = occ;
    paused = true;
    $('mode').value = mode; $('count').value = count; $('dbg').value = dbg; $('cull').checked = cull; sync(); applyMode(mode);
    ui.errorPx = errorPx; ui.budget = budget; ui.freeze = false;
    const rows = [];
    for (const d of distances) {
      setPose(...orbitPose(d, elev));
      for (let i = 0; i < 6; i++) { step(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); await sleep(OCC ? 8 : 0); }
      await sleep(30);
      for (let i = 0; i < (OCC ? 6 : 0); i++) { step(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); await sleep(8); }
      const t = [], ts = [];
      for (let i = 0; i < frames; i++) { const t0 = performance.now(); step(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); t.push(performance.now() - t0); ts.push(sel.ms); }
      t.sort((a, b) => a - b); ts.sort((a, b) => a - b);
      if (gl.isContextLost()) throw new Error('WebGL context lost during ' + label + ' ' + mode + ' n=' + count);
      rows.push({ occ: OCC ? (occ ? 'on' : 'off') : 'n/a', occluded: sel.occluded || 0, label, mode, count, errorPx, budget, dist: d, sourceTris, tris: Math.round(sel.tris), clusters: sel.clusters, calls: renderer.info.render.calls, effPx: +(+sel.threshold).toFixed(2), selectMs: +ts[frames >> 1].toFixed(2), frameMs: +t[frames >> 1].toFixed(2), p90: +t[Math.floor(frames * 0.9)].toFixed(2) });
      await sleep(10);
    }
    paused = false; last = performance.now();
    return rows;
  },
  // render the tour to numbered JPEGs in out/<dir>/
  async capture({ dir = 'frames', frames = 240, dbg = 1, mode = 'clod', count = 96, errorPx = 1, budget = 0, from = 0, to = 1 } = {}) {
    paused = true;
    $('mode').value = mode; $('count').value = count; $('dbg').value = dbg; sync();
    ui.errorPx = errorPx; ui.budget = budget; ui.freeze = false;
    const log = [];
    for (let i = 0; i < frames; i++) {
      setPose(...tourPose(from + (to - from) * i / (frames - 1)));
      step();
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
      await post(`${dir}/f${String(i).padStart(4, '0')}.jpg`, blob);
      log.push({ i, tris: Math.round(sel.tris), clusters: sel.clusters, effPx: +(+sel.threshold).toFixed(2), selectMs: +sel.ms.toFixed(2) });
    }
    await post(`${dir}/log.json`, JSON.stringify(log));
    paused = false; last = performance.now();
    return log.length;
  },
  save: (name, obj) => post(name, JSON.stringify(obj, null, 1)),
};

// ---- side-by-side examples: several settings rendered from the same camera into one composited frame
const comp = document.createElement('canvas'), cctx = comp.getContext('2d');
const topCam = new THREE.PerspectiveCamera(50, 16 / 9, 1, 3000); topCam.layers.enable(1);
const marker = new THREE.Group();
{ const mm = new THREE.MeshBasicMaterial({ color: 0xff2020, toneMapped: false });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(1.2, 12, 8), mm), cone = new THREE.Mesh(new THREE.ConeGeometry(2.2, 9, 12, 1, true), mm);
  cone.rotation.x = Math.PI / 2; cone.position.z = -5.5; ball.layers.set(1); cone.layers.set(1); marker.add(ball, cone); scene.add(marker); }
const V3 = (x, y, z) => new THREE.Vector3(x, y, z), sm = (u) => u * u * (3 - 2 * u);
const paths = {
  tour: (u) => tourPose(u),
  // circle a single prop (k = instance number)
  orbit: (u, o) => { const t = instPos[o.k], a = (o.a0 || 0) + u * (o.turn || 0.6) * 6.2832; return [V3(t.x + Math.sin(a) * o.r, o.h, t.z + Math.cos(a) * o.r), V3(t.x, o.ty || 0.9, t.z)]; },
  // circle the whole field
  field: (u, o) => { const a = 0.4 + u * (o.turn || 0.35) * 6.2832, r = fieldR * o.r; return [V3(Math.sin(a) * r, o.h, Math.cos(a) * r), V3(0, 1, 0)]; },
  // dolly in at eye height from far to near
  approach: (u, o) => { const d = o.from * Math.pow(o.to / o.from, sm(u)), t = instPos[o.k] || V3(0, 0, 0); return [V3(t.x + 0.45 * d, 1.7 + d * 0.04, t.z + 0.89 * d), V3(t.x, 1.0, t.z)]; },
  // walk through the field at eye height, looking around
  walk: (u) => { const R = fieldR, x = -R * 0.85 + u * R * 1.7, z = R * 0.55 - u * R * 1.0 + Math.sin(u * 9) * 3, a = -0.9 + Math.sin(u * 7) * 0.9; return [V3(x, 1.7, z), V3(x + Math.cos(a) * 10, 1.6, z + Math.sin(a) * 10 - 6)]; },
};
window.demo.captureGrid = async ({ dir, frames = 120, path = 'tour', pathOpts = {}, panels, cols = 1, pw = 960, ph = 540, crop = false, count = 96 }) => {
  paused = true; $('count').value = count; sync();
  const rows = Math.ceil(panels.length / cols); comp.width = cols * pw; comp.height = rows * ph;
  const W = canvas.width, H = canvas.height, log = [];
  topCam.position.set(0, fieldR * 2.3, fieldR * 0.9); topCam.lookAt(0, 0, 0); topCam.updateMatrixWorld();
  for (let f = 0; f < frames; f++) {
    setPose(...paths[path](frames > 1 ? f / (frames - 1) : 0, pathOpts));
    marker.position.copy(camera.position); marker.quaternion.copy(camera.quaternion);
    const entry = { f };
    for (let i = 0; i < panels.length; i++) {
      const pn = panels[i];
      applyMode(pn.mode || 'clod'); ui.errorPx = pn.errorPx ?? 2; ui.budget = pn.budget || 0; ui.freeze = false;
      debugUniform.value = pn.dbg || 0; occEnabled = pn.occ !== false; if (selector) selector.frustumCull = pn.cull !== false;
      if (pn.view === 'top') {
        if (selector) selector.hzb = OCC && occEnabled ? selector._hzbLatest || null : null;
        select(); renderer.setRenderTarget(null); renderer.render(scene, topCam);
      } else { step(); if (OCC) { await sleep(12); step(); } }
      const x = (i % cols) * pw, y = Math.floor(i / cols) * ph;
      if (crop) cctx.drawImage(canvas, (W - pw) / 2, (H - ph) / 2, pw, ph, x, y, pw, ph); else cctx.drawImage(canvas, 0, 0, W, H, x, y, pw, ph);
      let text = pn.label + '  ·  ' + fmt(sel.tris) + ' triangles';
      if (pn.budget) text += '  ·  error ' + (+sel.threshold).toFixed(1) + ' px';
      if (pn.hidden) text += '  ·  ' + (sel.occluded || 0) + ' props hidden';
      if (STREAM) text += '  ·  loaded ' + residentMB().toFixed(1) + ' of ' + fullMB().toFixed(0) + ' MB';
      cctx.font = '600 20px Consolas, monospace'; const tw = cctx.measureText(text).width;
      cctx.fillStyle = 'rgba(0,0,0,0.62)'; cctx.fillRect(x + 10, y + 10, tw + 20, 32); cctx.fillStyle = '#fff'; cctx.fillText(text, x + 20, y + 33);
      entry[pn.label] = Math.round(sel.tris);
    }
    cctx.fillStyle = '#000'; for (let c = 1; c < cols; c++) cctx.fillRect(c * pw - 1, 0, 2, comp.height); for (let r = 1; r < rows; r++) cctx.fillRect(0, r * ph - 1, comp.width, 2);
    const blob = await new Promise((r) => comp.toBlob(r, 'image/jpeg', 0.93));
    await post(dir + '/f' + String(f).padStart(4, '0') + '.jpg', blob);
    log.push(entry);
  }
  await post(dir + '/log.json', JSON.stringify(log));
  debugUniform.value = 0; occEnabled = OCC; paused = false; last = performance.now();
  return log.length;
};

// per-frame trace along the tour (no capture): how triangle count / effective error behave over time
window.demo.trace = async ({ frames = 300, mode = 'clod', count = 96, errorPx = 1, budget = 0 } = {}) => {
  paused = true; $('mode').value = mode; $('count').value = count; sync();
  ui.errorPx = errorPx; ui.budget = budget; ui.freeze = false;
  const tris = [], eff = [], selMs = [], ms = [];
  for (let i = 0; i < frames; i++) {
    setPose(...tourPose(i / (frames - 1)));
    const t0 = performance.now(); step(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); ms.push(performance.now() - t0);
    if (STREAM && streamPending.length) { await Promise.all(streamPending); streamPending = []; step(); }
    for (const b of batches) { const u = b.asset._used || (b.asset._used = new Uint8Array(b.asset.meta.clusters)); for (let n = 0; n < b._multiDrawCount; n++) u[b.indirect[n * 2 + 1] & 0xffffff] = 1; }
    tris.push(Math.round(sel.tris)); eff.push(sel.threshold); selMs.push(sel.ms);
    if (i % 50 === 49) await sleep(5);
  }
  paused = false; last = performance.now();
  const st = (a) => { const s = [...a].sort((x, y) => x - y); return { min: +s[0].toFixed(2), median: +s[s.length >> 1].toFixed(2), p95: +s[Math.floor(s.length * 0.95)].toFixed(2), max: +s[s.length - 1].toFixed(2) }; };
  let maxJump = 0; for (let i = 1; i < frames; i++) maxJump = Math.max(maxJump, Math.abs(tris[i] - tris[i - 1]));
  // what cluster-granular streaming would have had to load: every cluster drawn at least once in the flight
  let usedTris = 0; for (const a of assets) if (a._used) { for (let c = 0; c < a.meta.clusters; c++) if (a._used[c]) usedTris += a.clusterU[c * 4 + 1] / 3; a._used = null; }
  const usedMB = +(usedTris * 25 / 1048576).toFixed(1); // 12 B indices + about 13 B of vertex data per triangle in this format
  const stream = STREAM ? { residentMB: +residentMB().toFixed(2), fullMB: +fullMB().toFixed(1), hierarchyMB: +(assets.reduce((x, a) => x + a.hierarchyBytes, 0) / 1048576).toFixed(2), levels: assets.map((a) => a.loadedLevel), rootLevels: assets.map((a) => a.rootLevel), requests: assets.reduce((x, a) => x + a.requests, 0) } : null;
  return { usedTris, usedMB, stream, mode, count, errorPx, budget, frames, tris: st(tris), effPx: st(eff.map((e) => Math.min(e, 1e6))), selectMs: st(selMs), frameMs: st(ms), maxTriJumpPerFrame: maxJump };
};

// unattended suite: ?auto=<name>&res=1920x1080 -> out/bench/<name>.json
if (q.get('auto')) {
  const D = window.demo, out = { name: q.get('auto'), gpu: gpuName, res: `${canvas.width}x${canvas.height}`, multiDraw: hasMultiDraw, when: new Date().toISOString(), bench: [], trace: [] };
  const heavy = q.get('heavy') !== '0', quick = q.get('quick') === '1';
  try {
    await sleep(1500);
    if (q.get('suite') === 'occ') {
      for (const occ of [false, true]) for (const [e, b] of [[2, 0], [0.5, 300e3]]) out.bench.push(...await D.bench({ label: 'occ', count: 384, errorPx: e, budget: b, distances: [20, 45, 80], elev: 4, occ }));
      throw new Error('occ suite only');
    }
    if (quick) {
      for (const m of ['clod', 'lod']) out.bench.push(...await D.bench({ label: 'quick', mode: m, count: 96, errorPx: 2, distances: [8, 50, 300] }));
      out.bench.push(...await D.bench({ label: 'quick', count: 96, errorPx: 0.5, budget: 300e3, distances: [8, 50, 300] }));
      out.bench.push(...await D.bench({ label: 'quick', mode: 'full', count: 6, distances: [8, 50], frames: 8 }));
      throw new Error('quick suite only');
    }
    const one = [1.5, 3, 6, 12, 25, 50, 100, 200];
    for (const e of [1, 2, 4]) out.bench.push(...await D.bench({ label: 'single', count: 1, errorPx: e, distances: one }));
    out.bench.push(...await D.bench({ label: 'single', mode: 'lod', count: 1, errorPx: 1, distances: one }));
    out.bench.push(...await D.bench({ label: 'single', mode: 'full', count: 1, distances: [3], frames: 12 }));
    const field = [3, 8, 20, 50, 120, 300];
    for (const e of [1, 2, 4]) out.bench.push(...await D.bench({ label: 'field', count: 96, errorPx: e, distances: field }));
    for (const e of [1, 2, 4]) out.bench.push(...await D.bench({ label: 'field', mode: 'lod', count: 96, errorPx: e, distances: field }));
    out.bench.push(...await D.bench({ label: 'field-nocull', count: 96, errorPx: 1, distances: [3, 20], cull: false }));
    for (const b of [100e3, 300e3, 1e6]) out.bench.push(...await D.bench({ label: 'budget', count: 96, errorPx: 0.5, budget: b, distances: field }));
    for (const c of [384, 1536]) { out.bench.push(...await D.bench({ label: 'scale', count: c, errorPx: 2, distances: [8, 50, 300] })); out.bench.push(...await D.bench({ label: 'scale', count: c, errorPx: 0.5, budget: 500e3, distances: [8, 50, 300] })); out.bench.push(...await D.bench({ label: 'scale', mode: 'lod', count: c, errorPx: 2, distances: [8, 50, 300] })); }
    if (heavy) for (const c of [6, 24]) { out.bench.push(...await D.bench({ label: 'full', mode: 'full', count: c, distances: [8, 50], frames: 8 })); out.bench.push(...await D.bench({ label: 'full', mode: 'clod', count: c, errorPx: 1, distances: [8, 50] })); out.bench.push(...await D.bench({ label: 'full', mode: 'lod', count: c, errorPx: 1, distances: [8, 50] })); }
    out.trace.push(await D.trace({ count: 96, errorPx: 1 }));
    out.trace.push(await D.trace({ count: 96, errorPx: 2 }));
    out.trace.push(await D.trace({ count: 96, mode: 'lod', errorPx: 1 }));
    for (const b of [300e3, 1e6]) out.trace.push(await D.trace({ count: 96, errorPx: 0.5, budget: b }));
    out.trace.push(await D.trace({ count: 384, errorPx: 0.5, budget: 500e3 }));
  } catch (e) { out.error = String(e && e.stack || e); }
  out.contextLost = contextLostAt; out.assets = assets.map((a) => a.name); out.data = DATA; out.mat = q.get('mat') || 'standard';
  await D.save(`bench/${out.name}.json`, out);
  msg('auto bench done');
}
