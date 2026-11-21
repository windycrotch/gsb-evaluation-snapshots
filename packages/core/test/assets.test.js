// @vitest-environment jsdom
// Asset loading: shared decoded images across canvas instances, retries after
// failure, in-flight deduplication, and clean teardown — all driven by a fake
// Image, never touching a real network.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Editor } from '../src/editor.js'
import { Store } from '../src/store.js'
import { AssetCache, assetRegistry } from '../src/assets.js'
import { drawShape } from '../src/shapes.js'

// ---- fakes -----------------------------------------------------------------

// A stand-in for HTMLImageElement. Loads never start on their own: the test
// fires settle()/fail() explicitly, so timing is fully deterministic.
let liveImages = []
class FakeImage {
  constructor() {
    this.onload = null
    this.onerror = null
    this.src = ''
    this.width = 100
    this.height = 80
    liveImages.push(this)
  }
  settle() { this.onload?.(new Event('load')) }
  fail() { this.onerror?.(new Event('error')) }
}

const asset = (id = 'a1', src = 'data:,img-a') => ({
  id, typeName: 'asset', src, w: 100, h: 80,
})
const imageShape = (assetId = 'a1') => ({
  id: 's1', typeName: 'shape', type: 'image', x: 0, y: 0, rot: 0, z: 1,
  props: { w: 40, h: 30, assetId },
})
function storeWith(rec) {
  const store = new Store()
  store.transact(() => { for (const r of rec) store.put(r) })
  return store
}

beforeEach(() => {
  liveImages = []
  vi.stubGlobal('Image', FakeImage)
  assetRegistry.clear()
})
afterEach(() => vi.unstubAllGlobals())

// ---- AssetCache: the loading state machine ---------------------------------

describe('AssetCache', () => {
  it('loads once and then hands back the decoded image (success can draw)', () => {
    const store = storeWith([asset()])
    const cache = new AssetCache()
    const onReady = vi.fn()

    expect(cache.get(store, 'a1', onReady)).toBeNull() // first draw: placeholder
    expect(liveImages).toHaveLength(1)
    expect(cache.get(store, 'a1', onReady)).toBeNull() // still in flight
    expect(liveImages).toHaveLength(1) // no second Image

    liveImages[0].settle()
    expect(onReady).toHaveBeenCalledTimes(1)

    const img = cache.get(store, 'a1')
    expect(img).toBe(liveImages[0]) // ready image returned, no new load
    expect(liveImages).toHaveLength(1)
  })

  it('a failed load is retried on the next request, with one Image per attempt', () => {
    const store = storeWith([asset()])
    const cache = new AssetCache()

    cache.get(store, 'a1')
    expect(liveImages).toHaveLength(1)
    liveImages[0].fail()

    // failure is not sticky: another request starts a fresh load
    expect(cache.get(store, 'a1')).toBeNull()
    expect(liveImages).toHaveLength(2)
    liveImages[1].settle()
    expect(cache.get(store, 'a1')).toBe(liveImages[1])
  })

  it('concurrent requests while loading share a single in-flight Image', () => {
    const store = storeWith([asset()])
    const a = new AssetCache()
    const b = new AssetCache()

    a.get(store, 'a1')
    // second canvas asks for the same asset before the first finished
    b.get(store, 'a1')
    expect(liveImages).toHaveLength(1)
    expect(assetRegistry.get('a1').refs.size).toBe(2)

    liveImages[0].settle()
    expect(a.get(store, 'a1')).toBe(liveImages[0])
    expect(b.get(store, 'a1')).toBe(liveImages[0]) // shared decoded image
  })

  it('retry piling in during a retry never creates duplicate load tasks', () => {
    const store = storeWith([asset()])
    const cache = new AssetCache()
    cache.get(store, 'a1')
    liveImages[0].fail()

    cache.get(store, 'a1')
    cache.get(store, 'a1')
    cache.get(store, 'a1')
    expect(liveImages).toHaveLength(2) // exactly one retry Image
    liveImages[1].settle()
    expect(cache.get(store, 'a1')).toBe(liveImages[1])
  })

  it('a late load callback after release never invokes the destroyed cache', () => {
    const store = storeWith([asset()])
    const cache = new AssetCache()
    const onReady = vi.fn()
    cache.get(store, 'a1', onReady)
    const inFlight = liveImages[0]
    expect(cache._waiters.has('a1')).toBe(true)

    cache.release()
    expect(cache.alive).toBe(false)
    expect(cache._waiters.size).toBe(0) // waiters die with the cache
    inFlight.settle() // load finishes after the canvas was destroyed
    expect(onReady).not.toHaveBeenCalled()
    // a dead cache rejects further requests outright
    expect(cache.get(store, 'a1', onReady)).toBeNull()
  })

  it('releasing one of two shared caches keeps the image; the last release clears the registry', () => {
    const store = storeWith([asset()])
    const a = new AssetCache()
    const b = new AssetCache()
    a.get(store, 'a1')
    b.get(store, 'a1')
    liveImages[0].settle()
    expect(assetRegistry.has('a1')).toBe(true)

    a.release()
    expect(assetRegistry.has('a1')).toBe(true) // still referenced by b
    expect(b.get(store, 'a1')).toBe(liveImages[0]) // b keeps drawing

    b.release()
    expect(assetRegistry.has('a1')).toBe(false) // last referrer gone -> freed
  })

  it('a failed entry still held by a live cache can retry, and frees on release', () => {
    const store = storeWith([asset()])
    const cache = new AssetCache()
    cache.get(store, 'a1')
    liveImages[0].fail()
    expect(assetRegistry.has('a1')).toBe(true) // kept so a retry is possible

    cache.release()
    expect(assetRegistry.has('a1')).toBe(false)
  })

  it('releases are idempotent and unknown assets stay quiet', () => {
    const store = storeWith([asset()])
    const cache = new AssetCache()
    expect(cache.get(store, 'missing')).toBeNull() // no asset record
    expect(assetRegistry.size).toBe(0)
    cache.release()
    cache.release()
    expect(cache.alive).toBe(false)
  })
})

