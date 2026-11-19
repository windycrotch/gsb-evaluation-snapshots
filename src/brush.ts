// The brush sheet: eight marks of a loaded bristle brush, made in code. Ported from oil-paint (MIT),
// https://patch.gg/blendi/oil-paint, src/oilpaint/brush.js.
//
// Each cell holds one mark laid along +v. r: how thick the paint stands, for the light that rakes across it.
// g: where there is paint at all. b: a slow streak along the bristles, where a second colour was picked up.
// a: the plain mark, for strokes that are small on the canvas: the same touch as one clean shape with no bristles,
// gaps or dry end. The dab shader goes from one to the other by the size of the stroke on screen.
import * as THREE from 'three'

export const BRUSH_COLUMNS = 4
export const BRUSH_ROWS = 2
// large enough that a leaf seen close is not a blown-up picture of a mark
const CELL_WIDTH = 256
const CELL_HEIGHT = 512
// a margin of nothing round each mark, so the small copies of the sheet do not bleed into each other
const MARGIN = { side: 0.9, end: 0.04 }

type MarkKind = 'stroke' | 'pressed' | 'curved'

// cells 0..2 and 6: long strokes that run dry. 3 and 7: strokes with a curve. 4 and 5: short pressed dabs
const KINDS: MarkKind[] = ['stroke', 'stroke', 'stroke', 'curved', 'pressed', 'pressed', 'stroke', 'curved']

function hash(n: number) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}

const ease = (t: number) => t * t * (3 - 2 * t)

function noise1(x: number, seed: number) {
  const i = Math.floor(x)
  const f = ease(x - i)
  return hash(i + seed * 57.3) * (1 - f) + hash(i + 1 + seed * 57.3) * f
}

function noise2(x: number, y: number, seed: number) {
  const i = Math.floor(x)
  const j = Math.floor(y)
  const fx = ease(x - i)
  const fy = ease(y - j)
  const h = (a: number, b: number) => hash(a * 1.31 + b * 91.7 + seed * 13.9)
  return (h(i, j) * (1 - fx) + h(i + 1, j) * fx) * (1 - fy) + (h(i, j + 1) * (1 - fx) + h(i + 1, j + 1) * fx) * fy
}

const step = (a: number, b: number, x: number) => ease(Math.min(1, Math.max(0, (x - a) / (b - a))))

