// Same cluster selection and the same ClodBatch object, drawn by three.js WebGPURenderer.
// Purpose: measure what the stock WebGPU backend does with a batched multi-draw list
// (it loops drawIndexed in JS; WebGPU core has no multi-draw).
//   /webgpu.html?count=96&err=2&budget=0&gpu=low-power[&assets=a,b][&auto=name][&forcewebgl=1]
import * as THREE from 'three/webgpu';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { loadClod, loadClodMaterial, ClodBatch, ClodSelector } from 'three-nanite';

const q = new URLSearchParams(location.search), S = document.getElementById('s');
const [W, H] = (q.get('res') || '1920x1080').split('x').map(Number);
const canvas = document.getElementById('c');
const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, powerPreference: q.get('gpu') || 'high-performance', forceWebGL: q.get('forcewebgl') === '1' });
await renderer.init();
renderer.setPixelRatio(1); renderer.setSize(W, H, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const device = renderer.backend.device;
const info = device ? (device.adapterInfo || renderer.backend.adapter?.info || {}) : {};
const gpuName = device ? `WebGPU: ${info.vendor || ''} ${info.architecture || ''} ${info.device || ''} ${info.description || ''}` : 'WebGL2 fallback backend';

const scene = new THREE.Scene(); scene.background = new THREE.Color(0x8fa3b8);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.7;
const sun = new THREE.DirectionalLight(0xfff1dd, 2.5); sun.position.set(30, 60, 20); scene.add(sun);
const camera = new THREE.PerspectiveCamera(60, W / H, 0.05, 3000);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: 0x5b5f58, roughness: 1, metalness: 0 })); ground.rotation.x = -Math.PI / 2; scene.add(ground);

const DATA = (q.get('data') || '/data').replace(/\/$/, '');
const names = q.get('assets') ? q.get('assets').split(',') : await fetch(`${DATA}/assets.json`).then((r) => r.json()), assets = [];
for (const n of names) {
  const a = await loadClod(DATA, n);
  a.mat = loadClodMaterial(DATA, a);
  a.unit = 1 / Math.max(a.meta.bbMax[0] - a.meta.bbMin[0], a.meta.bbMax[1] - a.meta.bbMin[1], a.meta.bbMax[2] - a.meta.bbMin[2]);
  assets.push(a);
}
const count = +(q.get('count') || 96), side = Math.ceil(Math.sqrt(count)), SP = 4;
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const per = assets.map(() => []);
for (let k = 0; k < count; k++) {
  const ai = k % assets.length, a = assets[ai], s = (1.6 + rnd() * 1.2) * a.unit;
  const x = (k % side - (side - 1) / 2) * SP + (rnd() - 0.5), z = (Math.floor(k / side) - (side - 1) / 2) * SP + (rnd() - 0.5);
  per[ai].push(new THREE.Matrix4().compose(new THREE.Vector3(x, -a.meta.bbMin[1] * s, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6.283), new THREE.Vector3(s, s, s)));
}
const batches = assets.map((a, i) => { const b = new ClodBatch(a, a.mat, per[i]); scene.add(b); return b; });
const selector = new ClodSelector(batches);
const opts = { errorPx: +(q.get('err') || 2), budget: +(q.get('budget') || 0) };
const pose = (d) => { const e = THREE.MathUtils.degToRad(20); camera.position.set(Math.sin(0.5) * Math.cos(e) * d, 1 + Math.sin(e) * d, Math.cos(0.5) * Math.cos(e) * d); camera.lookAt(0, 1, 0); };
pose(+(q.get('d') || 20));

let sel, cpuRender = 0;
function frame() { sel = selector.select(camera, H, opts); const t = performance.now(); renderer.render(scene, camera); cpuRender = performance.now() - t; }
const done = () => device ? device.queue.onSubmittedWorkDone() : Promise.resolve(renderer.backend.gl.finish());
async function bench(distances, frames = 30) {
  const rows = [];
  for (const d of distances) {
    pose(d); for (let i = 0; i < 6; i++) { frame(); await done(); }
    const t = [], c = [];
    for (let i = 0; i < frames; i++) { const t0 = performance.now(); frame(); await done(); t.push(performance.now() - t0); c.push(cpuRender); }
    t.sort((a, b) => a - b); c.sort((a, b) => a - b);
    rows.push({ dist: d, errorPx: opts.errorPx, budget: opts.budget, tris: Math.round(sel.tris), ranges: sel.clusters, selectMs: +sel.ms.toFixed(2), cpuRenderMs: +c[frames >> 1].toFixed(2), frameMs: +t[frames >> 1].toFixed(2), p90: +t[Math.floor(frames * 0.9)].toFixed(2) });
  }
  return rows;
}
window.bench = bench;
if (q.get('auto')) {
  const out = { name: q.get('auto'), gpu: gpuName, res: `${W}x${H}`, count, rows: [] };
  try {
    await new Promise((r) => setTimeout(r, 1500));
    for (const [e, b] of [[2, 0], [4, 0], [0.5, 300e3], [0.5, 1e6]]) { opts.errorPx = e; opts.budget = b; out.rows.push(...await bench([8, 50, 300])); }
  } catch (err) { out.error = String(err && err.stack || err); }
  await fetch(`/__save?name=bench/${out.name}.json`, { method: 'POST', body: JSON.stringify(out, null, 1) });
  S.textContent = 'done';
} else {
  let ema = 16, last = performance.now();
  renderer.setAnimationLoop(() => { const n = performance.now(); ema += (n - last - ema) * 0.1; last = n; frame(); S.textContent = `${gpuName}\ntris ${Math.round(sel.tris)}  ranges ${sel.clusters}\nselect ${sel.ms.toFixed(2)} ms  render() cpu ${cpuRender.toFixed(2)} ms\nframe ${ema.toFixed(1)} ms`; });
}
