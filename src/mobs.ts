// Creatures of the valley: goblins in packs and a few trolls. They are painted in dabs like everything else.
//
//   kind ──▶ buildModel(): five parts painted once with paintSolid, shared by every creature of that kind
//   mob ───▶ a root at its feet ──▶ legs, body ──▶ arms. Each part is two meshes (under, dabs) on shared geometry
//   update() ──▶ think(): the stance (roam, chase, windup, recover, reel, dead) ──▶ move ──▶ pose the parts
//
// A creature is lit from straight above when it is painted: that light stays right as it turns. Sun, shade and
// mist come from the dab shader, by where the creature stands.
import * as THREE from 'three'
import { Dabs, MARKS, Under, clamp, dabMaterial, hex, lerp, mulberry, smooth, tone, underMaterial } from './paint.ts'
import type { DabKind, RGB, RampName, Vec3 } from './paint.ts'
import { paintSolid } from './things.ts'
import type { Canvas, SolidStyle } from './things.ts'
import { groundHeight, pushOut } from './world.ts'
import type { Collider } from './world.ts'

// ---------- kinds ----------

interface MobKind {
  /** size against the model, which is about 1.25 m to the top of its head */
  scale: number
  skin: RampName
  /** wears a jerkin and a pointed cap */
  dressed: boolean
  health: number
  /** metres a second: strolling round its home, and after the player */
  stroll: number
  run: number
  radius: number
  /** it starts a blow when the player is this near, metres */
  reach: number
  /** hearts a blow takes */
  damage: number
  /** it sees the player from this far, metres */
  sight: number
  /** a blow of the sword stops what it was doing */
  reels: boolean
  /** the pitch of its voice against a goblin's: a large creature has a low one */
  voice: number
}

const KINDS = {
  goblin: { scale: 1.2, skin: 'goblin', dressed: true, health: 3, stroll: 0.9, run: 4.3, radius: 0.4, reach: 1.7, damage: 1, sight: 17, reels: true, voice: 1 },
  troll: { scale: 1.9, skin: 'troll', dressed: false, health: 9, stroll: 0.7, run: 3, radius: 0.65, reach: 2.4, damage: 2, sight: 20, reels: false, voice: 0.6 },
} satisfies Record<string, MobKind>

// Packs, in the meadows and on the paths: x, z, goblins, trolls. The first one waits in the forest behind the start.
// prettier-ignore
const CAMPS: [number, number, number, number][] = [
  [-2, 44, 2, 0], [1.5, -27, 3, 0], [15, -84, 3, 0], [-20, -82, 2, 1], [-5, -112, 2, 0], [26, -133, 3, 0],
  [-19, -150, 3, 1], [37, -165, 2, 0], [-37, -120, 2, 0], [8, -204, 3, 1], [-45, -176, 2, 0],
]
const CAMP_RADIUS = 7
const MOB_SPACING = 2.2
const PLACE_TRIES = 60
const SEED = 20261115

// ---------- how they move ----------

const PLAYER_RADIUS = 0.4
const WINDUP_SECONDS = 0.45
const STRIKE_SECONDS = 0.12
const RECOVER_SECONDS = 1.1
const REEL_SECONDS = 0.3
const FALL_SECONDS = 0.55
const LIE_SECONDS = 4
const SINK_SECONDS = 1.6
// a dead creature is back at its home after this long, once the player is this far from there
const RETURN_SECONDS = 50
const RETURN_CLEAR = 70
const ROAM_RADIUS = 5
const ARRIVED = 0.4
// it gives up the chase this far from its home, metres
const LEASH = 55
const LEASH_SLACK = 10
// farther than this from the eye a creature is not drawn and stands still
const VISIBLE_RANGE = 150
const TURN_SPEED = 7
const KNOCK_SPEED = 6.5
const KNOCK_FADE = 7
// a blow still lands this far past the reach it was started at, and misses a player this high in the air
const BLOW_MARGIN = 0.6
// a creature that is struck calls the roaming ones this near to the fight
const ALARM_RADIUS = 16
// a roaming creature this near the player grunts now and then: metres, and grunts a second
const IDLE_HEARD = 26
const IDLE_RATE = 0.07
const DODGE_HEIGHT = 0.8

// ---------- how they look ----------

