// Ordering, lifecycle and multi-frame timing tests for the Canvas2D fallback
// renderer: one shared sort for every drawable source, screen-tint placement,
// dynamic-canvas unregister/re-register, layer add/remove and dispose.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ECSWorld, createTransform } from '@xip/core'
import { Canvas2DRenderSystem } from '../canvas2dRenderSystem'
import { createSprite } from '../components/sprite'
import { createText } from '../components/text'
import { createCamera2D } from '../components/camera2d'
import { createTileLayerComponent, TileLayerData } from '../tileLayer'
import { SpriteLayer, SPRITE_UNTEXTURED } from '../spriteLayer'
import { GlyphAtlas, TextLayer } from '../textLayer'
import { createFakeGlyphCanvas } from '../testing/fakeGlyphCanvas'
import { fakeCanvas, fakeImage, type Op } from './fakeCanvas2D'

beforeEach(() => vi.stubGlobal('OffscreenCanvas', undefined))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const BG = 'rgb(16,32,48)'

function setup(w = 200, h = 100, cw = w, ch = h) {
  const fc = fakeCanvas(w, h, cw, ch)
  const rs = new Canvas2DRenderSystem(fc.canvas, new Map())
  const world = new ECSWorld()
  const cam = world.createEntity()
  world.addComponent(
    cam,
    createCamera2D({ x: w / (2 * (w / cw)), y: h / (2 * (h / ch)), zoom: 1, background: '#102030' }),
  )
  return { ...fc, rs, world, cam }
}

function addSprite(world: ECSWorld, x: number, y: number, opts: Parameters<typeof createSprite>[0]) {
  const e = world.createEntity()
  world.addComponent(e, createTransform(x, y))
  world.addComponent(e, createSprite(opts))
  return e
}

function addTextEntity(world: ECSWorld, opts: Parameters<typeof createText>[0]) {
  const e = world.createEntity()
  world.addComponent(e, createTransform(100, 50))
  world.addComponent(e, createText(opts))
  return e
}

function makeTextLayer(opts: ConstructorParameters<typeof TextLayer>[0] = {}) {
  const fake = createFakeGlyphCanvas()
  const atlas = new GlyphAtlas({ createCanvas: fake.createCanvas, pageSize: 256 })
  return new TextLayer({ atlas, fontSize: 10, ...opts })
}

function makeTileLayer(opts: Partial<ConstructorParameters<typeof TileLayerData>[0]>) {
  const layer = new TileLayerData({
    width: 2,
    height: 2,
    tileset: { image: fakeImage(16, 16), tileWidth: 16, tileHeight: 16, columns: 1 },
    ...opts,
  })
  layer.fill(1)
  return layer
}

/** Solid-rect sprite layer with one untextured sprite of the given colour. */
function makeSpriteLayer(color: number, opts: ConstructorParameters<typeof SpriteLayer>[0] = {}) {
  const layer = new SpriteLayer(opts)
  const i = layer.add(100, 50, 6, 6)
  layer.flags[i] = SPRITE_UNTEXTURED
  layer.color[i] = color
  return layer
}

const draws = (ops: Op[], name: string) => ops.filter((o) => o.name === name)
/** Ops after the background clear, labelled for order assertions. */
const sceneOps = (ops: Op[]) =>
  ops.filter(
    (o) =>
      o.name === 'drawImage' ||
      o.name === 'fillText' ||
      o.name === 'arc' ||
      (o.name === 'fillRect' && o.fill !== BG),
  )

