import * as THREE from 'three';
import { SceneObject } from '../types/editor';

export function getPhysicsBounds(obj: SceneObject, three: typeof THREE) {
  obj.object.updateWorldMatrix(true, true);
  const collider = obj.properties.physics?.collider;
  if (!collider) return new three.Box3().setFromObject(obj.object);
  const size = collider.size;
  if (!['box', 'sphere', 'cylinder'].includes(collider.type) || !Array.isArray(size) || size.length !== 3 ||
      size.some(value => !Number.isFinite(value) || value <= 0)) {
    throw new Error(`${obj.name}: collider must have positive dimensions`);
  }
  const half = new three.Vector3(size[0] / 2, size[1] / 2, size[2] / 2);
  return new three.Box3(half.clone().negate(), half).applyMatrix4(obj.object.matrixWorld);
}

export function advancePhysics(
  objects: SceneObject[],
  deltaTime: number,
  gravity: number,
  three: typeof THREE,
  getBounds: typeof getPhysicsBounds = getPhysicsBounds,
  onCollision?: (a: SceneObject, b: SceneObject) => void
) {
  const previousBounds = new Map<string, THREE.Box3>();

  for (const obj of objects) {
    const physics = obj.properties.physics;
    if (!physics?.enabled || !obj.object) continue;

    if (!physics.velocity) physics.velocity = [0, 0, 0];
    if (!physics.acceleration) physics.acceleration = [0, 0, 0];
    obj.object.updateWorldMatrix(true, true);
    previousBounds.set(obj.id, getBounds(obj, three));
    if (obj.properties.characterController) {
      obj.properties.characterController.isGrounded = false;
    }

    if (physics.isKinematic) continue;
    if (physics.useGravity) physics.acceleration[1] = gravity;
    const damping = Math.exp(-Math.max(0, physics.linearDamping ?? 0) * deltaTime);
    for (let axis = 0; axis < 3; axis++) {
      physics.velocity[axis] = (physics.velocity[axis] + physics.acceleration[axis] * deltaTime) * damping;
    }
    obj.object.position.addScaledVector(new three.Vector3().fromArray(physics.velocity), deltaTime);
    obj.object.updateWorldMatrix(true, true);

    const bounds = getBounds(obj, three);
    if (!physics.isTrigger && !bounds.isEmpty() && bounds.min.y <= 0 && physics.velocity[1] <= 0) {
      obj.object.position.y -= bounds.min.y;
      physics.velocity[1] = 0;
      if (obj.properties.characterController) obj.properties.characterController.isGrounded = true;
    }
  }

  for (let i = 0; i < objects.length; i++) {
    for (let j = i + 1; j < objects.length; j++) {
      const a = objects[i];
      const b = objects[j];
      const physicsA = a.properties.physics;
      const physicsB = b.properties.physics;
      if (!physicsA?.enabled || !physicsB?.enabled || !a.object || !b.object ||
          physicsA.isTrigger || physicsB.isTrigger) continue;

      a.object.updateWorldMatrix(true, true);
      b.object.updateWorldMatrix(true, true);
      const boxA = getBounds(a, three);
      const boxB = getBounds(b, three);
      if (boxA.isEmpty() || boxB.isEmpty() || !boxA.intersectsBox(boxB)) continue;
      onCollision?.(a, b);
      if (physicsA.isKinematic && physicsB.isKinematic) continue;

      const prevA = previousBounds.get(a.id);
      const prevB = previousBounds.get(b.id);
      const landedA = !physicsA.isKinematic && prevA && prevB &&
        prevA.min.y >= prevB.max.y - 0.001 && physicsA.velocity[1] <= physicsB.velocity[1];
      const landedB = !physicsB.isKinematic && prevA && prevB &&
        prevB.min.y >= prevA.max.y - 0.001 && physicsB.velocity[1] <= physicsA.velocity[1];
      const hitUndersideA = !physicsA.isKinematic && prevA && prevB &&
        prevA.max.y <= prevB.min.y + 0.001 && physicsA.velocity[1] > physicsB.velocity[1];
      const hitUndersideB = !physicsB.isKinematic && prevA && prevB &&
        prevB.max.y <= prevA.min.y + 0.001 && physicsB.velocity[1] > physicsA.velocity[1];

      if (landedA) {
        a.object.position.y += boxB.max.y - boxA.min.y;
        physicsA.velocity[1] = physicsB.isKinematic ? 0 : Math.max(0, physicsB.velocity[1]);
        if (a.properties.characterController) a.properties.characterController.isGrounded = true;
        continue;
      }
      if (landedB) {
        b.object.position.y += boxA.max.y - boxB.min.y;
        physicsB.velocity[1] = physicsA.isKinematic ? 0 : Math.max(0, physicsA.velocity[1]);
        if (b.properties.characterController) b.properties.characterController.isGrounded = true;
        continue;
      }
      if (hitUndersideA) {
        a.object.position.y -= boxA.max.y - boxB.min.y;
        physicsA.velocity[1] = Math.min(0, physicsB.velocity[1]);
        continue;
      }
      if (hitUndersideB) {
        b.object.position.y -= boxB.max.y - boxA.min.y;
        physicsB.velocity[1] = Math.min(0, physicsA.velocity[1]);
        continue;
      }

      const centerA = boxA.getCenter(new three.Vector3());
      const centerB = boxB.getCenter(new three.Vector3());
      const overlaps = [
        Math.min(boxA.max.x - boxB.min.x, boxB.max.x - boxA.min.x),
        Math.min(boxA.max.y - boxB.min.y, boxB.max.y - boxA.min.y),
        Math.min(boxA.max.z - boxB.min.z, boxB.max.z - boxA.min.z),
      ];
      const axis = overlaps.indexOf(Math.min(...overlaps));
      const component = (['x', 'y', 'z'] as const)[axis];
      const direction = centerA[component] < centerB[component] ? -1 : 1;
      const shareA = physicsA.isKinematic ? 0 : physicsB.isKinematic ? 1 : 0.5;
      const shareB = physicsB.isKinematic ? 0 : physicsA.isKinematic ? 1 : 0.5;
      a.object.position[component] += direction * overlaps[axis] * shareA;
      b.object.position[component] -= direction * overlaps[axis] * shareB;
      if (shareA && physicsA.velocity[axis] * direction < 0) physicsA.velocity[axis] = 0;
      if (shareB && physicsB.velocity[axis] * direction > 0) physicsB.velocity[axis] = 0;
    }
  }

  for (const obj of objects) {
    if (obj.properties.physics?.enabled && obj.object) {
      obj.properties.position = [obj.object.position.x, obj.object.position.y, obj.object.position.z];
    }
  }
}

