import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { GlassStudio } from '~/utils/glassScene'
import { DEFAULT_GLASS_PARAMS } from '~/utils/presets'
import { deferred } from './helpers/mount'

// The shader package includes browser-only remote imports; exports do not instantiate it here.
vi.mock('@pmndrs/vanilla', () => ({ MeshTransmissionMaterial: class {} }))
const writer = vi.hoisted(() => ({ parse: vi.fn() }))
vi.mock('three/addons/exporters/GLTFExporter.js', () => ({ GLTFExporter: class { parseAsync = writer.parse } }))

beforeEach(() => { vi.stubGlobal('window', { devicePixelRatio: 1 }); writer.parse.mockReset() })
afterEach(() => vi.unstubAllGlobals())

it('owns GLB geometry and textures while asynchronous encoding is in progress', async () => {
  const encoding = deferred<ArrayBuffer>()
  const sourceGeometry = new THREE.BoxGeometry(10, 10, 10)
  const sourceTexture = new THREE.Texture()
  const mesh = new THREE.Mesh(sourceGeometry)
  let written: THREE.Mesh | undefined
  writer.parse.mockImplementation((group: THREE.Group) => {
    written = group.children[0] as THREE.Mesh
    return encoding.promise
  })
  // GPU calls are outside this test; snapshot ownership and real Three.js resources are exercised.
  const studio = Object.assign(Object.create(GlassStudio.prototype), {
    mesh, target: { ...DEFAULT_GLASS_PARAMS, finish: 'print' },
    print: { map: sourceTexture, normalMap: null, roughnessMap: null },
    snapParams() {}, ensurePrintTexture() {}, buildSurface() {},
  }) as GlassStudio
  const pending = studio.exportGLB()
  const sourcePositions = sourceGeometry.getAttribute('position')
  const before = sourcePositions.getX(0)
  sourcePositions.setX(0, 999)
  expect(written!.geometry.getAttribute('position').getX(0)).toBe(before)
  expect((written!.material as THREE.MeshPhysicalMaterial).map).not.toBe(sourceTexture)
  encoding.resolve(new ArrayBuffer(4))
  await pending
})

it('returns a non-empty GLB blob of the gltf-binary type when a model exists', async () => {
  writer.parse.mockResolvedValue(new ArrayBuffer(8))
  const studio = Object.assign(Object.create(GlassStudio.prototype), {
    mesh: new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10)),
    target: { ...DEFAULT_GLASS_PARAMS, finish: 'metal' },
    snapParams() {},
  }) as GlassStudio
  const blob = await studio.exportGLB()
  expect(blob).toBeInstanceOf(Blob)
  expect(blob.type).toBe('model/gltf-binary')
  expect(blob.size).toBeGreaterThan(0)
})

it('returns a non-empty STL blob of the stl type at true millimetre size', async () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 20, 30))
  // The pop animation's scale must not leak into the file.
  mesh.scale.setScalar(0.5)
  const studio = Object.assign(Object.create(GlassStudio.prototype), {
    mesh,
    target: { ...DEFAULT_GLASS_PARAMS },
    snapParams() {},
  }) as GlassStudio
  const blob = studio.exportSTL()
  expect(blob).toBeInstanceOf(Blob)
  expect(blob.type).toBe('model/stl')
  expect(blob.size).toBeGreaterThan(0)
  // Binary STL: 80-byte header, uint32 triangle count, then 50 bytes per triangle.
  const view = new DataView(await blob.arrayBuffer())
  const triangles = view.getUint32(80, true)
  expect(triangles).toBeGreaterThan(0)
  let max = 0
  for (let i = 0; i < triangles; i++)
    for (let f = 0; f < 12; f++) // skip the normal; read the 3 vertices' coordinates
      if (f >= 3) max = Math.max(max, Math.abs(view.getFloat32(84 + i * 50 + f * 4, true)))
  // The box is 30 mm deep; a pop-scaled export would read 15 here instead.
  expect(max).toBe(15)
})

it('throws a recognisable error from every export when there is no model', async () => {
  const studio = Object.assign(Object.create(GlassStudio.prototype), {
    mesh: null,
    target: { ...DEFAULT_GLASS_PARAMS },
    snapParams() {},
  }) as GlassStudio
  await expect(studio.exportGLB()).rejects.toThrow('Nothing to export')
  expect(() => studio.exportSTL()).toThrow('Nothing to export')
  await expect(studio.screenshot()).rejects.toThrow('Nothing to export')
})

it('restores viewport, pixel ratio and interaction state after a screenshot', async () => {
  let ratio = 1
  let resizes = 0
  const focus = { shift: 40, scale: 0.7 }
  const studio = Object.assign(Object.create(GlassStudio.prototype), {
    renderer: { getPixelRatio: () => ratio, setPixelRatio: (v: number) => { ratio = v } },
    canvas: { toBlob: (callback: BlobCallback) => callback(new Blob(['png'])) },
    focus, interacting: true, target: { ...DEFAULT_GLASS_PARAMS },
    mesh: new THREE.Mesh(new THREE.BoxGeometry()),
    snapParams() {}, resize() { resizes++ }, renderPasses() {},
  }) as GlassStudio
  const blob = await studio.screenshot()
  expect(blob.size).toBeGreaterThan(0)
  expect(ratio).toBe(1)
  expect((studio as unknown as { focus: unknown }).focus).toEqual(focus)
  expect((studio as unknown as { interacting: boolean }).interacting).toBe(true)
  // One resize for the high-resolution frame, one to restore the live viewport.
  expect(resizes).toBe(2)
})

it('restores capture settings before waiting for PNG encoding', async () => {
  let ratio = 1
  let encode!: BlobCallback
  const focus = { shift: 40, scale: 0.7 }
  const studio = Object.assign(Object.create(GlassStudio.prototype), {
    renderer: { getPixelRatio: () => ratio, setPixelRatio: (v: number) => { ratio = v } },
    canvas: { toBlob: (callback: BlobCallback) => { encode = callback } },
    focus, target: { ...DEFAULT_GLASS_PARAMS }, mesh: new THREE.Mesh(new THREE.BoxGeometry()),
    snapParams() {}, resize() {}, renderPasses() {},
  }) as GlassStudio
  const pending = studio.screenshot()
  expect(ratio).toBe(1)
  expect((studio as unknown as { focus: unknown }).focus).toEqual(focus)
  encode(new Blob(['png']))
  await pending
})

it('releases studio warm-up geometry when its lifetime ends during shader compilation', async () => {
  const lifetime = new AbortController()
  const compiling = deferred<void>()
  let released = false
  const renderer = {
    getRenderTarget: () => null, setRenderTarget() {},
    compileAsync(mesh: THREE.Mesh) {
      mesh.geometry.addEventListener('dispose', () => { released = true })
      return compiling.promise
    },
  }
  const studio = Object.assign(Object.create(GlassStudio.prototype), { renderer, lifetime }) as { warmUp(): Promise<void> }
  let settled = false
  void studio.warmUp().then(() => { settled = true })
  lifetime.abort()
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(settled).toBe(true)
  expect(released).toBe(true)
})