describe('Canvas2DRenderSystem: unified sort across all sources', () => {
  it('orders sprites, SpriteLayer, TextLayer, renderLayer tiles and layered text in one pass', () => {
    const { rs, world, ops } = setup()
    // All on the default render layer, distinguished only by zIndex 1..5.
    world.addComponent(
      world.createEntity(),
      createTileLayerComponent(makeTileLayer({ renderLayer: 'default', zIndex: 1, opacity: 0.5 })),
    )
    addSprite(world, 100, 50, { width: 4, height: 4, color: '#ff0000', zIndex: 2 })
    rs.addSpriteLayer(makeSpriteLayer(0x00ff00ff, { zIndex: 3 }))
    const textLayer = makeTextLayer({ zIndex: 4 })
    textLayer.add('A', 100, 50)
    rs.addTextLayer(textLayer)
    addTextEntity(world, { text: 'layered', layer: 'default', zIndex: 5 })

    rs.update(world, 1 / 60)

    const seq = sceneOps(ops).map((o) => {
      if (o.name === 'drawImage') return o.alpha === 0.5 ? 'tile' : 'textLayer'
      if (o.name === 'fillText') return 'textEntity'
      return String(o.fill)
    })
    expect(seq).toEqual(['tile', 'rgb(255,0,0)', 'rgb(0,255,0)', 'textLayer', 'textEntity'])
  })

  it('keeps tiles without a renderLayer beneath every sprite regardless of zIndex', () => {
    const { rs, world, ops } = setup()
    world.addComponent(
      world.createEntity(),
      createTileLayerComponent(makeTileLayer({ zIndex: 999, opacity: 0.5 })),
    )
    addSprite(world, 100, 50, { width: 4, height: 4, color: '#ff0000', zIndex: -999 })
    rs.update(world, 1 / 60)
    const seq = sceneOps(ops).map((o) => (o.name === 'drawImage' ? 'tile' : String(o.fill)))
    expect(seq).toEqual(['tile', 'rgb(255,0,0)'])
  })

  it('draws equal sort keys in a stable order that does not jitter between frames', () => {
    const { rs, world, ops } = setup()
    // Identical (layer, zIndex) for every source: order must come from the
    // deterministic tie-break, not from array reuse across frames.
    addSprite(world, 100, 50, { width: 4, height: 4, color: '#ff0000' })
    addSprite(world, 100, 50, { width: 4, height: 4, color: '#00ff00' })
    addSprite(world, 100, 50, { width: 4, height: 4, color: '#0000ff' })
    rs.addSpriteLayer(makeSpriteLayer(0xffff00ff)) // yellow, same keys
    const frames: string[][] = []
    for (let f = 0; f < 3; f++) {
      ops.length = 0
      rs.update(world, 1 / 60)
      frames.push(sceneOps(ops).map((o) => String(o.fill)))
    }
    // Sprites in creation order, then the sprite layer — identical every frame.
    expect(frames[0]).toEqual(['rgb(255,0,0)', 'rgb(0,255,0)', 'rgb(0,0,255)', 'rgb(255,255,0)'])
    expect(frames[1]).toEqual(frames[0])
    expect(frames[2]).toEqual(frames[0])
  })
})

describe('Canvas2DRenderSystem: layer add/remove between frames', () => {
  it('never draws a removed sprite layer and never draws an added one twice', () => {
    const { rs, world, ops } = setup()
    const layer = makeSpriteLayer(0x00ff00ff)
    rs.addSpriteLayer(layer)
    rs.addSpriteLayer(layer) // duplicate add is ignored
    rs.update(world, 1 / 60)
    expect(draws(ops, 'fillRect').filter((o) => o.fill === 'rgb(0,255,0)')).toHaveLength(1)
    expect(rs.stats.batches).toBe(1)

    rs.removeSpriteLayer(layer)
    rs.removeSpriteLayer(layer) // double remove is safe
    ops.length = 0
    rs.update(world, 1 / 60)
    expect(draws(ops, 'fillRect')).toHaveLength(1) // background only
    expect(rs.stats.batches).toBe(0)

    rs.addSpriteLayer(layer)
    ops.length = 0
    rs.update(world, 1 / 60)
    expect(draws(ops, 'fillRect').filter((o) => o.fill === 'rgb(0,255,0)')).toHaveLength(1)
    expect(rs.stats.batches).toBe(1)
  })

  it('never draws a removed text layer and never draws an added one twice', () => {
    const { rs, world, ops } = setup()
    const layer = makeTextLayer()
    layer.add('AB', 100, 50)
    rs.addTextLayer(layer)
    rs.addTextLayer(layer)
    rs.update(world, 1 / 60)
    expect(draws(ops, 'drawImage')).toHaveLength(2) // one glyph cell per character, once

    rs.removeTextLayer(layer)
    ops.length = 0
    rs.update(world, 1 / 60)
    expect(draws(ops, 'drawImage')).toHaveLength(0)

    rs.addTextLayer(layer)
    ops.length = 0
    rs.update(world, 1 / 60)
    expect(draws(ops, 'drawImage')).toHaveLength(2)
  })
})

