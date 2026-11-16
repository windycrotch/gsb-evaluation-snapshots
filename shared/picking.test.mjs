// Local verification for the city's instanced picking and tap/drag gesture.
//
// Runs with the Node built-in test runner and zero extra dependencies:
//
//     node --test shared/
//
// It drives the exact production modules (shared/picking.mjs and
// shared/gestures.mjs) against a hand-crafted small layout containing:
//
//   0  DEAD SHORT TOWER  – a failed blog: short (h≈12), dark, at the edge
//   1  TALL ACTIVE TOWER – a lively blog: the landmark height (h≈180)
//   2  MID TOWER         – an ordinary blog
//   3  FOGGED TOWER      – placed far enough that the scene fog fully covers
//                          it, proving fog is visual only and it stays pickable
//
// The checks pin the two real-world requirements: a pick still resolves to the
// correct instance id when the camera is wheeled very near or very far, and a
// pointer travel beyond the tap threshold is treated as a drag, never a select.
// Empty sky must never produce a hit.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { pickInstance, clientToNDC } from "./picking.mjs";
import { TapGesture, TAP_THRESHOLD } from "./gestures.mjs";

// ── hand-crafted layout (same fields the renderer puts in instanceMatrix) ──
// All towers sit on -z: the test cameras are at +z looking toward the origin,
// so -z is the half of the world in front of them.
const LAYOUT = [
  { id: 0, name: "dead-short", x: -40, z: -20, w: 9, d: 9, h: 12, dead: true, fogged: false },
  { id: 1, name: "tall-active", x: 0, z: 0, w: 12, d: 12, h: 180, dead: false, fogged: false },
  { id: 2, name: "mid", x: 45, z: -30, w: 11, d: 11, h: 70, dead: false, fogged: false },
  // off-axis and beyond the fog far plane, so its whole facade is fog-colour
  // without another tower standing on the same sight line
  { id: 3, name: "fogged-far", x: -180, z: -330, w: 10, d: 10, h: 40, dead: false, fogged: true },
];

// production fog range for the test city (mirrors CityScene's reach-based fog)
const FOG_NEAR = 120;
const FOG_FAR = 260;
const CAM_NEAR = 2;
const CAM_FAR = 12000;

// A stand-in for the canvas: picking only needs getBoundingClientRect. The
// 800×600 box maps the centre client point to NDC (0,0).
const domElement = {
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600 };
  },
};

