import * as THREE from 'three';
import { SceneObject } from '../types/editor';
import { createSceneObjectFromModel, loadGLBModel } from './modelLoader';
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js';
import { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry.js';
import droidFont from 'three/examples/fonts/droid/droid_sans_regular.typeface.json';
import { Text, configureTextBuilder } from 'troika-three-text';
import latinFontUrl from '@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff?url';
import extendedFontUrl from '@fontsource/noto-sans/files/noto-sans-latin-ext-400-normal.woff?url';

type Properties = SceneObject['properties'];
type SceneRecord = Omit<SceneObject, 'object'>;
type Material = THREE.MeshStandardMaterial | THREE.MeshBasicMaterial | THREE.MeshPhongMaterial | THREE.MeshLambertMaterial;
const textFont = new FontLoader().parse(droidFont);
configureTextBuilder({ defaultFontURL: latinFontUrl, useWorker: false });

export function isSupportedSdfText(text: string) {
  return [...text].every(char => {
    const code = char.codePointAt(0)!;
    return code === 9 || code === 10 || (code >= 32 && code <= 126) || (code >= 160 && code <= 255) ||
      [0x11e, 0x11f, 0x130, 0x131, 0x15e, 0x15f].includes(code);
  });
}

export function createSdfText(settings: NonNullable<Properties['text3d']>) {
  if (typeof settings.text !== 'string' || settings.text.length > 200 ||
      !isSupportedSdfText(settings.text) || !Number.isFinite(settings.size) || settings.size <= 0 || settings.size > 100) {
    throw new Error('SDF text supports Latin-1 and Turkish characters only');
  }
  const object = new Text();
  object.text = settings.text;
  object.fontSize = settings.size;
  object.font = extendedFontUrl;
  object.sync();
  return object;
}

export function createTextGeometry(settings: NonNullable<Properties['text3d']>) {
  if (typeof settings.text !== 'string' || settings.text.length > 200 ||
      !Number.isFinite(settings.size) || settings.size <= 0 || settings.size > 100 ||
      !Number.isFinite(settings.depth) || settings.depth < 0 || settings.depth > 50) {
    throw new Error('Invalid 3D text settings');
  }
  return new TextGeometry(settings.text, { font: textFont, size: settings.size, height: settings.depth, curveSegments: 4 });
}

function isEditableMaterial(material: THREE.Material): material is Material {
  return material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshBasicMaterial ||
    material instanceof THREE.MeshPhongMaterial || material instanceof THREE.MeshLambertMaterial;
}

function createMaterial(type: NonNullable<Properties['materialType']>, previous: Material): Material {
  const options = { color: previous.color.clone(), opacity: previous.opacity, transparent: previous.transparent, side: previous.side, map: previous.map, depthWrite: previous.depthWrite };
  switch (type) {
    case 'basic': return new THREE.MeshBasicMaterial(options);
    case 'phong': return new THREE.MeshPhongMaterial(options);
    case 'lambert': return new THREE.MeshLambertMaterial(options);
    default: return new THREE.MeshStandardMaterial(options);
  }
}

export async function applyMaterialProperties(object: THREE.Object3D, properties: Partial<Properties>): Promise<void> {
  const meshes: THREE.Mesh[] = [];
  object.traverse((child) => { if (child instanceof THREE.Mesh) meshes.push(child); });
  const textures = new Map<string, THREE.Texture>();
  for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap'] as const) {
    const source = properties[key];
    if (source) {
      const texture = await new THREE.TextureLoader().loadAsync(source);
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      if (key === 'map') texture.colorSpace = THREE.SRGBColorSpace;
      textures.set(key, texture);
    }
  }
  for (const mesh of meshes) {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const updated = materials.map((original) => {
      if (!isEditableMaterial(original)) return original;
      const material = properties.materialType ? createMaterial(properties.materialType, original) : original;
      if (properties.color !== undefined) material.color.set(properties.color);
      if (properties.opacity !== undefined) {
        material.opacity = properties.opacity;
        material.transparent = properties.opacity < 1 || object.userData.preserveTextureAlpha === true;
      }
      if (material instanceof THREE.MeshStandardMaterial) {
        if (properties.metalness !== undefined) material.metalness = properties.metalness;
        if (properties.roughness !== undefined) material.roughness = properties.roughness;
        if (textures.has('roughnessMap')) material.roughnessMap = textures.get('roughnessMap')!;
        if (textures.has('metalnessMap')) material.metalnessMap = textures.get('metalnessMap')!;
      }
      if (material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshPhongMaterial) {
        if (textures.has('normalMap')) material.normalMap = textures.get('normalMap')!;
      }
      if (textures.has('map')) material.map = textures.get('map')!;
      material.needsUpdate = true;
      return material;
    });
    mesh.material = Array.isArray(mesh.material) ? updated : updated[0];
  }
}

