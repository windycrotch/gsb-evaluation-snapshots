// First-person hands as pixel sprites, drawn over the world like Doom weapons.
// The sprites are cut from the reference painting (scripts/cut-sprite.ts). The scene is measured in pixels of the
// reference frame, 270 on the short side of the screen, and each sprite pixel is one of them.
// Each sprite has a margin of extra arm past the screen edge, so it can bob and swing without showing a cut.
import * as THREE from 'three'
import { hex, shared } from './paint.ts'

/** render size of the reference frame the sprites were cut from */
const REFERENCE = { width: 270, height: 405 }
// On a wide screen the hands stay this far apart at most, in sprite pixels: about 1.1 times the screen's height.
const HANDS_MAX_SPAN = 445
// On a low screen the sprites shrink until this many of their rows fit its height: the whole blade with room to
// sway over it, the fist and a little forearm. A tall screen shows them 1:1, as the reference does.
const HANDS_LEAST_ROWS = 340
// rows of screen kept free over the tip of the blade at rest: it sways up
const TIP_ROOM = 22

// The walk of the reference clip, measured by laying the sprites over each of its frames (0.87 s for two steps).
// Both hands sway to the same side together, 22 pixels from end to end, and each dips at the ends of its
// swing: deepest on its own side, where its foot comes down. Sprite pixels, x right and y up, as a mean and
// two harmonics of the walk cycle: mean, cos, sin, cos of twice the phase, sin of twice the phase.
const WALK = {
  torch: { x: [-7, 10.9, 0, -0.2, 0.4], y: [0.2, 2.6, 0.2, -3.2, 3.3] },
  sword: { x: [-7.3, 9.2, -3.8, 0.2, 1.2], y: [-0.3, -2.8, 2.6, -5, 2.6] },
}
const swayAt = (c: number[], phase: number) => c[0] + c[1] * Math.cos(phase) + c[2] * Math.sin(phase) + c[3] * Math.cos(2 * phase) + c[4] * Math.sin(2 * phase)
const SWING_SECONDS = 0.42
// the share of a swing at which the blade lands
const STRIKE_AT = 0.3
// how far the hands hang back when the player rises or falls: sprite pixels for a metre a second, and the most
const HANG = { rate: 1.3, most: 9 }
const SPARK_COUNT = 14
const SPARK_COLORS = ['#eea757', '#c8743a', '#a3512c'].map(hex)

// Sprite layouts in sprite pixels, y up from the bottom edge.
const TORCH = {
  url: '/sprites/torch.png',
  size: [150, 312],
  /** extra arm left of and below the screen corner */
  margin: [45, 60],
  /** the painted flame: left, bottom, right, top */
  flame: [78, 219, 120, 308],
}
const SWORD = {
  url: '/sprites/sword.png',
  size: [135, 412],
  /** extra arm right of and below the screen corner */
  margin: [52, 60],
  /** the wrist: the sword swings around it */
  pivot: [60, 112],
  /** the sleeve runs off the right edge of the sprite up to this height */
  cut: 112,
  /** the tip of the blade */
  tip: 402,
}

const SPRITE_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const SPRITE_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform vec2 uSize;
uniform vec4 uFlame;
uniform float uTime;
varying vec2 vUv;
void main() {
  vec2 px = floor(vUv * uSize);
  // The painted flame comes alive: rows sway sideways and columns lick up and down, in whole pixels, more toward the tip.
  if (px.x >= uFlame.x && px.x < uFlame.z && px.y >= uFlame.y && px.y < uFlame.w) {
    float tip = (px.y - uFlame.y) / (uFlame.w - uFlame.y);
    float sway = sin(uTime * 7.0 + px.y * 0.45) * 1.7 + sin(uTime * 12.3 + px.y * 0.21) * 1.1;
    float lick = sin(uTime * 9.0 + px.x * 0.9) * 2.2 + sin(uTime * 5.3 + px.x * 0.37) * 1.6;
    px += floor(vec2(sway, lick) * tip + 0.5);
  }
  vec4 color = texture2D(uMap, (px + 0.5) / uSize);
  if (color.a < 0.5) discard;
  gl_FragColor = vec4(color.rgb, 1.0);
}
`

function sprite(layout: { url: string; size: number[]; flame?: number[] }) {
  const map = new THREE.TextureLoader().load(layout.url)
  map.magFilter = map.minFilter = THREE.NearestFilter
  map.generateMipmaps = false
  const [width, height] = layout.size
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: map },
      uSize: { value: new THREE.Vector2(width, height) },
      uFlame: { value: new THREE.Vector4(...(layout.flame ?? [0, 0, 0, 0])) },
      uTime: shared.uTime,
    },
    vertexShader: SPRITE_VERTEX,
    fragmentShader: SPRITE_FRAGMENT,
    depthTest: false,
  })
  // origin at the bottom left corner of the sprite
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height).translate(width / 2, height / 2, 0), material)
  mesh.frustumCulled = false
  return mesh
}

interface Spark {
  x: number
  y: number
  vx: number
  vy: number
  age: number
  life: number
}

const SPARK_VERTEX = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aColor;
varying vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(aPos + position, 1.0);
}
`

