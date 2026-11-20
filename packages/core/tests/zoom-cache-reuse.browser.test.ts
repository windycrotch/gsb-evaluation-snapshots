import { describe, expect, test } from 'vitest'
/**
 * Acceptance tests for the scene-cache *reuse* path staying correct
 * across the whole lifecycle of a zoom gesture. Every requirement from
 * the zoom-cache correctness brief is pinned here:
 *
 *   1. a normal small zoom-out hits the scaled-blit reuse tier (reuse
 *      must not be replaced by blanket full re-renders),
 *   2. a document edit (add / restyle / remove) committed mid-zoom
 *      shows up on the next present,
 *   3. a viewport-size OR device-pixel-ratio change mid-zoom never
 *      blits old-size pixels into the new backing store,
 *   4. when reuse is unusable — ratio cap exceeded OR the reuse layout
 *      is invalid — the paint falls back to a complete full re-render,
 *   5. leaving the zoom gesture re-rasterizes the scene crisp at the
 *      current camera,
 *   6. rapid zoom/pan alternation keeps the cache reference camera
 *      registered with the actual blit — no accumulating drift.
 *
 * Draw-path assertions use `renderer.getLastDrawPath()`; observable
 * correctness is pinned with pixel reads on the live static canvas.
 */
import { zoomAtScreenPoint } from '../src/camera'
import { createRenderer } from '../src/render'
import { createCanvasStore } from '../src/store'
import { type Node, asClientId, asNodeId } from '../src/types'

const makeCanvases = (w = 800, h = 600) => {
  const staticCanvas = document.createElement('canvas')
  const interactiveCanvas = document.createElement('canvas')
  staticCanvas.style.width = `${w}px`
  staticCanvas.style.height = `${h}px`
  interactiveCanvas.style.width = `${w}px`
  interactiveCanvas.style.height = `${h}px`
  document.body.appendChild(staticCanvas)
  document.body.appendChild(interactiveCanvas)
  return { staticCanvas, interactiveCanvas, w, h }
}

const cleanup = (...els: HTMLElement[]) => {
  for (const el of els) el.remove()
}

const waitFrame = (): Promise<void> =>
  new Promise(resolve => requestAnimationFrame(() => resolve()))

const settle = async (): Promise<void> => {
  await waitFrame()
  await waitFrame()
}

const rectNode = (id: string, overrides: Partial<Node> = {}): Node => ({
  id: asNodeId(id),
  type: 'rect',
  x: 100,
  y: 100,
  w: 200,
  h: 100,
  angle: 0,
  z: 0,
  groups: [],
  style: { backgroundColor: '#ff0000' },
  ...overrides,
})

const readPixel = (canvas: HTMLCanvasElement, x: number, y: number) => {
  const ctx = canvas.getContext('2d')!
  const dpr = canvas.width / Number.parseFloat(canvas.style.width || '1')
  const data = ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data
  return [data[0], data[1], data[2], data[3]] as const
}

const isRed = (rgba: readonly number[]): boolean => rgba[0]! > 150 && rgba[1]! < 80 && rgba[3]! > 0

const makeHarness = (w = 800, h = 600) => {
  const { staticCanvas, interactiveCanvas } = makeCanvases(w, h)
  const store = createCanvasStore({ clientId: asClientId('u-test') })
  const renderer = createRenderer({
    store,
    staticCanvas,
    interactiveCanvas,
    width: w,
    height: h,
    maxDpr: 1,
    background: { color: 'transparent' },
  })
  return { store, renderer, staticCanvas, interactiveCanvas }
}

