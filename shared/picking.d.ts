import type * as THREE from "three";

/** Map a CSS-pixel client point inside `domElement` to clip space (-1..1). */
export function clientToNDC(
  clientX: number,
  clientY: number,
  domElement: HTMLElement,
  target?: THREE.Vector2,
): THREE.Vector2;

export interface PickResult {
  /** instance index in the InstancedMesh — equals the building index */
  instanceId: number;
  point: THREE.Vector3;
  distance: number;
}

/**
 * Closest visible instance under a client point, raycast with a depth range
 * aligned to the camera's near/far planes. Returns null on empty sky.
 */
export function pickInstance(
  mesh: THREE.InstancedMesh,
  camera: THREE.PerspectiveCamera,
  point: { clientX: number; clientY: number },
  domElement: HTMLElement,
  clipping?: { near?: number; far?: number },
): PickResult | null;