describe('Canvas2DRenderSystem: screen tint across frames', () => {
  it('sits between sprites and text, clears without residue and stays off at zero strength', () => {
    const { rs, world, ops } = setup()
    addSprite(world, 100, 50, { width: 4, height: 4, color: '#ff0000' })
    addTextEntity(world, { text: 'hello' })

    rs.setScreenTint(0, 0, 0, 0.5) // multiply by default
    rs.update(world, 1 / 60)
    let kinds = ops
      .filter((o) => o.name === 'fillRect' || o.name === 'fillText')
      .map((o) => (o.comp === 'multiply' ? 'tint' : o.name))
    expect(kinds).toEqual(['fillRect', 'fillRect', 'tint', 'fillText'])
    // The tint leaves no composite state behind for the text pass.
    expect(draws(ops, 'fillText')[0].comp).toBe('source-over')
    expect(draws(ops, 'fillText')[0].alpha).toBe(1)

    rs.clearScreenTint()
    ops.length = 0
    rs.update(world, 1 / 60)
    expect(ops.some((o) => o.comp === 'multiply')).toBe(false)
    expect(draws(ops, 'fillRect')).toHaveLength(2) // background + sprite

    rs.setScreenTint(1, 0, 0, 0) // zero strength: no tint draw at all
    ops.length = 0
    rs.update(world, 1 / 60)
    expect(draws(ops, 'fillRect')).toHaveLength(2)

    rs.setScreenTint(1, 0, 0, 0.4, 'additive')
    ops.length = 0
    rs.update(world, 1 / 60)
    const tint = draws(ops, 'fillRect').find((o) => o.comp === 'lighter')
    expect(tint).toBeTruthy()
    expect(tint!.alpha).toBeCloseTo(0.4)
    expect(ops.indexOf(tint!)).toBeGreaterThan(ops.findIndex((o) => o.fill === 'rgb(255,0,0)'))
    expect(ops.indexOf(tint!)).toBeLessThan(ops.findIndex((o) => o.name === 'fillText'))

    rs.clearScreenTint()
    ops.length = 0
    rs.update(world, 1 / 60)
    expect(ops.some((o) => o.comp === 'lighter')).toBe(false)
    expect(draws(ops, 'fillRect')).toHaveLength(2)
  })

  it('draws unlayered text after the tint and before particles', () => {
    const { rs, world, ops } = setup()
    addSprite(world, 100, 50, { width: 4, height: 4, color: '#ff0000' })
    addTextEntity(world, { text: 'hud' })
    const p = world.createEntity()
    world.addComponent(p, createTransform(100, 50))
    world.addComponent(p, {
      type: 'ParticlePool',
      particles: [{ x: 100, y: 50, vx: 0, vy: 0, life: 1, maxLife: 1, size: 10, color: '#ff8800', gravity: 0 }],
      active: false,
      maxParticles: 8,
      timer: 0,
      rate: 0,
      angle: 0,
      spread: 0,
      speed: 0,
      particleLife: 1,
      particleSize: 10,
      color: '#ff8800',
      gravity: 0,
      particleShape: 'circle',
    })
    rs.setScreenTint(0, 0, 0, 0.5)
    rs.update(world, 0)
    const at = (pred: (o: Op) => boolean) => ops.findIndex(pred)
    const iSprite = at((o) => o.fill === 'rgb(255,0,0)')
    const iTint = at((o) => o.comp === 'multiply')
    const iText = at((o) => o.name === 'fillText')
    const iParticle = at((o) => o.name === 'arc')
    expect(iSprite).toBeGreaterThan(-1)
    expect(iTint).toBeGreaterThan(iSprite)
    expect(iText).toBeGreaterThan(iTint)
    expect(iParticle).toBeGreaterThan(iText)
  })
})

