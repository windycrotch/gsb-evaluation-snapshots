// Bootstrap: renderer, first-person controls, game loop.
// Sizes on screen are set against the reference frame, which is 270 pixels on its short side.
import * as THREE from 'three'
import { buildAudio } from './audio.ts'
import type { SoundName } from './audio.ts'
import type { MobEvent } from './mobs.ts'
import { bakeShade, gustAt, shared } from './paint.ts'
import { buildMobs } from './mobs.ts'
import { buildViewModel } from './viewmodel.ts'
import { BACKDROP, buildWorld, groundHeight, pushOut } from './world.ts'

const REFERENCE_SHORT_SIDE = 270
// The picture is drawn at the screen's own pixels, up to this many on its short side: drawn smaller and
// stretched, far things turn soft.
const MAX_SHORT_SIDE_PIXELS = 2400
// When frames are slow it gives up pixels a step at a time, down to this many.
const MIN_SHORT_SIDE_PIXELS = 1080
const SLOW_FRAME_SECONDS = 1 / 45
const PACE_FRAMES = 90
const PIXEL_STEP = 0.85
// radians a second: a full turn of the sky in about seven minutes
const SKY_TURN = 0.015
const EYE_HEIGHT = 1.7
// vertical field of view in degrees, for a screen as tall as the reference frame (2:3) and for a wide one (16:10)
const TALL_FOV = 70
const WIDE_FOV = 56
const TALL_ASPECT = 2 / 3
const WIDE_ASPECT = 1.6
const WALK_SPEED = 3.4
// The walk cycle (two steps) of the reference clip takes 0.87 s: radians of it a second at a walk. At a run
// the steps come faster, but less than the speed does (CADENCE_POWER): the strides are longer too.
const WALK_CADENCE = 7.24
const CADENCE_POWER = 0.6
const RUN_SPEED = 7
const PLAYER_RADIUS = 0.4
const LOOK_SPEED = 0.0023
const TOUCH_LOOK_SPEED = 0.006
const STICK_RADIUS = 56
const MAX_PITCH = 1.2
const MAX_FRAME_SECONDS = 0.05
// a jump: metres a second upward, and what pulls it down. About a metre high, two thirds of a second long
const JUMP_SPEED = 6.4
const GRAVITY = 19
// how far a hard landing dips the eye, metres
const LANDING_DIP = 0.14
// the sword strikes what is within reach of the player and inside the arc (radians each side) before the eye
const SWORD = { reach: 2.3, arc: 0.95, damage: 1 }
const MAX_HEALTH = 5
// a heart comes back every HEAL_SECONDS, once no blow has landed for HEAL_AFTER_SECONDS
const HEAL_AFTER_SECONDS = 6
const HEAL_SECONDS = 4
// after a blow no other blow lands for this long: a pack does not take every heart at once
const GRACE_SECONDS = 0.8
// struck down, the player lies this long and then starts again at the forest
const DOWN_SECONDS = 2.8
const DOWN_EYE_HEIGHT = 0.4
// what is heard of each thing a creature does. Snarls of one pack start up to ALERT_STAGGER_SECONDS apart
const MOB_SOUNDS: Record<MobEvent['type'], SoundName> = { alert: 'goblinAlert', blow: 'club', hurt: 'goblinHurt', death: 'goblinDeath', idle: 'goblinIdle' }
const ALERT_STAGGER_SECONDS = 0.35

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' })
// colours are mixed as they should look on screen: nothing converts them
renderer.outputColorSpace = THREE.LinearSRGBColorSpace
renderer.setClearColor(new THREE.Color().setRGB(...BACKDROP, THREE.LinearSRGBColorSpace))
renderer.autoClear = false
const canvas = renderer.domElement
document.body.appendChild(canvas)

// ---------- the finish ----------