// least stroke sizes on screen in reference pixels, like KINDS in world.ts
const MOB_DABS: DabKind = { min: [1.3, 2.4], jitter: 0.4 }
const SHADOW_DABS: DabKind = { min: [1.7, 3.1], jitter: 0.25 }
const FLECK_DABS: DabKind = { min: [1.1, 1.7], jitter: 0.5 }
const FLASH = hex('#ffe2a6')
const FLASH_MOST = 0.55
const FLASH_FADE = 9
const EYE = hex('#ffd640')
const SOCKET = hex('#0a0d06')
const SHADOW = tone('forestFloor', 0.2)
const SHADOW_LIFT = 0.1
const BLOOD = [hex('#5a1410'), hex('#8a2415'), hex('#2a0c0c')]

// Joints of the model, metres: the hips above the ground, the shoulders above the hips (the arms hang from the body).
// Every kind is the same creature scaled.
const HIP = 0.4
const SHOULDER = 0.42
const CLUB_SIDE = -1
const ARM_REST = -0.35
const ARM_RAISED = -2.7
const ARM_STRUCK = -0.9
const STRIDE_SWING = 0.75
// radians of stride for a metre walked, at scale 1
const STRIDE_RATE = 7
const SINK_DEPTH = 0.7
// generous bound of a part round its joint, for culling
const PART_REACH = 1.1

type PartName = 'body' | 'armLeft' | 'armRight' | 'legLeft' | 'legRight'

interface Part {
  under: THREE.BufferGeometry
  dabs: THREE.InstancedBufferGeometry
  /** the joint it turns round, in its parent */
  pivot: Vec3
}

interface Brush {
  /** a shape of the body, moved, turned and sized in the model's metres */
  solid: (shape: { geometry: THREE.BufferGeometry; style: SolidStyle; bias?: number; move?: Vec3; turn?: Vec3; size?: Vec3 }) => void
  /** one touch that faces the eye, on the front of the head */
  touch: (dab: { at: Vec3; dir: Vec3; size: [number, number]; color: RGB; lift: number; pinned?: boolean }) => void
}

const fromAbove = (_nx: number, ny: number) => ny * 0.5 + 0.5
const ball = () => new THREE.SphereGeometry(1, 10, 7)

