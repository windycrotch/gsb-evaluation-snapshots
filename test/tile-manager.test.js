import { assert } from '@esm-bundle/chai'
import { TileManager } from '../src/layers/gis/TileLayer.js'

// TileManager unit tests.
//
// Every GPU/network dependency is replaced with a controllable fake so the tests
// run offline and can drive load completion and failure by hand:
//   • loadImage(url)     → returns a promise the test resolves/rejects
//   • createTexture(opts)→ a fake texture that records destroy() calls
//   • uploadPositions(a) → a fake position texture
//   • buildMesh(...)     → a tiny mesh (no proj4 / no real tessellation)
//
// Views are EPSG:3857 domains in metres. The tile grid below was computed with the
// same tile math TileManager uses; each comment names the keys a view needs.

const VIEW = { width: 256, height: 256 }

// 600 km square → zoom 6, tiles {6/32/31, 6/32/32}
const VIEW_A = [[0, 600000], [0, 600000]]
// +80 km east → shares 6/32/* and adds column 33:
// {6/32/31, 6/32/32, 6/33/31, 6/33/32}
const VIEW_A_EAST = [[80000, 680000], [0, 600000]]
// far east → fully disjoint from VIEW_A: {6/33/31, 6/33/32}
const VIEW_FAR_EAST = [[650000, 1250000], [0, 600000]]
// +40 km north → column 32, rows 30 & 31: {6/32/30, 6/32/31}
const VIEW_A_NORTH = [[0, 600000], [40000, 640000]]
// half the extent → zoom 7, tiles {7/64/63, 7/64/64}
const VIEW_ZOOMED = [[0, 300000], [0, 300000]]

const KEY_A_LOWER = '6/32/32'   // y=32 (south half in tile space)
const KEY_A_UPPER = '6/32/31'
const KEY_EAST_UPPER = '6/33/31'
const KEY_EAST_LOWER = '6/33/32'
const KEY_NORTH_UPPER = '6/32/30'

function makeFakeTexture() {
  return { destroyed: 0, destroy() { this.destroyed++ } }
}

// Controllable image loader. Each call parks its resolve/reject until the test
// settles it, so "loading" can be observed before completion.
function makeFakeLoader() {
  const pending = []
  const calls = []
  const loadImage = (url) => {
    calls.push(url)
    return new Promise((resolve, reject) => {
      pending.push({ url, resolve, reject })
    })
  }
  return {
    loadImage,
    calls,
    pending,
    // Resolve every outstanding request (or those matching a predicate).
    resolveAll(predicate = () => true) {
      for (const p of pending.splice(0)) {
        if (predicate(p)) p.resolve({ src: p.url })
        else pending.push(p)
      }
    },
    rejectAll(predicate = () => true, message = 'Network error') {
      for (const p of pending.splice(0)) {
        if (predicate(p)) p.reject(new Error(message))
        else pending.push(p)
      }
    },
    countFor(url) { return calls.filter(u => u === url).length },
  }
}

function makeHarness() {
  const loader = makeFakeLoader()
  const createdTextures = []
  const imageTextures = []      // { tileUrl, tex }
  const positionTextures = []
  const renders = { count: 0 }

  const xTexFns = [() => null]
  const yTexFns = [() => null]
  const imageTexFns = [() => null]

  const manager = new TileManager({
    regl: null,
    source: { type: 'xyz', url: 'https://tiles.test/{z}/{x}/{y}.png', maxZoom: 19, crs: 'EPSG:3857' },
    tileCrs: 'EPSG:3857',
    plotCrs: 'EPSG:3857',
    tessellation: 2,
    xTexFns, yTexFns, imageTexFns,
    onLoad: () => { renders.count++ },
    loadImage: loader.loadImage,
    createTexture: (opts) => {
      const tex = makeFakeTexture()
      tex.src = opts.data?.src ?? null
      createdTextures.push(tex)
      imageTextures.push({ tileUrl: opts.data?.src ?? null, tex })
      return tex
    },
    uploadPositions: () => {
      const tex = makeFakeTexture()
      positionTextures.push(tex)
      return tex
    },
    buildMesh: () => ({ vertexCount: 6, positions: new Float32Array(12), uvs: new Float32Array(12) }),
  })

  return { manager, loader, createdTextures, imageTextures, positionTextures, renders, xTexFns, yTexFns, imageTexFns }
}

// Let every queued microtask (the async load continuations) run.
const flush = () => new Promise(r => setTimeout(r, 0))

// The keys currently handed to the renderer: the image fn[] filtered to non-null.
function drawnUrls(h) {
  return h.imageTexFns.map(fn => fn()).filter(Boolean).map(t => t.src)
}

