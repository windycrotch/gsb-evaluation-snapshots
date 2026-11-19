// Painters for kinds of things, after the scenes of https://patch.gg/blendi/oil-paint. Each lays an underpainting
// (a plain dark shape that hides what is behind) and the strokes over it.
//
//   paintSolid ── made things and rock: strokes that lie on every face and run along its grain
//   paintCrown ── leaves: lobes of pressed dabs round a dark core
//   paintTrunk ── long strokes of bark up a pole, moss at its foot
//   paintFir ──── tiers of boughs that hang out and down round a dark cone
//   paintTuft ─── grass and fern: flicks of the brush pinned by the foot
import * as THREE from 'three'
import { MARKS, lerp, lightOn, noise, smooth, tone } from './paint.ts'
import type { Dabs, RGB, RampName, Under, Vec3 } from './paint.ts'

/** What the painters work on. Dabs are kept by how they behave on screen (see the limits in world.ts). */
export interface Canvas {
  under: Under
  /** strokes on the ground, on made things and on rock */
  solid: Dabs
  /** bark and boughs */
  wood: Dabs
  /** leaves: they sway */
  leaves: Dabs
  /** grass and fern, pinned by the foot: they bend */
  blades: Dabs
  rand: () => number
}

/** How a thing takes its colour: tone = base + light * (how lit it is) + chance */
export interface Tone {
  ramp: RampName
  base: number
  light: number
  /** random tone spread from dab to dab */
  noise: number
  /** soft patches of light and dark: strength and size in metres */
  clump?: [number, number]
  /** last touch on a mixed colour, by place: haze, mist */
  tint?: (color: RGB, at: Vec3) => RGB
}

function colorOf(style: Tone, { at, lit, shift }: { at: Vec3; lit: number; shift: number }): RGB {
  let t = style.base + shift + lit * style.light
  if (style.clump) {
    const k = 1 / style.clump[1]
    t += (noise(at[0] * k + at[1] * k * 0.61, at[2] * k + at[1] * k * 0.37) - 0.5) * style.clump[0]
  }
  const rgb = tone(style.ramp, t)
  return style.tint ? style.tint(rgb, at) : rgb
}

const UP = new THREE.Vector3(0, 1, 0)
// the underpainting is a little darker than the strokes on it
const UNDER_SHIFT = -0.1
// A mark fills about half of its card, so strokes are laid several times over a face to hide the underpainting.
const DEFAULT_COVER = 4.5

// ---------- made things and rock ----------

export interface SolidStyle extends Tone {
  /** stroke size across and along, metres */
  stroke: [number, number]
  /** the way strokes run on a face: up it (up a wall, down a roof) or level along it. Default up */
  grain?: 'up' | 'level'
  /** how many times over the strokes cover a face */
  cover?: number
  /** round things take the light from their vertex normals, not from each flat face */
  smooth?: boolean
  /** the faces make one surface (rock): strokes may be larger than the face they are on */
  free?: boolean
}

/**
 * Keeps every face as underpainting and lays strokes on it. Faces must be wound outward.
 * bias shifts the tone of the whole thing: negative is darker.
 * lightOf: how lit a face with this normal is, 0..1. The sun by default; a thing that turns needs a light that
 * turns with it.
 */