describe('Canvas2DRenderSystem: dynamic canvas unregister and re-register', () => {
  it('skips sprites and layer atlases bound to an unregistered id, then recovers', () => {
    const { rs, world, ops } = setup()
    const dyn = { width: 32, height: 32 } as unknown as HTMLCanvasElement
    rs.registerDynamicCanvas('fx', dyn)
    addSprite(world, 100, 50, { width: 16, height: 16, dynamicSrc: 'fx' })
    const layer = new SpriteLayer({ atlases: [{ dynamicSrc: 'fx' }] })
    layer.add(100, 50, 8, 8)
    rs.addSpriteLayer(layer)

    rs.update(world, 1 / 60)
    expect(draws(ops, 'drawImage')).toHaveLength(2)
    expect(draws(ops, 'drawImage').every((o) => o.args[0] === dyn)).toBe(true)

    // Unregistered: both sources skip this frame — no throw, no fallback rect.
    rs.unregisterDynamicCanvas('fx')
    ops.length = 0
    expect(() => rs.update(world, 1 / 60)).not.toThrow()
    expect(draws(ops, 'drawImage')).toHaveLength(0)
    expect(draws(ops, 'fillRect')).toHaveLength(1) // background only
    expect(rs.stats.instances).toBe(0)

    // Re-registered under the same id: both draw again on the next frame.
    rs.registerDynamicCanvas('fx', dyn)
    ops.length = 0
    rs.update(world, 1 / 60)
    expect(draws(ops, 'drawImage')).toHaveLength(2)
  })

  it('skips a sprite whose dynamic canvas has zero size without throwing', () => {
    const { rs, world, ops } = setup()
    rs.registerDynamicCanvas('zero', { width: 0, height: 0 } as unknown as HTMLCanvasElement)
    addSprite(world, 100, 50, { width: 16, height: 16, dynamicSrc: 'zero' })
    expect(() => rs.update(world, 1 / 60)).not.toThrow()
    expect(draws(ops, 'drawImage')).toHaveLength(0)
    expect(draws(ops, 'fillRect')).toHaveLength(1) // background only
  })
})

describe('Canvas2DRenderSystem: dispose', () => {
  it('tolerates update after dispose and never touches the cleared collections', () => {
    const { rs, world, ops } = setup()
    const dyn = { width: 32, height: 32 } as unknown as HTMLCanvasElement
    rs.registerDynamicCanvas('fx', dyn)
    addSprite(world, 100, 50, { width: 16, height: 16, dynamicSrc: 'fx' })
    rs.addSpriteLayer(makeSpriteLayer(0x00ff00ff))
    const textLayer = makeTextLayer()
    textLayer.add('A', 100, 50)
    rs.addTextLayer(textLayer)
    rs.update(world, 1 / 60)
    expect(draws(ops, 'drawImage').length).toBeGreaterThan(0)

    rs.dispose()
    ops.length = 0
    expect(() => {
      rs.update(world, 1 / 60)
      rs.update(world, 1 / 60)
    }).not.toThrow()
    // Layers and dynamic canvases are gone: nothing from them may be drawn.
    expect(draws(ops, 'drawImage')).toHaveLength(0)
    expect(draws(ops, 'fillRect').every((o) => o.fill === BG)).toBe(true) // background clears only
    expect(rs.hasDynamicCanvas('fx')).toBe(false)
    expect(rs.dynamicCanvasIds()).toEqual([])
  })
})

describe('Canvas2DRenderSystem: per-frame stats', () => {
  it('resets draw counters every frame while frames keep counting', () => {
    const { rs, world } = setup()
    addSprite(world, 100, 50, { width: 4, height: 4, color: '#ff0000' })
    const layer = makeSpriteLayer(0x00ff00ff)
    layer.add(120, 50, 6, 6) // second sprite in the same layer
    rs.addSpriteLayer(layer)

    rs.update(world, 1 / 60)
    expect(rs.stats.frames).toBe(1)
    expect(rs.stats.spritesConsidered).toBe(1)
    expect(rs.stats.instances).toBe(3) // 1 sprite + 2 layer sprites
    expect(rs.stats.batches).toBe(1)
    expect(rs.stats.drawCalls).toBe(3)

    rs.update(world, 1 / 60)
    expect(rs.stats.frames).toBe(2)
    // Counters describe this frame only — nothing accumulates.
    expect(rs.stats.spritesConsidered).toBe(1)
    expect(rs.stats.instances).toBe(3)
    expect(rs.stats.batches).toBe(1)
    expect(rs.stats.drawCalls).toBe(3)
  })
})
