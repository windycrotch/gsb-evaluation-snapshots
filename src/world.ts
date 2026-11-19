// The valley: ground, forest, village, castle on its crag, mountains and sky, all painted in dabs (things.ts).
// Layout (top view, the player starts in the forest and looks toward -Z):
//
//   mountains ......... z -1300 .. -3400
//   cloud veil ........ z -1560
//   castle crag ....... z -900
//   mist bank ......... z -600
//   far hills ......... z -300 .. -480
//   church knoll ...... z -226
//   village ........... z -80 .. -200
//   forest edge ....... z 0
//   start ............. z 14
import * as THREE from 'three'
import { CASTER_LAYER, Dabs, MARKS, Under, buildFlyingLeaves, billow, clamp, fbm, hex, lerp, lightOn, mixColor, mulberry, noise, ridged, smooth, tone, underMaterial } from './paint.ts'
import type { DabKind, RGB, Vec3 } from './paint.ts'
import { paintCrown, paintFir, paintSolid, paintTrunk, paintTuft } from './things.ts'
import type { Canvas, CrownStyle, SolidStyle, Tone, TrunkStyle } from './things.ts'

export interface Collider {
  x: number
  z: number
  r: number
}

/** Moves a circle out of every collider it overlaps. */
export function pushOut({ x, z, radius, colliders }: { x: number; z: number; radius: number; colliders: Collider[] }) {
  for (const c of colliders) {
    const dx = x - c.x
    const dz = z - c.z
    const min = c.r + radius
    const d2 = dx * dx + dz * dz
    if (d2 >= min * min || d2 === 0) continue
    const d = Math.sqrt(d2)
    x = c.x + (dx / d) * min
    z = c.z + (dz / d) * min
  }
  return { x, z }
}

const EYE_START = { x: 0, y: 1.7, z: 14 }
const CRAG = { x: -55, z: -900, top: 178 }
const HOUSE_SCALE = 0.62
const HEAD_ROOM = 2.2

// ---------- terrain height ----------

const FOREST_EDGE = 0
const VALLEY_FLOOR_START = 120

/** Downhill slope along the valley axis. d is the distance walked past the forest edge. */
function axisSlope(d: number) {
  if (d < -40) return 0.06
  if (d < -14) return lerp(0.06, 0.45, smooth(-40, -14, d))
  // The slope eases all the way down, so the hill never hides the village below.
  if (d < VALLEY_FLOOR_START) return (0.45 * (VALLEY_FLOOR_START - d)) / (VALLEY_FLOOR_START + 14)
  if (d < 150) return 0
  if (d < 230) return -0.13 * Math.sin((Math.PI * (d - 150)) / 80)
  if (d < 290) return 0
  return 0.22 * smooth(290, 330, d)
}

// axis height by integrating the slope, 1 m steps. Height is 0 at the start position
const AXIS_MIN = -220
const AXIS_MAX = 820
const AXIS_HEIGHTS = (() => {
  const heights = new Float32Array(AXIS_MAX - AXIS_MIN + 1)
  for (let i = 1; i < heights.length; i++) heights[i] = heights[i - 1] - axisSlope(AXIS_MIN + i - 0.5)
  const start = heights[-EYE_START.z - AXIS_MIN]
  return heights.map((h) => h - start)
})()

function axis(d: number) {
  const f = clamp(d, AXIS_MIN, AXIS_MAX - 1) - AXIS_MIN
  const i = Math.floor(f)
  return lerp(AXIS_HEIGHTS[i], AXIS_HEIGHTS[i + 1], f - i)
}

/** The valley is a funnel: a narrow hollow at the forest edge that opens toward the village. */
const valleyHalfWidth = (d: number) => lerp(18, 70, smooth(-14, 110, d))

/** a round hill: 1 at its middle, fading over the radii rx and rz */
const bump = ({ dx, rx, dz, rz }: { dx: number; rx: number; dz: number; rz: number }) => Math.exp(-(dx * dx) / (rx * rx) - (dz * dz) / (rz * rz))

export function groundHeight(x: number, z: number) {
  const d = FOREST_EDGE - z
  const a = axis(d)
  const u = Math.abs(x) / valleyHalfWidth(d)
  const far = smooth(235, 330, d)
  const rim = 9 + 10 * fbm(x * 0.008 + 3, z * 0.008 + 7) + 8 * smooth(1, 2.6, u) - 26 * far
  const wall = Math.pow(smooth(0.2, 1.05, u), 1.25)
  let h = a + Math.max(rim - a, 0) * wall
  h += far * (4 * bump({ dx: x + 150, rx: 170, dz: d - 400, rz: 110 }) + 10 * bump({ dx: x - 200, rx: 220, dz: d - 420, rz: 130 }))
  h += (fbm(x * 0.05, z * 0.05) - 0.5) * 2.2 * smooth(0.15, 0.6, u)
  return h
}

// ---------- paths and zones ----------

type Point = [number, number]

// prettier-ignore
const MAIN_PATH: Point[] = [
  [0.5, 95], [-1, 60], [0.5, 30], [0, 14], [-0.3, 0], [-1.5, -9], [1.5, -19], [4.5, -30], [3, -41], [-2, -51],
  [-4.5, -61], [-1, -72], [2.5, -82], [0.5, -94], [5, -106], [14, -118], [18, -130], [9, -141], [-3, -151],
  [-9, -165], [-2, -179], [4, -192], [0, -210], [-2, -224],
]

// prettier-ignore
const BRANCH_PATHS: Point[][] = [
  [[14, -118], [30, -120], [50, -126], [72, -123]],
  [[-4.5, -61], [-18, -65], [-32, -76], [-38, -95], [-34, -115]],
  [[-9, -165], [-28, -168], [-48, -162], [-66, -158]],
]

// bright meadows: x, z, radius x, radius z, strength
// prettier-ignore
const FIELDS: [number, number, number, number, number][] = [
  [-19, -150, 29, 18, 0.9], [26, -133, 24, 13, 0.8], [-5, -112, 24, 11, 0.5], [37, -165, 22, 15, 0.7],
  [-37, -120, 18, 13, 0.6], [1, -28, 14, 26, 0.5], [8, -204, 24, 14, 0.6], [-45, -176, 20, 14, 0.6],
  [16, -84, 21, 13, 0.45], [-21, -83, 18, 11, 0.4],
]

function smoothPath(points: Point[]) {
  const curve = new THREE.CatmullRomCurve3(points.map(([x, z]) => new THREE.Vector3(x, 0, z)))
  return curve.getPoints(points.length * 10).map((p): Point => [p.x, p.z])
}

const mainPath = smoothPath(MAIN_PATH)

/** x of the main path at a given z. The main path never doubles back in z. */
function pathXAt(z: number) {
  for (let i = 0; i < mainPath.length - 1; i++) {
    const [x1, z1] = mainPath[i]
    const [x2, z2] = mainPath[i + 1]
    if (z <= z1 && z >= z2) return lerp(x1, x2, (z1 - z) / Math.max(z1 - z2, 1e-6))
  }
  return z > mainPath[0][1] ? mainPath[0][0] : mainPath[mainPath.length - 1][0]
}

const ZONE = { minX: -256, minZ: -420, size: 512, res: 1024 }