export function paintSolid(
  canvas: Canvas,
  { geometry: source, style, bias = 0, matrix, lightOf = lightOn }: { geometry: THREE.BufferGeometry; style: SolidStyle; bias?: number; matrix?: THREE.Matrix4; lightOf?: (nx: number, ny: number, nz: number) => number },
) {
  if (!source.attributes.normal) source.computeVertexNormals()
  const geometry = source.index ? source.toNonIndexed() : source
  if (matrix) geometry.applyMatrix4(matrix)
  if (!style.smooth) geometry.computeVertexNormals()
  const position = geometry.attributes.position
  const normal = geometry.attributes.normal
  const color = new Float32Array(position.count * 3)
  const { rand } = canvas
  const cover = style.cover ?? DEFAULT_COVER
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const e1 = new THREE.Vector3()
  const e2 = new THREE.Vector3()
  const e3 = new THREE.Vector3()
  const n = new THREE.Vector3()
  const grain = new THREE.Vector3()
  const cross = new THREE.Vector3()
  const centre = new THREE.Vector3()
  const p = new THREE.Vector3()

  for (let i = 0; i < position.count; i += 3) {
    a.fromBufferAttribute(position, i)
    b.fromBufferAttribute(position, i + 1)
    c.fromBufferAttribute(position, i + 2)
    e1.subVectors(b, a)
    e2.subVectors(c, a)
    n.crossVectors(e1, e2)
    const area = n.length() / 2
    if (area < 1e-9) continue
    n.normalize()

    for (let v = i; v < i + 3; v++) {
      const at: Vec3 = [position.getX(v), position.getY(v), position.getZ(v)]
      color.set(colorOf(style, { at, lit: lightOf(normal.getX(v), normal.getY(v), normal.getZ(v)), shift: bias + UNDER_SHIFT }), v * 3)
    }

    if (style.grain === 'level') grain.crossVectors(n, UP)
    else grain.copy(UP).addScaledVector(n, -n.y)
    // a level face has no up: its strokes run along its first edge
    if (grain.lengthSq() < 1e-4) grain.copy(e1)
    grain.normalize()
    cross.crossVectors(n, grain)

    let [across, along] = style.stroke
    let pull = 0
    if (!style.free) {
      // a stroke is never larger than the face it is on: a window bar is painted with small touches
      e3.subVectors(e2, e1)
      const long = Math.max(Math.abs(e1.dot(grain)), Math.abs(e2.dot(grain)), Math.abs(e3.dot(grain)))
      const wide = Math.max(Math.abs(e1.dot(cross)), Math.abs(e2.dot(cross)), Math.abs(e3.dot(cross)))
      across = Math.max(0.012, Math.min(across, wide * 1.05))
      along = Math.max(0.02, Math.min(along, long * 1.05))
      // and is kept a little off the edges it would hang over
      pull = 0.35 * Math.min(1, Math.max(across / Math.max(wide, 1e-4), along / Math.max(long, 1e-4)))
      centre.copy(a).add(b).add(c).divideScalar(3)
    }
    const count = Math.floor((area / (across * along)) * cover + rand())
    for (let k = 0; k < count; k++) {
      // a uniform point of the triangle
      let u = rand()
      let w = rand()
      if (u + w > 1) {
        u = 1 - u
        w = 1 - w
      }
      p.copy(a).addScaledVector(e1, u).addScaledVector(e2, w).lerp(centre, pull)
      let nn: Vec3 = [n.x, n.y, n.z]
      if (style.smooth) {
        const s = 1 - u - w
        nn = [
          normal.getX(i) * s + normal.getX(i + 1) * u + normal.getX(i + 2) * w,
          normal.getY(i) * s + normal.getY(i + 1) * u + normal.getY(i + 2) * w,
          normal.getZ(i) * s + normal.getZ(i + 1) * u + normal.getZ(i + 2) * w,
        ]
      }
      const turn = (rand() - 0.5) * 0.35
      const size: [number, number] = [across * (0.8 + 0.4 * rand()), along * (0.75 + 0.5 * rand())]
      // laid a little off the face, each at its own height: where two overlap, the same one is always on top
      const lift = size[0] * (0.03 + 0.07 * rand())
      const at: Vec3 = [p.x + n.x * lift, p.y + n.y * lift, p.z + n.z * lift]
      canvas.solid.lie({
        at,
        normal: nn,
        dir: [grain.x + cross.x * turn, grain.y + cross.y * turn, grain.z + cross.z * turn],
        size,
        color: colorOf(style, { at, lit: lightOf(...nn), shift: bias + (rand() - 0.5) * style.noise }),
      })
    }
  }
  canvas.under.push(position.array, color)
}

// ---------- leaves ----------

export interface CrownStyle extends Tone {
  /** radius of a lobe of leaves, metres: smallest and largest */
  lobe: [number, number]
  /** leaf dabs to a lobe */
  leaves: number
  /** a leaf's size across, as a share of its lobe's radius */
  touch: number
  /** now and then a dab in another colour: flowers */
  accent?: { colors: RGB[]; chance: number }
}

// the dark inside of a crown: smaller than the crown, so the leaves and the cores of the lobes hide its flat faces
const BLOB = new THREE.IcosahedronGeometry(1, 2).attributes.position
const BLOB_SCALE = 0.68