// The world is painted in saturated colours into a picture of its own. One pass then finishes that picture, pixel
// by pixel. The grade: a single colour runs through the shade and another through the light, which holds the
// palette together. Then, as in oil-paint's finish: the weave of the canvas under the paint, the brightest
// passages rolled off toward the white of the paint, and a little varnish.
// Before all that the picture is antialiased (FXAA): thin ridges of paint and the edges of strokes are smoothed,
// so they do not shimmer as the eye moves.
// Nothing here reads the world, so nothing depends on where the eye is. The hands are drawn after it: they are
// cut from the reference frame and have its colours already.
const FINISH_FRAGMENT = /* glsl */ `
uniform sampler2D tColor;
uniform vec2 uTexel;
uniform float uSmooth;
uniform float uSharp;
uniform vec3 uShade;
uniform vec3 uLight;
uniform vec3 uLift;
uniform float uSaturation;
uniform float uCanvas;
uniform float uVarnish;
uniform float uHurt;
uniform float uDark;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float smoothNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// warp and weft of a medium linen, each thread a little uneven
float weave(vec2 p) {
  vec2 q = p / 2.6;
  float n = smoothNoise(p / 40.0);
  return sin(q.x * 3.14159) * sin(q.y * 3.14159 + floor(q.x) * 3.14159) * (0.3 + 1.4 * n * n);
}

const vec3 LUMA = vec3(0.3, 0.59, 0.11);

// FXAA, after Timothy Lottes: where the picture has a hard edge, it is blurred along that edge and nowhere else.
// It reaches only two pixels along an edge, not the usual eight: the picture is all small strokes, every one an
// edge, and a long reach would smear them into each other.
const float FXAA_SPAN = 2.0;
vec3 antialiased(vec2 uv) {
  vec3 m = texture2D(tColor, uv).rgb;
  float nw = dot(texture2D(tColor, uv + vec2(-1.0, -1.0) * uTexel).rgb, LUMA);
  float ne = dot(texture2D(tColor, uv + vec2(1.0, -1.0) * uTexel).rgb, LUMA);
  float sw = dot(texture2D(tColor, uv + vec2(-1.0, 1.0) * uTexel).rgb, LUMA);
  float se = dot(texture2D(tColor, uv + vec2(1.0, 1.0) * uTexel).rgb, LUMA);
  float mid = dot(m, LUMA);
  float low = min(mid, min(min(nw, ne), min(sw, se)));
  float high = max(mid, max(max(nw, ne), max(sw, se)));
  vec2 dir = vec2(-((nw + ne) - (sw + se)), (nw + sw) - (ne + se));
  float reduce = max((nw + ne + sw + se) * 0.03125, 0.0078125);
  dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + reduce), -FXAA_SPAN, FXAA_SPAN) * uTexel;
  vec3 near = 0.5 * (texture2D(tColor, uv + dir * (1.0 / 3.0 - 0.5)).rgb + texture2D(tColor, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 wide = near * 0.5 + 0.25 * (texture2D(tColor, uv - dir * 0.5).rgb + texture2D(tColor, uv + dir * 0.5).rgb);
  float l = dot(wide, LUMA);
  return mix(m, l < low || l > high ? near : wide, uSmooth);
}

// The edge of a stroke is drawn firm again: each pixel is pushed away from the mean of its neighbours, but never
// past the lightest or darkest of them, so no halo grows round an edge. Passages that are nearly flat are left
// alone: there is nothing in them to make firm but the grain of the antialiasing.
vec3 sharpened(vec2 uv, vec3 m) {
  vec3 n = texture2D(tColor, uv + vec2(0.0, -1.0) * uTexel).rgb;
  vec3 s = texture2D(tColor, uv + vec2(0.0, 1.0) * uTexel).rgb;
  vec3 e = texture2D(tColor, uv + vec2(1.0, 0.0) * uTexel).rgb;
  vec3 w = texture2D(tColor, uv + vec2(-1.0, 0.0) * uTexel).rgb;
  vec3 low = min(m, min(min(n, s), min(e, w)));
  vec3 high = max(m, max(max(n, s), max(e, w)));
  float range = dot(high - low, LUMA);
  vec3 firm = m + (m - 0.25 * (n + s + e + w)) * uSharp * 2.0 * smoothstep(0.03, 0.1, range);
  return clamp(firm, low, high);
}

void main() {
  vec3 c = sharpened(vUv, antialiased(vUv));
  float l = dot(c, LUMA);
  c = mix(vec3(l), c, uSaturation);
  // the shade leans to violet and the light to a warm yellow
  c *= mix(uShade, uLight, smoothstep(0.04, 0.6, l));
  // the darkest paint is never black: it has the colour of the shade in it
  c += uLift * pow(1.0 - l, 4.0);
  vec2 px = gl_FragCoord.xy;
  float w = weave(px);
  c *= 1.0 + (0.6 * (weave(px + vec2(1.0, 0.0)) - w) - 0.8 * (weave(px + vec2(0.0, 1.0)) - w)) * 0.022 * uCanvas + w * 0.006 * uCanvas;
  // the brightest passages roll off toward the white of the paint and never past it
  vec3 over = max(c - 0.8, 0.0);
  c = min(c, 0.8) + over / (1.0 + over * 5.0);
  // varnish: more depth in the darks, the lights left alone
  c = mix(c, c * c * (3.0 - 2.0 * c), uVarnish);
  // a blow reddens the picture, most at its edges; struck down, it goes dark
  float rim = smoothstep(0.2, 0.75, distance(vUv, vec2(0.5)));
  c = mix(c, c * vec3(1.25, 0.42, 0.38) + vec3(0.07, 0.0, 0.0), uHurt * (0.15 + 0.7 * rim));
  c *= 1.0 - uDark;
  gl_FragColor = vec4(c, 1.0);
}
`