/** Zone map, read when the world is painted. r: path, g: open lit ground (meadows and path sides), b: forest shade. */
function buildZones() {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = ZONE.res
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const scale = ZONE.res / ZONE.size
  const px = (x: number) => (x - ZONE.minX) * scale
  const pz = (z: number) => (z - ZONE.minZ) * scale
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, ZONE.res, ZONE.res)
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = ctx.lineJoin = 'round'

  const stroke = ({ points, width, color }: { points: Point[]; width: number; color: string }) => {
    ctx.strokeStyle = color
    ctx.lineWidth = width * scale
    ctx.beginPath()
    points.forEach(([x, z], i) => (i === 0 ? ctx.moveTo(px(x), pz(z)) : ctx.lineTo(px(x), pz(z))))
    ctx.stroke()
  }
  for (const [x, z, rx, rz, strength] of FIELDS) {
    ctx.save()
    ctx.translate(px(x), pz(z))
    ctx.scale(rx * scale, rz * scale)
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1)
    gradient.addColorStop(0, `rgb(0,${Math.round(strength * 230)},0)`)
    gradient.addColorStop(0.6, `rgb(0,${Math.round(strength * 190)},0)`)
    gradient.addColorStop(1, 'rgb(0,0,0)')
    ctx.fillStyle = gradient
    ctx.fillRect(-1, -1, 2, 2)
    ctx.restore()
  }
  // the grass beside the path is lit from the forest edge down
  const litPath = mainPath.filter(([, z]) => z < 11)
  stroke({ points: litPath, width: 6.5, color: 'rgb(0,45,0)' })
  stroke({ points: litPath, width: 3.8, color: 'rgb(0,45,0)' })
  stroke({ points: mainPath, width: 1.8, color: 'rgb(255,0,0)' })
  for (const branch of BRANCH_PATHS) {
    const points = smoothPath(branch)
    stroke({ points, width: 7, color: 'rgb(0,40,0)' })
    stroke({ points, width: 1.4, color: 'rgb(255,0,0)' })
  }

  const image = ctx.getImageData(0, 0, ZONE.res, ZONE.res)
  const data = image.data
  for (let j = 0; j < ZONE.res; j++) {
    const z = ZONE.minZ + (j + 0.5) / scale
    for (let i = 0; i < ZONE.res; i++) {
      const x = ZONE.minX + (i + 0.5) / scale
      const n = fbm(x * 0.03, z * 0.03)
      const u = Math.abs(x) / valleyHalfWidth(-z)
      const wall = smooth(0.5, 0.78, u + (n - 0.5) * 0.3)
      const forest = smooth(-12, 3, z + (n - 0.5) * 12)
      const far = smooth(-240, -285, z + (n - 0.5) * 30)
      data[(j * ZONE.res + i) * 4 + 2] = Math.round(255 * Math.max(wall, forest, far))
    }
  }

  /** [path, open, shade] in 0..1 at a world position */
  const sample = (x: number, z: number): RGB => {
    const i = Math.floor((x - ZONE.minX) * scale)
    const j = Math.floor((z - ZONE.minZ) * scale)
    if (i < 0 || j < 0 || i >= ZONE.res || j >= ZONE.res) return [0, 0, 1]
    const k = (j * ZONE.res + i) * 4
    return [data[k] / 255, data[k + 1] / 255, data[k + 2] / 255]
  }
  return { sample }
}

const PATH_FIELD = { minX: -126, minZ: -250, cell: 2, columns: 126, rows: 176 }
const PATH_BUCKET = 4

/** Distance to the nearest path in metres. Far from every path it returns a large number. */
function buildPathDistance() {
  // points every 40 cm or so along every path
  const points: Point[] = []
  for (const path of [mainPath, ...BRANCH_PATHS.map(smoothPath)]) {
    for (let i = 0; i < path.length - 1; i++) {
      for (let k = 0; k < 3; k++) points.push([lerp(path[i][0], path[i + 1][0], k / 3), lerp(path[i][1], path[i + 1][1], k / 3)])
    }
  }
  const { minX, minZ, cell, columns, rows } = PATH_FIELD
  const field = new Float32Array((columns + 1) * (rows + 1))
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= columns; i++) {
      let best = Infinity
      for (const [px, pz] of points) {
        const dx = px - (minX + i * cell)
        const dz = pz - (minZ + j * cell)
        best = Math.min(best, dx * dx + dz * dz)
      }
      field[j * (columns + 1) + i] = Math.sqrt(best)
    }
  }
  const coarse = (x: number, z: number) => {
    const fx = (x - minX) / cell
    const fz = (z - minZ) / cell
    if (fx < 0 || fz < 0 || fx >= columns || fz >= rows) return 1000
    const i = Math.floor(fx)
    const j = Math.floor(fz)
    const k = j * (columns + 1) + i
    const top = lerp(field[k], field[k + 1], fx - i)
    const bottom = lerp(field[k + columns + 1], field[k + columns + 2], fx - i)
    return lerp(top, bottom, fz - j)
  }
  // The grid rounds off the path's edge. Within one bucket of a path the distance is exact, from the points near by.
  const buckets = new Map<number, Point[]>()
  const key = (i: number, j: number) => i * 4096 + j
  for (const point of points) {
    const k = key(Math.floor(point[0] / PATH_BUCKET), Math.floor(point[1] / PATH_BUCKET))
    const bucket = buckets.get(k)
    if (bucket) bucket.push(point)
    else buckets.set(k, [point])
  }
  return (x: number, z: number) => {
    const i = Math.floor(x / PATH_BUCKET)
    const j = Math.floor(z / PATH_BUCKET)
    let best = PATH_BUCKET * PATH_BUCKET
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const [px, pz] of buckets.get(key(i + di, j + dj)) ?? []) best = Math.min(best, (px - x) ** 2 + (pz - z) ** 2)
      }
    }
    return best < PATH_BUCKET * PATH_BUCKET ? Math.sqrt(best) : Math.max(coarse(x, z), PATH_BUCKET)
  }
}

// ---------- colours by place ----------

const MIST = hex('#39396a')
const JOINT = hex('#3e2f1b')
const FLOWER = hex('#b24300')

/** what shows where no dab reaches: the mist below the horizon */
export const BACKDROP = hex('#29285a')

/** mist that rises to about `top` metres, give or take `feather`, and swallows what stands in it */
const mistBelow =
  ({ top, feather, most }: { top: number; feather: number; most: number }) =>
  (color: RGB, [x, y, z]: Vec3): RGB => {
    const edge = y + (fbm(x * 0.012, z * 0.012) - 0.5) * feather * 2
    return mixColor(color, MIST, smooth(top + feather, top - feather, edge) * most)
  }

// ---------- sky ----------

// cloud value thresholds and their tones, light to dark
const SKY_TONES: [number, RGB][] = [
  [0.7, hex('#887f71')],
  [0.61, hex('#766b70')],
  [0.54, hex('#6b5f70')],
  [0.45, hex('#5e506e')],
  [0.33, hex('#46416a')],
  [0.2, hex('#2f2d5e')],
]
const SKY_DARKEST = hex('#1a1735')
const SKY_GREEN = hex('#496262')

function cloud(x: number, y: number) {
  const warp = fbm(x * 0.8 + 3.1, y * 0.8 + 8.2)
  return fbm(x * 1.05 + warp * 1.7, y * 1.05 + warp) * 0.62 + (1 - billow(x * 1.7 + 2, y * 1.7 + 2)) * 0.38
}

/**
 * The sky in a direction: az from -Z toward +X, el up, radians. chance in 0..1 frays the edges.
 * f is how thick the cloud is there.
 */
/** how thick the cloud is in a direction, without the chance of a single stroke */
function cloudiness(az: number, el: number) {
  const x = az * 3.6
  const y = el * 4.4
  const body = cloud(x, y)
  // cumulus shading: edges that face the light, up and to the left, are bright; the far side is dark
  const lit = clamp((body - cloud(x - 0.07, y + 0.1)) * 8, -0.12, 0.24)
  let f = (body - 0.53) * 1.45 + 0.46 + lit + (fbm(x * 5 + 5, y * 5 + 5) - 0.5) * 0.04
  // bright bank above the castle, darker to the right and near the horizon
  f += 0.17 * Math.exp(-((az + 0.2) ** 2 * 2.2 + (el - 0.62) ** 2 * 5))
  f -= 0.1 * smooth(-0.15, 0.45, az) + 0.04 * smooth(0.5, 0.05, el)
  return f + 0.06 * smooth(0.35, 1, el)
}

// The sky turns with the wind, so every part of it comes into view. Behind the start, where az wraps round,
// one side is mixed into the other over this many radians.
const SKY_SEAM = 0.8