export function createCollisionSystem(
  notify: (id: string, method: 'collisionEnter' | 'collisionExit', other: THREE.Object3D) => void
) {
  let previous = new Map<string, [SceneObject, SceneObject]>();
  let current = new Map<string, [SceneObject, SceneObject]>();
  return {
    begin() { current = new Map(); },
    contact(a: SceneObject, b: SceneObject) {
      const key = JSON.stringify([a.id, b.id]);
      current.set(key, [a, b]);
      if (!previous.has(key)) {
        notify(a.id, 'collisionEnter', b.object);
        notify(b.id, 'collisionEnter', a.object);
      }
    },
    end() {
      for (const [key, [a, b]] of previous) {
        if (!current.has(key)) {
          notify(a.id, 'collisionExit', b.object);
          notify(b.id, 'collisionExit', a.object);
        }
      }
      previous = current;
    }
  };
}

export function createTriggerSystem(
  objects: SceneObject[],
  three: typeof THREE,
  notify: (id: string, method: 'triggerEnter' | 'triggerExit', other: THREE.Object3D) => void,
  getBounds: typeof getPhysicsBounds = getPhysicsBounds
) {
  let previous = new Map<string, [SceneObject, SceneObject]>();
  return {
    update() {
      const next = new Map<string, [SceneObject, SceneObject]>();
      for (let i = 0; i < objects.length; i++) {
        const a = objects[i];
        if (!a.properties.physics?.enabled) continue;
        for (let j = i + 1; j < objects.length; j++) {
          const b = objects[j];
          if (!b.properties.physics?.enabled || !(a.properties.physics.isTrigger || b.properties.physics.isTrigger)) continue;
          const boundsA = getBounds(a, three);
          const boundsB = getBounds(b, three);
          if (boundsA.isEmpty() || boundsB.isEmpty() || !boundsA.intersectsBox(boundsB)) continue;
          const key = JSON.stringify([a.id, b.id]);
          next.set(key, [a, b]);
          if (!previous.has(key)) {
            notify(a.id, 'triggerEnter', b.object);
            notify(b.id, 'triggerEnter', a.object);
          }
        }
      }
      for (const [key, [a, b]] of previous) {
        if (!next.has(key)) {
          notify(a.id, 'triggerExit', b.object);
          notify(b.id, 'triggerExit', a.object);
        }
      }
      previous = next;
    }
  };
}

export class PhysicsEngine {
  constructor(private gravity: number = -9.8) {}

  update(objects: SceneObject[], deltaTime: number, onCollision?: (a: SceneObject, b: SceneObject) => void) {
    advancePhysics(objects, deltaTime, this.gravity, THREE, getPhysicsBounds, onCollision);
  }

  setGravity(gravity: number) {
    this.gravity = gravity;
  }
}