/** Paints the five parts of a creature, each round its own joint. It faces +Z and stands on y 0. */
function buildModel({ kind, rand }: { kind: MobKind; rand: () => number }): Record<PartName, Part> {
  const s = kind.scale
  const scaled = ([x, y, z]: Vec3): Vec3 => [x * s, y * s, z * s]
  const stroke: [number, number] = [0.05 * s, 0.12 * s]
  const skin: SolidStyle = { ramp: kind.skin, base: 0.08, light: 0.85, noise: 0.3, stroke, smooth: true, free: true, cover: 5 }
  const hide: SolidStyle = { ramp: 'hide', base: 0.1, light: 0.75, noise: 0.35, stroke, smooth: true, free: true, cover: 5 }
  const bone: SolidStyle = { ramp: 'bone', base: 0.15, light: 0.75, noise: 0.4, stroke: [0.04 * s, 0.14 * s], smooth: true, free: true, cover: 5 }

  const part = (pivot: Vec3, paint: (brush: Brush) => void): Part => {
    const dabs = new Dabs()
    const under = new Under()
    const canvas: Canvas = { under, solid: dabs, wood: dabs, leaves: dabs, blades: dabs, rand }
    paint({
      solid: ({ geometry, style, bias, move = [0, 0, 0], turn = [0, 0, 0], size = [1, 1, 1] }) => {
        const matrix = new THREE.Matrix4().compose(new THREE.Vector3(...scaled(move)), new THREE.Quaternion().setFromEuler(new THREE.Euler(...turn)), new THREE.Vector3(...scaled(size)))
        paintSolid(canvas, { geometry, style, bias, matrix, lightOf: fromAbove })
      },
      touch: ({ at, dir, size, color, lift, pinned }) => dabs.face({ at: scaled(at), dir, size: [size[0] * s, size[1] * s], color, marks: MARKS.pressed, normal: [0, 0, 1], lift, pinned, bend: 0 }),
    })
    const geometry = dabs.geometry()
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), PART_REACH * s)
    return { under: under.geometry(), dabs: geometry, pivot: scaled(pivot) }
  }

  const leg = (side: number) =>
    part([0.1 * side, HIP, 0], ({ solid }) => {
      solid({ geometry: new THREE.CylinderGeometry(0.075, 0.05, 0.38, 7), style: skin, move: [0, -0.19, 0] })
      // broad flat feet
      solid({ geometry: ball(), style: skin, bias: -0.15, move: [0, -0.37, 0.06], size: [0.075, 0.05, 0.14] })
    })

  const arm = (side: number) =>
    part([0.235 * side, SHOULDER, 0.03], ({ solid }) => {
      solid({ geometry: ball(), style: kind.dressed ? hide : skin, size: [0.08, 0.08, 0.08] })
      // long arms: the hands hang at the knees
      solid({ geometry: new THREE.CylinderGeometry(0.055, 0.04, 0.46, 7), style: skin, move: [0, -0.23, 0] })
      solid({ geometry: ball(), style: skin, bias: -0.1, move: [0, -0.48, 0], size: [0.06, 0.07, 0.06] })
      // a club of bone, thick end away from the hand, held forward and up
      if (side === CLUB_SIDE) solid({ geometry: new THREE.CylinderGeometry(0.085, 0.03, 0.62, 6), style: bone, move: [0, -0.39, 0.18], turn: [1.1, 0, 0] })
    })

  const body = part([0, HIP, 0], ({ solid, touch }) => {
    // a skirt of hides over the hips
    solid({ geometry: new THREE.CylinderGeometry(0.17, 0.25, 0.24, 9, 1, true), style: hide, bias: -0.12, move: [0, 0.02, 0] })
    // belly and chest, hunched forward
    solid({ geometry: ball(), style: kind.dressed ? hide : skin, move: [0, 0.27, 0.03], turn: [0.3, 0, 0], size: [0.21, 0.27, 0.18] })
    // a large head carried low and forward
    solid({ geometry: ball(), style: skin, bias: 0.05, move: [0, 0.66, 0.1], size: [0.2, 0.185, 0.2] })
    for (const side of [1, -1]) {
      // long ears that stand out to the sides: thin flaps
      solid({ geometry: new THREE.ConeGeometry(0.09, 0.4, 4), style: skin, bias: -0.05, move: [0.34 * side, 0.75, 0.06], turn: [0, 0, -1.15 * side], size: [1, 1, 0.3] })
      // eyes that glow out of dark sockets
      touch({ at: [0.085 * side, 0.695, 0.279], dir: [1, 0, 0], size: [0.085, 0.075], color: SOCKET, lift: 0.15 })
      touch({ at: [0.085 * side, 0.695, 0.284], dir: [1, 0, 0], size: [0.042, 0.048], color: EYE, lift: 0.7, pinned: true })
      // tusks: a troll's are large
      const tusk = kind.dressed ? 1 : 1.7
      touch({ at: [0.05 * side, 0.585 + 0.012 * tusk, 0.286], dir: [0, 1, 0], size: [0.02 * tusk, 0.045 * tusk], color: tone('bone', 0.9), lift: 0.7 })
    }
    touch({ at: [0, 0.572, 0.281], dir: [1, 0, 0], size: [0.04, 0.16], color: SOCKET, lift: 0.3 })
    // a long nose that points forward and down
    solid({ geometry: new THREE.ConeGeometry(0.045, 0.17, 5), style: skin, bias: 0.1, move: [0, 0.645, 0.345], turn: [Math.PI / 2 + 0.3, 0, 0] })
    // a pointed cap of rust-red hide that falls back
    if (kind.dressed) solid({ geometry: new THREE.ConeGeometry(0.19, 0.34, 7), style: hide, bias: 0.3, move: [0, 0.9, 0.02], turn: [-0.55, 0, 0] })
  })

  return { body, armLeft: arm(1), armRight: arm(-1), legLeft: leg(1), legRight: leg(-1) }
}