function skyAt({ az, el, chance }: { az: number; el: number; chance: number }) {
  const seam = smooth(Math.PI - SKY_SEAM, Math.PI, az)
  const here = cloudiness(az, el)
  const f = (seam > 0 ? lerp(here, cloudiness(az - Math.PI * 2, el), seam) : here) + (chance - 0.5) * 0.03
  let color = SKY_TONES.find(([edge]) => f > edge)?.[1] ?? SKY_DARKEST
  if (seam === 0 && f > 0.5 && f < 0.56 && fbm(az * 2.16 + 40, el * 2.64 + 40) > 0.66) color = SKY_GREEN
  // below the horizon the valley is lost in mist
  const low = smooth(0.02, -0.12, el + (fbm(az * 6, 1) - 0.5) * 0.06)
  if (chance < low) color = BACKDROP
  return { f, color }
}

const SKY_RADIUS = 6000
// angle between rows of sky strokes
const SKY_STEP = 0.018

/** The sky: a dome of underpainting and level strokes of cloud over it. It travels with the eye. */
function buildSky(rand: () => number) {
  const dabs = new Dabs()
  for (let el = -0.3; el < 1.55; el += SKY_STEP) {
    const count = Math.ceil((Math.PI * 2 * Math.cos(el)) / (SKY_STEP * 1.6))
    for (let i = 0; i < count; i++) {
      const az = ((i + rand()) / count) * Math.PI * 2 - Math.PI
      const e = el + (rand() - 0.5) * SKY_STEP * 2
      const flat = Math.cos(e) * SKY_RADIUS
      const across = SKY_RADIUS * SKY_STEP * lerp(1.5, 2.3, rand())
      dabs.face({
        at: [Math.sin(az) * flat, Math.sin(e) * SKY_RADIUS, -Math.cos(az) * flat],
        // clouds are laid in level strokes that tilt a little
        dir: [Math.cos(az), (rand() - 0.5) * 0.5, Math.sin(az)],
        size: [across, across * lerp(2.6, 3.8, rand())],
        color: skyAt({ az, el: e, chance: rand() }).color,
        lift: 0,
      })
    }
  }
  const dome = new THREE.SphereGeometry(SKY_RADIUS * 1.03, 96, 48)
  const position = dome.attributes.position
  const color = new Float32Array(position.count * 3)
  for (let i = 0; i < position.count; i++) {
    const az = Math.atan2(position.getX(i), -position.getZ(i))
    const el = Math.asin(clamp(position.getY(i) / (SKY_RADIUS * 1.03), -1, 1))
    color.set(skyAt({ az, el, chance: 0.5 }).color, i * 3)
  }
  dome.setAttribute('aColor', new THREE.BufferAttribute(color, 3))
  const sky = new THREE.Group()
  const under = new THREE.Mesh(dome, underMaterial(KINDS.sky))
  under.frustumCulled = false
  // the sky is drawn before everything else: the dome, then its strokes
  under.renderOrder = -11
  const strokes = dabs.build(KINDS.sky)
  strokes.renderOrder = -10
  sky.add(under, strokes)
  return sky
}

// ---------- ground ----------

const GROUND = { minX: -460, maxX: 460, minZ: -700, maxZ: 120, step: 2.5 }
// the part of the ground with paths, painted in fine strokes
const NEAR = { minX: -126, maxX: 126, minZ: -250, maxZ: 102 }

// Strokes get coarser away from the paths, where the player rarely stands.
// reach: up to this distance from a path. step: spacing both ways. size: a stroke across and along.
const GROUND_BANDS: { reach: number; step: [number, number]; size: [number, number] }[] = [
  { reach: 2.6, step: [0.12, 0.1], size: [0.15, 0.32] },
  { reach: 8, step: [0.2, 0.17], size: [0.26, 0.52] },
  { reach: 25, step: [0.4, 0.35], size: [0.52, 1] },
  { reach: Infinity, step: [0.9, 0.8], size: [1.2, 2.2] },
]
const FAR_GROUND: { step: number; size: [number, number] } = { step: 2.6, size: [3.6, 6.5] }
const UNDER_GROUND_DROP = 0.3
// strokes are laid block by block, so blocks far from the band's distance are skipped whole
const GROUND_BLOCK = 4
// grass and fern grow in clumps up to this far from a path: one try every TUFT_STEP metres
const TUFT_REACH = 14
const TUFT_STEP = 0.7

const GRASS_TUFT: Tone = { ramp: 'grass', base: 0.12, light: 0.95, noise: 0.5 }
const FERN_TUFT: Tone = { ramp: 'forestFloor', base: 0.42, light: 0.6, noise: 0.5 }