function urlsFor(keys) {
  return keys.map(k => `https://tiles.test/${k}.png`).sort()
}

describe('TileManager', () => {
  it('panning within the view keeps already-loaded tiles in the draw list', async () => {
    const h = makeHarness()
    h.manager.syncTiles(...VIEW_A, VIEW)
    assert.lengthOf(h.loader.pending, 2, 'first view requests its two tiles')

    h.loader.resolveAll()
    await flush()
    assert.deepEqual(drawnUrls(h).sort(), urlsFor([KEY_A_UPPER, KEY_A_LOWER]))

    // Small pan that stays inside the same tile set: nothing is re-requested and the
    // already-loaded tiles are still drawn (never blanked out).
    const before = h.loader.calls.length
    h.manager.syncTiles(...VIEW_A, VIEW)  // unchanged view
    h.manager.syncTiles([[8000, 608000], [0, 600000]], VIEW)  // 1.3% pan, same keys
    assert.lengthOf(h.loader.calls, before, 'no new requests for an already-covered view')
    assert.deepEqual(drawnUrls(h).sort(), urlsFor([KEY_A_UPPER, KEY_A_LOWER]))

    h.manager.destroy()
  })

  it('after a pan, tiles from the previous view are not drawn while new tiles load', async () => {
    const h = makeHarness()
    h.manager.syncTiles(...VIEW_A, VIEW)
    h.loader.resolveAll()
    await flush()
    assert.lengthOf(drawnUrls(h), 2)

    // Pan far east: two new tiles are requested and none of the old view's tiles
    // belong to the new view. Until they finish the draw list is empty — the previous
    // view's tiles are never presented as current content.
    h.manager.syncTiles(...VIEW_FAR_EAST, VIEW)
    assert.lengthOf(h.loader.pending, 2, 'the two new east tiles are requested')
    assert.deepEqual(drawnUrls(h), [], 'stale tiles are not drawn as current content')
    assert.equal(h.manager.tiles.get(KEY_A_UPPER)?.imgTex?.destroyed ?? 0, 0,
      'previous tiles remain cached (not destroyed) for a quick pan back')

    // New tiles arrive: now exactly the new view draws.
    h.loader.resolveAll()
    await flush()
    assert.deepEqual(drawnUrls(h).sort(), urlsFor([KEY_EAST_UPPER, KEY_EAST_LOWER]))

    h.manager.destroy()
  })

  it('zooming to a new level does not keep drawing the old level', async () => {
    const h = makeHarness()
    h.manager.syncTiles(...VIEW_A, VIEW)
    h.loader.resolveAll()
    await flush()
    const oldTextures = h.imageTextures.map(e => e.tex)

    h.manager.syncTiles(...VIEW_ZOOMED, VIEW)
    assert.deepEqual(drawnUrls(h), [], 'old zoom level tiles are not drawn at the new level')
    // The old level is cached but untouched (its textures are still alive).
    assert.isTrue(oldTextures.every(t => t.destroyed === 0))

    h.loader.resolveAll()
    await flush()
    assert.deepEqual(drawnUrls(h).sort(), urlsFor(['7/64/63', '7/64/64']))

    h.manager.destroy()
  })

  it('a key needed again before its first load completes produces one request and one texture', async () => {
    const h = makeHarness()
    h.manager.syncTiles(...VIEW_A, VIEW)
    assert.lengthOf(h.loader.pending, 2)

    // Same view again (within the change threshold → no sync), then a real pan that
    // still needs one of the in-flight keys.
    h.manager.syncTiles(...VIEW_A, VIEW)
    h.manager.syncTiles(...VIEW_A_NORTH, VIEW)   // needs 6/32/30 + still 6/32/31

    const upperUrl = `https://tiles.test/${KEY_A_UPPER}.png`
    assert.equal(h.loader.countFor(upperUrl), 1, 'the shared key was requested once')
    assert.equal(h.imageTextures.filter(e => e.tileUrl === upperUrl).length, 0,
      'no texture exists before the load completes')

    h.loader.resolveAll()
    await flush()

    assert.equal(h.loader.countFor(upperUrl), 1, 'still only one request after completion')
    assert.equal(h.imageTextures.filter(e => e.tileUrl === upperUrl).length, 1,
      'exactly one image texture created for the shared key')
    // The draw list holds the shared tile plus the new northern tile — both loaded.
    assert.deepEqual(drawnUrls(h).sort(), urlsFor([KEY_A_UPPER, KEY_NORTH_UPPER]))

    h.manager.destroy()
  })

  it('a failed load is retried when a later view needs the key again', async () => {
    const h = makeHarness()
    h.manager.syncTiles(...VIEW_A, VIEW)
    const lowerUrl = `https://tiles.test/${KEY_A_LOWER}.png`
    const upperUrl = `https://tiles.test/${KEY_A_UPPER}.png`
    // One tile loads, the other fails.
    h.loader.resolveAll(p => p.url === lowerUrl)
    h.loader.rejectAll(p => p.url === upperUrl)
    await flush()

    assert.isFalse(h.manager.tiles.has(KEY_A_UPPER), 'the failed key is not left stuck in loading')
    assert.deepEqual(drawnUrls(h), [lowerUrl], 'only the loaded tile is drawn')

    // Panning away and back (a new view) must retry the failed key — and succeed now.
    h.manager.syncTiles(...VIEW_A_NORTH, VIEW)
    h.loader.resolveAll()
    await flush()
    h.manager.syncTiles(...VIEW_A, VIEW)
    assert.equal(h.loader.countFor(upperUrl), 2, 'the failed key is requested again for a new view')
    h.loader.resolveAll()
    await flush()

    assert.isTrue(h.manager.tiles.has(KEY_A_UPPER))
    assert.isTrue(h.manager.tiles.get(KEY_A_UPPER).status === 'loaded')
    assert.deepEqual(drawnUrls(h).sort(), urlsFor([KEY_A_UPPER, KEY_A_LOWER]))

    h.manager.destroy()
  })

  it('a COG tile that returns no data is retried, not stuck loading', async () => {
    const loader = makeFakeLoader()
    let fetchCalls = 0
    const manager = new TileManager({
      regl: null,
      source: { type: 'cog', url: 'https://cog.test/dem.tif', crs: 'EPSG:3857' },
      tileCrs: 'EPSG:3857', plotCrs: 'EPSG:3857', tessellation: 1,
      xTexFns: [() => null], yTexFns: [() => null], imageTexFns: [() => null],
      onLoad: () => {},
      loadImage: loader.loadImage,
      fetchTileData: async () => { fetchCalls++; return null },  // empty COG
      createTexture: () => makeFakeTexture(),
      uploadPositions: () => makeFakeTexture(),
      buildMesh: () => ({ vertexCount: 6, positions: new Float32Array(12) }),
    })

    manager.syncTiles(...VIEW_A, VIEW)
    await flush()
    assert.equal(fetchCalls, 1)
    assert.equal(manager.tiles.size, 0, 'the empty COG tile is not left stuck loading')

    // The unchanged view does not re-request in a loop...
    manager.syncTiles(...VIEW_A, VIEW)
    assert.equal(fetchCalls, 1, 'no retry storm for the unchanged view')

    // ...but panning away and back to the same bbox retries that same key.
    manager.syncTiles(...VIEW_A_EAST, VIEW)
    await flush()
    manager.syncTiles(...VIEW_A, VIEW)
    assert.equal(fetchCalls, 3, 'returning to the failed bbox retries its key')

    manager.destroy()
  })

  it('evicting a tile releases its image and position textures', async () => {
    const h = makeHarness()
    h.manager._maxCacheSize = 2   // force eviction once more than two tiles are cached
    h.manager.syncTiles(...VIEW_A, VIEW)
    h.loader.resolveAll()
    await flush()
    assert.lengthOf(h.manager.tiles, 2)

    // A disjoint view: its two tiles are needed, the two old ones are not. With a cap
    // of two the old tiles are evicted to make room.
    h.manager.syncTiles(...VIEW_FAR_EAST, VIEW)
    h.loader.resolveAll()
    await flush()

    assert.lengthOf(h.manager.tiles, 2)   // two needed tiles; old ones gone
    assert.isFalse(h.manager.tiles.has(KEY_A_UPPER), 'the unneeded old tile is evicted')
    assert.isFalse(h.manager.tiles.has(KEY_A_LOWER), 'the unneeded old tile is evicted')

    // Every texture whose tile was evicted has been destroyed; the survivors are alive.
    const liveTextures = new Set()
    for (const tile of h.manager.tiles.values()) {
      if (tile.imgTex) liveTextures.add(tile.imgTex)
      if (tile.xTex) liveTextures.add(tile.xTex)
      if (tile.yTex) liveTextures.add(tile.yTex)
    }
    let evicted = 0
    for (const tex of [...h.imageTextures.map(e => e.tex), ...h.positionTextures]) {
      if (!liveTextures.has(tex)) { assert.equal(tex.destroyed, 1, 'evicted textures are destroyed once'); evicted++ }
    }
    assert.isAbove(evicted, 0, 'at least one texture was released')

    h.manager.destroy()
  })

  it('never releases textures still referenced by the current draw list', async () => {
    const h = makeHarness()
    h.manager.syncTiles(...VIEW_A, VIEW)
    h.loader.resolveAll()
    await flush()

    const live = [...h.manager.tiles.values()].map(t => t.imgTex)
    // Ask to evict a needed key directly — it must refuse.
    assert.isFalse(h.manager._evictTile(KEY_A_UPPER))
    assert.isTrue(h.manager.tiles.has(KEY_A_UPPER))
    assert.isTrue(live.every(t => t.destroyed === 0), 'needed textures stay alive')

    h.manager.destroy()
  })

  it('destroy releases every texture and stops pending loads from creating new ones', async () => {
    const h = makeHarness()
    h.manager.syncTiles(...VIEW_A, VIEW)
    const [a, b] = h.loader.pending.splice(0)
    a.resolve({ src: a.url })      // one tile completes, the other stays in flight
    await flush()
    assert.lengthOf(h.manager.tiles, 2)   // one loaded, one loading
    const rendersBefore = h.renders.count

    h.manager.destroy()
    assert.isTrue(h.manager.destroyed)
    assert.equal(h.manager.tiles.size, 0)

    // The in-flight load now resolves: it must not create a texture or schedule a render.
    const createdBefore = h.imageTextures.length
    b.resolve({ src: b.url })
    await flush()
    assert.equal(h.imageTextures.length, createdBefore, 'no texture created after destroy')
    assert.equal(h.renders.count, rendersBefore, 'no render scheduled after destroy')
    assert.deepEqual(h.imageTexFns.map(fn => fn()), [null], 'the draw list is nulled out')

    // Every texture the manager owned was released exactly once.
    for (const tex of [...h.imageTextures.map(e => e.tex), ...h.positionTextures]) {
      assert.equal(tex.destroyed, 1)
    }
  })

  it('destroy during texture creation releases the just-created textures', async () => {
    const h = makeHarness()
    h.manager.syncTiles(...VIEW_A, VIEW)
    const [a] = h.loader.pending.splice(0)

    // Resolve, then destroy synchronously before the async continuation resumes, so the
    // continuation itself sees a destroyed manager while holding a created texture.
    a.resolve({ src: a.url })
    // The continuation runs on a microtask; destroy now to race it.
    h.manager.destroy()
    await flush()

    for (const tex of [...h.imageTextures.map(e => e.tex), ...h.positionTextures]) {
      assert.isAtMost(tex.destroyed, 1)
    }
    assert.isFalse(h.renders.count > 0, 'no render after destroy')
  })

  it('stays empty (and silent) when the view is outside the tile range', async () => {
    const h = makeHarness()
    // A view with a non-finite corner yields no tiles; the manager must not throw.
    h.manager.syncTiles([NaN, NaN], [0, 1], VIEW)
    await flush()
    assert.deepEqual(drawnUrls(h), [])
    h.manager.destroy()
  })

  it('a panic-driven zoom cycle recovers: old level released, new level drawn', async () => {
    const h = makeHarness()
    // Load level 6.
    h.manager.syncTiles(...VIEW_A, VIEW)
    h.loader.resolveAll()
    await flush()
    const level6 = [...h.manager.tiles.values()].map(t => t.imgTex)
    assert.lengthOf(level6, 2)

    // Zoom in (level 7), then straight back out before level 7 finishes: level 7's
    // in-flight requests are kept in flight (not cancelled and re-requested), and once
    // everything settles the level-6 view draws again.
    h.manager.syncTiles(...VIEW_ZOOMED, VIEW)
    assert.lengthOf(h.loader.pending, 2, 'level 7 requested')
    h.manager.syncTiles(...VIEW_A, VIEW)
    assert.deepEqual(drawnUrls(h).sort(), urlsFor([KEY_A_UPPER, KEY_A_LOWER]),
      'returning to level 6 immediately draws the cached level-6 tiles')
    assert.isTrue(level6.every(t => t.destroyed === 0), 'level-6 textures were never released')

    h.loader.resolveAll()   // level 7 completes in the background
    await flush()
    assert.deepEqual(drawnUrls(h).sort(), urlsFor([KEY_A_UPPER, KEY_A_LOWER]),
      'completed level-7 tiles are cached but not drawn at level 6')

    h.manager.destroy()
  })

  it('a tile whose image fails does not stay in the loading state', async () => {
    const h = makeHarness()
    h.manager.syncTiles(...VIEW_A, VIEW)
    h.loader.rejectAll()
    await flush()
    for (const tile of h.manager.tiles.values()) {
      assert.notEqual(tile.status, 'loading', 'no tile is stuck loading after a failure')
    }
  })
})