// the samples cut the edges of the strokes (alpha to coverage)
const picture = new THREE.WebGLRenderTarget(1, 1, { samples: 4, depthBuffer: true })
const finish = new THREE.Mesh(
  new THREE.PlaneGeometry(2, 2),
  new THREE.ShaderMaterial({
    uniforms: {
      tColor: { value: picture.texture },
      uTexel: { value: new THREE.Vector2(1, 1) },
      uSmooth: { value: 1 },
      uSharp: { value: 0.8 },
      uShade: { value: new THREE.Vector3(0.88, 0.9, 1.12) },
      uLight: { value: new THREE.Vector3(1.04, 1.0, 0.94) },
      uLift: { value: new THREE.Vector3(0.012, 0.008, 0.03) },
      uSaturation: { value: 1 },
      uCanvas: { value: 1 },
      uVarnish: { value: 0.22 },
      uHurt: { value: 0 },
      uDark: { value: 0 },
    },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: FINISH_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  }),
)
finish.frustumCulled = false
const flat = new THREE.Camera()

const world = buildWorld()
const mobs = buildMobs({ scene: world.scene, colliders: world.colliders, walkable: world.walkable })
const hands = buildViewModel({ hearts: MAX_HEALTH })
const audio = buildAudio()
// the sun's shade over the part of the valley the player can walk
bakeShade({ renderer, scene: world.scene, center: new THREE.Vector3(0, 0, -75), half: 260 })
const camera = new THREE.PerspectiveCamera(70, 1, 0.25, 9000)
camera.rotation.order = 'YXZ'

const player = {
  ...world.start,
  vx: 0,
  vz: 0,
  bob: 0,
  stride: 0,
  // In a jump: the height of the feet and their speed upward. On the ground the feet are where the ground is.
  grounded: true,
  y: 0,
  vy: 0,
  /** how far the last landing still dips the eye, metres */
  dip: 0,
  /** hearts left, and seconds since the last blow or the last heart that came back */
  health: MAX_HEALTH,
  calm: 0,
  /** seconds since the player was struck down, or -1 */
  down: -1,
  /** 1 right after a blow, then it fades: the picture reddens and the eye jolts */
  blow: 0,
}

// the share of the screen's pixels that are drawn: falls when frames are slow, see keepPace
let sharpness = 1

function resize() {
  const short = Math.min(innerWidth, innerHeight)
  const least = Math.min(devicePixelRatio, MIN_SHORT_SIDE_PIXELS / short)
  const ratio = Math.max(least, Math.min(devicePixelRatio, MAX_SHORT_SIDE_PIXELS / short) * sharpness)
  renderer.setPixelRatio(ratio)
  renderer.setSize(innerWidth, innerHeight)
  picture.setSize(Math.round(innerWidth * ratio), Math.round(innerHeight * ratio))
  finish.material.uniforms.uTexel.value.set(1 / picture.width, 1 / picture.height)
  camera.aspect = innerWidth / innerHeight
  // The scene is composed for a tall screen: a wide one keeps a similar horizontal view, and the shapes between
  // go from one to the other, so a square screen still shows the castle whole.
  camera.fov = THREE.MathUtils.lerp(TALL_FOV, WIDE_FOV, THREE.MathUtils.smoothstep(camera.aspect, TALL_ASPECT, WIDE_ASPECT))
  camera.updateProjectionMatrix()
  shared.uPixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / (innerHeight * ratio)
  shared.uRef.value = (short * ratio) / REFERENCE_SHORT_SIDE
  hands.resize((innerWidth * REFERENCE_SHORT_SIDE) / short, (innerHeight * REFERENCE_SHORT_SIDE) / short)
}
addEventListener('resize', () => {
  sharpness = 1
  resize()
})
resize()