// ---- Editor integration: real wiring through drawShape/render --------------

describe('editor image assets', () => {
  function makeContainer() {
    const c = document.createElement('div')
    Object.defineProperty(c, 'clientWidth', { value: 800, configurable: true })
    Object.defineProperty(c, 'clientHeight', { value: 600, configurable: true })
    document.body.appendChild(c)
    return c
  }

  function board(store, c = makeContainer()) {
    const editor = new Editor({ container: c, store })
    // count drawImage calls on the main canvas's (fake) 2d context
    const ctx = editor.canvas.getContext('2d')
    ctx.drawImage = vi.fn(ctx.drawImage)
    return { editor, ctx, container: c }
  }

  it('paints the placeholder first, then draws the image when the load completes', () => {
    const store = storeWith([asset(), imageShape()])
    const { editor, ctx, container } = board(store)

    editor.render()
    expect(liveImages).toHaveLength(1)
    expect(ctx.drawImage).not.toHaveBeenCalled() // still a placeholder box

    liveImages[0].settle() // load finishes -> requests a repaint
    editor.render() // the repaint now finds the decoded image
    expect(ctx.drawImage).toHaveBeenCalledWith(liveImages[0], 0, 0, 40, 30)

    editor.destroy()
    container.remove()
  })

  it('fails, then retries on the next render and draws once the retry succeeds', () => {
    const store = storeWith([asset(), imageShape()])
    const { editor, ctx, container } = board(store)

    editor.render()
    liveImages[0].fail()
    expect(ctx.drawImage).not.toHaveBeenCalled()

    editor.render() // next draw pass asks again -> retry
    expect(liveImages).toHaveLength(2)
    liveImages[1].settle()
    editor.render()
    expect(ctx.drawImage).toHaveBeenCalledWith(liveImages[1], 0, 0, 40, 30)

    editor.destroy()
    container.remove()
  })

  it('two canvases sharing a store load one Image and both draw it', () => {
    const store = storeWith([asset(), imageShape()])
    const one = board(store)
    const other = board(store)

    one.editor.render()
    other.editor.render()
    expect(liveImages).toHaveLength(1) // one load for both canvases

    liveImages[0].settle()
    one.editor.render()
    other.editor.render()
    expect(one.ctx.drawImage).toHaveBeenCalledWith(liveImages[0], 0, 0, 40, 30)
    expect(other.ctx.drawImage).toHaveBeenCalledWith(liveImages[0], 0, 0, 40, 30)

    one.editor.destroy()
    one.container.remove()
    expect(assetRegistry.has('a1')).toBe(true) // the other canvas still holds it
    other.editor.destroy()
    other.container.remove()
    expect(assetRegistry.has('a1')).toBe(false)
  })

  it('a load that finishes after destroy never repaints the dead canvas', async () => {
    const store = storeWith([asset(), imageShape()])
    const { editor, container } = board(store)
    editor.render()
    const inFlight = liveImages[0]

    const requestRender = vi.spyOn(editor, 'requestRender')
    editor.destroy()
    inFlight.settle()
    // any queued rAF from the constructor must also be a no-op on a dead editor
    await new Promise((r) => setTimeout(r, 60))
    expect(requestRender).not.toHaveBeenCalled()
    expect(assetRegistry.has('a1')).toBe(false) // its holdings were released
    container.remove()
  })

  it('drawShape renders a ready image through the editor-supplied cache', () => {
    const store = storeWith([asset(), imageShape()])
    const cache = new AssetCache()
    const calls = []
    const ctx = new Proxy({}, { get: (t, k) => (k === 'drawImage' ? (...a) => calls.push(a) : () => {}) })
    const theme = { id: 'light', colors: { black: { stroke: '#000' } } }

    drawShape(ctx, imageShape(), { theme, store, assets: cache })
    expect(calls).toHaveLength(0)
    liveImages[0].settle()
    drawShape(ctx, imageShape(), { theme, store, assets: cache })
    expect(calls).toHaveLength(1)
    cache.release()
  })
})
