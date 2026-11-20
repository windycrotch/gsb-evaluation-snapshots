// The smallest useful setup: one asset, 100 instances, a 4 px error threshold.
// Open /minimal.html (optionally ?asset=<name>&budget=300000) after "npm run dev".
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadClod, loadClodMaterial, ClodBatch, ClodSelector } from 'three-nanite';

const q = new URLSearchParams(location.search);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fa3b8);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 2.5); sun.position.set(3, 6, 2); scene.add(sun);
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 1000);
camera.position.set(8, 5, 12);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.5, 0);

const asset = await loadClod('/data', q.get('asset') || 'rock');
const material = loadClodMaterial('/data', asset);        // or any stock three.js material

// one Matrix4 per instance, world space, uniform scale
const matrices = [];
for (let i = 0; i < 100; i++) matrices.push(new THREE.Matrix4().makeTranslation((i % 10 - 4.5) * 2, 0, (Math.floor(i / 10) - 4.5) * 2));

const batch = new ClodBatch(asset, material, matrices);
scene.add(batch);

const selector = new ClodSelector([batch /*, batches of other assets */]);
const info = document.getElementById('info');

renderer.setAnimationLoop(() => {
  controls.update();
  // pick the cut, then render as usual
  const stats = selector.select(camera, renderer.domElement.height, { errorPx: 4, budget: +(q.get('budget') || 0) });
  renderer.render(scene, camera);
  info.textContent = `${Math.round(stats.tris).toLocaleString()} of ${(asset.meta.sourceTris * matrices.length).toLocaleString()} triangles, ${stats.clusters} clusters, select ${stats.ms.toFixed(2)} ms`;
});
window.addEventListener('resize', () => { renderer.setSize(window.innerWidth, window.innerHeight); camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); });
window.minimal = { selector, batch, renderer, camera };