/** The ground: its under mesh goes into the scene, its strokes and its grass onto the canvas. */
function buildGround({ canvas, zones, pathDistance }: { canvas: Canvas; zones: ReturnType<typeof buildZones>; pathDistance: (x: number, z: number) => number }) {
  const { rand } = canvas
  const { minX, maxX, minZ, maxZ, step } = GROUND
  const nx = Math.round((maxX - minX) / step) + 1
  const nz = Math.round((maxZ - minZ) / step) + 1
  const heights = new Float32Array(nx * nz)
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) heights[j * nx + i] = groundHeight(minX + i * step, minZ + j * step)
  }
  // height from the grid, so dabs sit on the under mesh
  const heightAt = (x: number, z: number) => {
    const fx = clamp((x - minX) / step, 0, nx - 1.001)
    const fz = clamp((z - minZ) / step, 0, nz - 1.001)
    const i = Math.floor(fx)
    const j = Math.floor(fz)
    const k = j * nx + i
    return lerp(lerp(heights[k], heights[k + 1], fx - i), lerp(heights[k + nx], heights[k + nx + 1], fx - i), fz - j)
  }
  const normalAt = (x: number, z: number): Vec3 => {
    const dx = heightAt(x + 1.25, z) - heightAt(x - 1.25, z)
    const dz = heightAt(x, z + 1.25) - heightAt(x, z - 1.25)
    const length = Math.hypot(dx, 2.5, dz)
    return [-dx / length, 2.5 / length, -dz / length]
  }
  // deep in the forest at the start everything is darker
  const duskAt = (z: number) => 0.5 * smooth(3, 17, z)

  interface Spot {
    x: number
    z: number
    /** distance to the nearest path */
    d: number
    light: number
    /** chances in 0..1: the tone, the ragged zone edges, and the rare odd stroke */
    spread: number
    edge: number
    pick: number
  }
  /** what a stroke at a spot is painted with, and whether the spot is on a path */
  const paintAt = ({ x, z, d, light, spread, edge, pick }: Spot): { color: RGB; path: boolean } => {
    const [, open, forest] = zones.sample(x, z)
    const dusk = duskAt(z)
    // the path is a cart track at the start and a footpath in the valley
    const half = lerp(0.5, 0.8, smooth(-60, 10, z))
    if (d < half + (edge - 0.5) * 0.3 + (fbm(x * 0.8, z * 0.8) - 0.5) * 0.5) {
      // trodden earth in soft patches of light, with a dark crack or a tuft of grass now and then
      if (pick < 0.015) return { color: JOINT, path: true }
      if (pick > 0.965) return { color: tone('grass', 0.3 + spread * 0.4), path: true }
      const patch = fbm(x * 1.3 + 7, z * 0.9 + 3, 3) - 0.44
      const earth = tone('path', 0.5 + patch * 1.5 + (spread - 0.5) * 0.3 - dusk * 0.3)
      return { color: mixColor(earth, tone('forestFloor', 0.6), dusk * 0.55), path: true }
    }
    const shade = forest * (1 - smooth(0.1, 0.32, open))
    const t = -0.06 + (light - 0.5) * 1.1 + open * 0.8 + (fbm(x * 0.045, z * 0.045) - 0.5) * 0.55 + (spread - 0.5) * 0.7 - dusk * 0.42
    if (shade + (edge - 0.5) * 0.3 > 0.5) return { color: tone('forestFloor', t * 0.9 + 0.22 - shade * 0.25), path: false }
    if (pick > 0.994 && open > 0.1) return { color: FLOWER, path: false }
    return { color: tone('grass', t + 0.12), path: false }
  }

  // under mesh
  const position = new Float32Array(nx * nz * 3)
  const color = new Float32Array(nx * nz * 3)
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = minX + i * step
      const z = minZ + j * step
      // a little below the strokes, so none of them is buried where the ground curves
      position.set([x, heights[j * nx + i] - UNDER_GROUND_DROP, z], (j * nx + i) * 3)
      color.set(paintAt({ x, z, d: pathDistance(x, z), light: lightOn(...normalAt(x, z)), spread: 0.4, edge: 0.5, pick: 0.5 }).color, (j * nx + i) * 3)
    }
  }
  const index = new Uint32Array((nx - 1) * (nz - 1) * 6)
  for (let j = 0, k = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++, k += 6) {
      const a = j * nx + i
      index.set([a, a + nx, a + 1, a + 1, a + nx, a + nx + 1], k)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))
  geometry.setAttribute('aColor', new THREE.BufferAttribute(color, 3))
  geometry.setIndex(new THREE.BufferAttribute(index, 1))
  const mesh = new THREE.Mesh(geometry, underMaterial())
  mesh.frustumCulled = false
  mesh.layers.enable(CASTER_LAYER)

  /** the way a path runs at a spot beside it: across the slope of the distance to it */
  const pathDirection = (x: number, z: number): Vec3 => {
    const gx = pathDistance(x + 0.3, z) - pathDistance(x - 0.3, z)
    const gz = pathDistance(x, z + 0.3) - pathDistance(x, z - 0.3)
    // on the middle of a path the distance has no slope: the main path runs along z
    return Math.hypot(gx, gz) > 0.05 ? [-gz, 0, gx] : [0, 0, 1]
  }
  const stroke = ({ x, z, d, size }: { x: number; z: number; d: number; size: [number, number] }) => {
    const normal = normalAt(x, z)
    const { color, path } = paintAt({ x, z, d, light: lightOn(...normal), spread: rand(), edge: rand(), pick: rand() })
    // earth is laid along the path. Grass lies any way round, though strokes near each other lie much alike
    let dir = pathDirection(x, z)
    if (!path) {
      const angle = noise(x * 0.11, z * 0.11) * Math.PI * 2.6 + (rand() - 0.5) * 1.4
      dir = [Math.cos(angle), 0, Math.sin(angle)]
    }
    const k = 0.8 + rand() * 0.45
    // laid a little off the ground, each at its own height: where two overlap, the same one is always on top
    const y = heightAt(x, z) + size[0] * (0.05 + rand() * 0.25)
    canvas.solid.lie({ at: [x, y, z], normal, dir, size: [size[0] * k, size[1] * k], color })
  }
  let inner = 0
  for (const band of GROUND_BANDS) {
    const columns = Math.round(GROUND_BLOCK / band.step[0])
    const rows = Math.round(GROUND_BLOCK / band.step[1])
    for (let bz = NEAR.minZ; bz < NEAR.maxZ; bz += GROUND_BLOCK) {
      for (let bx = NEAR.minX; bx < NEAR.maxX; bx += GROUND_BLOCK) {
        const rough = pathDistance(bx + GROUND_BLOCK / 2, bz + GROUND_BLOCK / 2)
        if (rough < inner - GROUND_BLOCK || rough >= band.reach + GROUND_BLOCK) continue
        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < columns; i++) {
            const x = bx + ((i + rand()) / columns) * GROUND_BLOCK
            const z = bz + ((j + rand()) / rows) * GROUND_BLOCK
            const d = pathDistance(x, z)
            if (d >= inner && d < band.reach) stroke({ x, z, d, size: band.size })
          }
        }
      }
    }
    inner = band.reach
  }
  for (let z = minZ; z < maxZ; z += FAR_GROUND.step) {
    for (let x = minX; x < maxX; x += FAR_GROUND.step) {
      const px = x + rand() * FAR_GROUND.step
      const pz = z + rand() * FAR_GROUND.step
      if (px > NEAR.minX && px < NEAR.maxX && pz > NEAR.minZ && pz < NEAR.maxZ) continue
      stroke({ x: px, z: pz, d: 1000, size: FAR_GROUND.size })
    }
  }

  // grass and fern: in drifts beside the paths, where the player sees them close
  for (let gz = NEAR.minZ; gz < NEAR.maxZ; gz += TUFT_STEP) {
    for (let gx = NEAR.minX; gx < NEAR.maxX; gx += TUFT_STEP) {
      const x = gx + rand() * TUFT_STEP
      const z = gz + rand() * TUFT_STEP
      const d = pathDistance(x, z)
      if (d < 1.1 || d > TUFT_REACH) continue
      const [, open, forest] = zones.sample(x, z)
      const drift = smooth(0.4, 0.62, fbm(x * 0.09 + 31, z * 0.09 + 7))
      // thick beside the path, thinner away from it
      if (rand() > (0.12 + 0.6 * drift) * lerp(1, 0.35, d / TUFT_REACH)) continue
      const at: Vec3 = [x, heightAt(x, z), z]
      const fern = forest * (1 - smooth(0.1, 0.32, open)) > 0.5
      const lit = clamp(0.3 + open * 0.7 + (fbm(x * 0.045, z * 0.045) - 0.5) * 0.5 - duskAt(z) * 0.3, 0, 1)
      paintTuft(canvas, { at, kind: fern ? 'fern' : 'grass', style: fern ? FERN_TUFT : GRASS_TUFT, lit })
      // a flower head over the grass now and then
      if (!fern && open > 0.1 && rand() < 0.08) {
        canvas.leaves.face({ at: [x, at[1] + 0.3 + rand() * 0.25, z], dir: [rand() - 0.5, 1, rand() - 0.5], size: [0.07, 0.09], color: rand() < 0.5 ? FLOWER : FLOWERS.colors[0], marks: MARKS.pressed })
      }
    }
  }
  return mesh
}

// ---------- geometry helpers ----------

/** A roof with two slopes, ridge along z. w wide, h high, d deep. Its foot is at y 0. */
function gableRoof({ w, h, d }: { w: number; h: number; d: number }) {
  const x = w / 2
  const z = d / 2
  const v = [-x, 0, -z, x, 0, -z, 0, h, -z, -x, 0, z, x, 0, z, 0, h, z]
  // faces wound to point outward: the light is taken from their normals
  const faces = [0, 2, 1, 3, 4, 5, 0, 5, 2, 0, 3, 5, 1, 5, 4, 1, 2, 5]
  const position = new Float32Array(faces.flatMap((i) => v.slice(i * 3, i * 3 + 3)))
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))
  return geometry
}

const translation = (by: Vec3) => new THREE.Matrix4().makeTranslation(...by)

/** How near the player can come to a spot, metres. 0 where the player can walk. */
const reachOf = (x: number, z: number) => Math.max(0, Math.abs(x) - (valleyHalfWidth(-z) * 0.95 + 4), z - 84, -238 - z)

// ---------- how each kind of thing is painted ----------

// How the dabs of each mesh behave. Sizes on screen are in pixels of the reference frame. The wind is strong:
// `gust` is how far a full gust pushes a dab, `sway` how far it flutters on its own, metres.
// `far` holds what stands beyond the valley: it is painted in its own airy colours and takes no mist or shade.
const KINDS: Record<'solid' | 'wood' | 'leaves' | 'blades' | 'far' | 'sky', DabKind> = {
  solid: { min: [1.7, 3.1], jitter: 0.45 },
  wood: { min: [1.1, 2.8], max: [30, 125], sway: 0.03, gust: 0.4, jitter: 0.6 },
  leaves: { min: [1.75, 2.8], max: [36, 56], sway: 0.06, gust: 0.22, jitter: 0.55, shade: 0.5 },
  blades: { min: [0.85, 4.2], max: [15, 105], sway: 0.03, gust: 0.22, jitter: 0.55 },
  far: { min: [1.7, 3.1], jitter: 0.35, shade: 0, mist: false, layered: true },
  sky: { min: [1.6, 3], jitter: 0.2, shade: 0, mist: false, layered: true },
}