const pace = { frames: 0, slow: 0 }
/** Counts slow frames. When most of the last frames were slow, the picture is drawn with fewer pixels. */
function keepPace(seconds: number) {
  pace.frames++
  if (seconds > SLOW_FRAME_SECONDS) pace.slow++
  if (pace.frames < PACE_FRAMES) return
  const short = Math.min(innerWidth, innerHeight)
  const drawn = Math.min(picture.width, picture.height)
  if (pace.slow > PACE_FRAMES / 2 && drawn > Math.min(short * devicePixelRatio, MIN_SHORT_SIDE_PIXELS)) {
    sharpness *= PIXEL_STEP
    resize()
  }
  pace.frames = 0
  pace.slow = 0
}

// ---------- input ----------

const keys = new Set<string>()
const stick = { x: 0, y: 0 }
const hint = document.querySelector<HTMLElement>('#hint')!
let turnSpeed = 0

function look({ dx, dy, speed }: { dx: number; dy: number; speed: number }) {
  player.yaw -= dx * speed
  player.pitch = THREE.MathUtils.clamp(player.pitch - dy * speed, -MAX_PITCH, MAX_PITCH)
  turnSpeed -= dx * speed * 30
}

/** the sword is swung, if the player stands and it is not in a swing already */
function swing() {
  if (player.down < 0 && hands.swing()) audio.play({ sound: 'swing' })
}

// a browser makes no sound before the player touches the page
for (const type of ['keydown', 'pointerdown', 'pointerup'] as const) addEventListener(type, () => audio.unlock())

addEventListener('keydown', (event) => {
  keys.add(event.code)
  if (event.code === 'KeyF' || event.code === 'KeyE') swing()
  if (event.code === 'KeyM') audio.toggleMute()
})
addEventListener('keyup', (event) => keys.delete(event.code))
addEventListener('blur', () => keys.clear())

canvas.addEventListener('mousedown', () => {
  if (document.pointerLockElement === canvas) return swing()
  // Returns a promise only in newer browsers. A refused lock needs no handling: the next click asks again.
  void Promise.resolve(canvas.requestPointerLock?.()).catch(() => {})
})
addEventListener('mousemove', (event) => {
  if (document.pointerLockElement === canvas) look({ dx: event.movementX, dy: event.movementY, speed: LOOK_SPEED })
})

// touch: left half is a movement stick, right half drags the view, a tap swings the sword
// no emulated mouse events after a touch
canvas.addEventListener('touchstart', (event) => event.preventDefault(), { passive: false })
const touches = new Map<number, { startX: number; startY: number; lastX: number; lastY: number; move: boolean; travelled: number }>()
canvas.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'mouse') return
  canvas.setPointerCapture(event.pointerId)
  touches.set(event.pointerId, { startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, move: event.clientX < innerWidth / 2, travelled: 0 })
})
canvas.addEventListener('pointermove', (event) => {
  const touch = touches.get(event.pointerId)
  if (!touch) return
  const dx = event.clientX - touch.lastX
  const dy = event.clientY - touch.lastY
  touch.lastX = event.clientX
  touch.lastY = event.clientY
  touch.travelled += Math.abs(dx) + Math.abs(dy)
  if (touch.move) {
    stick.x = THREE.MathUtils.clamp((event.clientX - touch.startX) / STICK_RADIUS, -1, 1)
    stick.y = THREE.MathUtils.clamp((event.clientY - touch.startY) / STICK_RADIUS, -1, 1)
  } else {
    look({ dx, dy, speed: TOUCH_LOOK_SPEED })
  }
})
const endTouch = (event: PointerEvent) => {
  const touch = touches.get(event.pointerId)
  if (!touch) return
  touches.delete(event.pointerId)
  if (touch.move) stick.x = stick.y = 0
  else if (touch.travelled < 8) swing()
}
canvas.addEventListener('pointerup', endTouch)
canvas.addEventListener('pointercancel', endTouch)

