import * as THREE from 'three';
import { SceneObject } from '../types/editor';
import { InputManager } from './InputManager';

export function advanceCharacterControllers(
  objects: SceneObject[],
  inputManager: { isKeyPressed: (key: string) => boolean },
  three: typeof THREE,
  camera?: THREE.Camera
) {
    objects.forEach(obj => {
      if (!obj.properties.characterController?.enabled || !obj.object) return;

      const controller = obj.properties.characterController;
      const physics = obj.properties.physics;

      if (!physics) return;

      if (!physics.velocity) {
        physics.velocity = [0, 0, 0];
      }

      const moveDirection = new three.Vector3();
      let moved = false;

      if (inputManager.isKeyPressed('w') || inputManager.isKeyPressed('arrowup')) {
        moveDirection.z -= 1;
        moved = true;
      }
      if (inputManager.isKeyPressed('s') || inputManager.isKeyPressed('arrowdown')) {
        moveDirection.z += 1;
        moved = true;
      }
      if (inputManager.isKeyPressed('a') || inputManager.isKeyPressed('arrowleft')) {
        moveDirection.x -= 1;
        moved = true;
      }
      if (inputManager.isKeyPressed('d') || inputManager.isKeyPressed('arrowright')) {
        moveDirection.x += 1;
        moved = true;
      }

      if (moved) {
        moveDirection.normalize();

        if (camera) {
          const cameraDirection = new three.Vector3();
          camera.getWorldDirection(cameraDirection);
          cameraDirection.y = 0;
          cameraDirection.normalize();

          const cameraRight = new three.Vector3();
          cameraRight.crossVectors(cameraDirection, new three.Vector3(0, 1, 0));

          const worldMoveDirection = new three.Vector3();
          worldMoveDirection.addScaledVector(cameraDirection, -moveDirection.z);
          worldMoveDirection.addScaledVector(cameraRight, moveDirection.x);
          worldMoveDirection.normalize();

          physics.velocity[0] = worldMoveDirection.x * controller.speed;
          physics.velocity[2] = worldMoveDirection.z * controller.speed;
        } else {
          physics.velocity[0] = moveDirection.x * controller.speed;
          physics.velocity[2] = moveDirection.z * controller.speed;
        }
      } else {
        physics.velocity[0] *= 0.8;
        physics.velocity[2] *= 0.8;
      }

      if (
        controller.canJump &&
        controller.isGrounded &&
        (inputManager.isKeyPressed(' ') || inputManager.isKeyPressed('space'))
      ) {
        physics.velocity[1] = controller.jumpForce;
        controller.isGrounded = false;
      }
    });
}

export function createPlayerCamera(
  objects: SceneObject[],
  camera: THREE.Camera,
  canvas: HTMLCanvasElement,
  three: typeof THREE,
  reportError: (message: string) => void
) {
  const players = objects.filter(item => item.properties.characterController?.enabled &&
    ['fps', 'rpg'].includes(item.properties.characterController.mode ?? 'legacy'));
  if (players.length === 0) return null;
  if (players.length > 1) {
    reportError('Only one FPS/RPG player can control the camera in a scene.');
    return null;
  }
  const player = players[0];
  const controller = player.properties.characterController!;
  if (!player.properties.physics?.enabled || player.properties.physics.isKinematic) {
    reportError(`${player.name}: FPS/RPG requires enabled, non-kinematic physics.`);
    return null;
  }
  const height = controller.cameraHeight ?? 1.5;
  const distance = controller.cameraDistance ?? 4;
  const sensitivity = controller.lookSensitivity ?? 0.002;
  if (![height, distance, sensitivity].every(Number.isFinite) || distance <= 0 || sensitivity <= 0) {
    reportError(`${player.name}: invalid player camera settings.`);
    return null;
  }
  const originalPosition = camera.position.clone();
  const originalQuaternion = camera.quaternion.clone();
  const initial = new three.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
  let yaw = initial.y;
  let pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, initial.x));
  const abort = new AbortController();
  canvas.addEventListener('click', () => {
    if (document.pointerLockElement === canvas) return;
    if (typeof canvas.requestPointerLock !== 'function') {
      reportError('Pointer lock is not available in this browser.');
      return;
    }
    const request = canvas.requestPointerLock();
    if (request) void request.catch(error => {
      if (!abort.signal.aborted) reportError(`Pointer lock: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, { signal: abort.signal });
  window.addEventListener('mousemove', event => {
    if (document.pointerLockElement !== canvas) return;
    yaw -= event.movementX * sensitivity;
    pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch - event.movementY * sensitivity));
  }, { signal: abort.signal });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.pointerLockElement === canvas) document.exitPointerLock();
  }, { signal: abort.signal });
  function update() {
    const target = player.object.getWorldPosition(new three.Vector3()).add(new three.Vector3(0, height, 0));
    camera.quaternion.setFromEuler(new three.Euler(pitch, yaw, 0, 'YXZ'));
    camera.position.copy(target);
    if (controller.mode === 'rpg') {
      camera.position.add(new three.Vector3(0, 0, distance).applyQuaternion(camera.quaternion));
    }
    camera.updateMatrixWorld();
  }
  update();
  return {
    update,
    stop() {
      abort.abort();
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      camera.position.copy(originalPosition);
      camera.quaternion.copy(originalQuaternion);
      camera.updateMatrixWorld();
    }
  };
}

export class CharacterControllerSystem {
  constructor(private inputManager: InputManager) {}

  update(objects: SceneObject[], camera?: THREE.Camera) {
    advanceCharacterControllers(objects, this.inputManager, THREE, camera);
  }
}
