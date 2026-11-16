// Deterministic in-memory mock of the subset of three.js used by three-render-objects.
// Texture loads never touch the network: they are recorded in `pendingTextureLoads`
// and completed manually via `resolveTextureLoad` / `rejectTextureLoad`.

export const pendingTextureLoads = [];

export function resolveTextureLoad(entry, texture = entry.texture) {
  entry.settled = true;
  entry.onLoad(texture);
}

export function rejectTextureLoad(entry, err = new Error(`mock texture load failure: ${entry.url}`)) {
  entry.settled = true;
  entry.onError(err);
}

export class TextureLoader {
  load(url, onLoad, onProgress, onError) {
    const entry = { url, onLoad, onProgress, onError, settled: false, texture: new Texture(url) };
    pendingTextureLoads.push(entry);
    return entry.texture;
  }
}

export class Texture {
  constructor(name = 'mock-texture') {
    this.name = name;
    this.colorSpace = null;
    this.disposed = false;
  }
  dispose() {
    this.disposed = true;
  }
}

export class EventDispatcher {
  constructor() {
    this._listeners = {};
  }
  addEventListener(type, fn) {
    (this._listeners[type] ||= []).push(fn);
  }
  removeEventListener(type, fn) {
    this._listeners[type] = (this._listeners[type] || []).filter(cb => cb !== fn);
  }
  dispatchEvent(event) {
    (this._listeners[event.type] || []).forEach(fn => fn(event));
  }
}

export class Object3D extends EventDispatcher {
  constructor() {
    super();
    this.children = [];
    this.parent = null;
    this.visible = true;
    this.position = new Vector3();
    this.quaternion = new Quaternion();
    this.up = new Vector3(0, 1, 0);
    this.matrixWorld = {};
  }
  add(...objs) {
    objs.forEach(obj => {
      this.children.push(obj);
      obj.parent = this;
    });
    return this;
  }
  remove(...objs) {
    objs.forEach(obj => {
      const idx = this.children.indexOf(obj);
      if (idx !== -1) {
        this.children.splice(idx, 1);
        obj.parent = null;
      }
    });
    return this;
  }
  updateMatrixWorld() {}
  getWorldPosition(target) {
    return target.copy(this.position);
  }
  getWorldDirection(target) {
    return target.set(0, 0, -1);
  }
}

export class Scene extends Object3D {
  constructor() {
    super();
    this.visible = true;
  }
}

export class Mesh extends Object3D {
  constructor(geometry, material) {
    super();
    this.geometry = geometry;
    this.material = material;
  }
}

export class SphereGeometry {
  constructor(radius) {
    this.radius = radius;
    this.disposed = false;
  }
  dispose() {
    this.disposed = true;
  }
}

export class MeshBasicMaterial {
  constructor(opts = {}) {
    this.map = opts.map ?? null;
    this.side = opts.side;
    this.disposed = false;
  }
  dispose() {
    this.disposed = true;
  }
}

export class Color {
  constructor(value) {
    this.value = value;
  }
}

export class PerspectiveCamera extends Object3D {
  constructor() {
    super();
    this.fov = 50;
    this.aspect = 1;
    this.far = 2000;
    this.minDistance = 0;
    this.maxDistance = Infinity;
  }
  updateProjectionMatrix() {}
  setViewOffset() {}
  clearViewOffset() {}
  lookAt() {}
}

export class WebGLRenderer {
  constructor(config) {
    this.config = config;
    this.domElement = document.createElement('canvas');
    this.clearColor = null;
    this.clearAlpha = 1;
  }
  setPixelRatio() {}
  setSize() {}
  setClearColor(color, alpha) {
    this.clearColor = color;
    this.clearAlpha = alpha;
  }
  render() {}
  dispose() {
    this.disposed = true;
  }
}

export class Raycaster {
  constructor() {
    this.params = { Line: { threshold: 1 }, Points: { threshold: 1 } };
  }
  setFromCamera() {}
  intersectObjects() {
    return [];
  }
}

export class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
  set(x, y) {
    this.x = x;
    this.y = y;
    return this;
  }
}

export class Vector3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
  copy(v) {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }
  clone() {
    return new Vector3(this.x, this.y, this.z);
  }
  add(v) {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }
  sub(v) {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }
  multiplyScalar(s) {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }
  negate() {
    return this.multiplyScalar(-1);
  }
  dot(v) {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }
  crossVectors(a, b) {
    this.x = a.y * b.z - a.z * b.y;
    this.y = a.z * b.x - a.x * b.z;
    this.z = a.x * b.y - a.y * b.x;
    return this;
  }
  normalize() {
    return this;
  }
  distanceTo(v) {
    return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z);
  }
  applyQuaternion() {
    return this;
  }
}

export class Quaternion {}

export class Box3 {
  constructor() {
    this.min = new Vector3(Infinity, Infinity, Infinity);
    this.max = new Vector3(-Infinity, -Infinity, -Infinity);
  }
  expandByObject() {
    return this;
  }
}

export class Timer {
  update() {
    return this;
  }
  getDelta() {
    return 0;
  }
}

export const BackSide = 'back';
export const SRGBColorSpace = 'srgb-colorspace';
export const MOUSE = { ROTATE: 0, DOLLY: 1, PAN: 2 };
export const Spherical = class Spherical {};
