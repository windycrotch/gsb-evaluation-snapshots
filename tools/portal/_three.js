// Test shim for "three": the portal protocol tests never render, so every
// WebGL-facing class is an inert stub. Only the math helpers that module
// code actually calls carry real behavior.
export class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  applyMatrix4() { return this; }
  distanceTo() { return 0; }
}
export class Vector4 {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
}
export class Box3 {
  intersectBox() { return null; }
  clone() { return new Box3(); }
}
export class Sphere {}
export class Group {
  constructor() { this.name = ''; this.position = new Vector3(); this.rotation = {}; this.children = []; }
  add() {}
  updateMatrixWorld() {}
}
export class Mesh {}
export class BufferGeometry {
  setAttribute() { return this; }
}
export class Float32BufferAttribute {
  constructor(array, size) { this.array = array; this.itemSize = size; }
}
export class ShaderMaterial {
  constructor(options) { Object.assign(this, options); }
}
export class Color {}
export class TextureLoader {
  setCrossOrigin() { return this; }
  load(_src, onLoad, _onProgress, onError) { queueMicrotask(() => onError?.(new Error('no textures in tests'))); }
}
export const UniformsUtils = { clone: uniforms => structuredClone(uniforms) };
export const UniformsLib = { fog: { fogColor: {}, fogNear: {}, fogFar: {} } };
export const DoubleSide = 2;
export const AdditiveBlending = 2;
export const SRGBColorSpace = 'srgb';
export const MathUtils = {
  smoothstep(x, min, max) {
    if (x <= min) return 0;
    if (x >= max) return 1;
    const t = (x - min) / (max - min);
    return t * t * (3 - 2 * t);
  },
};
export default {
  Vector3, Vector4, Box3, Sphere, Group, Mesh, BufferGeometry, Float32BufferAttribute,
  ShaderMaterial, Color, TextureLoader, UniformsUtils, UniformsLib,
  DoubleSide, AdditiveBlending, SRGBColorSpace, MathUtils,
};