const SPARK_FRAGMENT = /* glsl */ `
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }
`

/** a few one-pixel sparks that rise from the flame. Positions are in torch sprite pixels */
function buildSparks() {
  const geometry = new THREE.InstancedBufferGeometry()
  const quad = new THREE.PlaneGeometry(1, 1)
  geometry.index = quad.index
  geometry.setAttribute('position', quad.attributes.position)
  geometry.instanceCount = SPARK_COUNT
  const pos = new THREE.InstancedBufferAttribute(new Float32Array(SPARK_COUNT * 3), 3).setUsage(THREE.DynamicDrawUsage)
  const color = new THREE.InstancedBufferAttribute(new Float32Array(SPARK_COUNT * 3), 3).setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute('aPos', pos)
  geometry.setAttribute('aColor', color)
  const mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({ vertexShader: SPARK_VERTEX, fragmentShader: SPARK_FRAGMENT, depthTest: false }))
  mesh.frustumCulled = false
  // drawn after the sprite
  mesh.renderOrder = 1

  const [left, bottom, right, top] = TORCH.flame
  const spawn = (s: Spark) => {
    s.x = left + 8 + Math.random() * (right - left - 16)
    s.y = bottom + 20 + Math.random() * (top - bottom - 30)
    s.vx = (Math.random() - 0.5) * 14
    s.vy = 22 + Math.random() * 30
    s.life = 0.5 + Math.random() * 0.9
    s.age = 0
  }
  const sparks: Spark[] = Array.from({ length: SPARK_COUNT }, () => {
    const s: Spark = { x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 1 }
    spawn(s)
    s.age = Math.random() * s.life
    return s
  })
  const update = (dt: number, time: number) => {
    sparks.forEach((s, i) => {
      s.age += dt
      if (s.age > s.life) spawn(s)
      s.x += (s.vx + Math.sin(time * 5 + i) * 10) * dt
      s.y += s.vy * dt
      const rgb = SPARK_COLORS[Math.min(2, Math.floor((s.age / s.life) * 3))]
      pos.setXYZ(i, Math.round(s.x), Math.round(s.y), 0)
      color.setXYZ(i, rgb[0], rgb[1], rgb[2])
    })
    pos.needsUpdate = color.needsUpdate = true
  }
  return { mesh, update }
}

// A heart of the player's health, drawn in the pixels of the sprites. o: outline, r: red, h: highlight
// prettier-ignore
const HEART_ROWS = [
  '..oo...oo..',
  '.orro.orro.',
  'orhrrorrrro',
  'orhrrrrrrro',
  'orrrrrrrrro',
  '.orrrrrrro.',
  '..orrrrro..',
  '...orrro...',
  '....oro....',
  '.....o.....',
]
const HEART_SIZE = [HEART_ROWS[0].length, HEART_ROWS.length]
const HEART_INKS = {
  full: { o: '#2a0d12', r: '#c5362c', h: '#f08a6a' },
  lost: { o: '#2a0d12', r: '#4a3440', h: '#4a3440' },
}
/** from the screen's top left corner to the first heart, and between hearts, in sprite pixels */
const HEART_MARGIN = 6
const HEART_GAP = 1

function heartMaterial(inks: Record<string, string>) {
  const [width, height] = HEART_SIZE
  const data = new Uint8Array(width * height * 4)
  HEART_ROWS.forEach((row, j) => {
    for (let i = 0; i < width; i++) {
      const ink = inks[row[i]]
      if (!ink) continue
      const [r, g, b] = hex(ink)
      // the first row of a texture is its bottom
      data.set([r * 255, g * 255, b * 255, 255], ((height - 1 - j) * width + i) * 4)
    }
  })
  const map = new THREE.DataTexture(data, width, height)
  map.magFilter = map.minFilter = THREE.NearestFilter
  map.needsUpdate = true
  return new THREE.MeshBasicMaterial({ map, alphaTest: 0.5, depthTest: false })
}

