// test/three.stub.mjs: a minimal stand-in for the three.js module, just enough for the game logic modules
// (coop.js, versus.js and their imports) to load and run headless. Vector3/Quaternion are real (the net code
// does actual math with them); everything render-related is a generic inert object.

export class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  setScalar(s) { this.x = this.y = this.z = s; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  distanceToSquared(v) { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return dx * dx + dy * dy + dz * dz; }
  normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  cross(v) { return this.set(this.y * v.z - this.z * v.y, this.z * v.x - this.x * v.z, this.x * v.y - this.y * v.x); }
  lerp(v, t) { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this; }
  negate() { return this.multiplyScalar(-1); }
  applyQuaternion() { return this; }                      // direction math is not under test
  toArray() { return [this.x, this.y, this.z]; }
  fromArray(a) { this.x = a[0]; this.y = a[1]; this.z = a[2]; return this; }
}

export class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
  clone() { return new Quaternion(this.x, this.y, this.z, this.w); }
  setFromAxisAngle(axis, angle) {
    const h = angle / 2, s = Math.sin(h);
    this.x = axis.x * s; this.y = axis.y * s; this.z = axis.z * s; this.w = Math.cos(h);
    return this;
  }
  setFromEuler() { return this; }
  slerp(q, t) { this.x += (q.x - this.x) * t; this.y += (q.y - this.y) * t; this.z += (q.z - this.z) * t; this.w += (q.w - this.w) * t; return this; }
  multiply() { return this; }
}

class Inert {
  constructor() {
    this.children = [];
    this.position = new Vector3();
    this.quaternion = new Quaternion();
    this.scale = new Vector3(1, 1, 1);
    this.up = new Vector3(0, 1, 0);
    this.visible = true;
    this.rotation = { x: 0, y: 0, z: 0, set() {} };
  }
  add(...o) { this.children.push(...o); return this; }
  remove(...o) { for (const c of o) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); } return this; }
  traverse(cb) { cb(this); for (const c of this.children) if (c && c.traverse) c.traverse(cb); }
  clone() { return new Inert(); }
  lookAt() {} updateMatrixWorld() {} updateProjectionMatrix() {}
  dispose() {} render() {} setSize() {} setPixelRatio() {}
}

export class Object3D extends Inert {}
export class Group extends Inert {}
export class Scene extends Inert {}
export class Mesh extends Inert {}
export class InstancedMesh extends Inert {}
export class Line extends Inert {}
export class LineSegments extends Inert {}
export class Points extends Inert {}
export class Sprite extends Inert {}
export class PerspectiveCamera extends Inert {}
export class HemisphereLight extends Inert {}
export class DirectionalLight extends Inert {}
export class AmbientLight extends Inert {}
export class PointLight extends Inert {}
export class Matrix4 extends Inert { compose() { return this; } identity() { return this; } }
export class Euler extends Inert {}
export class Vector2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } set(x, y) { this.x = x; this.y = y; return this; } }
export class Color { constructor(c) { this.c = c; } set(c) { this.c = c; return this; } clone() { return new Color(this.c); } copy(c) { this.c = c.c; return this; } }
export class Fog extends Inert {}
export class FogExp2 extends Inert {}
export class BoxGeometry extends Inert {}
export class SphereGeometry extends Inert {}
export class CylinderGeometry extends Inert {}
export class PlaneGeometry extends Inert {}
export class ConeGeometry extends Inert {}
export class RingGeometry extends Inert {}
export class CircleGeometry extends Inert {}
export class IcosahedronGeometry extends Inert {}
export class OctahedronGeometry extends Inert {}
export class BufferGeometry extends Inert { setAttribute() { return this; } setIndex() { return this; } }
export class BufferAttribute extends Inert {}
export class Float32BufferAttribute extends Inert {}
export class InstancedBufferAttribute extends Inert {}
export class MeshBasicMaterial extends Inert {}
export class MeshLambertMaterial extends Inert {}
export class MeshStandardMaterial extends Inert {}
export class MeshPhongMaterial extends Inert {}
export class LineBasicMaterial extends Inert {}
export class PointsMaterial extends Inert {}
export class SpriteMaterial extends Inert {}
export class ShaderMaterial extends Inert {}
export class CanvasTexture extends Inert {}
export class Texture extends Inert {}
export class Raycaster extends Inert {}
export class Plane extends Inert {}
export class Clock extends Inert { getDelta() { return 0; } }
export const MathUtils = { clamp: (v, a, b) => Math.max(a, Math.min(b, v)), lerp: (a, b, t) => a + (b - a) * t, degToRad: d => d * Math.PI / 180 };
export const DynamicDrawUsage = 35048;
export const AdditiveBlending = 2;
export const NormalBlending = 1;
export const DoubleSide = 2;
export const FrontSide = 0;
export const BackSide = 1;
export const SRGBColorSpace = 'srgb';
export const RepeatWrapping = 1000;