// touch: a button to jump, held like the space bar
const jumpButton = document.querySelector<HTMLElement>('#jump')!
let jumpHeld = false
jumpButton.addEventListener('pointerdown', (event) => {
  event.preventDefault()
  jumpHeld = true
})
for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) jumpButton.addEventListener(type, () => (jumpHeld = false))

// ---------- simulation ----------

function moveInput() {
  const x = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) + stick.x
  const y = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) - stick.y
  const length = Math.hypot(x, y)
  return length > 1 ? { x: x / length, y: y / length } : { x, y }
}

/** height of the feet above the ground */
const airOf = () => (player.grounded ? 0 : Math.max(0, player.y - groundHeight(player.x, player.z)))

/** what the creatures know of the player */
const prey = () => ({ x: player.x, z: player.z, air: airOf(), alive: player.down < 0 })

function hurt(damage: number) {
  player.health = Math.max(0, player.health - damage)
  player.calm = 0
  player.blow = 1
  audio.play({ sound: player.health > 0 ? 'hurt' : 'down' })
  if (player.health > 0) return
  player.down = 0
  player.grounded = true
  player.vx = player.vz = 0
}

/** the player starts again at the forest, whole, and so do the creatures */
function rise() {
  Object.assign(player, world.start, { vx: 0, vz: 0, stride: 0, grounded: true, vy: 0, dip: 0, health: MAX_HEALTH, calm: 0, down: -1 })
  mobs.reset()
}

function step(dt: number) {
  player.blow *= Math.exp(-dt * 3.5)
  player.dip *= Math.exp(-dt * 9)
  turnSpeed *= Math.exp(-dt * 8)
  if (player.down >= 0) {
    player.down += dt
    player.stride *= Math.exp(-dt * 10)
    if (player.down > DOWN_SECONDS) rise()
    return
  }
  player.calm += dt
  if (player.health < MAX_HEALTH && player.calm > HEAL_AFTER_SECONDS) {
    player.health++
    player.calm -= HEAL_SECONDS
    audio.play({ sound: 'heal' })
  }

  const input = moveInput()
  const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? RUN_SPEED : WALK_SPEED
  const sin = Math.sin(player.yaw)
  const cos = Math.cos(player.yaw)
  const targetX = (input.x * cos - input.y * sin) * speed
  const targetZ = (-input.x * sin - input.y * cos) * speed
  const ease = 1 - Math.exp(-dt * 10)
  player.vx += (targetX - player.vx) * ease
  player.vz += (targetZ - player.vz) * ease

  // pushed out of the creatures, then out of the things that stand still: those have the last word
  const clear = pushOut({ x: player.x + player.vx * dt, z: player.z + player.vz * dt, radius: PLAYER_RADIUS, colliders: mobs.bodies() })
  const next = pushOut({ ...clear, radius: PLAYER_RADIUS, colliders: world.colliders })
  if (world.walkable(next.x, player.z)) player.x = next.x
  if (world.walkable(player.x, next.z)) player.z = next.z

  const footfall: SoundName = world.onPath(player.x, player.z) ? 'stepGravel' : 'stepGrass'
  const ground = groundHeight(player.x, player.z)
  if (player.grounded) {
    player.y = ground
    if (keys.has('Space') || jumpHeld) {
      player.vy = JUMP_SPEED
      player.grounded = false
      audio.play({ sound: footfall, volume: 0.7, rate: 1.2 })
    }
  } else {
    player.vy -= GRAVITY * dt
    player.y += player.vy * dt
    if (player.y <= ground) {
      player.grounded = true
      player.dip = LANDING_DIP * Math.min(1, -player.vy / JUMP_SPEED)
      audio.play({ sound: 'land', volume: Math.min(1, -player.vy / JUMP_SPEED) })
      player.vy = 0
    }
  }

  // the feet make no steps in the air
  const moving = player.grounded ? Math.hypot(player.vx, player.vz) : 0
  player.stride += (Math.min(moving / WALK_SPEED, 1.4) - player.stride) * ease
  // a foot comes down at every half turn of the walk cycle, louder at a run
  const strides = Math.floor(player.bob / Math.PI)
  player.bob += WALK_CADENCE * Math.pow(moving / WALK_SPEED, CADENCE_POWER) * dt
  if (Math.floor(player.bob / Math.PI) !== strides) audio.play({ sound: footfall, volume: THREE.MathUtils.clamp(moving / RUN_SPEED, 0.5, 1) })
  if (moving > 0.5 && hint.style.opacity !== '0') hint.style.opacity = '0'
}