function buildInstancedMesh(layout) {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.translate(0, 0.5, 0);
  const material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.InstancedMesh(geometry, material, layout.length);
  const matrix = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  layout.forEach((b, i) => {
    pos.set(b.x, 0, b.z);
    scale.set(b.w, b.h, b.d);
    matrix.compose(pos, quat, scale);
    mesh.setMatrixAt(i, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  // the renderer calls this after writing matrices; the raycast guard sphere
  // and tests both rely on it reflecting every instance.
  mesh.computeBoundingSphere();
  return mesh;
}

function makeCamera(position, look = new THREE.Vector3(0, 15, 0)) {
  const camera = new THREE.PerspectiveCamera(42, 800 / 600, CAM_NEAR, CAM_FAR);
  camera.position.copy(position);
  camera.lookAt(look);
  camera.updateMatrixWorld(true);
  return camera;
}

// A camera wheeled close to a specific tower: it stands ~95 units away and
// looks at that tower, the way the in-app focus flight frames a selection.
function nearCameraFor(building) {
  const look = new THREE.Vector3(building.x, building.h * 0.5, building.z);
  const position = new THREE.Vector3(
    building.x,
    building.h * 0.5 + 45,
    building.z + 95,
  );
  return makeCamera(position, look);
}

// The camera pulled out to roughly the OrbitControls maxDistance; one shared
// vantage covers the whole small layout.
function farCamera() {
  return makeCamera(new THREE.Vector3(0, 320, 620), new THREE.Vector3(0, 20, -120));
}

// Project a world point into the client coordinates that sit under it. This is
// the inverse of clientToNDC and gives us a client point guaranteed to aim the
// ray at a chosen tower instead of hand-picking fragile pixel coordinates.
function clientPointFor(worldPoint, camera) {
  const ndc = worldPoint.clone().project(camera);
  return {
    clientX: (ndc.x + 1) * 400,
    clientY: (1 - ndc.y) * 300,
  };
}

// Pick a specific tower through the full production path and return the hit.
function pickAtTower(mesh, camera, building, heightFraction = 0.5) {
  const aim = new THREE.Vector3(building.x, building.h * heightFraction, building.z);
  const point = clientPointFor(aim, camera);
  return pickInstance(mesh, camera, point, domElement);
}

const mesh = buildInstancedMesh(LAYOUT);

// ── 1. near camera: wheel zoomed right up against the city ──────────────────
test("near camera: each tower under the cursor returns its own instance id", () => {
  for (const building of LAYOUT) {
    const camera = nearCameraFor(building);
    const hit = pickAtTower(mesh, camera, building);
    assert.ok(hit, `tower "${building.name}" should be hit at close range`);
    assert.equal(hit.instanceId, building.id, `instance id must match "${building.name}"`);
  }

  // the landmark and the dead short tower are close together on screen; aim at
  // the dead tower's own facade and make sure the tall one never steals it
  const deadCamera = nearCameraFor(LAYOUT[0]);
  const deadHit = pickAtTower(mesh, deadCamera, LAYOUT[0], 0.4);
  assert.equal(deadHit.instanceId, 0, "the failed short tower is independently selectable");
});

// ── 2. far camera: wheel pulled out to the zoom limit ───────────────────────
test("far camera: tiny on-screen towers still resolve to the correct instance", () => {
  const camera = farCamera();

  for (const building of LAYOUT) {
    const hit = pickAtTower(mesh, camera, building);
    assert.ok(hit, `tower "${building.name}" should still be hit when zoomed out`);
    assert.equal(hit.instanceId, building.id, `instance id must still match "${building.name}"`);
  }
});

// ── 3. fog does not affect geometry: the fully fogged tower stays clickable ─
test("fogged and dead towers remain pickable even though fog hides them", () => {
  // sanity: the fogged tower really is beyond the fog far plane from a normal
  // vantage...
  const fogged = LAYOUT[3];
  const vantage = new THREE.Vector3(0, 60, 95);
  const eyeToTower = vantage.distanceTo(new THREE.Vector3(fogged.x, fogged.h / 2, fogged.z));
  assert.ok(eyeToTower > FOG_FAR, "fixture assumption: the fogged tower is past fog far");
  assert.ok(FOG_FAR > FOG_NEAR, "fixture assumption: fog range is well-formed");

  // ...yet the exact per-instance box test still returns it (fog is a shader
  // blend, not a raycast filter). The dead short tower is likewise pickable.
  const fogCamera = nearCameraFor(fogged);
  assert.equal(pickAtTower(mesh, fogCamera, fogged).instanceId, 3);
  assert.equal(pickAtTower(mesh, nearCameraFor(LAYOUT[0]), LAYOUT[0]).instanceId, 0);
});

// ── 4. empty sky never produces a hit (no bounding-sphere false positive) ───
test("rays aimed at empty sky return null instead of a stray instance", () => {
  const near = nearCameraFor(LAYOUT[1]);
  const far = farCamera();

  for (const camera of [near, far]) {
    // a point high above every roofline, reprojected through the same camera
    const skyWorld = new THREE.Vector3(0, 4000, 0);
    const skyClient = clientPointFor(skyWorld, camera);
    assert.equal(pickInstance(mesh, camera, skyClient, domElement), null);

    // NDC corner: definitely off the city footprint
    const corner = { clientX: 12, clientY: 12 };
    assert.equal(pickInstance(mesh, camera, corner, domElement), null);
  }
});

// ── 5. a drag past the threshold must never become a selection ──────────────
test("pointer travel beyond the tap threshold is a drag and selects nothing", () => {
  const camera = nearCameraFor(LAYOUT[1]);
  const gesture = new TapGesture();
  let selections = 0;

  // press on the tall tower, then drag (low-FPS pan/orbit) well past 8px and
  // release somewhere over the mid tower — the release ray is never even cast
  const down = { clientX: 400, clientY: 300, button: 0 };
  gesture.begin(down, 1);
  // a single coarse move, as happens when frames drop between events
  gesture.move({ clientX: 400 + TAP_THRESHOLD + 27, clientY: 300 + 14 });
  assert.equal(gesture.isDragging, true, "the gesture must latch into drag mode");

  const release = gesture.end({ clientX: 400 + TAP_THRESHOLD + 27, clientY: 300 + 14 }, 1);
  assert.equal(release, null, "a drag yields no tap release, so no picking occurs");

  // mirror the bridge: it only raycasts when end() hands back a release point
  if (release) {
    const hit = pickInstance(mesh, camera, release, domElement);
    if (hit) selections += 1;
  }
  assert.equal(selections, 0, "no tower may be selected at the end of a drag");
});

// ── 6. control case: a stationary press/release is a tap and does select ────
test("a stationary tap on a tower resolves through the same release path", () => {
  const camera = nearCameraFor(LAYOUT[1]);
  const gesture = new TapGesture();

  const client = clientPointFor(new THREE.Vector3(LAYOUT[1].x, LAYOUT[1].h / 2, LAYOUT[1].z), camera);
  gesture.begin({ ...client, button: 0 }, 2);
  const release = gesture.end({ ...client }, 2);
  assert.ok(release, "a press that never moves is a tap");

  const hit = pickInstance(mesh, camera, release, domElement);
  assert.ok(hit);
  assert.equal(hit.instanceId, 1, "the tap selects the tall active tower under the cursor");
});

// ── 7. non-primary buttons (right orbit / middle dolly) never select ───────
test("right-button and middle-button presses are ignored by the gesture", () => {
  const gesture = new TapGesture();
  assert.equal(gesture.begin({ clientX: 10, clientY: 10, button: 2 }, 3), false);
  assert.equal(gesture.end({ clientX: 10, clientY: 10 }, 3), null);

  gesture.begin({ clientX: 10, clientY: 10, button: 1 }, 4);
  assert.equal(gesture.end({ clientX: 10, clientY: 10 }, 4), null);
});

// ── 8. NDC mapping honours the canvas rect (offset/scaling safe) ────────────
test("clientToNDC maps rect edges to clip space", () => {
  const ndc = clientToNDC(0, 0, domElement);
  assert.deepEqual([ndc.x, ndc.y], [-1, 1]);
  const centre = clientToNDC(800, 600, domElement);
  assert.deepEqual([centre.x, centre.y], [1, -1]);
});

// ── 8b. a release outside the canvas still closes the gesture safely ───────
test("a release far outside the canvas settles as a non-selecting drag", () => {
  const gesture = new TapGesture();
  gesture.begin({ clientX: 100, clientY: 100, button: 0 }, 7);
  // the pointer flings off the canvas before coming up; no element pointerup
  // fires, so the window safety net calls end() with a far-away coordinate
  const release = gesture.end({ clientX: 240, clientY: 320 }, 7);
  assert.equal(release, null, "the outside release cannot select anything");
  assert.equal(gesture.isDown, false, "the gesture is settled, not stuck open");
});

test("pointercancel and blur abandon the gesture without selecting", () => {
  const gesture = new TapGesture();
  gesture.begin({ clientX: 10, clientY: 10, button: 0 }, 8);
  gesture.cancel();
  assert.equal(gesture.isDown, false);
  assert.equal(gesture.end({ clientX: 10, clientY: 10 }, 8), null);
});

test("a second pointer cannot hijack an in-flight gesture (pinch safety)", () => {
  const gesture = new TapGesture();
  gesture.begin({ clientX: 10, clientY: 10, button: 0 }, 9);
  // second finger down, then the first finger releases as a clean tap
  assert.equal(gesture.begin({ clientX: 20, clientY: 20, button: 0 }, 10), false);
  const release = gesture.end({ clientX: 10, clientY: 10 }, 9);
  assert.ok(release, "the first pointer still owns the gesture");
});

// ── 9. ray clipping matches the camera planes ───────────────────────────────
test("a tower beyond the configured far plane is not picked (clipping parity)", () => {
  // aim at the mid tower, whose sight line from the camera crosses no other
  // instance, then tighten the pick far plane in front of it: the ray must be
  // cut exactly as the renderer would cut the geometry
  const camera = nearCameraFor(LAYOUT[2]);
  const mid = LAYOUT[2];
  const midPoint = clientPointFor(new THREE.Vector3(mid.x, mid.h / 2, mid.z), camera);

  const visible = pickInstance(mesh, camera, midPoint, domElement);
  assert.ok(visible && visible.instanceId === 2, "fixture: the mid tower is normally picked");
  const midDistance = visible.distance;

  const clipped = pickInstance(mesh, camera, midPoint, domElement, {
    near: CAM_NEAR,
    far: midDistance * 0.5,
  });
  assert.equal(clipped, null, "a clipped-away tower cannot intercept the pick ray");

  // and a near plane pushed past it rejects it too (wheel pushed very close)
  const behindNear = pickInstance(mesh, camera, midPoint, domElement, {
    near: midDistance * 1.5,
    far: CAM_FAR,
  });
  assert.equal(behindNear, null, "a tower inside the near plane is not picked either");
});