describe('zoom cache-reuse correctness', () => {
  test('small zoom-out reuses the cache via the scaled tier (not full re-render)', async () => {
    const { store, renderer, staticCanvas, interactiveCanvas } = makeHarness()
    store.addNode(rectNode('n-1'))
    renderer.start()
    await settle()
    expect(renderer.getLastDrawPath()).toBe('full')

    store.setInteractionState({ mode: 'zooming' })
    const cam = store.getCamera()
    store.setCamera({ ...cam, z: cam.z * 0.9 })
    await settle()

    // Reuse fired — the frame was a scaled blit, not a full re-render.
    expect(renderer.getLastDrawPath()).toBe('scaled')
    // The node must still be observable at the position the new camera
    // maps it to (world (200,150) at z 0.9 → screen (180,135)).
    expect(isRed(readPixel(staticCanvas, 180, 135))).toBe(true)

    // A second in-cap zoom step keeps reusing rather than re-rasterizing.
    const cam2 = store.getCamera()
    store.setCamera({ ...cam2, z: cam2.z * 1.05 })
    await settle()
    expect(renderer.getLastDrawPath()).toBe('scaled')

    renderer.dispose()
    cleanup(staticCanvas, interactiveCanvas)
  })

  test('document edits committed mid-zoom are reflected by the next present', async () => {
    const { store, renderer, staticCanvas, interactiveCanvas } = makeHarness()
    store.addNode(rectNode('n-1'))
    renderer.start()
    await settle()

    // Begin a zoom gesture and take the scaled-blit reuse path once.
    store.setInteractionState({ mode: 'zooming' })
    let cam = store.getCamera()
    store.setCamera({ ...cam, z: cam.z * 1.1 })
    await settle()
    expect(renderer.getLastDrawPath()).toBe('scaled')

    // Commit a node ADD while still zooming. The stale cache must be
    // re-rasterized so the new content appears on the next frame.
    store.addNode(rectNode('n-2', { x: 400, y: 300, w: 120, h: 120 }))
    await settle()
    expect(renderer.getLastDrawPath()).toBe('full')
    // n-2's center in world = (460, 360); at z=1.1 → screen ≈ (506, 396).
    expect(isRed(readPixel(staticCanvas, 506, 396))).toBe(true)

    // After the forced rebuild, a further zoom step is allowed to reuse
    // again — and stays registered with the rebuilt reference camera.
    cam = store.getCamera()
    store.setCamera({ ...cam, z: cam.z * 1.05 })
    await settle()
    expect(renderer.getLastDrawPath()).toBe('scaled')
    const z1 = store.getCamera().z
    expect(isRed(readPixel(staticCanvas, Math.round(460 * z1), Math.round(360 * z1)))).toBe(true)

    // A restyle of n-1 mid-gesture must likewise force a fresh raster.
    store.updateNode(asNodeId('n-1'), { style: { backgroundColor: '#00ff00' } })
    await settle()
    expect(renderer.getLastDrawPath()).toBe('full')
    const restyled = readPixel(
      staticCanvas,
      Math.round(200 * store.getCamera().z),
      Math.round(150 * store.getCamera().z),
    )
    expect(restyled[1]!).toBeGreaterThan(150)
    expect(restyled[0]!).toBeLessThan(80)

    // And a removal must not keep painting the deleted node from cache.
    store.removeNode(asNodeId('n-2'))
    await settle()
    expect(renderer.getLastDrawPath()).toBe('full')
    const z2 = store.getCamera().z
    expect(isRed(readPixel(staticCanvas, Math.round(460 * z2), Math.round(360 * z2)))).toBe(false)

    renderer.dispose()
    cleanup(staticCanvas, interactiveCanvas)
  })

  test('viewport resize mid-zoom re-renders at the new size (no old-size blit)', async () => {
    const { store, renderer, staticCanvas, interactiveCanvas } = makeHarness()
    store.addNode(rectNode('n-1'))
    renderer.start()
    await settle()

    store.setInteractionState({ mode: 'zooming' })
    const cam = store.getCamera()
    store.setCamera({ ...cam, z: cam.z * 1.15 })
    await settle()
    expect(renderer.getLastDrawPath()).toBe('scaled')

    // Resize the viewport while the gesture is still active. Reusing the
    // old (800×600) cache pixels into the new (640×480) backing store is
    // forbidden — a full re-render at the new geometry is required.
    renderer.setSize(640, 480)
    await settle()
    expect(renderer.getLastDrawPath()).toBe('full')
    expect(staticCanvas.width).toBe(640)
    expect(staticCanvas.height).toBe(480)
    // Node center world (200,150) at z=1.15 → screen (230,172.5) must
    // still land inside the shrunken viewport, freshly rasterized.
    expect(isRed(readPixel(staticCanvas, 230, 173))).toBe(true)

    renderer.dispose()
    cleanup(staticCanvas, interactiveCanvas)
  })

  test('device-pixel-ratio change mid-zoom re-renders at the new DPR', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')!
    let rawDpr = 1
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      get: () => rawDpr,
    })
    try {
      const { staticCanvas, interactiveCanvas } = makeCanvases(800, 600)
      const store = createCanvasStore({ clientId: asClientId('u-test') })
      // No maxDpr → tiered cap of 2 at this CSS area, so raw dpr 1 and 2
      // both pass through unchanged.
      const renderer = createRenderer({
        store,
        staticCanvas,
        interactiveCanvas,
        width: 800,
        height: 600,
        background: { color: 'transparent' },
      })
      store.addNode(rectNode('n-1'))
      renderer.start()
      await settle()
      expect(staticCanvas.width).toBe(800)

      store.setInteractionState({ mode: 'zooming' })
      const cam = store.getCamera()
      store.setCamera({ ...cam, z: 1.2 })
      await settle()
      expect(renderer.getLastDrawPath()).toBe('scaled')

      // Emulate moving the window to a hi-DPI monitor.
      rawDpr = 2
      renderer.setSize(800, 600)
      await settle()
      expect(renderer.getLastDrawPath()).toBe('full')
      expect(staticCanvas.width).toBe(1600)
      expect(staticCanvas.height).toBe(1200)
      // World (200,150) at z 1.2 → css (240,180). readPixel applies the
      // canvas DPR internally, so pass CSS coordinates.
      expect(isRed(readPixel(staticCanvas, 240, 180))).toBe(true)

      // Reuse keeps working at the new DPR with correct device math.
      const cam2 = store.getCamera()
      store.setCamera({ ...cam2, z: 1.3 })
      await settle()
      expect(renderer.getLastDrawPath()).toBe('scaled')
      const z = store.getCamera().z
      expect(isRed(readPixel(staticCanvas, Math.round(200 * z), Math.round(150 * z)))).toBe(true)

      renderer.dispose()
      cleanup(staticCanvas, interactiveCanvas)
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', descriptor)
    }
  })

  test('ratio beyond the reuse cap falls back to a full, complete re-render', async () => {
    const { store, renderer, staticCanvas, interactiveCanvas } = makeHarness()
    store.addNode(rectNode('n-1'))
    renderer.start()
    await settle()

    // Zoom beyond the 4x scaled-blit cap while mode=zooming: every reuse
    // tier refuses and the frame comes from a full re-render.
    store.setInteractionState({ mode: 'zooming' })
    // Recenter so the node stays onscreen at the extreme zoom.
    store.setCamera({ x: 200 - 400 / 6, y: 150 - 300 / 6, z: 6 })
    await settle()
    expect(renderer.getLastDrawPath()).toBe('full')
    // Node center world (200,150) now lands at screen (400,300).
    expect(isRed(readPixel(staticCanvas, 400, 300))).toBe(true)

    // The fallback rebuilt a complete, reference-consistent cache, so a
    // subsequent in-cap step is permitted to reuse again.
    const cam2 = store.getCamera()
    store.setCamera({ ...cam2, z: cam2.z * 1.05 })
    await settle()
    expect(renderer.getLastDrawPath()).toBe('scaled')

    renderer.dispose()
    cleanup(staticCanvas, interactiveCanvas)
  })

  test('an invalid scaled-extend layout falls back to full, never a half cache', async () => {
    // A wide viewport makes a 0.85 zoom-out overflow the cache margin,
    // which is the only window the scaled-extend (tier 2.7) tier opens.
    const W = 3200
    const H = 2000
    const { staticCanvas, interactiveCanvas } = makeCanvases(W, H)
    const store = createCanvasStore({ clientId: asClientId('u-test') })
    const renderer = createRenderer({
      store,
      staticCanvas,
      interactiveCanvas,
      width: W,
      height: H,
      maxDpr: 1,
      background: { color: 'transparent' },
    })
    store.addNode(rectNode('n-1', { x: 0, y: 0, w: 80, h: 80 }))
    renderer.start()
    await settle()
    expect(renderer.getLastDrawPath()).toBe('full')

    // Mild zoom-out around an off-center anchor reaches scaled-extend.
    store.setInteractionState({ mode: 'zooming' })
    const next = zoomAtScreenPoint(store.getCamera(), store.getCamera().z * 0.85, {
      x: 200,
      y: 150,
    })
    store.setCamera(next)
    await settle()
    expect(renderer.getLastDrawPath()).toBe('scaled-extend')

    // Now combine the next zoom-out with a large pan so the reuse dest
    // rect is pushed off-canvas → cacheReuseLayout(...).valid === false.
    // The renderer must refuse the hybrid and fully re-render instead.
    const cam = store.getCamera()
    const zoomedOut = zoomAtScreenPoint(cam, cam.z * 0.9, { x: 2800, y: 1800 })
    store.setCamera({ ...zoomedOut, x: zoomedOut.x + 1200, y: zoomedOut.y + 900 })
    await settle()
    expect(renderer.getLastDrawPath()).toBe('full')
    // The full render leaves no blank half-cache: the node, if still in
    // view, is painted exactly where the final camera maps it.
    const finalCam = store.getCamera()
    const sx = Math.round((40 - finalCam.x) * finalCam.z)
    const sy = Math.round((40 - finalCam.y) * finalCam.z)
    if (sx >= 0 && sy >= 0 && sx < W && sy < H) {
      expect(isRed(readPixel(staticCanvas, sx, sy))).toBe(true)
    }

    renderer.dispose()
    cleanup(staticCanvas, interactiveCanvas)
  })

  test('ending the zoom gesture re-rasterizes a crisp frame at the current camera', async () => {
    const { store, renderer, staticCanvas, interactiveCanvas } = makeHarness()
    store.addNode(rectNode('n-1'))
    renderer.start()
    await settle()

    store.setInteractionState({ mode: 'zooming' })
    const cam = store.getCamera()
    store.setCamera({ ...cam, z: cam.z * 0.9 })
    await settle()
    expect(renderer.getLastDrawPath()).toBe('scaled')

    store.setInteractionState({ mode: 'idle' })
    await settle()
    expect(renderer.getLastDrawPath()).toBe('full')

    // Crispness / registration: the full re-render places the node exactly
    // where the camera says, and leaves no blurred old-cache pixels in the
    // surrounding (transparent) area.
    expect(isRed(readPixel(staticCanvas, 180, 135))).toBe(true)
    expect(readPixel(staticCanvas, 50, 50)[3]).toBe(0)

    renderer.dispose()
    cleanup(staticCanvas, interactiveCanvas)
  })

  test('rapid zoom/pan alternation keeps the blit registered with the cache camera (no drift)', async () => {
    const { store, renderer, staticCanvas, interactiveCanvas } = makeHarness()
    // A node whose world position we can probe after every gesture.
    store.addNode(rectNode('n-1', { x: 300, y: 250, w: 100, h: 100 }))
    renderer.start()
    await settle()
    expect(renderer.getLastDrawPath()).toBe('full')

    const expectNodeAtCamera = (): void => {
      const cam = store.getCamera()
      // Node center world (350, 300) → expected screen position.
      const sx = Math.round((350 - cam.x) * cam.z)
      const sy = Math.round((300 - cam.y) * cam.z)
      if (sx < 0 || sy < 0 || sx >= staticCanvas.width || sy >= staticCanvas.height) return
      expect(isRed(readPixel(staticCanvas, sx, sy))).toBe(true)
    }

    for (let i = 1; i <= 8; i++) {
      // Alternate zoom and pan bursts, flipping the interaction mode the
      // way the real gesture layer does (including direct flips that
      // never pass through idle).
      if (i % 2 === 1) {
        store.setInteractionState({ mode: 'zooming' })
        const cam = store.getCamera()
        const factor = i % 4 === 1 ? 1.08 : 0.92
        store.setCamera({ ...cam, z: cam.z * factor, x: cam.x + 12, y: cam.y + 8 })
      } else {
        store.setInteractionState({ mode: 'panning' })
        const cam = store.getCamera()
        store.setCamera({ ...cam, x: cam.x + 30 / cam.z, y: cam.y + 20 / cam.z })
      }
      await settle()
      expectNodeAtCamera()
    }

    // Settle to idle: one final crisp full render, still perfectly
    // registered with the final camera (no accumulated offset).
    store.setInteractionState({ mode: 'idle' })
    await settle()
    expect(renderer.getLastDrawPath()).toBe('full')
    expectNodeAtCamera()

    renderer.dispose()
    cleanup(staticCanvas, interactiveCanvas)
  })
})