// leaves torn off by the wind: mostly green, some turned yellow or brown
const FLYING_LEAVES: { count: number; box: Vec3; speed: number; colors: RGB[] } = {
  count: 2600,
  box: [44, 16, 44],
  speed: 9,
  colors: [tone('bushy', 0.7), tone('bushy', 0.9), tone('grass', 0.8), tone('grass', 0.95), tone('canopy', 0.9), tone('path', 0.4), tone('roof', 0.7)],
}

const BARK: TrunkStyle = { ramp: 'bark', base: 0.2, light: 0.85, noise: 0.7, moss: { ramp: 'forestFloor', base: 0.4, light: 0.6, noise: 0.4 } }
const FOREST_WALL: SolidStyle = { ramp: 'bark', base: 0, light: 0.3, noise: 0.6, stroke: [2.5, 8], free: true }

const CANOPY: Tone = { ramp: 'canopy', base: 0, light: 0.75, noise: 0.45, clump: [0.5, 2.5] }
// how closely a crown is seen sets how fine it is painted
const CROWN: Record<'near' | 'mid' | 'far', CrownStyle> = {
  near: { ...CANOPY, lobe: [0.8, 1.3], leaves: 70, touch: 0.3 },
  mid: { ...CANOPY, lobe: [1.4, 2.1], leaves: 26, touch: 0.34 },
  far: { ...CANOPY, lobe: [2.4, 3.4], leaves: 8, touch: 0.42 },
}

const FLOWERS = { colors: [hex('#a5b5a0'), hex('#798c78')], chance: 0.12 }
const SHRUB: Tone = { ramp: 'bushy', base: 0.12, light: 0.8, noise: 0.45, clump: [0.4, 0.8] }
const HERO_BUSH: CrownStyle = { ...SHRUB, lobe: [0.35, 0.6], leaves: 60, touch: 0.3 }
const WILD_BUSH: CrownStyle = { ...SHRUB, lobe: [0.4, 0.7], leaves: 40, touch: 0.34 }
const VALLEY_BUSH: CrownStyle = { ...SHRUB, lobe: [0.55, 0.9], leaves: 32, touch: 0.38 }
const LEAFY: CrownStyle = { ramp: 'bushy', base: 0.02, light: 0.85, noise: 0.4, clump: [0.5, 1.4], lobe: [0.6, 0.9], leaves: 56, touch: 0.28 }
const FIR: Tone = { ramp: 'conifer', base: 0.06, light: 0.62, noise: 0.4 }

const WALL: SolidStyle = { ramp: 'wall', base: -0.06, light: 0.92, noise: 0.6, clump: [0.3, 1.5], stroke: [0.3, 0.85], grain: 'level', cover: 9 }
const ROOF: SolidStyle = { ramp: 'roof', base: -0.06, light: 0.92, noise: 0.6, stroke: [0.32, 0.9], cover: 9 }
const TIMBER: SolidStyle = { ramp: 'bark', base: 0.3, light: 0.5, noise: 0.3, stroke: [0.12, 0.5] }
const CASTLE: SolidStyle = { ramp: 'castle', base: -0.02, light: 0.9, noise: 0.45, clump: [0.3, 40], stroke: [2.2, 5.5] }
const CASTLE_ROUND: SolidStyle = { ...CASTLE, smooth: true }
const CRAG_MIST = mistBelow({ top: -30, feather: 30, most: 1 })
const CRAG_ROCK: SolidStyle = { ramp: 'crag', base: -0.2, light: 0.8, noise: 0.4, clump: [0.6, 30], tint: CRAG_MIST, stroke: [4.5, 10], free: true, smooth: true }
const CRAG_FIR: Tone = { ramp: 'cragTree', base: 0.05, light: 0.6, noise: 0.4, tint: CRAG_MIST }
const MOUNTAIN: SolidStyle = { ramp: 'mountain', base: -0.45, light: 1.4, noise: 0.35, clump: [0.75, 70], tint: mistBelow({ top: 230, feather: 200, most: 0.85 }), stroke: [26, 60], free: true, smooth: true }

// ---------- world ----------