/** A few dark strokes that lie on the ground under a creature. */
function buildShadow({ kind, rand }: { kind: MobKind; rand: () => number }) {
  const dabs = new Dabs()
  const r = kind.radius * 1.1
  for (let i = 0; i < 8; i++) {
    const angle = rand() * Math.PI * 2
    const d = r * 0.6 * Math.sqrt(rand())
    dabs.lie({ at: [Math.cos(angle) * d, 0.01 * i, Math.sin(angle) * d], normal: [0, 1, 0], dir: [rand() - 0.5, 0, rand() - 0.5], size: [r * 0.8, r * 1.2], color: SHADOW })
  }
  const geometry = dabs.geometry()
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), r * 2)
  return geometry
}

// ---------- flecks of paint ----------

const FLECK_COUNT = 140
const FLECK_SECONDS = 1.2
const FLECK_GRAVITY = 14
const FLECK_PARKED: Vec3 = [0, -1000, 0]

/** Flecks of paint that fly off a creature when the sword lands: dabs that are moved every frame. */
function buildFlecks(rand: () => number) {
  const dabs = new Dabs()
  for (let i = 0; i < FLECK_COUNT; i++) {
    dabs.face({ at: FLECK_PARKED, dir: [rand() - 0.5, rand() - 0.5, rand() - 0.5], size: [0.03 + 0.03 * rand(), 0.05 + 0.06 * rand()], color: [0, 0, 0], marks: MARKS.pressed, pinned: true, bend: 0 })
  }
  const geometry = dabs.geometry()
  const position = geometry.getAttribute('aPos')
  const color = geometry.getAttribute('aColor')
  const mesh = new THREE.Mesh(geometry, dabMaterial(FLECK_DABS))
  mesh.frustumCulled = false
  const flying = Array.from({ length: FLECK_COUNT }, () => ({ vx: 0, vy: 0, vz: 0, left: 0 }))
  let next = 0

  return {
    mesh,
    /** count flecks from a spot, thrown along (awayX, awayZ) */
    burst({ at, awayX, awayZ, colors, count }: { at: Vec3; awayX: number; awayZ: number; colors: RGB[]; count: number }) {
      for (let k = 0; k < count; k++) {
        const i = next
        next = (next + 1) % FLECK_COUNT
        const fleck = flying[i]
        const speed = 1 + 3.5 * rand()
        fleck.vx = awayX * speed + (rand() - 0.5) * 3.5
        fleck.vy = 1 + 4.5 * rand()
        fleck.vz = awayZ * speed + (rand() - 0.5) * 3.5
        fleck.left = FLECK_SECONDS * (0.5 + 0.5 * rand())
        position.setXYZ(i, at[0] + (rand() - 0.5) * 0.3, at[1] + (rand() - 0.5) * 0.4, at[2] + (rand() - 0.5) * 0.3)
        const [r, g, b] = colors[Math.floor(rand() * colors.length)]
        color.setXYZ(i, r, g, b)
      }
      position.needsUpdate = color.needsUpdate = true
    },
    update(dt: number) {
      for (let i = 0; i < FLECK_COUNT; i++) {
        const fleck = flying[i]
        if (fleck.left <= 0) continue
        fleck.left -= dt
        fleck.vy -= FLECK_GRAVITY * dt
        const x = position.getX(i) + fleck.vx * dt
        const y = position.getY(i) + fleck.vy * dt
        const z = position.getZ(i) + fleck.vz * dt
        // it is gone when its time is up or it lands
        if (fleck.left <= 0 || y < groundHeight(x, z)) {
          fleck.left = 0
          position.setXYZ(i, ...FLECK_PARKED)
        } else position.setXYZ(i, x, y, z)
        position.needsUpdate = true
      }
    },
  }
}

// ---------- mobs ----------

type Stance = 'roam' | 'chase' | 'windup' | 'recover' | 'reel' | 'dead'

interface Spot {
  x: number
  z: number
}

interface Mob {
  kind: MobKind
  home: Spot
  x: number
  z: number
  /** 0 faces +Z */
  yaw: number
  stance: Stance
  /** seconds in this stance */
  clock: number
  health: number
  /** where it strolls to while it roams, and the clock at which it picks the next spot */
  goal: Spot
  rest: number
  /** knocked back by a blow, metres a second */
  pushX: number
  pushZ: number
  /** phase of its stride, and how fast it goes: 0 standing .. 1 running */
  walk: number
  pace: number
  flash: number
  root: THREE.Group
  body: THREE.Group
  armLeft: THREE.Group
  armRight: THREE.Group
  legLeft: THREE.Group
  legRight: THREE.Group
  shadow: THREE.Mesh
  materials: THREE.ShaderMaterial[]
}