function unit(rand: () => number): Vec3 {
  // a uniform direction
  const y = rand() * 2 - 1
  const angle = rand() * Math.PI * 2
  const flat = Math.sqrt(1 - y * y)
  return [Math.cos(angle) * flat, y, Math.sin(angle) * flat]
}

function normalized([x, y, z]: Vec3): Vec3 {
  const length = Math.hypot(x, y, z) || 1
  return [x / length, y / length, z / length]
}

/**
 * A mass of leaves: an ellipsoid of dark underpainting, and round it lobes of leaf dabs, each with a dark core.
 * A lobe's leaves stand off it, so the outline is ragged.
 */
export function paintCrown(canvas: Canvas, { center, radius, style, bias = 0 }: { center: Vec3; radius: Vec3; style: CrownStyle; bias?: number }) {
  const { rand } = canvas
  // the inside of the mass: dark, but not a hole
  const dark = (at: Vec3, lit: number) => colorOf(style, { at, lit: lit * 0.6, shift: bias - 0.16 })

  const position = new Float32Array(BLOB.count * 3)
  const color = new Float32Array(BLOB.count * 3)
  for (let i = 0; i < BLOB.count; i++) {
    const at: Vec3 = [center[0] + BLOB.getX(i) * radius[0] * BLOB_SCALE, center[1] + BLOB.getY(i) * radius[1] * BLOB_SCALE, center[2] + BLOB.getZ(i) * radius[2] * BLOB_SCALE]
    position.set(at, i * 3)
    color.set(dark(at, lightOn(BLOB.getX(i), BLOB.getY(i), BLOB.getZ(i))), i * 3)
  }
  canvas.under.push(position, color)

  // lobes: as many as cover the ellipsoid
  const mean = (style.lobe[0] + style.lobe[1]) / 2
  const [rx, ry, rz] = radius
  const area = 4 * Math.PI * (((rx * ry) ** 1.6 + (rx * rz) ** 1.6 + (ry * rz) ** 1.6) / 3) ** (1 / 1.6)
  const lobes = Math.max(3, Math.round((area / (Math.PI * mean * mean)) * 0.8))
  for (let i = 0; i < lobes; i++) {
    const away = unit(rand)
    const lobe: Vec3 = [center[0] + away[0] * rx * 0.85, center[1] + away[1] * ry * 0.85, center[2] + away[2] * rz * 0.85]
    const size = lerp(style.lobe[0], style.lobe[1], rand())
    // the dark of the inside of the lobe, pushed back behind its leaves
    for (let k = 0; k < 2; k++) {
      const at: Vec3 = [lobe[0] + (rand() - 0.5) * size * 0.5, lobe[1] - size * 0.15 * k, lobe[2] + (rand() - 0.5) * size * 0.5]
      canvas.leaves.face({ at, dir: unit(rand), size: [size * 1.25, size * 1.5], color: dark(at, 0.5), marks: MARKS.pressed, lift: -0.4 })
    }
    for (let k = 0; k < style.leaves; k++) {
      const [ux, uy, uz] = unit(rand)
      const out = normalized([ux + away[0] * 0.5, uy + away[1] * 0.5 + 0.15, uz + away[2] * 0.5])
      const reach = size * (0.72 + rand() * 0.4)
      const at: Vec3 = [lobe[0] + out[0] * reach, lobe[1] + out[1] * reach, lobe[2] + out[2] * reach]
      // lit as a part of its lobe and of the whole crown at once
      const whole = normalized([(at[0] - center[0]) / rx, (at[1] - center[1]) / ry, (at[2] - center[2]) / rz])
      const normal = normalized([out[0] * 0.6 + whole[0] * 0.55, out[1] * 0.6 + whole[1] * 0.55, out[2] * 0.6 + whole[2] * 0.55])
      // the underside of a mass of leaves is in its own shade
      const lit = lightOn(...normal) * lerp(0.6, 1, smooth(-0.7, 0.1, normal[1]))
      const accent = style.accent && rand() < style.accent.chance ? style.accent.colors[Math.floor(rand() * style.accent.colors.length)] : undefined
      const across = size * style.touch * (accent ? 0.5 : 1 + rand() * 0.6)
      // leaves lie round their lobe and hang a little
      const round = unit(rand)
      canvas.leaves.face({
        at,
        dir: [normal[1] * round[2] - normal[2] * round[1], normal[2] * round[0] - normal[0] * round[2] - 0.35, normal[0] * round[1] - normal[1] * round[0]],
        size: [across, across * (accent ? 1.2 : 1.5 + rand() * 0.5)],
        color: accent ?? colorOf(style, { at, lit, shift: bias + (rand() - 0.5) * style.noise }),
        marks: MARKS.pressed,
      })
    }
  }
}

