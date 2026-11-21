import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SceneObject } from '../types/editor';

const loader = new GLTFLoader();

export async function loadGLBModel(data: string): Promise<THREE.Group> {
  const gltf = await loader.loadAsync(data);
  gltf.scene.animations = gltf.animations;
  gltf.scene.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  return gltf.scene;
}

export function createSceneObjectFromModel(model: THREE.Group, name: string, data: string): SceneObject {
  const boundingBox = new THREE.Box3().setFromObject(model);
  const center = boundingBox.getCenter(new THREE.Vector3());
  const size = boundingBox.getSize(new THREE.Vector3());

  model.position.sub(center);

  const maxDim = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(maxDim) || maxDim <= 0) throw new Error('Model has no visible geometry');
  const scale = 2 / maxDim;
  const root = new THREE.Group();
  root.add(model);
  root.animations = model.animations;
  root.scale.setScalar(scale);

  return {
    id: `model-${crypto.randomUUID()}`,
    name,
    type: 'model',
    object: root,
    properties: {
      modelData: data,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [scale, scale, scale],
      castShadow: true,
      receiveShadow: true,
      physics: {
        enabled: false,
        mass: 1,
        velocity: [0, 0, 0],
        acceleration: [0, 0, 0],
        useGravity: false,
        isKinematic: false
      }
    }
  };
}
