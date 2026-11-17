import { SceneObject } from '../types/editor';

export class CodeGenerator {
  static generateThreeJSCode(objects: SceneObject[]): string {
    return `
import * as THREE from 'three';

// Create scene
const scene = new THREE.Scene();

// Create camera
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 5, 10);

// Create renderer
const renderer = new THREE.WebGLRenderer();
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

// Add ambient light
const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambientLight);

${objects.map(obj => this.generateObjectCode(obj)).join('\n')}

// Animation loop
function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}
animate();

// Handle window resize
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
`;
  }

  private static generateObjectCode(obj: SceneObject): string {
    switch (obj.type) {
      case 'box':
        return this.generateBoxCode(obj);
      case 'cylinder':
        return this.generateCylinderCode(obj);
      case 'pointLight':
        return this.generatePointLightCode(obj);
      case 'spotLight':
        return this.generateSpotLightCode(obj);
      case 'camera':
        return this.generateCameraCode(obj);
      default:
        return '';
    }
  }

  private static generateBoxCode(obj: SceneObject): string {
    return `
// Create box
const ${obj.id} = new THREE.Mesh(
  new THREE.BoxGeometry(),
  new THREE.MeshStandardMaterial({ color: 0x808080 })
);
${obj.id}.position.set(${obj.properties.position.join(', ')});
${obj.id}.rotation.set(${obj.properties.rotation.join(', ')});
${obj.id}.scale.set(${obj.properties.scale.join(', ')});
scene.add(${obj.id});`;
  }

  private static generateCylinderCode(obj: SceneObject): string {
    return `
// Create cylinder
const ${obj.id} = new THREE.Mesh(
  new THREE.CylinderGeometry(),
  new THREE.MeshStandardMaterial({ color: 0x808080 })
);
${obj.id}.position.set(${obj.properties.position.join(', ')});
${obj.id}.rotation.set(${obj.properties.rotation.join(', ')});
${obj.id}.scale.set(${obj.properties.scale.join(', ')});
scene.add(${obj.id});`;
  }

  private static generatePointLightCode(obj: SceneObject): string {
    return `
// Create point light
const ${obj.id} = new THREE.PointLight(
  '${obj.properties.color}',
  ${obj.properties.intensity}
);
${obj.id}.position.set(${obj.properties.position.join(', ')});
scene.add(${obj.id});`;
  }

  private static generateSpotLightCode(obj: SceneObject): string {
    return `
// Create spot light
const ${obj.id} = new THREE.SpotLight(
  '${obj.properties.color}',
  ${obj.properties.intensity}
);
${obj.id}.position.set(${obj.properties.position.join(', ')});
${obj.id}.angle = ${(obj.properties.angle ?? 60) * Math.PI / 180};
scene.add(${obj.id});`;
  }

  private static generateCameraCode(obj: SceneObject): string {
    return `
// Create camera
const ${obj.id} = new THREE.PerspectiveCamera(
  ${obj.properties.fov},
  window.innerWidth / window.innerHeight,
  ${obj.properties.near},
  ${obj.properties.far}
);
${obj.id}.position.set(${obj.properties.position.join(', ')});
${obj.id}.rotation.set(${obj.properties.rotation.join(', ')});
scene.add(${obj.id});`;
  }
}