export function buildWorld() {
  const scene = new THREE.Scene()
  const colliders: Collider[] = []
  const zones = buildZones()
  const pathDistance = buildPathDistance()
  const rand = mulberry(20260715)
  const range = (a: number, b: number) => lerp(a, b, rand())
  const canvas: Canvas = { under: new Under(), solid: new Dabs(), wood: new Dabs(), leaves: new Dabs(), blades: new Dabs(), rand }
  // what stands beyond the valley is painted on a canvas of its own
  const farDabs = new Dabs()
  const far: Canvas = { ...canvas, under: new Under(), solid: farDabs, wood: farDabs }

  const sky = buildSky(rand)
  scene.add(sky)
  scene.add(buildGround({ canvas, zones, pathDistance }))

  // ----- forest at the start: dark trunks, dark crowns that frame the view -----
  const bigTree = ({ x, z, radius, height, crown = true }: { x: number; z: number; radius: number; height: number; crown?: boolean }) => {
    const ground = groundHeight(x, z)
    const reach = reachOf(x, z)
    // trunks the player can walk up to get every stroke of their bark
    const strokes = reach < 10 ? Math.round(260 + radius * 400) : reach < 35 ? 50 : 0
    paintTrunk(canvas, { x, z, foot: ground, radius, height, strokes, style: BARK })
    colliders.push({ x, z, r: radius + 0.35 })
    if (!crown) return
    const blobs = 3 + Math.floor(rand() * 3)
    for (let i = 0; i < blobs; i++) {
      const rx = range(2.4, 4.4)
      let bx = x + range(-2.6, 2.6)
      const bz = z + range(-2.6, 2.6)
      const by = ground + lerp(height * 0.28, height * 0.95, (i + rand()) / blobs)
      // keep the sky open above the path, except deep in the forest
      const px = pathXAt(bz)
      const gap = 4.2 + rx
      if (bz < 24 && Math.abs(bx - px) < gap) bx = px + Math.sign(bx - px || 1) * gap
      paintCrown(canvas, { center: [bx, by, bz], radius: [rx, range(2, 3.6), rx * range(0.85, 1.15)], style: CROWN[reach < 14 ? 'mid' : 'far'] })
    }
  }

  // hero trees and crowns that frame the first view
  bigTree({ x: -4.6, z: 3, radius: 0.3, height: 34, crown: false })
  bigTree({ x: -6.4, z: -4.5, radius: 0.22, height: 30, crown: false })
  bigTree({ x: 5.5, z: 2, radius: 0.26, height: 33, crown: false })
  bigTree({ x: -8.5, z: 8, radius: 0.6, height: 36 })
  bigTree({ x: 9, z: 7, radius: 0.55, height: 35 })
  // x, height above ground, z, radii
  // prettier-ignore
  const heroCrowns = [
    [-7.2, 9.5, 2, 4.4, 4.6, 4], [-8.6, 16.5, 0, 5.4, 5, 5], [-6, 5.8, -2, 2.3, 2.1, 2.3], [-9.5, 23, 3, 6, 5, 5.5],
    [-10, 4, 5, 3, 3.2, 3], [7.6, 11, 1, 4.7, 5, 4.6], [9.2, 18.5, -1, 5.6, 5, 5], [7.6, 4.6, -3.5, 3, 3.6, 2.8],
    [10, 25, 2, 6, 5, 5.5], [10.5, 5, 4, 3.2, 3.6, 3], [3.9, 3.2, 5, 1.9, 2.2, 1.9], [4.7, 7.6, 3, 2.6, 2.6, 2.6],
    [-4.3, 4.6, 4, 2.2, 2.8, 2.2],
  ]
  for (const [x, y, z, rx, ry, rz] of heroCrowns) paintCrown(canvas, { center: [x, groundHeight(x, z) + y, z], radius: [rx, ry, rz], style: CROWN.near })

  const treeSpots: Point[] = []
  for (let i = 0; i < 2600; i++) {
    const x = range(-125, 125)
    const z = range(-9, 105)
    const [, open] = zones.sample(x, z)
    // the forest opens like a funnel toward the valley, so the castle stays in view
    if (open > 0.1 || Math.abs(x - pathXAt(z)) < 4.5 + 0.4 * Math.max(EYE_START.z - z, 0)) continue
    if (treeSpots.some(([tx, tz]) => Math.hypot(tx - x, tz - z) < 5.2)) continue
    treeSpots.push([x, z])
    bigTree({ x, z, radius: range(0.28, 0.7), height: range(26, 38) })
  }

  // dark wall of forest behind and beside the start, so no sky shows between trunks. Mirrored: it is seen from inside
  {
    const wall = new THREE.CylinderGeometry(128, 128, 46, 72, 1, true, THREE.MathUtils.degToRad(-128), THREE.MathUtils.degToRad(256)).scale(-1, 1, 1)
    paintSolid(canvas, { geometry: wall, style: FOREST_WALL, bias: -0.12, matrix: translation([0, 14, 18]) })
  }

  // ----- bushes -----
  const bush = ({ x, z, size, style, bias }: { x: number; z: number; size: number; style: CrownStyle; bias: number }) => {
    colliders.push({ x, z, r: size * 1.1 })
    paintCrown(canvas, { center: [x, groundHeight(x, z) + size * 0.5, z], radius: [size, size * 0.75, size], style, bias })
  }
  // dark undergrowth beside the path at the start: flowering on the left, as in the reference. x, z, size, flowers
  // prettier-ignore
  const heroBushes: [number, number, number, boolean][] = [
    [-2.1, 10.6, 0.9, true], [-2.9, 8.6, 1.3, true], [-3.6, 6.4, 1.6, true], [-2.6, 4.2, 1.1, true], [-5.2, 8, 1.8, true],
    [2.1, 10.8, 0.9, false], [2.8, 8.8, 1.3, false], [3.4, 6.6, 1.7, false], [4.6, 4.4, 2.1, false], [3.2, 2.4, 1.4, false],
    [5.6, 8, 2, false], [1.8, 12, 0.7, false], [-1.8, 12.1, 0.7, true], [-4.4, -6, 1.3, false], [-5.6, -9.5, 1.6, false],
    [5, -9, 1.4, false],
  ]
  for (const [x, z, size, flowers] of heroBushes) bush({ x, z, size, style: flowers ? { ...HERO_BUSH, accent: FLOWERS } : HERO_BUSH, bias: z > 0 ? -0.25 : -0.15 })
  for (let i = 0; i < 160; i++) {
    const z = range(-63, 60)
    const side = rand() < 0.5 ? -1 : 1
    const x = pathXAt(z) + side * range(3.2, 16)
    const [path] = zones.sample(x, z)
    if (path > 0.05) continue
    bush({ x, z, size: range(0.6, 1.5), style: WILD_BUSH, bias: -0.18 })
  }
  // the valley is full of round shrubs in many greens, as in the reference: they hide most of the ground
  for (let i = 0; i < 620; i++) {
    const z = range(-215, -12)
    const x = pathXAt(z) + range(-1, 1) * lerp(14, 60, smooth(-12, -120, z))
    // small on the slope below the forest, so the valley stays in view
    const size = range(1, 1.7) * lerp(1, 1.8, smooth(-45, -100, z))
    const [, open, shade] = zones.sample(x, z)
    if (pathDistance(x, z) < size * 1.2 + 2.5 || open > 0.3 || shade > 0.6) continue
    bush({ x, z, size, style: VALLEY_BUSH, bias: range(-0.3, 0.25) })
  }

  // ----- round leafy trees of the valley -----
  const leafyTree = ({ x, z, size }: { x: number; z: number; size: number }) => {
    const ground = groundHeight(x, z)
    paintTrunk(canvas, { x, z, foot: ground, radius: 0.26 * size, height: 4.2 * size, strokes: 70, style: BARK, bias: 0.25 })
    colliders.push({ x, z, r: 0.6 })
    const blobs = 3 + Math.floor(rand() * 3)
    for (let i = 0; i < blobs; i++) {
      const r = size * range(1.9, 3)
      // crowns stay above the player's head
      const cy = ground + Math.max(size * range(3.4, 6.2), r + HEAD_ROOM)
      paintCrown(canvas, { center: [x + range(-1.8, 1.8) * size, cy, z + range(-1.8, 1.8) * size], radius: [r, r * 0.82, r], style: LEAFY, bias: Math.abs(z) < 110 ? -0.1 : -0.24 })
    }
  }
  // x, z, size
  // prettier-ignore
  const heroLeafy = [
    [-11, -78, 1.25], [-6, -72, 1.1], [-15, -85, 1.2], [10, -75, 1.3], [18, -70, 1.15], [22, -78, 1.3],
    [9, -66, 1], [-9, -45, 1.1], [8, -42, 1.2], [12, -49, 1], [-13, -53, 1.2],
  ]
  for (const [x, z, size] of heroLeafy) leafyTree({ x, z, size: size * 0.8 })
  const leafySpots: Point[] = []
  for (let i = 0; i < 1500 && leafySpots.length < 45; i++) {
    const x = range(-62, 62)
    const z = range(-240, -35)
    const [path, open, shade] = zones.sample(x, z)
    if (path > 0.02 || open > 0.3 || shade > 0.6) continue
    if (leafySpots.some(([tx, tz]) => Math.hypot(tx - x, tz - z) < 8)) continue
    leafySpots.push([x, z])
    leafyTree({ x, z, size: range(0.5, 0.8) })
  }

  // ----- firs on the valley walls and the far hills -----
  {
    const plant = ({ x, z, scale }: { x: number; z: number; scale: number }) => {
      const height = scale * range(11, 16)
      // firs the player can walk up to are painted bough by bough
      paintFir(canvas, { x, y: groundHeight(x, z) - 0.6, z, height, radius: scale * range(2.3, 3.2), full: reachOf(x, z) < 10, style: FIR, bias: range(-0.18, 0.18) })
      if (Math.abs(x) < 70 && z > -250) colliders.push({ x, z, r: 0.6 })
    }
    for (let z = 112; z > -240; z -= 5.2) {
      for (let x = -455; x < 455; x += 5.2) {
        const tx = x + range(-2.4, 2.4)
        const tz = z + range(-2.4, 2.4)
        const [path, open, shade] = zones.sample(tx, tz)
        if (path > 0.02 || open > 0.12 || tz > -6) continue
        // dense on the walls, sparse singles on the valley floor, none among the big trees of the start
        if (rand() < (shade > 0.5 ? 0.82 : 0.1)) plant({ x: tx, z: tz, scale: 1 })
      }
    }
    for (let z = -240; z > -690; z -= 7.5) {
      for (let x = -455; x < 455; x += 7.5) {
        const tx = x + range(-3.5, 3.5)
        const tz = z + range(-3.5, 3.5)
        const [path, open] = zones.sample(tx, tz)
        if (path > 0.02 || open > 0.12) continue
        if (rand() < 0.9) plant({ x: tx, z: tz, scale: 1.45 })
      }
    }
  }

  // ----- village -----
  const house = ({ x, z, turn, w, d, h, roofBias = 0 }: { x: number; z: number; turn: number; w: number; d: number; h: number; roofBias?: number }) => {
    const place = new THREE.Matrix4().makeRotationY(turn).setPosition(x, groundHeight(x, z), z)
    const at = (by: Vec3) => place.clone().multiply(translation(by))
    paintSolid(canvas, { geometry: new THREE.BoxGeometry(w, h + 3, d), style: WALL, matrix: at([0, h / 2 - 1.5, 0]) })
    paintSolid(canvas, { geometry: gableRoof({ w: w + 1, h: w * 0.5, d: d + 1 }), style: ROOF, bias: roofBias, matrix: at([0, h, 0]) })
    // door and window
    paintSolid(canvas, { geometry: new THREE.BoxGeometry(1.1, 2, 0.3), style: TIMBER, matrix: at([w * 0.15, 1, d / 2]) })
    paintSolid(canvas, { geometry: new THREE.BoxGeometry(0.9, 0.9, 0.3), style: TIMBER, matrix: at([-w * 0.25, h * 0.55, d / 2]) })
    colliders.push({ x, z, r: Math.max(w, d) * 0.6 })
  }
  const tower = ({ x, z, w, h }: { x: number; z: number; w: number; h: number }) => {
    const ground = groundHeight(x, z)
    paintSolid(canvas, { geometry: new THREE.BoxGeometry(w, h + 2, w), style: WALL, bias: -0.08, matrix: translation([x, ground + h / 2 - 1, z]) })
    paintSolid(canvas, { geometry: new THREE.ConeGeometry(w * 0.8, w * 0.9, 4).rotateY(Math.PI / 4), style: ROOF, bias: -0.1, matrix: translation([x, ground + h + w * 0.45, z]) })
    colliders.push({ x, z, r: w * 0.75 })
  }
  // x, z, turn, width, depth, wall height
  // prettier-ignore
  const houses = [
    [-18, -108, 0.2, 15, 10, 7], [-9, -102, -0.3, 10, 8, 6], [4, -86, 0.1, 9, 8, 6], [15, -109, -0.2, 10, 8, 6],
    [31, -109, 0.3, 11, 9, 6.5], [38, -125, 0, 10, 8, 6], [27, -140, 0.4, 10, 8, 6], [-19, -133, 0.1, 11, 9, 6.5],
    [-34, -119, 0.5, 10, 8, 6], [-16, -195, 0, 12, 9, 6.5], [48, -150, -0.3, 10, 8, 6], [-40, -150, 0.2, 10, 8, 6],
    [-62, -160, 0.1, 11, 9, 6.5], [-70, -152, -0.2, 10, 8, 6], [-58, -168, 0.4, 10, 8, 6], [58, -126, 0.2, 10, 8, 6],
    [-6, -123, -0.1, 9, 8, 6],
  ]
  for (const [x, z, turn, w, d, h] of houses) house({ x, z, turn, w: w * HOUSE_SCALE, d: d * HOUSE_SCALE, h: h * 0.55, roofBias: range(-0.34, -0.14) })
  // church on the knoll and two stone towers below it
  house({ x: -2, z: -226, turn: 0, w: 7, d: 12, h: 5.5, roofBias: -0.2 })
  tower({ x: -2, z: -216, w: 3.8, h: 13 })
  tower({ x: 14, z: -175, w: 3.4, h: 8 })
  tower({ x: 6, z: -165, w: 3, h: 5.5 })

  // Far things are laid far to near, in this order: a depth cannot tell two overlapping strokes apart at this
  // distance, so the stroke laid later is on top (`layered` in KINDS).

  // ----- mountains -----
  {
    const peaks = [
      { x: -820, z: -1650, h: 1400, r: 640 },
      { x: -1500, z: -1950, h: 1400, r: 900 },
      { x: -380, z: -2500, h: 1150, r: 560 },
      { x: 230, z: -2700, h: 1100, r: 620 },
      { x: 800, z: -1900, h: 700, r: 900 },
      { x: 1900, z: -2050, h: 1300, r: 1000 },
      { x: -2400, z: -2050, h: 1200, r: 1000 },
      { x: -900, z: -3000, h: 1500, r: 900 },
      { x: 900, z: -3200, h: 1500, r: 1000 },
      { x: 2800, z: -2600, h: 1400, r: 1000 },
    ]
    const mountainHeight = (x: number, z: number) => {
      // each peak is a broad dome that bounds a field of sharp ridges
      let dome = 0
      for (const p of peaks) {
        const dd = Math.hypot(x - p.x, z - p.z) / p.r
        if (dd < 1) dome = Math.max(dome, p.h * (1 - dd * dd))
      }
      const wx = x + 300 * (fbm(x * 0.0012, z * 0.0012) - 0.5)
      const wz = z + 300 * (fbm(x * 0.0012 + 40, z * 0.0012 + 9) - 0.5)
      const ridges = Math.pow(ridged(wx * 0.0026, wz * 0.0026), 1.4)
      const crags = ridged(x * 0.0075 + 9, z * 0.0075 + 3)
      return dome * (0.3 + 1.05 * ridges) + crags * 120 * smooth(0, 300, dome) - 150
    }
    const minX = -3300
    const minZ = -3760
    const step = 30
    const nx = 221
    const nz = 93
    const position = new Float32Array(nx * nz * 3)
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = minX + i * step
        const z = minZ + j * step
        position.set([x, mountainHeight(x, z), z], (j * nx + i) * 3)
      }
    }
    const index: number[] = []
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i
        index.push(a, a + nx, a + 1, a + 1, a + nx, a + nx + 1)
      }
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))
    geometry.setIndex(index)
    paintSolid(far, { geometry, style: MOUNTAIN })
  }

  // ----- castle on its crag -----
  {
    // rock: a polar height field, longer on the right as in the reference. rr: 0 at the middle, 1 at the foot
    const cragPoint = (angle: number, rr: number): Vec3 => {
      const reach = lerp(215, 340, Math.cos(angle) * 0.5 + 0.5) * (0.9 + 0.25 * noise(Math.cos(angle) * 2 + 9, Math.sin(angle) * 2 + 4))
      const x = Math.cos(angle) * reach * rr
      const z = Math.sin(angle) * reach * rr
      // a steep cone with a flat top, cut by radial gullies
      const fall = 1 - Math.pow(clamp((rr - 0.3) / 0.7, 0, 1), 0.9) - 0.06 * smooth(0, 0.3, rr)
      const gully = ridged(Math.cos(angle) * 2.6 + 4, Math.sin(angle) * 2.6 + rr * 1.6) - 0.5
      const rough = ridged(x * 0.02 + 2, z * 0.02 + 5) - 0.5
      const y = -95 + (CRAG.top + 95) * fall + (gully * 90 * (1 - 0.5 * rr) + rough * 40) * smooth(0.28, 0.5, rr)
      return [CRAG.x + x, y, CRAG.z + z]
    }
    const rings = 44
    const segments = 96
    const position: number[] = []
    const index: number[] = []
    for (let i = 0; i <= rings; i++) {
      for (let j = 0; j <= segments; j++) position.push(...cragPoint((j / segments) * Math.PI * 2, i / rings))
    }
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < segments; j++) {
        const a = i * (segments + 1) + j
        const b = a + segments + 1
        index.push(a, a + 1, b, a + 1, b + 1, b)
      }
    }
    const rock = new THREE.BufferGeometry()
    rock.setAttribute('position', new THREE.Float32BufferAttribute(position, 3))
    rock.setIndex(index)
    paintSolid(far, { geometry: rock, style: CRAG_ROCK })

    // castle. Sizes read from the reference frame: 1 unit is 1.167 m, heights are from the castle's foot
    const k = 1.167
    const foot = CRAG.top - 26
    // every part goes down at least this far, so it stands in the rock
    const buried = -110
    const lightWindow = ([x, y, z]: Vec3) => {
      const color = hex(rand() < 0.6 ? '#b24300' : '#d66a00')
      farDabs.face({ at: [CRAG.x + x, y, CRAG.z + z], dir: [0, 1, 0], size: [2.2, 2.8], color, marks: MARKS.pressed, lift: 0.2, pinned: true })
    }
    /** a round shaft from y0 to y1 at x and z, r0 wide at its foot and r1 at its top */
    const column = ({ x, z, y0, y1, r0, r1, bias }: { x: number; z: number; y0: number; y1: number; r0: number; r1: number; bias: number }) => {
      const geometry = new THREE.CylinderGeometry(r1 * k, r0 * k, (y1 - y0) * k, 12, 1, false)
      paintSolid(far, { geometry, style: CASTLE_ROUND, bias, matrix: translation([CRAG.x + x * k, foot + ((y0 + y1) / 2) * k, CRAG.z + z * k]) })
    }
    const spireTower = ({ x, z, r, y0, y1, spire, bias = 0 }: { x: number; z: number; r: number; y0: number; y1: number; spire: number; bias?: number }) => {
      const gallery = y1 + r * 0.7
      column({ x, z, y0: Math.min(y0, buried), y1, r0: r, r1: r * 0.94, bias })
      column({ x, z, y0: y1, y1: gallery, r0: r * 1.22, r1: r * 1.22, bias: bias + 0.05 })
      column({ x, z, y0: gallery, y1: gallery + spire, r0: r * 1.1, r1: 0.35, bias: bias - 0.08 })
      const lit = Math.max(1, Math.round((y1 - y0) / 70))
      for (let i = 0; i < lit; i++) {
        const angle = range(-0.9, 0.5)
        lightWindow([(x + Math.sin(angle) * (r + 2)) * k, foot + lerp(y0 + 30, y1 - 6, rand()) * k, (z + Math.cos(angle) * (r + 2)) * k])
      }
    }
    const hall = ({ x0, x1, z, depth, y0, y1, roof, bias = 0 }: { x0: number; x1: number; z: number; depth: number; y0: number; y1: number; roof: number; bias?: number }) => {
      const w = (x1 - x0) * k
      const cx = CRAG.x + ((x0 + x1) / 2) * k
      const bottom = Math.min(y0, buried)
      paintSolid(far, { geometry: new THREE.BoxGeometry(w, (y1 - bottom) * k, depth * k), style: CASTLE, bias, matrix: translation([cx, foot + ((bottom + y1) / 2) * k, CRAG.z + z * k]) })
      if (roof === 0) return
      const geometry = gableRoof({ w: depth * k * 1.06, h: roof * k, d: w * 1.04 }).rotateY(Math.PI / 2)
      paintSolid(far, { geometry, style: CASTLE, bias: bias - 0.1, matrix: translation([cx, foot + y1 * k, CRAG.z + z * k]) })
    }
    // x, z, radius, lowest window, top of the shaft, spire height, tone bias
    // prettier-ignore
    const towers = [
      [0, 0, 14, -40, 222, 90, 0], [50, 10, 11, -30, 140, 62, 0], [-37, 15, 8.5, -20, 115, 44, 0], [-80, 26, 7.5, -40, 68, 28, 0.2],
      [100, 22, 6, -50, 44, 30, 0], [-30, 46, 4, 30, 84, 16, 0], [45, 46, 4, 20, 80, 16, 0], [10, 52, 3.6, 60, 96, 14, 0],
      [-58, 56, 3.6, 10, 58, 14, 0], [76, 50, 3.6, 10, 60, 14, 0], [22, -6, 5, 100, 172, 20, 0], [-112, 34, 5, -50, -4, 18, 0.1],
    ]
    for (const [x, z, r, y0, y1, spire, bias] of towers) spireTower({ x, z, r, y0, y1, spire, bias })
    // left, right, z, depth, foot, top, roof height (0: flat), tone bias
    // prettier-ignore
    const halls = [
      [-30, 45, 25, 50, -40, 70, 26, 0], [-66, -20, 40, 36, -40, 42, 18, 0.04], [45, 92, 30, 34, -50, 30, 16, 0],
      [-118, -66, 32, 14, -60, -24, 0, 0.08], [-20, 20, -22, 30, 40, 110, 22, -0.04], [88, 122, 30, 14, -70, -6, 0, 0],
    ]
    for (const [x0, x1, z, depth, y0, y1, roof, bias] of halls) hall({ x0, x1, z, depth, y0, y1, roof, bias })
    for (let i = 0; i < 5; i++) lightWindow([range(-60, 85) * k, foot + range(-10, 50) * k, 64 * k])

    // dark firs on the crag: fewer on the left, where the rock is bare
    for (let i = 0; i < 800; i++) {
      const [x, y, z] = cragPoint(range(-1.2, 4.3), range(0.3, 0.98))
      if (x < CRAG.x - 20 && rand() < 0.65) continue
      const height = range(16, 30)
      paintFir(far, { x, y: y - 2, z, height, radius: height * 0.2, full: false, style: CRAG_FIR, bias: range(-0.1, 0.15) })
    }
  }

  // ----- cloud veil: the sky's clouds repeated on a plane before the mountains. Peaks show above it and through its gaps -----
  {
    const VEIL = { z: -1560, step: 16, size: 24 }
    for (let x = -4200; x < 4200; x += VEIL.step) {
      for (let y = -100; y < 1300; y += VEIL.step) {
        const dx = x - EYE_START.x
        const dz = VEIL.z - EYE_START.z
        const az = Math.atan2(dx, -dz)
        const el = Math.atan2(y - EYE_START.y, Math.hypot(dx, dz))
        const { f, color } = skyAt({ az, el, chance: rand() })
        if (f < 0.42 || el > 0.33 + (fbm(az * 9, 2) - 0.5) * 0.2) continue
        const across = VEIL.size * range(0.9, 1.3)
        farDabs.face({ at: [x + range(-0.5, 0.5) * VEIL.step, y + range(-0.5, 0.5) * VEIL.step, VEIL.z + range(-30, 30)], dir: [1, range(-0.25, 0.25), 0], size: [across, across * range(1.6, 2.4)], color, lift: 0 })
      }
    }
  }

  // ----- mist banks: level strokes below a billowy top line, with a light rim -----
  interface Bank {
    z: number
    /** lowest strokes, and the mean top line, metres */
    floor: number
    top: number
    /** how far the top line rises and falls */
    swell: number
    width: number
    /** stroke size across */
    size: number
    /** dark, middle and light tones */
    colors: [RGB, RGB, RGB]
    seed: number
  }
  const bank = ({ z, floor, top, swell, width, size, colors: [dark, mid, light], seed }: Bank) => {
    const step = size * 0.6
    for (let x = -width / 2; x < width / 2; x += step) {
      const rise = fbm(x * 0.006 + seed, seed) * 0.6 + (1 - billow(x * 0.012 + seed, 3)) * 0.4 - 0.5
      // the bank thins out toward its ends
      const crest = top + rise * swell * 2 - smooth(0.3, 0.5, Math.abs(x) / width) * (top - floor)
      for (let y = floor; y < crest; y += step) {
        const patch = fbm(x * 0.01 + seed, y * 0.03)
        // soft patches of light in the body of the bank, and a light rim along its top
        const glow = Math.max(smooth(0.4, 0.6, patch), smooth(size * 2, size * 0.5, crest - y))
        const color = glow < 0.5 ? mixColor(dark, mid, glow * 2) : mixColor(mid, light, glow * 2 - 1)
        // mist lies in long level streaks
        const across = size * range(0.6, 0.9)
        farDabs.face({ at: [x + range(-0.5, 0.5) * step, y + range(-0.5, 0.5) * step, z + range(-20, 20)], dir: [1, range(-0.12, 0.12), 0], size: [across, across * range(3, 4.5)], color, lift: 0 })
      }
    }
  }
  bank({ z: -600, floor: -70, top: 40, swell: 40, width: 2800, size: 13, colors: [hex('#39396a'), hex('#4b4871'), hex('#5f5779')], seed: 3.7 })
  bank({ z: -990, floor: -70, top: 95, swell: 60, width: 3600, size: 20, colors: [hex('#29285a'), hex('#39396a'), hex('#4b4871')], seed: 11.3 })

  // the underpainting of the valley is what stands in the sun's way
  const under = canvas.under.build()
  under.layers.enable(CASTER_LAYER)
  scene.add(under, far.under.build({ ...KINDS.far, pushBack: true }))
  // far strokes are drawn after the valley, so the depth of what stands before them cuts them
  const farStrokes = farDabs.build(KINDS.far)
  farStrokes.renderOrder = 5
  scene.add(canvas.solid.build(KINDS.solid), canvas.wood.build(KINDS.wood), canvas.leaves.build(KINDS.leaves), canvas.blades.build(KINDS.blades), farStrokes)
  scene.add(buildFlyingLeaves({ ...FLYING_LEAVES, rand }))

  return {
    scene,
    sky,
    colliders,
    walkable: (x: number, z: number) => reachOf(x, z) === 0,
    /** true on the trodden earth of a path: steps sound different there */
    onPath: (x: number, z: number) => zones.sample(x, z)[0] > 0.4,
    start: { x: EYE_START.x, z: EYE_START.z, yaw: 0, pitch: -0.05 },
    counts: { solid: canvas.solid.count, wood: canvas.wood.count, leaves: canvas.leaves.count, blades: canvas.blades.count, far: farDabs.count },
  }
}

export type World = ReturnType<typeof buildWorld>
