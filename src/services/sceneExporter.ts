import JSZip from 'jszip';
import type { StoredScene } from './sceneStorage';
import { advancePhysics, createCollisionSystem, createTriggerSystem, getPhysicsBounds } from '../systems/PhysicsEngine';
import { advanceCharacterControllers, createPlayerCamera } from '../systems/CharacterControllerSystem';
import { createSceneAI } from '../systems/SceneAI';
import { createPathFollowers } from '../systems/PathFollowers';
import { createObjectScripts } from '../systems/ObjectScripts';
import { createWebLayer } from '../systems/WebLayer';
import { createModelAnimations } from '../systems/ModelAnimations';
import { createPropertyAnimations } from '../systems/PropertyAnimations';
import { createTweenAnimations } from '../systems/TweenAnimations';
import { createFloatEffects } from '../systems/FloatEffects';
import { createEnvironmentTexture } from '../systems/Environment';
import { createTimeline } from '../systems/Timeline';
import { createTimelineMedia } from '../systems/TimelineMedia';
import jquerySource from 'jquery/dist/jquery.min.js?raw';
import threeSource from 'three-export/build/three.min.js?raw';
import gltfLoaderSource from 'three-export/examples/js/loaders/GLTFLoader.js?raw';
import rgbeLoaderSource from 'three-export/examples/js/loaders/RGBELoader.js?raw';
import threeLicense from 'three-export/LICENSE?raw';
import tweenSource from '../../node_modules/@tweenjs/tween.js/dist/tween.umd.js?raw';
import tweenLicense from '../../node_modules/@tweenjs/tween.js/LICENSE?raw';
import textFontSource from 'three/examples/fonts/droid/droid_sans_regular.typeface.json?raw';
import textFontNotice from 'three/examples/fonts/droid/NOTICE?raw';
import latinFontUrl from '@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff?url';
import extendedFontUrl from '@fontsource/noto-sans/files/noto-sans-latin-ext-400-normal.woff?url';
import notoLicense from '@fontsource/noto-sans/LICENSE?raw';
import sdfUtils from '../../node_modules/troika-three-utils/dist/troika-three-utils.umd.min.js?raw';
import sdfWorkers from '../../node_modules/troika-worker-utils/dist/troika-worker-utils.umd.min.js?raw';
import sdfGenerator from '../../node_modules/webgl-sdf-generator/dist/webgl-sdf-generator.min.js?raw';
import sdfBidi from '../../node_modules/bidi-js/dist/bidi.min.js?raw';
import sdfText from '../../node_modules/troika-three-text/dist/troika-three-text.umd.min.js?raw';
import sdfUtilsLicense from '../../node_modules/troika-three-utils/LICENSE?raw';
import sdfWorkersLicense from '../../node_modules/troika-worker-utils/LICENSE?raw';
import sdfGeneratorLicense from '../../node_modules/webgl-sdf-generator/LICENSE.txt?raw';
import sdfBidiLicense from '../../node_modules/bidi-js/LICENSE.txt?raw';
import sdfTextLicense from '../../node_modules/troika-three-text/LICENSE?raw';
import { packageExportAssets } from './exportAssets';
import { isSupportedSdfText } from './sceneObjects';

export type ExportFormat = 'html' | 'react' | 'wordpress';