function render(time: number) {
  shared.uTime.value = time
  const lift = Math.abs(Math.cos(player.bob)) * 0.06 * player.stride
  // struck down, the eye sinks to the ground and tips over
  const fallen = player.down < 0 ? 0 : THREE.MathUtils.smoothstep(player.down, 0, 0.7)
  const eye = THREE.MathUtils.lerp(EYE_HEIGHT, DOWN_EYE_HEIGHT, fallen)
  camera.position.set(player.x, groundHeight(player.x, player.z) + airOf() + eye - lift - player.dip, player.z)
  camera.rotation.set(player.pitch + player.blow * 0.04, player.yaw, Math.sin(player.bob) * 0.006 * player.stride + player.blow * 0.05 + fallen * 0.6)
  finish.material.uniforms.uHurt.value = player.blow
  finish.material.uniforms.uDark.value = dark
  // the sky is painted on a far sphere that travels with the eye
  world.sky.position.copy(camera.position)
  // and turns with the wind: the clouds drift from left to right
  world.sky.rotation.y = -time * SKY_TURN
  renderer.setRenderTarget(picture)
  renderer.clear()
  renderer.render(world.scene, camera)
  renderer.setRenderTarget(null)
  renderer.clear()
  renderer.render(finish, flat)
  if (player.down < 0) renderer.render(hands.scene, hands.camera)
}

// how dark the picture is, 0..1: it goes dark when the player is struck down and clears when the player rises
let dark = 0

const handsUpdate = (dt: number, time: number) =>
  hands.update({ dt, time, bob: player.bob, stride: player.stride, turn: turnSpeed, rise: player.grounded ? 0 : player.vy, health: player.health })

function advance(dt: number, time: number) {
  step(dt)
  audio.update({ x: player.x, z: player.z, yaw: player.yaw, gust: gustAt({ x: player.x, z: player.z, time }) })
  const { damage, events } = mobs.update({ dt, time, prey: prey() })
  if (damage > 0 && player.down < 0 && player.calm > GRACE_SECONDS) hurt(damage)
  const { struck } = handsUpdate(dt, time)
  if (struck && player.down < 0) {
    const cries = mobs.strike({ x: player.x, z: player.z, yaw: player.yaw, ...SWORD })
    if (cries.some((cry) => cry.type === 'hurt' || cry.type === 'death')) audio.play({ sound: 'hit' })
    events.push(...cries)
  }
  for (const { type, x, z, voice } of events) {
    audio.play({ sound: MOB_SOUNDS[type], rate: voice, at: { x, z }, delay: type === 'alert' ? Math.random() * ALERT_STAGGER_SECONDS : 0 })
  }
  const darkest = player.down < 0 ? 0 : THREE.MathUtils.smoothstep(player.down, 0.6, 2)
  dark += (darkest - dark) * (1 - Math.exp(-dt * 6))
  render(time)
}

// Debug hook for screenshots and frame-by-frame capture. While `manual` is on, only `tick` moves time.
const debug = {
  player,
  stick,
  counts: world.counts,
  scene: world.scene,
  mobs,
  hands,
  audio,
  finish: finish.material.uniforms,
  manual: false,
  time: 3,
  /** place the player, draw one frame, return it as a PNG data URL */
  snap(pose: Partial<typeof player> = {}) {
    Object.assign(player, pose)
    mobs.update({ dt: 0, time: debug.time, prey: prey() })
    handsUpdate(0, debug.time)
    render(debug.time)
    return canvas.toDataURL('image/png')
  },
  /** advance the game by dt seconds and return the frame */
  tick(dt: number) {
    debug.time += dt
    advance(dt, debug.time)
    return canvas.toDataURL('image/png')
  },
}
Object.assign(window, { game: debug })

let last = performance.now()
function frame(now: number) {
  // the first rAF timestamp can be older than the page clock
  const seconds = (now - last) / 1000
  const dt = THREE.MathUtils.clamp(seconds, 0, MAX_FRAME_SECONDS)
  last = now
  if (!debug.manual) {
    keepPace(seconds)
    advance(dt, now / 1000)
  }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