export async function restoreSceneObject(record: SceneRecord): Promise<SceneObject> {
  const p = record.properties;
  let object: THREE.Object3D;
  switch (record.type) {
    case 'model':
      if (!p.modelData) throw new Error(`Model "${record.name}" has no GLB data`);
      object = createSceneObjectFromModel(await loadGLBModel(p.modelData), record.name, p.modelData).object;
      break;
    case 'imagePlane':
      object = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false }));
      object.userData.preserveTextureAlpha = true;
      break;
    case 'imageSprite': {
      if (!p.map) throw new Error(`Sprite "${record.name}" has no image`);
      const texture = await new THREE.TextureLoader().loadAsync(p.map);
      texture.colorSpace = THREE.SRGBColorSpace;
      object = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture }));
      break;
    }
    case 'audioSource':
    case 'web':
      object = new THREE.Object3D();
      break;
    case 'box':
    case '3d':
      object = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
      break;
    case 'text3d':
      if (!p.text3d) throw new Error(`Text "${record.name}" has no text settings`);
      object = new THREE.Mesh(createTextGeometry(p.text3d), new THREE.MeshStandardMaterial());
      break;
    case 'textSdf':
      if (!p.text3d) throw new Error(`Text "${record.name}" has no text settings`);
      object = createSdfText(p.text3d);
      break;
    case 'sphere':
      object = new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 32), new THREE.MeshStandardMaterial());
      break;
    case 'cylinder':
      object = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 32), new THREE.MeshStandardMaterial());
      break;
    case 'cone':
      object = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1, 32), new THREE.MeshStandardMaterial());
      break;
    case 'ground':
      object = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }));
      break;
    case 'pointLight':
      object = new THREE.PointLight(p.color ?? 0xffffff, p.intensity ?? 1, p.distance ?? 0, p.decay ?? 2);
      break;
    case 'spotLight':
      object = new THREE.SpotLight(p.color ?? 0xffffff, p.intensity ?? 1, p.distance ?? 0,
        p.angle !== undefined ? THREE.MathUtils.degToRad(p.angle) : Math.PI / 3, p.penumbra ?? 0, p.decay ?? 2);
      break;
    case 'camera':
      object = new THREE.PerspectiveCamera(p.fov ?? 75, p.aspect ?? window.innerWidth / window.innerHeight, p.near ?? 0.1, p.far ?? 1000);
      break;
    default:
      throw new Error(`Unsupported scene object type: ${record.type}`);
  }
  object.position.fromArray(p.position ?? [0, 0, 0]);
  object.name = record.name;
  object.visible = p.visible !== false;
  object.userData.className = p.className ?? '';
  object.userData.tags = p.tags ?? [];
  const rotation = p.rotation ?? [0, 0, 0];
  object.rotation.set(...rotation.map(THREE.MathUtils.degToRad) as [number, number, number]);
  object.scale.fromArray(p.scale ?? [1, 1, 1]);
  object.castShadow = p.castShadow !== false;
  object.receiveShadow = p.receiveShadow === true;
  await applyMaterialProperties(object, p);
  return { ...record, object };
}