/** Something a creature did that can be heard: it saw the player, swung its club, was struck, died, or grunted. */
export interface MobEvent {
  type: 'alert' | 'blow' | 'hurt' | 'death' | 'idle'
  x: number
  z: number
  /** the pitch of the creature's voice */
  voice: number
}

const eventOf = (mob: Mob, type: MobEvent['type']): MobEvent => ({ type, x: mob.x, z: mob.z, voice: mob.kind.voice })

/** what a creature knows of the player */
export interface Prey {
  x: number
  z: number
  /** height of the feet above the ground */
  air: number
  alive: boolean
}

const UP = new THREE.Vector3(0, 1, 0)
const slope = new THREE.Vector3()
const STILL: { speed: number; damage: number; event?: MobEvent['type'] } = { speed: 0, damage: 0 }

/** the short way from one angle to another */
const turnBetween = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from))

function enter(mob: Mob, stance: Stance) {
  mob.stance = stance
  mob.clock = 0
}

/**
 * One step of a living creature's mind: may change its stance. Says where it wants to go, what its blow does
 * and what is heard of it.
 */
function think({ mob, prey, distance, rand }: { mob: Mob; prey: Prey; distance: number; rand: () => number }) {
  const { kind } = mob
  const toPrey = Math.atan2(prey.x - mob.x, prey.z - mob.z)
  const strayed = Math.hypot(mob.x - mob.home.x, mob.z - mob.home.z)

  if (mob.stance === 'roam') {
    if (prey.alive && distance < kind.sight && strayed < LEASH - LEASH_SLACK) {
      enter(mob, 'chase')
      return { heading: toPrey, ...STILL, event: 'alert' as const }
    }
    // it strolls from spot to spot round its home and stands a while at each
    if (mob.clock > mob.rest) {
      const angle = rand() * Math.PI * 2
      const reach = ROAM_RADIUS * Math.sqrt(rand())
      mob.goal = { x: mob.home.x + Math.cos(angle) * reach, z: mob.home.z + Math.sin(angle) * reach }
      mob.rest = 3 + 6 * rand()
      mob.clock = 0
    }
    const gx = mob.goal.x - mob.x
    const gz = mob.goal.z - mob.z
    if (Math.hypot(gx, gz) < ARRIVED) return { heading: mob.yaw, ...STILL }
    return { heading: Math.atan2(gx, gz), speed: kind.stroll, damage: 0 }
  }

  if (mob.stance === 'chase') {
    if (!prey.alive || strayed > LEASH) {
      enter(mob, 'roam')
      mob.goal = mob.home
      mob.rest = strayed / kind.stroll
      return { heading: mob.yaw, ...STILL }
    }
    if (distance < kind.reach) {
      enter(mob, 'windup')
      return { heading: toPrey, ...STILL }
    }
    return { heading: toPrey, speed: kind.run, damage: 0 }
  }

  if (mob.stance === 'windup') {
    if (mob.clock < WINDUP_SECONDS) return { heading: toPrey, ...STILL }
    enter(mob, 'recover')
    const lands = prey.alive && distance < kind.reach + BLOW_MARGIN && prey.air < DODGE_HEIGHT
    return { heading: mob.yaw, speed: 0, damage: lands ? kind.damage : 0, event: 'blow' as const }
  }

  if (mob.clock > (mob.stance === 'recover' ? RECOVER_SECONDS : REEL_SECONDS)) enter(mob, 'chase')
  return { heading: mob.yaw, ...STILL }
}

/** the angle of the club arm: raised in the windup, brought down in the blow */
function clubAngle(mob: Mob) {
  if (mob.stance === 'windup') return lerp(ARM_REST, ARM_RAISED, smooth(0, WINDUP_SECONDS, mob.clock))
  if (mob.stance !== 'recover') return ARM_REST
  if (mob.clock < STRIKE_SECONDS) return lerp(ARM_RAISED, ARM_STRUCK, mob.clock / STRIKE_SECONDS)
  return lerp(ARM_STRUCK, ARM_REST, smooth(STRIKE_SECONDS, RECOVER_SECONDS, mob.clock))
}

