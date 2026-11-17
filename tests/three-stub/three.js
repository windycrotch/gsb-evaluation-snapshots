// Minimal, dependency-free stand-in for the parts of the three.js API touched
// by the modules under test (reelMinigame.js + fishFactory.js). It is NOT a
// renderer: there is no WebGL, no DOM canvas and no network — just plain
// objects that record hierarchy and transforms so lifecycle logic can be
// asserted deterministically in Node or in a browser.
//
// Keep this in sync with the three.* usages in src/gameplay and src/fish.

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
  setScalar(s) {
    return this.set(s, s, s);
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
  addScaledVector(v, s) {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }
  sub(v) {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }
  subVectors(a, b) {
    this.x = a.x - b.x;
    this.y = a.y - b.y;
    this.z = a.z - b.z;
    return this;
  }
  multiplyScalar(s) {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }
  divideScalar(s) {
    return this.multiplyScalar(1 / s);
  }
  lerp(v, t) {
    this.x += (v.x - this.x) * t;
    this.y += (v.y - this.y) * t;
    this.z += (v.z - this.z) * t;
    return this;
  }
  lerpVectors(a, b, t) {
    this.copy(a).lerp(b, t);
    return this;
  }
  length() {
    return Math.hypot(this.x, this.y, this.z);
  }
  normalize() {
    const l = this.length() || 1;
    return this.divideScalar(l);
  }
}

export class Euler {
  constructor(x = 0, y = 0, z = 0, order = "XYZ") {
    this.x = x;
    this.y = y;
    this.z = z;
    this.order = order;
  }
  set(x, y, z, order = this.order) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.order = order;
    return this;
  }
  copy(e) {
    this.x = e.x;
    this.y = e.y;
    this.z = e.z;
    return this;
  }
}

let nextId = 1;

export class Object3D {
  constructor() {
    this.id = nextId++;
    this.uuid = `stub-object-${this.id}`;
    this.position = new Vector3();
    this.rotation = new Euler();
    this.scale = new Vector3(1, 1, 1);
    this.children = [];
    this.parent = null;
    this.visible = true;
    this.userData = {};
  }
  add(...objects) {
    for (const o of objects) {
      if (o.parent) o.parent.remove(o);
      o.parent = this;
      this.children.push(o);
    }
    return this;
  }
  remove(...objects) {
    for (const o of objects) {
      const i = this.children.indexOf(o);
      if (i >= 0) {
        this.children.splice(i, 1);
        o.parent = null;
      }
    }
    return this;
  }
  traverse(cb) {
    cb(this);
    for (const c of [...this.children]) c.traverse(cb);
    return this;
  }
}

export class Group extends Object3D {
  constructor() {
    super();
    this.type = "Group";
    this.isGroup = true;
  }
}

export class Mesh extends Object3D {
  constructor(geometry, material) {
    super();
    this.type = "Mesh";
    this.isMesh = true;
    this.geometry = geometry;
    this.material = material;
  }
}

class BufferGeometry {
  constructor() {
    this.attributes = {};
    this.userData = {};
  }
  setAttribute(name, attr) {
    this.attributes[name] = attr;
    return this;
  }
  computeVertexNormals() {}
  dispose() {}
}

class BufferAttribute {
  constructor(array, itemSize) {
    this.array = array;
    this.itemSize = itemSize;
    this.needsUpdate = false;
  }
}

export { BufferGeometry, BufferAttribute };

export class SphereGeometry extends BufferGeometry {
  constructor(...args) {
    super();
    this.type = "SphereGeometry";
    this.args = args;
  }
}

export class ConeGeometry extends BufferGeometry {
  constructor(...args) {
    super();
    this.type = "ConeGeometry";
    this.args = args;
  }
}

class Material {
  constructor(options = {}) {
    Object.assign(this, options);
    this.userData = {};
    this.isMaterial = true;
  }
  dispose() {}
}

export class MeshStandardMaterial extends Material {
  constructor(options) {
    super(options);
    this.type = "MeshStandardMaterial";
  }
}

export class Color {
  constructor(value) {
    this.r = 0;
    this.g = 0;
    this.b = 0;
    if (value !== undefined) this.set(value);
  }
  set(value) {
    if (typeof value === "number") {
      this.b = (value & 0xff) / 255;
      this.g = ((value >> 8) & 0xff) / 255;
      this.r = ((value >> 16) & 0xff) / 255;
    }
    return this;
  }
  setHex(hex) {
    return this.set(hex);
  }
  getHex() {
    return (
      (Math.round(this.r * 255) << 16) |
      (Math.round(this.g * 255) << 8) |
      Math.round(this.b * 255)
    );
  }
}

export const DoubleSide = 2;
export const FrontSide = 0;