// ---------- trunks ----------

export interface TrunkStyle extends Tone {
  /** moss low on the trunk */
  moss: Tone
}

const TRUNK_SIDES = 10
// bark is painted up to this height: above it the trunk is lost among the leaves
const BARK_TOP = 16
const MOSS_TOP = 2.6

/** A pole that narrows upward, with `strokes` long strokes of bark up it. foot: height of the ground it stands on. */
export function paintTrunk(canvas: Canvas, { x, z, foot, radius, height, strokes, style, bias = 0 }: { x: number; z: number; foot: number; radius: number; height: number; strokes: number; style: TrunkStyle; bias?: number }) {
  const { rand } = canvas
  // it starts below the ground, so its foot never hangs over a slope
  const base = foot - 1
  const radiusAt = (y: number) => radius * lerp(1.15, 0.7, y / height)
  const pole = new THREE.CylinderGeometry(radiusAt(height), radiusAt(-1), height + 1, TRUNK_SIDES, 1, true).toNonIndexed().translate(x, base + (height + 1) / 2, z)
  const position = pole.attributes.position
  const normal = pole.attributes.normal
  const color = new Float32Array(position.count * 3)
  for (let i = 0; i < position.count; i++) {
    const at: Vec3 = [position.getX(i), position.getY(i), position.getZ(i)]
    color.set(colorOf(style, { at, lit: lightOn(normal.getX(i), normal.getY(i), normal.getZ(i)), shift: bias }), i * 3)
  }
  canvas.under.push(position.array, color)

  const lean: Vec3 = [(rand() - 0.5) * 0.08, 1, (rand() - 0.5) * 0.08]
  const top = Math.min(height, BARK_TOP)
  for (let k = 0; k < strokes; k++) {
    const y = Math.pow(rand(), 1.3) * top
    const angle = rand() * Math.PI * 2
    const r = radiusAt(y)
    const normalAt: Vec3 = [Math.cos(angle), 0, Math.sin(angle)]
    const at: Vec3 = [x + normalAt[0] * r, foot + y, z + normalAt[2] * r]
    const lit = lightOn(normalAt[0], 0.15, normalAt[2])
    const shift = bias + (rand() - 0.5) * style.noise
    // moss low down, more of it on the side away from the light
    const mossy = y < MOSS_TOP && rand() < 0.45 * (1 - y / MOSS_TOP) + 0.15 * (1 - lit)
    canvas.wood.face({
      at,
      dir: lean,
      size: [Math.min(0.5, r * 0.75) * (0.8 + 0.4 * rand()), mossy ? 0.5 + rand() * 0.6 : 1 + rand() * 1.5],
      color: colorOf(mossy ? style.moss : style, { at, lit, shift }),
      marks: MARKS.strokes,
      normal: normalAt,
      // bark stands still in the wind
      bend: 0,
    })
  }
}

// ---------- firs ----------

const FIR_SIDES = 7
// the dark cone inside a fir stops short of the top, which bends in the wind
const FIR_CONE_TOP = 0.88
// a fir bends from its foot: its top moves this many times the gust for every metre of height
const FIR_BEND = 1 / 12

/**
 * A narrow spire: tiers of boughs that hang out and down from the trunk, a stroke for each bough. Inside is a
 * plain dark cone that hides the far side. full: painted bough by bough; otherwise in a dozen touches.
 */