/** Puts the creature's parts where its state says. */
function pose({ mob, time, seen }: { mob: Mob; time: number; seen: boolean }) {
  const s = mob.kind.scale
  const dead = mob.stance === 'dead'
  const sink = dead ? clamp((mob.clock - LIE_SECONDS) / SINK_SECONDS, 0, 1) : 0
  mob.root.visible = seen && sink < 1
  mob.shadow.visible = mob.root.visible && !dead
  if (!mob.root.visible) return

  const ground = groundHeight(mob.x, mob.z)
  mob.root.position.set(mob.x, ground - sink * SINK_DEPTH * s, mob.z)
  // struck, it rocks back; dead, it falls on its back
  const rock = mob.stance === 'reel' ? -0.3 * Math.sin((Math.PI * mob.clock) / REEL_SECONDS) : 0
  mob.root.rotation.set(dead ? (-Math.PI / 2) * smooth(0, FALL_SECONDS, mob.clock) : rock, mob.yaw, 0)

  const stride = Math.min(1, mob.pace * 2)
  const swing = Math.sin(mob.walk) * stride * STRIDE_SWING
  const club = clubAngle(mob)
  const fighting = mob.stance === 'windup' || mob.stance === 'recover'
  mob.legLeft.rotation.x = swing
  mob.legRight.rotation.x = -swing
  mob.armLeft.rotation.x = ARM_REST - swing * 0.8
  mob.armRight.rotation.x = fighting ? club : ARM_REST + swing * 0.8
  mob.armLeft.rotation.z = 0.12
  mob.armRight.rotation.z = -0.12
  // it leans into its run, back in the windup and forward with the blow; it breathes
  const lean = 0.3 * mob.pace + (club - ARM_REST) * (mob.stance === 'windup' ? 0.1 : -0.5)
  mob.body.rotation.x = dead ? 0 : lean + Math.sin(time * 2 + mob.home.x) * 0.025
  mob.body.position.y = (HIP + Math.abs(Math.sin(mob.walk)) * 0.035 * stride) * s

  if (!mob.shadow.visible) return
  const e = 0.4
  slope.set(groundHeight(mob.x - e, mob.z) - groundHeight(mob.x + e, mob.z), 2 * e, groundHeight(mob.x, mob.z - e) - groundHeight(mob.x, mob.z + e)).normalize()
  mob.shadow.position.set(mob.x, ground + SHADOW_LIFT, mob.z)
  mob.shadow.quaternion.setFromUnitVectors(UP, slope)
}

