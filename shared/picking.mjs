// Exact per-instance picking for the city's single InstancedMesh.
//
// Why a dedicated module instead of R3F's synthetic click:
//
//  * R3F owns one global Raycaster with default near=0 / far=Infinity. The
//    scene camera is created with near=2 / far=12000, so a pick should honour
//    the same clipping range a pixel is drawn with — otherwise a tower that
//    is clipped away could still intercept a ray, or (if the camera ever
//    tightens its planes) a visible one could refuse to be picked.
//  * The ray is cast at *release* against the camera state of that moment.
//    At low frame rates the world moves between press and release; picking at
//    the settled frame means "the tower under the cursor now", always.
//  * three's InstancedMesh.raycast tests the real transformed box of every
//    instance and reports its instanceId. Fog is only a fragment-shader blend
//    and "dead" is only a short dark shape — neither changes geometry, so
//    fogged and failed towers stay clickable while empty sky returns no hit.
//
// Everything here is plain three.js math (no WebGL/renderer), which is why the
// Node verification suite can exercise the real production picking path.
// Types live in ./picking.d.ts.

import * as THREE from "three";

const _ndc = new THREE.Vector2();
const _raycaster = new THREE.Raycaster();

/**
 * Convert a CSS-pixel client point inside `domElement` to clip space (-1..1).
 * Uses the element's own rect, exactly like the engine's pointer mapping, so
 * canvas offsets/scaling never skew the ray.
 */
export function clientToNDC(clientX, clientY, domElement, target = new THREE.Vector2()) {
  const rect = domElement.getBoundingClientRect();
  target.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  return target;
}

/**
 * Pick the closest visible instance of `mesh` under a client point.
 *
 * @param {THREE.InstancedMesh} mesh  towers, instance i === building i
 * @param {THREE.PerspectiveCamera} camera  already updated for this frame
 * @param {{clientX:number, clientY:number}} point  release position
 * @param {HTMLElement} domElement  canvas owning the pointer
 * @param {{near?:number, far?:number}} [clipping]  defaults to the camera's
 *        own near/far so ray clipping matches what is drawn
 * @returns {{instanceId:number, point:THREE.Vector3, distance:number} | null}
 */
export function pickInstance(mesh, camera, point, domElement, clipping) {
  if (!mesh || !camera || !domElement || !point) return null;

  clientToNDC(point.clientX, point.clientY, domElement, _ndc);

  // Align the ray's depth range with the camera planes. A point behind the
  // near plane or beyond the far plane is not pickable, matching the pixels.
  _raycaster.camera = camera;
  _raycaster.near = clipping?.near ?? camera.near;
  _raycaster.far = clipping?.far ?? camera.far;
  _raycaster.setFromCamera(_ndc, camera);

  // recursive=false: the InstancedMesh is a leaf, and three does the
  // per-instance box tests internally and stamps instanceId on each hit.
  const hits = _raycaster.intersectObject(mesh, false);
  if (hits.length === 0) return null;

  const hit = hits[0];
  if (hit.instanceId === undefined || hit.instanceId === null) return null;
  return {
    instanceId: hit.instanceId,
    point: hit.point.clone(),
    distance: hit.distance,
  };
}
