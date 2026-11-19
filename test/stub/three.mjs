// test/stub/three.mjs: the smallest stand-in for three.js that js/versus.js needs to import.
//
// versus.js is the 3D half of the match, and it only touches THREE.Vector3, Quaternion and Group directly (the
// real geometry lives behind the game object tests pass in). This stub lets the end-to-end test load the real
// Versus class and its real network glue, instead of a lookalike, while staying dependency-free.
// test/threeResolver.mjs makes `import ... from 'three'` resolve here.

export class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  normalize() { const l = Math.hypot(this.x, this.y, this.z) || 1; return this.multiplyScalar(1 / l); }
  length() { return Math.hypot(this.x, this.y, this.z); }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  distanceToSquared(v) { const x = this.x - v.x, y = this.y - v.y, z = this.z - v.z; return x * x + y * y + z * z; }
  distanceTo(v) { return Math.sqrt(this.distanceToSquared(v)); }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  cross() { return new Vector3(); }
  applyQuaternion() { return this; }
  lerp() { return this; }
}

export class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  setFromAxisAngle() { return this; }
  setFromEuler() { return this; }
  slerp() { return this; }
  set() { return this; }
}

export class Group {
  constructor() { this.position = new Vector3(); this.quaternion = new Quaternion(); this.visible = true; this.children = []; }
  add() {} remove() {}
}
export class Mesh extends Group {}
export class Matrix4 { constructor() { this.elements = []; } }
export class Euler { constructor() {} }
export class Color { constructor() {} }
export class BufferGeometry { dispose() {} setAttribute() { return this; } setIndex() { return this; } computeVertexNormals() {} }
export class Float32BufferAttribute { constructor() {} }
export class InstancedMesh extends Group { setMatrixAt() {} setColorAt() {} }
export class ConeGeometry { constructor() {} }
export class CylinderGeometry { constructor() {} }
export class SphereGeometry { constructor() {} }
export class BoxGeometry { constructor() {} }
export class PlaneGeometry { constructor() {} }
export class CircleGeometry { constructor() {} }
export class MeshLambertMaterial { constructor() {} }
export class MeshBasicMaterial { constructor() {} }
export class PointsMaterial { constructor() {} }
export class Points { constructor() { this.position = new Vector3(); } }
export class CanvasTexture { constructor() {} }