/** Paints the creatures, puts them in their camps and returns what moves them. */
export function buildMobs({ scene, colliders, walkable }: { scene: THREE.Scene; colliders: Collider[]; walkable: (x: number, z: number) => boolean }) {
  const rand = mulberry(SEED)
  const flecks = buildFlecks(rand)
  scene.add(flecks.mesh)
  const shadowMaterial = dabMaterial(SHADOW_DABS)
  const mobs: Mob[] = []

  const clear = ({ x, z, radius }: Spot & { radius: number }) => {
    if (!walkable(x, z)) return false
    const out = pushOut({ x, z, radius: radius + 0.3, colliders })
    return out.x === x && out.z === z && mobs.every((mob) => Math.hypot(mob.x - x, mob.z - z) > MOB_SPACING)
  }

  const spawn = ({ kind, model, shadow, camp }: { kind: MobKind; model: Record<PartName, Part>; shadow: THREE.BufferGeometry; camp: Spot }) => {
    for (let i = 0; i < PLACE_TRIES; i++) {
      const angle = rand() * Math.PI * 2
      const reach = CAMP_RADIUS * Math.sqrt(rand())
      const home = { x: camp.x + Math.cos(angle) * reach, z: camp.z + Math.sin(angle) * reach }
      if (!clear({ ...home, radius: kind.radius })) continue
      // one pair of materials for the whole creature: it flares as one when it is struck
      const materials = [dabMaterial(MOB_DABS), underMaterial()]
      for (const material of materials) material.uniforms.uFlash.value.set(...FLASH, 0)
      const limb = (part: Part) => {
        const group = new THREE.Group()
        group.position.set(...part.pivot)
        group.add(new THREE.Mesh(part.under, materials[1]), new THREE.Mesh(part.dabs, materials[0]))
        return group
      }
      const mob: Mob = {
        kind,
        home,
        ...home,
        yaw: rand() * Math.PI * 2,
        stance: 'roam',
        clock: 0,
        health: kind.health,
        goal: home,
        rest: 6 * rand(),
        pushX: 0,
        pushZ: 0,
        walk: rand() * Math.PI * 2,
        pace: 0,
        flash: 0,
        root: new THREE.Group(),
        body: limb(model.body),
        armLeft: limb(model.armLeft),
        armRight: limb(model.armRight),
        legLeft: limb(model.legLeft),
        legRight: limb(model.legRight),
        shadow: new THREE.Mesh(shadow, shadowMaterial),
        materials,
      }
      mob.root.rotation.order = 'YXZ'
      mob.body.add(mob.armLeft, mob.armRight)
      mob.root.add(mob.body, mob.legLeft, mob.legRight)
      scene.add(mob.root, mob.shadow)
      mobs.push(mob)
      return
    }
  }

  const models = {
    goblin: { kind: KINDS.goblin, model: buildModel({ kind: KINDS.goblin, rand }), shadow: buildShadow({ kind: KINDS.goblin, rand }) },
    troll: { kind: KINDS.troll, model: buildModel({ kind: KINDS.troll, rand }), shadow: buildShadow({ kind: KINDS.troll, rand }) },
  }
  for (const [x, z, goblins, trolls] of CAMPS) {
    for (let i = 0; i < trolls; i++) spawn({ ...models.troll, camp: { x, z } })
    for (let i = 0; i < goblins; i++) spawn({ ...models.goblin, camp: { x, z } })
  }

  const revive = (mob: Mob) => {
    Object.assign(mob, mob.home, { health: mob.kind.health, goal: mob.home, rest: 0, pushX: 0, pushZ: 0, flash: 0 })
    enter(mob, 'roam')
  }

  const move = ({ mob, heading, speed, prey, dt }: { mob: Mob; heading: number; speed: number; prey: Prey; dt: number }) => {
    const turn = turnBetween(mob.yaw, heading)
    mob.yaw += clamp(turn, -TURN_SPEED * dt, TURN_SPEED * dt)
    // it only walks the way it faces
    const pace = Math.abs(turn) < 1 ? speed : 0
    const nextX = mob.x + (Math.sin(mob.yaw) * pace + mob.pushX) * dt
    const nextZ = mob.z + (Math.cos(mob.yaw) * pace + mob.pushZ) * dt
    if (walkable(nextX, mob.z)) mob.x = nextX
    if (walkable(mob.x, nextZ)) mob.z = nextZ
    const fade = Math.exp(-dt * KNOCK_FADE)
    mob.pushX *= fade
    mob.pushZ *= fade
    mob.walk += (pace * dt * STRIDE_RATE) / mob.kind.scale
    mob.pace += (pace / mob.kind.run - mob.pace) * (1 - Math.exp(-dt * 10))
    // it does not stand in the player
    const dx = mob.x - prey.x
    const dz = mob.z - prey.z
    const d = Math.hypot(dx, dz)
    const least = mob.kind.radius + PLAYER_RADIUS
    if (d >= least || d === 0) return
    mob.x = prey.x + (dx / d) * least
    mob.z = prey.z + (dz / d) * least
  }

  /** creatures that overlap step apart */
  const spread = () => {
    for (let i = 0; i < mobs.length; i++) {
      const a = mobs[i]
      if (a.stance === 'dead') continue
      for (let j = i + 1; j < mobs.length; j++) {
        const b = mobs[j]
        if (b.stance === 'dead') continue
        const dx = b.x - a.x
        const dz = b.z - a.z
        const d = Math.hypot(dx, dz)
        const overlap = a.kind.radius + b.kind.radius - d
        if (overlap <= 0 || d === 0) continue
        const half = overlap / (2 * d)
        a.x -= dx * half
        a.z -= dz * half
        b.x += dx * half
        b.z += dz * half
      }
    }
  }

  return {
    list: mobs,
    /** the living: they stand in the player's way */
    bodies: (): Collider[] => mobs.filter((mob) => mob.stance !== 'dead').map((mob) => ({ x: mob.x, z: mob.z, r: mob.kind.radius })),
    /** Advances every creature by dt. Returns the hearts their blows take from the player, and what is heard. */
    update({ dt, time, prey }: { dt: number; time: number; prey: Prey }) {
      let damage = 0
      const events: MobEvent[] = []
      const seen: boolean[] = []
      for (const mob of mobs) {
        const distance = Math.hypot(prey.x - mob.x, prey.z - mob.z)
        seen.push(distance < VISIBLE_RANGE)
        mob.clock += dt
        mob.flash *= Math.exp(-dt * FLASH_FADE)
        for (const material of mob.materials) material.uniforms.uFlash.value.w = mob.flash * FLASH_MOST
        if (mob.stance === 'dead') {
          if (mob.clock > RETURN_SECONDS && Math.hypot(prey.x - mob.home.x, prey.z - mob.home.z) > RETURN_CLEAR) revive(mob)
          continue
        }
        if (distance >= VISIBLE_RANGE) continue
        const wish = think({ mob, prey, distance, rand })
        // blows that land in the same frame count as the hardest one: a pack does not take every heart at once
        damage = Math.max(damage, wish.damage)
        if (wish.event) events.push(eventOf(mob, wish.event))
        else if (mob.stance === 'roam' && distance < IDLE_HEARD && rand() < IDLE_RATE * dt) events.push(eventOf(mob, 'idle'))
        move({ mob, heading: wish.heading, speed: wish.speed, prey, dt })
      }
      spread()
      // what stands still has the last word: the player and the pack never push a creature into a tree
      mobs.forEach((mob, i) => {
        if (mob.stance === 'dead' || !seen[i]) return
        const out = pushOut({ x: mob.x, z: mob.z, radius: mob.kind.radius, colliders })
        if (!walkable(out.x, out.z)) return
        mob.x = out.x
        mob.z = out.z
      })
      mobs.forEach((mob, i) => pose({ mob, time, seen: seen[i] }))
      flecks.update(dt)
      return { damage, events }
    },
    /**
     * The sword comes down: every creature within reach and inside the arc before the eye is struck.
     * Returns what is heard: a cry for each one struck, and the snarls of those it calls.
     */
    strike({ x, z, yaw, reach, arc, damage }: { x: number; z: number; yaw: number; reach: number; arc: number; damage: number }) {
      const events: MobEvent[] = []
      for (const mob of mobs) {
        if (mob.stance === 'dead') continue
        const dx = mob.x - x
        const dz = mob.z - z
        const d = Math.hypot(dx, dz) || 1
        if (d > reach + mob.kind.radius) continue
        // the player looks along (-sin yaw, -cos yaw)
        if (Math.abs(turnBetween(yaw, Math.atan2(-dx, -dz))) > arc) continue
        mob.health -= damage
        mob.flash = 1
        mob.pushX = ((dx / d) * KNOCK_SPEED) / mob.kind.scale
        mob.pushZ = ((dz / d) * KNOCK_SPEED) / mob.kind.scale
        const dead = mob.health <= 0
        events.push(eventOf(mob, dead ? 'death' : 'hurt'))
        flecks.burst({
          at: [mob.x, groundHeight(mob.x, mob.z) + 0.75 * mob.kind.scale, mob.z],
          awayX: dx / d,
          awayZ: dz / d,
          colors: [...BLOOD, tone(mob.kind.skin, 0.5), tone(mob.kind.skin, 0.8)],
          count: dead ? 34 : 14,
        })
        if (dead) {
          // it falls on its back, away from the blow
          mob.yaw = Math.atan2(-dx, -dz)
          enter(mob, 'dead')
        } else if (mob.kind.reels) enter(mob, 'reel')
        for (const other of mobs) {
          if (other.stance !== 'roam' || Math.hypot(other.x - mob.x, other.z - mob.z) > ALARM_RADIUS) continue
          enter(other, 'chase')
          events.push(eventOf(other, 'alert'))
        }
      }
      return events
    },
    /** every creature alive again and at its home */
    reset: () => mobs.forEach(revive),
  }
}

export type Mobs = ReturnType<typeof buildMobs>