export function paintFir(canvas: Canvas, { x, y, z, height, radius, full, style, bias = 0 }: { x: number; y: number; z: number; height: number; radius: number; full: boolean; style: Tone; bias?: number }) {
  const { rand } = canvas
  const cone = new Float32Array(FIR_SIDES * 9)
  const color = new Float32Array(FIR_SIDES * 9)
  const dark = colorOf(style, { at: [x, y, z], lit: 0.15, shift: bias - 0.2 })
  for (let s = 0; s < FIR_SIDES; s++) {
    const a0 = (s / FIR_SIDES) * Math.PI * 2
    const a1 = ((s + 1) / FIR_SIDES) * Math.PI * 2
    const r = radius * 0.72
    cone.set([x, y + height * FIR_CONE_TOP, z, x + Math.cos(a1) * r, y, z + Math.sin(a1) * r, x + Math.cos(a0) * r, y, z + Math.sin(a0) * r], s * 9)
    for (let v = 0; v < 3; v++) color.set(dark, s * 9 + v * 3)
  }
  canvas.under.push(cone, color)

  const tiers = full ? Math.round(8 + height * 0.9) : 4
  const lean = [(rand() - 0.5) * 0.06, (rand() - 0.5) * 0.06]
  for (let i = 0; i < tiers; i++) {
    // 0 at the foot, 1 at the top
    const up = (i + 0.4) / tiers
    const tierY = y + height * (0.1 + 0.88 * up)
    const reach = radius * Math.pow(1 - up, 0.8) + 0.1
    const cx = x + height * lean[0] * up
    const cz = z + height * lean[1] * up
    // many small boughs on a fir seen close, a few broad touches on a far one
    const boughs = full ? Math.round(4 + reach * 6) : 3
    const span = full ? 0.5 : 1
    const start = rand() * Math.PI * 2
    const droop = 0.35 + 0.55 * (1 - up)
    for (let k = 0; k < boughs; k++) {
      const angle = start + ((k + rand() * 0.5) / boughs) * Math.PI * 2
      const ox = Math.cos(angle)
      const oz = Math.sin(angle)
      // boughs of one tier reach out to different lengths
      const out = reach * (full ? 0.45 + 0.4 * rand() : 0.55)
      const at: Vec3 = [cx + ox * out, tierY - out * droop * 0.8, cz + oz * out]
      // a bough is light on its upper side, toward the light, and dark where it hangs under the next
      const lit = lightOn(ox * 0.8, 0.5, oz * 0.8)
      canvas.wood.face({
        at,
        dir: [ox, -droop, oz],
        size: [(reach * (0.85 - 0.3 * up) * span + 0.1) * (0.85 + 0.3 * rand()), (reach * (1.35 - 0.4 * up) * span + 0.25) * (0.85 + 0.3 * rand())],
        color: colorOf(style, { at, lit, shift: bias + (rand() - 0.5) * style.noise }),
        lift: 0.25,
        bend: Math.pow(up, 1.5) * height * FIR_BEND,
      })
    }
  }
  const tip: Vec3 = [x + height * lean[0], y + height * 0.99, z + height * lean[1]]
  canvas.wood.face({ at: tip, dir: [0, 1, 0], size: [0.3 + height * 0.02, 0.9 + height * 0.06], color: colorOf(style, { at: tip, lit: 0.6, shift: bias }), marks: MARKS.blades, lift: 0.25, bend: height * FIR_BEND })
}

// ---------- grass and fern ----------

/**
 * A clump: each blade or frond is one flick of the brush, and the flicks fan out from the foot.
 * A frond is a broad curved stroke that arches over; a blade of grass a thin straight one.
 */
export function paintTuft(canvas: Canvas, { at, kind, style, lit }: { at: Vec3; kind: 'grass' | 'fern'; style: Tone; lit: number }) {
  const { rand } = canvas
  const grass = kind === 'grass'
  const flicks = 4 + Math.floor(rand() * 4)
  const turn = rand() * Math.PI * 2
  for (let k = 0; k < flicks; k++) {
    const angle = turn + ((k + rand()) / flicks) * Math.PI * 2
    const lean = grass ? 0.12 + 0.4 * rand() : 0.7 + 0.9 * rand()
    const foot: Vec3 = [at[0] + Math.cos(angle) * (grass ? 0.03 : 0.1), at[1] - 0.02, at[2] + Math.sin(angle) * (grass ? 0.03 : 0.1)]
    canvas.blades.face({
      at: foot,
      dir: [Math.cos(angle) * lean, 1, Math.sin(angle) * lean],
      size: grass ? [0.035 + 0.03 * rand(), 0.3 + 0.4 * rand()] : [0.13 + 0.08 * rand(), 0.4 + 0.45 * rand()],
      color: colorOf(style, { at: foot, lit, shift: (rand() - 0.5) * style.noise }),
      marks: grass ? MARKS.blades : MARKS.frond,
      lift: 0.25,
      foot: true,
    })
  }
}