/** One mark at u in -1..1 across and v in 0..1 along: [thickness, paint, streak, plain paint], each 0..1. */
function mark({ u, v, seed, kind }: { u: number; v: number; seed: number; kind: MarkKind }): [number, number, number, number] {
  const bend = kind === 'curved' ? (seed % 2 ? 0.34 : -0.34) : (hash(seed * 3.1) - 0.5) * 0.12
  const ub = u - bend * (4 * (v - 0.5) * (v - 0.5) - 0.5)
  if (kind === 'pressed') {
    // a pressed dab: fat in the middle, ragged all round
    const r = Math.hypot(ub / 0.66, (v - 0.5) / 0.44)
    const edge = 1 + (noise1(Math.atan2(v - 0.5, ub) * 2.2 + 9, seed) - 0.5) * 0.34
    const inside = 1 - step(edge - 0.16, edge, r)
    const dry = step(0.55, 1.0, r) * 0.9
    const paint = inside * (noise1(ub * 11, seed + 11) > dry * 0.8 ? 1 : 0.25)
    const ridge = noise1(ub * 13 + noise1(v * 3, seed) * 1.5, seed + 31)
    const thick = paint * (0.4 + 0.22 * ridge * noise1(ub * 9, seed + 5) + 0.3 * step(0.45, 0.95, r) + 0.12 * noise2(ub * 4, v * 6, seed))
    // plain: an oval with a slightly uneven rim
    const angle = Math.atan2(v - 0.5, ub)
    const rim = 1 + (noise2(Math.cos(angle) * 1.2 + 3, Math.sin(angle) * 1.2 + 3, seed) - 0.5) * 0.2
    return [thick, paint, noise2(ub * 3.2, v * 1.3, seed + 20), 1 - step(rim - 0.1, rim, r)]
  }
  const wobble = (noise1(v * 5, seed + 3) - 0.5) * 0.1
  const a = Math.abs(ub + wobble)
  const half = 0.6 * (0.8 + 0.2 * Math.sin(Math.PI * Math.min(1, v * 1.15))) * (1 + (noise1(v * 7, seed + 1) - 0.5) * 0.1)
  const start = 0.05 + 0.05 * noise1(ub * 5, seed + 2)
  const end = 0.95 - 0.3 * noise1(ub * 4.5 + 2, seed + 4) - 0.06 * noise1(ub * 19, seed + 6)
  const side = 1 - step(half - 0.07, half, a)
  const head = step(start, start + 0.035, v)
  const tail = 1 - step(end - 0.02, end + 0.015, v)
  // the brush runs dry toward the end: single bristles give out and leave gaps
  const dryness = step(end - 0.2, end, v)
  const bristle = noise1(ub * 13, seed + 8) * 0.7 + noise1(ub * 31, seed + 9) * 0.3
  const gap = 1 - step(dryness * 0.55 - 0.08, dryness * 0.55, bristle) < 0.5 ? 1 : 0
  const paint = side * head * tail * gap
  const furrow = noise1(ub * 12 + noise1(v * 2.5, seed + 12) * 1.2, seed + 33) * 0.7 + noise1(ub * 29, seed + 34) * 0.3
  // thick where the brush touched down, thin where it left
  const load = 1 - 0.55 * step(0.1, 0.9, v)
  // paint pushed out to the sides of the stroke
  const squeezed = step(half - 0.3, half - 0.06, a)
  const thick = paint * (0.3 + 0.22 * furrow * (0.5 + 0.5 * noise1(ub * 11, seed + 13)) + 0.3 * squeezed + 0.25 * load * (1 - step(start, start + 0.25, v)) + 0.1 * noise2(ub * 3, v * 7, seed + 14))
  // plain: round where the brush touched down, tapering where it left, with a slow wobble along its sides
  const plainHalf = 0.62 * Math.pow(Math.sin(Math.PI * Math.pow(v, 0.75)), 0.55) * (1 + (noise1(v * 3, seed + 1) - 0.5) * 0.14)
  return [Math.min(1, thick), paint, noise2(ub * 3.4, v * 1.1, seed + 20), 1 - step(plainHalf - 0.08, plainHalf, Math.abs(ub))]
}

export function createBrushSheet() {
  const width = CELL_WIDTH * BRUSH_COLUMNS
  const height = CELL_HEIGHT * BRUSH_ROWS
  const data = new Uint8Array(width * height * 4)
  KINDS.forEach((kind, cell) => {
    const column = cell % BRUSH_COLUMNS
    const row = Math.floor(cell / BRUSH_COLUMNS)
    for (let y = 0; y < CELL_HEIGHT; y++) {
      for (let x = 0; x < CELL_WIDTH; x++) {
        const u = ((x + 0.5) / CELL_WIDTH) * 2 - 1
        const v = (y + 0.5) / CELL_HEIGHT
        const outside = Math.abs(u) > MARGIN.side || v < MARGIN.end || v > 1 - MARGIN.end
        const [thick, paint, streak, plain] = outside ? [0, 0, 0.5, 0] : mark({ u: u / MARGIN.side, v: (v - MARGIN.end) / (1 - 2 * MARGIN.end), seed: cell * 7 + 1, kind })
        data.set([Math.round(thick * 255), Math.round(paint * 255), Math.round(streak * 255), Math.round(plain * 255)], (column * CELL_WIDTH + x + (row * CELL_HEIGHT + y) * width) * 4)
      }
    }
  })
  const texture = new THREE.DataTexture(data, width, height)
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 4
  texture.needsUpdate = true
  return texture
}