/** hearts: how many the player has when whole */
export function buildViewModel({ hearts: heartCount }: { hearts: number }) {
  const scene = new THREE.Scene()
  // reference pixels, y up
  const camera = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10)

  const torch = new THREE.Group()
  const sparks = buildSparks()
  torch.add(sprite(TORCH), sparks.mesh)

  // the sword group sits on the wrist, so rotation swings the blade around it
  const sword = new THREE.Group()
  const swordSprite = sprite(SWORD)
  swordSprite.position.set(-SWORD.pivot[0], -SWORD.pivot[1], 0)
  sword.add(swordSprite)
  scene.add(torch, sword)

  // Hearts in the top left corner. They show only while the player is hurt: the frame stays clean otherwise.
  const heartInks = { full: heartMaterial(HEART_INKS.full), lost: heartMaterial(HEART_INKS.lost) }
  const hearts = Array.from({ length: heartCount }, () => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(HEART_SIZE[0], HEART_SIZE[1]).translate(HEART_SIZE[0] / 2, HEART_SIZE[1] / 2, 0), heartInks.full)
    mesh.frustumCulled = false
    scene.add(mesh)
    return mesh
  })

  let width = REFERENCE.width
  let height = REFERENCE.height
  let scale = 1
  let inset = 0
  let swordDrop = 0
  let swing = -1

  return {
    scene,
    camera,
    /** size of the screen in reference pixels */
    resize(renderWidth: number, renderHeight: number) {
      camera.right = renderWidth
      camera.top = renderHeight
      camera.updateProjectionMatrix()
      width = renderWidth
      height = renderHeight
      scale = Math.min(renderWidth / REFERENCE.width, renderHeight / HANDS_LEAST_ROWS)
      // how far each hand is moved in from its corner of the screen
      inset = Math.max(0, (renderWidth / scale - HANDS_MAX_SPAN) / 2)
      // Moved in, the sword arm would show where its sleeve ends at the sprite's edge: it is lowered until the
      // sleeve is below the screen and the fist rises from the bottom edge.
      const sleeveDrop = (SWORD.cut - SWORD.margin[1]) * THREE.MathUtils.smoothstep(inset, 0, SWORD.margin[0])
      // on a low screen it is lowered until the tip of the blade is inside the picture
      const tipDrop = SWORD.tip - SWORD.margin[1] + TIP_ROOM - renderHeight / scale
      swordDrop = Math.max(sleeveDrop, tipDrop, 0)
      torch.scale.setScalar(scale)
      sword.scale.setScalar(scale)
      for (const heart of hearts) heart.scale.setScalar(scale)
    },
    /** Starts a swing of the sword. Returns false when one is under way already. */
    swing() {
      if (swing >= 0) return false
      swing = 0
      return true
    },
    /**
     * bob: walk cycle phase, stride: 0..1 walk speed, turn: yaw speed in rad/s, rise: metres a second upward,
     * health: hearts left. Returns struck: true in the frame the blade of a swing lands.
     */
    update({ dt, time, bob, stride, turn, rise, health }: { dt: number; time: number; bob: number; stride: number; turn: number; rise: number; health: number }) {
      sparks.update(dt, time)
      const lag = THREE.MathUtils.clamp(turn * 4, -10, 10)
      // the hands hang back: they are late to rise in a jump and late to fall
      const hang = THREE.MathUtils.clamp(-rise * HANG.rate, -HANG.most, HANG.most)
      const idle = Math.sin(time * 1.1) * 1.2
      torch.position.set(
        Math.round((inset - TORCH.margin[0] + swayAt(WALK.torch.x, bob) * stride + lag) * scale),
        Math.round((-TORCH.margin[1] + swayAt(WALK.torch.y, bob) * stride + idle + hang) * scale),
        0,
      )
      hearts.forEach((heart, i) => {
        heart.visible = health < heartCount
        heart.material = i < health ? heartInks.full : heartInks.lost
        heart.position.set(Math.round((HEART_MARGIN + i * (HEART_SIZE[0] + HEART_GAP)) * scale), Math.round(height - (HEART_MARGIN + HEART_SIZE[1]) * scale), 0)
      })

      const before = swing
      if (swing >= 0) swing += dt / SWING_SECONDS
      const struck = before >= 0 && before < STRIKE_AT && swing >= STRIKE_AT
      if (swing > 1) swing = -1
      const slash = swing < 0 ? 0 : Math.sin(Math.PI * swing)
      const restX = width / scale - inset - (SWORD.size[0] - SWORD.margin[0]) + SWORD.pivot[0]
      const restY = -SWORD.margin[1] - swordDrop + SWORD.pivot[1]
      sword.position.set(
        Math.round((restX + swayAt(WALK.sword.x, bob) * stride + lag * 1.4 - slash * 46) * scale),
        Math.round((restY + swayAt(WALK.sword.y, bob) * stride - idle - slash * 14 + hang * 1.2) * scale),
        0,
      )
      sword.rotation.z = slash * 1.2
      return { struck }
    },
  }
}