export const exportScene = async (snapshot: StoredScene, format: ExportFormat = 'html') => {
  const zip = new JSZip();
  const sceneZip = format === 'html' ? zip : zip.folder(format === 'react' ? 'public/scene' : 'three-scene-export/scene');
  if (!sceneZip) throw new Error('Could not create the export folder.');
  const projectData = {
    version: "1.0",
    lastModified: new Date().toISOString(),
    ...await packageExportAssets(snapshot, sceneZip)
  };
  const scenes = [
    { id: projectData.activeSceneId!, objects: projectData.objects, sceneOptions: projectData.sceneOptions },
    ...(projectData.otherScenes ?? [])
  ];
  for (const scene of scenes) {
    if (scene.objects.some(obj => obj.type === 'model' && !obj.properties.modelData)) {
      throw new Error(`${scene.sceneOptions.name}: a model is missing its original GLB data. Please import it again.`);
    }
    if (scene.sceneOptions.activeCameraId && !scene.objects.some(obj => obj.id === scene.sceneOptions.activeCameraId && obj.type === 'camera')) {
      throw new Error(`${scene.sceneOptions.name}: selected play camera is unavailable; choose another camera.`);
    }
  }
  const pages = Object.fromEntries(scenes.map((scene, index) => [scene.id, index === 0 ? 'index.html' : `scene-${index}.html`]));
  sceneZip.file('scene.json', JSON.stringify(projectData, null, 2));
  sceneZip.file('vendor/three.min.js', threeSource);
  sceneZip.file('vendor/GLTFLoader.js', gltfLoaderSource);
  sceneZip.file('vendor/THREE-LICENSE.txt', threeLicense);
  if (scenes.some(scene => scene.sceneOptions.environment?.enabled && scene.sceneOptions.environment.source === 'hdr')) {
    sceneZip.file('vendor/RGBELoader.js', rgbeLoaderSource);
  }
  if (scenes.some(scene => scene.objects.some(obj => obj.properties.tween?.enabled))) {
    sceneZip.file('vendor/tween.umd.js', tweenSource);
    sceneZip.file('vendor/TWEEN-LICENSE.txt', tweenLicense);
  }
  if (scenes.some(scene => scene.objects.some(obj => obj.type === 'text3d'))) {
    sceneZip.file('vendor/droid_sans_regular.typeface.json', textFontSource);
    sceneZip.file('vendor/DROID-FONT-NOTICE.txt', textFontNotice);
  }
  if (scenes.some(scene => scene.objects.some(obj => obj.type === 'textSdf'))) {
    for (const [name, source] of [
      ['sdf-utils.js', sdfUtils], ['sdf-workers.js', sdfWorkers], ['sdf-generator.js', sdfGenerator],
      ['sdf-bidi.js', sdfBidi], ['sdf-text.js', sdfText], ['SDF-UTILS-LICENSE.txt', sdfUtilsLicense],
      ['SDF-WORKERS-LICENSE.txt', sdfWorkersLicense], ['SDF-GENERATOR-LICENSE.txt', sdfGeneratorLicense],
      ['SDF-BIDI-LICENSE.txt', sdfBidiLicense], ['SDF-TEXT-LICENSE.txt', sdfTextLicense],
      ['NOTO-SANS-LICENSE.txt', notoLicense]
    ]) sceneZip.file(`vendor/${name}`, source);
    for (const [name, url] of [['noto-latin.woff', latinFontUrl], ['noto-latin-ext.woff', extendedFontUrl]]) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not load bundled font: ${name} (HTTP ${response.status})`);
      sceneZip.file(`vendor/${name}`, await response.arrayBuffer());
    }
  }
  if (scenes.some(scene => scene.sceneOptions.enableJQuery)) sceneZip.file('jquery.min.js', jquerySource);
  if (scenes.some(scene => scene.objects.some(obj => obj.properties.web?.kind === 'lottie' && obj.properties.web.lottieData))) {
    const { default: lottieSource } = await import('lottie-web/build/player/lottie.min.js?raw');
    sceneZip.file('lottie.min.js', lottieSource);
  }

  for (const [index, entry] of scenes.entries()) {
  const sceneOptions = entry.sceneOptions;
  const sceneObjects = entry.objects;
  const sceneData = { version: projectData.version, lastModified: projectData.lastModified, objects: entry.objects, sceneOptions };
  const hasLottie = sceneObjects.some(obj => obj.properties.web?.kind === 'lottie' && obj.properties.web.lottieData);
  const hasTween = sceneObjects.some(obj => obj.properties.tween?.enabled);
  const hasSdf = sceneObjects.some(obj => obj.type === 'textSdf');
  const hasHdr = sceneOptions.environment?.enabled && sceneOptions.environment.source === 'hdr';
  const scriptName = index === 0 ? 'scene.js' : `scene-${index}.js`;

  const title = (sceneOptions.name || 'Game Scene').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character] || character));
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    html, body {
      width: 100%;
      height: 100%;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
    }

    #canvas {
      display: block;
      width: 100%;
      height: 100%;
    }

    #stats {
      position: absolute;
      top: 10px;
      left: 10px;
      background: rgba(0, 0, 0, 0.8);
      color: #fff;
      padding: 10px 15px;
      border-radius: 4px;
      font-size: 12px;
      font-family: monospace;
      z-index: 100;
    }

    #controls {
      position: absolute;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.8);
      color: #fff;
      padding: 15px 20px;
      border-radius: 8px;
      text-align: center;
      z-index: 100;
    }

    #controls p {
      margin: 5px 0;
      font-size: 13px;
    }

    #enable-sound {
      position: absolute;
      top: 10px;
      right: 10px;
      z-index: 101;
      padding: 10px;
      cursor: pointer;
    }

    #load-error {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: #991b1b;
      color: white;
      padding: 16px;
      z-index: 102;
    }

    @media (max-width: 768px) {
      #controls {
        font-size: 11px;
        padding: 10px 15px;
        bottom: 10px;
      }

      #controls p {
        margin: 3px 0;
      }
    }
  </style>
</head>
<body>
  <div id="stats">
    <div>FPS: <span id="fps">0</span></div>
    <div>Objects: <span id="objects">${sceneObjects.length}</span></div>
  </div>

  <div id="controls">
    <p><strong>Controls:</strong></p>
    <p>WASD/Arrows: Move | Space: Jump</p>
  </div>
  <button id="enable-sound" hidden>Enable sound</button>
  <div id="load-error" role="alert" hidden></div>

  ${sceneOptions.enableJQuery ? '<script src="jquery.min.js"></script>' : ''}
  ${hasLottie ? '<script src="lottie.min.js"></script>' : ''}
  <script>
    function loadScript(src) {
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = () => reject(new Error('Could not load ' + src));
        document.head.appendChild(script);
      });
    }
    async function loadWithFallback(local, cdn, ready) {
      try {
        await loadScript(local);
        if (!ready()) throw new Error('Invalid local library: ' + local);
      } catch (error) {
        console.warn('Local library failed; trying CDN:', error);
        await loadScript(cdn);
        if (!ready()) throw new Error('Invalid CDN library: ' + cdn);
      }
    }
    (async () => {
      await loadWithFallback('vendor/three.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
        () => window.THREE && window.THREE.REVISION === '128');
      await loadWithFallback('vendor/GLTFLoader.js', 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js',
        () => typeof window.THREE.GLTFLoader === 'function');
      ${hasHdr ? "await loadScript('vendor/RGBELoader.js'); if (typeof window.THREE.RGBELoader !== 'function') throw new Error('HDR loader failed to load');" : ''}
      ${hasTween ? "await loadScript('vendor/tween.umd.js');" : ''}
      ${hasSdf ? `for (const name of ['sdf-utils.js', 'sdf-workers.js', 'sdf-generator.js', 'sdf-bidi.js', 'sdf-text.js']) {
        await loadScript('vendor/' + name);
      }
      if (!window.troika_three_text?.Text) throw new Error('SDF text library failed to load');
      window.troika_three_text.configureTextBuilder({ defaultFontURL: 'vendor/noto-latin.woff', useWorker: false });` : ''}
      await loadScript('${scriptName}');
    })().catch(error => {
      console.error('Failed to load game libraries:', error);
      const message = document.getElementById('load-error');
      message.textContent = 'Could not load the game: ' + error.message;
      message.hidden = false;
    });
  </script>
</body>
</html>`;

  sceneZip.file(pages[entry.id], htmlContent);

  const sceneCode = `
// Game Scene - Auto-generated
const sceneData = ${JSON.stringify(sceneData, null, 2)};
const scenePages = ${JSON.stringify(pages)};
const sceneReferences = ${JSON.stringify(scenes.map(scene => ({ id: scene.id, name: scene.sceneOptions.name })))};
let sceneActive = true;
function openScene(id) {
  if (!sceneActive) return;
  if (!Object.prototype.hasOwnProperty.call(scenePages, id)) {
    const error = document.getElementById('load-error');
    error.textContent = 'Target scene no longer exists';
    error.hidden = false;
    return;
  }
  window.location.href = scenePages[id];
}

let scene, camera, renderer, clock;
let textFont;
let environmentTexture;
let sceneObjects = [];
let keys = {};
let objectScripts;
let modelAnimations;
let propertyAnimations;
let tweenAnimations;
let floatEffects;
let timeline;
let triggerSystem;
let collisionSystem;
let playerCamera;
let pathFollowers;
const createObjectScripts = ${createObjectScripts.toString()};
const createSceneAI = ${createSceneAI.toString()};
const createPathFollowers = ${createPathFollowers.toString()};
const createModelAnimations = ${createModelAnimations.toString()};
const createPropertyAnimations = ${createPropertyAnimations.toString()};
const createTweenAnimations = ${createTweenAnimations.toString()};
const createFloatEffects = ${createFloatEffects.toString()};
const createEnvironmentTexture = ${createEnvironmentTexture.toString()};
const isSupportedSdfText = ${isSupportedSdfText.toString()};
const createTimeline = ${createTimeline.toString()};
const createTimelineMedia = ${createTimelineMedia.toString()};
const createWebLayer = ${createWebLayer.toString()};
const getPhysicsBounds = ${getPhysicsBounds.toString()};
const advancePhysicsImpl = ${advancePhysics.toString()};
const advancePhysics = (objects, delta, gravity, three, onCollision) =>
  advancePhysicsImpl(objects, delta, gravity, three, getPhysicsBounds, onCollision);
const createTriggerSystem = ${createTriggerSystem.toString()};
const createCollisionSystem = ${createCollisionSystem.toString()};
const advanceCharacterControllers = ${advanceCharacterControllers.toString()};
const createPlayerCamera = ${createPlayerCamera.toString()};
const input = { isKeyPressed: key => !!keys[key.toLowerCase()] };

// Initialize scene
async function init() {
  // Scene setup
  scene = new THREE.Scene();
  scene.background = new THREE.Color(sceneData.sceneOptions.backgroundColor || '#1a1a2e');

  if (sceneData.sceneOptions.fogEnabled) {
    scene.fog = new THREE.FogExp2(
      new THREE.Color(sceneData.sceneOptions.fogColor || '#cccccc'),
      sceneData.sceneOptions.fogDensity ?? 0.1
    );
  }

  // Camera setup
  camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  camera.position.set(0, 5, 10);
  camera.lookAt(0, 0, 0);

  // Renderer setup
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = sceneData.sceneOptions.shadowsEnabled !== false;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);
  if (sceneData.sceneOptions.environment?.enabled) {
    environmentTexture = await createEnvironmentTexture(sceneData.sceneOptions.environment, THREE, url => new THREE.RGBELoader().loadAsync(url));
    scene.environment = environmentTexture;
    if (sceneData.sceneOptions.environment.background) scene.background = environmentTexture;
  }

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, sceneData.sceneOptions.ambientLightIntensity ?? 0.5);
  scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
  directionalLight.position.set(10, 10, 5);
  directionalLight.castShadow = sceneData.sceneOptions.shadowsEnabled !== false;
  scene.add(directionalLight);

  clock = new THREE.Clock();

  // Load scene objects
  if (sceneData.objects.some(obj => obj.type === 'text3d')) {
    textFont = await new THREE.FontLoader().loadAsync('vendor/droid_sans_regular.typeface.json');
  }
  await loadSceneObjects();
  if (sceneData.sceneOptions.activeCameraId) {
    const source = sceneObjects.find(obj => obj.id === sceneData.sceneOptions.activeCameraId && obj.object.isPerspectiveCamera);
    if (!source) throw new Error('Selected play camera is unavailable');
    camera.position.copy(source.object.position);
    camera.quaternion.copy(source.object.quaternion);
    camera.fov = source.object.fov;
    camera.near = source.object.near;
    camera.far = source.object.far;
    camera.zoom = source.object.zoom;
    camera.updateProjectionMatrix();
  }
  playerCamera = createPlayerCamera(sceneObjects, camera, renderer.domElement, THREE, message => {
    console.error('Player camera error:', message);
    const error = document.getElementById('load-error');
    error.textContent = message;
    error.hidden = false;
  });
  if (sceneObjects.some(obj => (obj.properties.script && obj.properties.script.trim()) || (obj.properties.web && obj.properties.web.script && obj.properties.web.script.trim())) &&
      !window.confirm('This scene contains JavaScript with full browser access. Run only trusted code. Continue?')) {
    throw new Error('Script execution was cancelled');
  }
  objectScripts = createObjectScripts(sceneObjects, scene, camera, THREE, message => {
    console.error('Object script error:', message);
    const error = document.getElementById('load-error');
    error.textContent = 'Script error: ' + message;
    error.hidden = false;
  }, openScene, sceneReferences, sceneData.sceneOptions.ai ? createSceneAI(sceneData.sceneOptions.ai) : null);
  objectScripts.start();
  pathFollowers = createPathFollowers(sceneObjects, sceneData.sceneOptions.ai, sceneData.sceneOptions.timeline,
    createSceneAI, message => {
      console.error('AI navigation error:', message);
      const error = document.getElementById('load-error');
      error.textContent = message;
      error.hidden = false;
    }, THREE, getPhysicsBounds, message => {
      const error = document.getElementById('load-error');
      if (error.textContent === message) { error.textContent = ''; error.hidden = true; }
    });
  triggerSystem = createTriggerSystem(sceneObjects, THREE,
    (id, method, other) => objectScripts.trigger(id, method, other), getPhysicsBounds);
  collisionSystem = createCollisionSystem((id, method, other) => objectScripts.trigger(id, method, other));
  modelAnimations = createModelAnimations(sceneObjects, THREE, message => {
    console.error('Model animation error:', message);
    const error = document.getElementById('load-error');
    error.textContent = 'Animation error: ' + message;
    error.hidden = false;
  }, openScene, (sceneData.sceneOptions.timeline?.clips || []).map(clip => clip.targetId));
  propertyAnimations = createPropertyAnimations(sceneObjects, message => {
    console.error('Animation error:', message);
    const error = document.getElementById('load-error');
    error.textContent = 'Animation error: ' + message;
    error.hidden = false;
  }, window, openScene);
  ${hasTween ? `if (!window.TWEEN || typeof window.TWEEN.Tween !== 'function') throw new Error('Tween.js failed to load');
  tweenAnimations = createTweenAnimations(sceneObjects, window.TWEEN, message => {
    console.error('Tween animation error:', message);
    const error = document.getElementById('load-error');
    error.textContent = 'Animation error: ' + message;
    error.hidden = false;
  });` : ''}
  floatEffects = createFloatEffects(sceneObjects, message => {
    console.error('Float error:', message);
    const error = document.getElementById('load-error');
    error.textContent = 'Float error: ' + message;
    error.hidden = false;
  });
  const cleanupWeb = createWebLayer(document.body, sceneObjects, {
    editing: false, width: '100%', scene, camera, three: THREE, lottie: typeof lottie === 'undefined' ? undefined : lottie,
    onPlayClip: (id, clipIndex) => modelAnimations.play(id, clipIndex),
    timelineSounds: sceneData.sceneOptions.timeline?.sounds,
    onSceneChange: openScene, scenes: sceneReferences,
    onError: message => {
      console.error('Web component error:', message);
      const error = document.getElementById('load-error');
      error.textContent = 'Web error: ' + message;
      error.hidden = false;
    }
  });
  if (sceneData.sceneOptions.timeline) {
    timeline = createTimeline(sceneData.sceneOptions.timeline, sceneObjects, sceneData.sceneOptions.activeCameraId, camera, document.body, message => {
      console.error('Timeline error:', message);
      const error = document.getElementById('load-error');
      error.textContent = 'Timeline error: ' + message;
      error.hidden = false;
    }, THREE, createTimelineMedia);
  }
  if (sceneObjects.some(obj => obj.properties.web) &&
      !sceneObjects.some(obj => obj.properties.characterController && obj.properties.characterController.enabled)) {
    document.getElementById('stats').hidden = true;
    document.getElementById('controls').hidden = true;
  }
  renderer.domElement.addEventListener('click', event => {
    const rect = renderer.domElement.getBoundingClientRect();
    const point = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(point, camera);
    const hit = raycaster.intersectObjects(sceneObjects.map(obj => obj.object), true)[0];
    if (!hit) return;
    let target = hit.object;
    while (target.parent && !sceneObjects.some(obj => obj.object === target)) target = target.parent;
    const item = sceneObjects.find(obj => obj.object === target);
    if (item) objectScripts.click(item.id);
  });
  window.addEventListener('pagehide', () => { sceneActive = false; playerCamera?.stop(); timeline?.stop(); cleanupWeb(); objectScripts.stop(); modelAnimations.stop(); propertyAnimations.stop(); tweenAnimations?.stop(); environmentTexture?.dispose(); });

  const sounds = sceneObjects.flatMap(obj => (obj.properties.sounds || [])
    .filter(sound => sound.autoPlay && !(sceneData.sceneOptions.timeline?.sounds || [])
      .some(segment => segment.targetId === obj.id && segment.soundId === sound.id))
    .map(sound => {
      const audio = new Audio(sound.url);
      audio.volume = sound.volume;
      audio.loop = sound.loop;
      return audio;
    }));
  const soundButton = document.getElementById('enable-sound');
  async function playSounds() {
    const results = await Promise.allSettled(sounds.map(sound => sound.play()));
    const failed = results.some(result => result.status === 'rejected');
    soundButton.hidden = !failed;
    if (failed) console.error('Some scene sounds could not be played', results);
  }
  soundButton.addEventListener('click', playSounds);
  if (sounds.length) await playSounds();

  // Input handling
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof Element && e.target.closest('.engine-web-root button, .engine-web-root input, .engine-web-root textarea, .engine-web-root select, .engine-web-root a')) return;
    if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(e.key.toLowerCase())) e.preventDefault();
    keys[e.key.toLowerCase()] = true;
  });

  window.addEventListener('keyup', (e) => {
    keys[e.key.toLowerCase()] = false;
  });
  window.addEventListener('blur', () => { keys = {}; });

  // Handle window resize
  window.addEventListener('resize', onWindowResize);

  // Start animation loop
  animate();
}

async function loadSceneObjects() {
  for (const objData of sceneData.objects) {
    let object = null;

    switch (objData.type) {
      case 'imagePlane':
        object = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false }));
        break;
      case 'imageSprite': {
        if (!objData.properties.map) throw new Error('Sprite is missing image data: ' + objData.name);
        const texture = await new THREE.TextureLoader().loadAsync(objData.properties.map);
        texture.encoding = THREE.sRGBEncoding;
        object = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture }));
        break;
      }
      case 'audioSource':
      case 'web':
        object = new THREE.Object3D();
        break;
      case 'model': {
        if (!objData.properties.modelData) throw new Error('Model is missing GLB data: ' + objData.name);
        const gltf = await new THREE.GLTFLoader().loadAsync(objData.properties.modelData);
        const model = gltf.scene;
        const center = new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3());
        model.position.sub(center);
        model.traverse(child => {
          if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });
        object = new THREE.Group();
        object.add(model);
        object.animations = gltf.animations;
        break;
      }
      case 'box':
      case '3d':
        object = new THREE.Mesh(
          new THREE.BoxGeometry(1, 1, 1),
          new THREE.MeshStandardMaterial({ color: objData.properties.color || 0x808080 })
        );
        break;
      case 'text3d': {
        const settings = objData.properties.text3d;
        if (!settings || typeof settings.text !== 'string' || settings.text.length > 200 ||
            !Number.isFinite(settings.size) || settings.size <= 0 || settings.size > 100 ||
            !Number.isFinite(settings.depth) || settings.depth < 0 || settings.depth > 50) {
          throw new Error('Invalid 3D text settings: ' + objData.name);
        }
        object = new THREE.Mesh(new THREE.TextGeometry(settings.text, {
          font: textFont, size: settings.size, height: settings.depth, curveSegments: 4
        }), new THREE.MeshStandardMaterial({ color: objData.properties.color || 0x808080 }));
        break;
      }
      case 'textSdf': {
        const settings = objData.properties.text3d;
        if (!settings || typeof settings.text !== 'string' || settings.text.length > 200 || !isSupportedSdfText(settings.text) ||
            !Number.isFinite(settings.size) || settings.size <= 0 || settings.size > 100) {
          throw new Error('SDF text supports Latin-1 and Turkish characters only: ' + objData.name);
        }
        object = new window.troika_three_text.Text();
        object.font = 'vendor/noto-latin-ext.woff';
        object.fontSize = settings.size;
        object.text = settings.text;
        await new Promise(resolve => object.sync(resolve));
        break;
      }

      case 'sphere':
        object = new THREE.Mesh(
          new THREE.SphereGeometry(0.5, 32, 32),
          new THREE.MeshStandardMaterial({ color: objData.properties.color || 0x808080 })
        );
        break;

      case 'cylinder':
        object = new THREE.Mesh(
          new THREE.CylinderGeometry(0.5, 0.5, 1, 32),
          new THREE.MeshStandardMaterial({ color: objData.properties.color || 0x808080 })
        );
        break;

      case 'cone':
        object = new THREE.Mesh(
          new THREE.ConeGeometry(0.5, 1, 32),
          new THREE.MeshStandardMaterial({ color: objData.properties.color || 0x808080 })
        );
        break;

      case 'ground':
        object = new THREE.Mesh(
          new THREE.PlaneGeometry(10, 10),
          new THREE.MeshStandardMaterial({ color: objData.properties.color || 0x808080, side: THREE.DoubleSide })
        );
        object.rotation.x = -Math.PI / 2;
        break;

      case 'pointLight':
        object = new THREE.PointLight(
          objData.properties.color ?? 0xffffff,
          objData.properties.intensity ?? 1,
          objData.properties.distance ?? 0,
          objData.properties.decay ?? 2
        );
        break;

      case 'spotLight':
        object = new THREE.SpotLight(
          objData.properties.color ?? 0xffffff,
          objData.properties.intensity ?? 1,
          objData.properties.distance ?? 0,
          objData.properties.angle != null ? objData.properties.angle * Math.PI / 180 : Math.PI / 3,
          objData.properties.penumbra ?? 0,
          objData.properties.decay ?? 2
        );
        break;

      case 'camera':
        object = new THREE.PerspectiveCamera(
          objData.properties.fov ?? 75,
          window.innerWidth / window.innerHeight,
          objData.properties.near ?? 0.1,
          objData.properties.far ?? 1000
        );
        break;
      default:
        throw new Error('Unsupported scene object type: ' + objData.type);
    }

    if (object) {
      object.name = objData.name;
      object.userData.className = objData.properties.className || '';
      object.userData.tags = objData.properties.tags || [];
      // Apply properties
      if (objData.properties.position) {
        object.position.fromArray(objData.properties.position);
      }
      if (objData.properties.rotation) {
        object.rotation.set(
          objData.properties.rotation[0] * Math.PI / 180,
          objData.properties.rotation[1] * Math.PI / 180,
          objData.properties.rotation[2] * Math.PI / 180
        );
      }
      if (objData.properties.scale) {
        object.scale.fromArray(objData.properties.scale);
      }

      object.castShadow = objData.properties.castShadow !== false;
      object.receiveShadow = objData.properties.receiveShadow === true;
      object.visible = objData.properties.visible !== false;

      const textures = {};
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) {
        if (objData.properties[key]) {
          const texture = await new THREE.TextureLoader().loadAsync(objData.properties[key]);
          texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
          if (key === 'map') texture.encoding = THREE.sRGBEncoding;
          textures[key] = texture;
        }
      }
      object.traverse(child => {
        if (!child.isMesh) return;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        const updated = materials.map(material => {
          const type = objData.properties.materialType;
          if (type) {
            const options = { color: material.color, opacity: material.opacity, transparent: material.transparent, side: material.side, map: material.map, depthWrite: material.depthWrite };
            const constructors = { standard: THREE.MeshStandardMaterial, basic: THREE.MeshBasicMaterial, phong: THREE.MeshPhongMaterial, lambert: THREE.MeshLambertMaterial };
            material = new constructors[type](options);
          }
          if (objData.properties.color !== undefined && material.color) material.color.set(objData.properties.color);
          if (objData.properties.metalness !== undefined && 'metalness' in material) material.metalness = objData.properties.metalness;
          if (objData.properties.roughness !== undefined && 'roughness' in material) material.roughness = objData.properties.roughness;
          if (objData.properties.opacity !== undefined) {
            material.opacity = objData.properties.opacity;
            material.transparent = material.opacity < 1 || objData.type === 'imagePlane';
            if (objData.type === 'imagePlane') material.depthWrite = false;
          }
          for (const key of Object.keys(textures)) if (key in material) material[key] = textures[key];
          material.needsUpdate = true;
          return material;
        });
        child.material = Array.isArray(child.material) ? updated : updated[0];
      });

      scene.add(object);
      sceneObjects.push({ ...objData, object });
    }
  }
}

function animate() {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();
  floatEffects.before();
  objectScripts.update(delta);
  modelAnimations.update(delta);

  pathFollowers.update(delta);
  collisionSystem.begin();
  advancePhysics(sceneObjects, Math.min(delta, 0.05), sceneData.sceneOptions.gravity, THREE, (a, b) => collisionSystem.contact(a, b));
  collisionSystem.end();
  triggerSystem.update();
  advanceCharacterControllers(sceneObjects, input, THREE, camera);
  propertyAnimations.update(delta);
  tweenAnimations?.update(delta);
  timeline?.update(delta);
  floatEffects.update(delta);
  playerCamera?.update();

  renderer.render(scene, camera);

  // Update FPS
  document.getElementById('fps').textContent = Math.round(1 / delta);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// Start the application
init().catch(error => {
  console.error('Failed to start game:', error);
  const message = document.getElementById('load-error');
  message.textContent = 'Could not load the game: ' + error.message;
  message.hidden = false;
});
`;

  sceneZip.file(scriptName, sceneCode);
  }

  if (format === 'react') {
    zip.file('package.json', JSON.stringify({
      name: 'three-scene-export', private: true, version: '1.0.0', type: 'module',
      scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
      dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
      devDependencies: { vite: '^5.4.2' }
    }, null, 2));
    zip.file('index.html', '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Scene</title></head><body style="margin:0"><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>');
    zip.file('src/main.jsx', `import React from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  return <iframe title="3D scene" src={import.meta.env.BASE_URL + 'scene/index.html'} style={{display:'block',width:'100%',height:'100vh',border:0}} allow="fullscreen; autoplay" />;
}

createRoot(document.getElementById('root')).render(<App />);
`);
    zip.file('README.txt', 'Run npm install, then npm run dev. The generated scene runs in an iframe from public/scene. Three.js and GLTFLoader are included locally, with CDN fallback.');
  } else if (format === 'wordpress') {
    zip.file('three-scene-export/three-scene-export.php', `<?php
/*
Plugin Name: Three Scene Export
Description: Displays the exported scene using the [three_scene] shortcode.
Version: 1.0.0
*/
if (!defined('ABSPATH')) exit;
add_shortcode('three_scene', function () {
    $url = plugins_url('scene/index.html', __FILE__);
    return '<iframe title="3D scene" src="' . esc_url($url) . '" style="display:block;width:100%;height:100vh;border:0" allow="fullscreen; autoplay"></iframe>';
});
`);
    zip.file('three-scene-export/README.txt', 'Install and activate this ZIP as a WordPress plugin, then add [three_scene] to a page. Three.js and GLTFLoader are included locally, with CDN fallback.');
  }

  const content = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(content);
  const a = document.createElement('a');
  a.href = url;
  a.download = (projectData.sceneOptions.name || 'scene') + (format === 'html' ? '-export.zip' : `-${format}.zip`);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};
