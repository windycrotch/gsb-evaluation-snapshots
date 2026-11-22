import "./style.css"
import * as dat from "dat.gui"
import * as THREE from "three"
import gsap from "gsap"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js"
import firefliesVertexShader from "./shaders/fireflies/vertex.glsl"
import firefliesFragmentShader from "./shaders/fireflies/fragment.glsl"
import waterVertexShader from "./shaders/water/vertex.glsl"
import waterFragmentShader from "./shaders/water/fragment.glsl"
import { Mesh, MeshBasicMaterial, PlaneBufferGeometry } from "three"
import { Flow } from "three/examples/jsm/modifiers/CurveModifier.js"
import { createWaterColorBinding } from "./waterColor.js"

/**
 * Base
 */
// Debug
const debugObject = {}
const gui = new dat.GUI({
  width: 400,
  closed: true,
})

// Canvas
const canvas = document.querySelector("canvas.webgl")

// Scene
const scene = new THREE.Scene()
scene.fog = new THREE.Fog(0xffffff, 0, 17)

/**
 * Loading UI
 *
 * The overlay is driven by the resource registry below instead of
 * LoadingManager.onLoad: that callback only tells us that requests settled,
 * not that every resource actually succeeded. Keeping our own state also lets
 * a retry target only the resources that failed.
 */
const overlay = document.getElementById("loading-overlay")
const overlayText = document.getElementById("loading-overlay-text")
const errorPanel = document.getElementById("load-error")
const errorMessage = document.getElementById("load-error-message")
const retryButton = document.getElementById("load-retry")

let overlayTween = null

function showOverlay(message) {
  if (overlayTween) {
    overlayTween.kill()
    overlayTween = null
  }

  overlay.style.display = "flex"
  overlay.style.opacity = "1"
  overlay.dataset.state = "loading"
  overlay.setAttribute("aria-hidden", "false")

  if (message) {
    overlayText.textContent = message
  }
}

function hideOverlay(immediate) {
  if (overlay.dataset.state === "hidden") return

  overlay.dataset.state = "hidden"
  overlay.setAttribute("aria-hidden", "true")

  if (overlayTween) {
    overlayTween.kill()
    overlayTween = null
  }

  // Failures remove the overlay at once so the error prompt and the partially
  // loaded scene are never blocked behind a fade-out.
  if (immediate) {
    overlay.style.opacity = "0"
    overlay.style.display = "none"
    return
  }

  overlayTween = gsap.to(overlay, {
    opacity: 0,
    duration: 0.8,
    ease: "power2.out",
    onComplete: () => {
      overlayTween = null
      if (overlay.dataset.state === "hidden") {
        overlay.style.display = "none"
      }
    },
  })
}

function showErrorPanel(failedTasks, blockedTasks = []) {
  const lines = failedTasks.map(
    (task) => `${task.label}（${task.url}）：${describeError(task.error)}`
  )

  if (blockedTasks.length > 0) {
    lines.push(
      `以下资源因模型解码器不可用而未能加载：${blockedTasks
        .map((task) => task.label)
        .join("、")}`
    )
  }
  errorMessage.textContent = lines.join("\n")
  errorPanel.dataset.failedIds = [...failedTasks, ...blockedTasks]
    .map((task) => task.id)
    .join(" ")
  errorPanel.hidden = false
  retryButton.disabled = false
  retryButton.textContent = "重试"
}

function hideErrorPanel() {
  errorPanel.hidden = true
  delete errorPanel.dataset.failedIds
}

function describeError(error) {
  if (!error) return "未知错误"
  if (typeof error === "string") return error
  if (error.message) return error.message
  if (error.target && error.target.status) return `HTTP ${error.target.status}`
  if (error.type) return `请求失败（${error.type}）`
  return "网络请求失败"
}

/**
 * Loaders
 */
// Texture loader
const textureLoader = new THREE.TextureLoader()

const loadTexture = (url) =>
  new Promise((resolve, reject) => {
    textureLoader.load(url, resolve, undefined, reject)
  })

// Draco decoder files are shared between loader instances so that retrying a
// failed decoder request does not download the files that already succeeded.
const dracoLibraryCache = new Map()

// DRACOLoader caches its decoder init promise, so a failed init would
// otherwise stay rejected forever. Track that here so the loader can be
// rebuilt before the next attempt.
const dracoState = { initFailed: false }

function createDracoLoader() {
  const loader = new DRACOLoader()
  loader.setDecoderPath("draco/")

  const loadLibrary = loader._loadLibrary.bind(loader)
  loader._loadLibrary = (url, responseType) => {
    const cacheKey = `${responseType || "default"}:${url}`
    if (dracoLibraryCache.has(cacheKey)) {
      return Promise.resolve(dracoLibraryCache.get(cacheKey))
    }

    return loadLibrary(url, responseType).then((data) => {
      dracoLibraryCache.set(cacheKey, data)
      return data
    })
  }

  const initDecoder = loader._initDecoder.bind(loader)
  loader._initDecoder = () => {
    const pending = initDecoder()
    // DRACOLoader.preload() ignores this promise, so without an attached
    // handler a failed decoder request surfaces as an unhandled rejection.
    // Attaching one also lets us flag the failure for the retry path.
    pending.catch(() => {
      dracoState.initFailed = true
    })
    return pending
  }

  return loader
}

let dracoLoader = createDracoLoader()

// GLTF loader
let gltfLoader = new GLTFLoader()
gltfLoader.setDRACOLoader(dracoLoader)

const loadGLTF = (url) =>
  new Promise((resolve, reject) => {
    gltfLoader.load(url, resolve, undefined, reject)
  })

function resetDracoLoader() {
  dracoLoader.dispose()
  dracoLoader = createDracoLoader()
  gltfLoader = new GLTFLoader()
  gltfLoader.setDRACOLoader(dracoLoader)
  dracoState.initFailed = false
}

/**
 * Mesh
 */
const floorGeometry = new PlaneBufferGeometry(4, 4, 1)
const floorMaterial = new MeshBasicMaterial({ color: "#2b1d0e" })
const floorMesh = new Mesh(floorGeometry, floorMaterial)
floorMesh.rotation.x = Math.PI * 0.5
scene.add(floorMesh)

/**
 * Koi Fish
 */
const koiMaterial = new THREE.MeshMatcapMaterial()

//Koi Fish path
const curve = new THREE.CatmullRomCurve3([
  new THREE.Vector3(-0.3, 0.2, -0.3),
  new THREE.Vector3(0.5, 0.2, -0.1),
  new THREE.Vector3(0.2, 0.2, 0.7),
  new THREE.Vector3(-0.8, 0.2, 0.7),
  new THREE.Vector3(-0.6, 0.2, 0.1),
  new THREE.Vector3(-0.6, 0.2, -0.2),
])

curve.curveType = "centripetal"
curve.closed = true

const points = curve.getPoints(50)
const lineGeometry = new THREE.BufferGeometry().setFromPoints(points)

const lineMaterial = new THREE.LineBasicMaterial({
  transparent: true,
  opacity: 0,
})

const curveObject = new THREE.LineLoop(lineGeometry, lineMaterial)

scene.add(curveObject)

let flow = null

/**
 * Water
 */

//geometry
const waterGeometry = new THREE.PlaneGeometry(2.5, 2.5, 150, 150)

//material
debugObject.waterColor1 = "#96c4e8"
debugObject.waterColor2 = "#e1c1eb"

// The GUI exists before the material is constructed. Keep the latest selected
// colors here so a drag can never touch an undefined material, and so the
// current selection is picked up the moment the material becomes available.
const waterColors = createWaterColorBinding({
  uColor1: debugObject.waterColor1,
  uColor2: debugObject.waterColor2,
})

gui.addColor(debugObject, "waterColor1").onChange((value) => {
  waterColors.setColor("uColor1", value)
})
gui.addColor(debugObject, "waterColor2").onChange((value) => {
  waterColors.setColor("uColor2", value)
})

const waterMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uColor1: { value: new THREE.Color(waterColors.selection.uColor1) },
    uColor2: { value: new THREE.Color(waterColors.selection.uColor2) },
  },
  vertexShader: waterVertexShader,
  fragmentShader: waterFragmentShader,
  transparent: true,
})

waterColors.attachMaterial(waterMaterial)

//mesh
const waterMesh = new Mesh(waterGeometry, waterMaterial)
waterMesh.rotation.x = -Math.PI * 0.5
waterMesh.position.set(0, 0.3, 0.2)
scene.add(waterMesh)

/**
 * Material
 */
//Baked material (its map is attached once the texture resource loads)
const bakedMaterial = new THREE.MeshBasicMaterial()

//Pole light material
const lampMeshMaterial = new THREE.MeshBasicMaterial({ color: "#f5deb3" })

/**
 * Fireflies
 */
// Geometry

const firefliesGeomerty = new THREE.BufferGeometry()
const firefliesCount = 30
const positionArray = new Float32Array(firefliesCount * 3) //xyz
const scaleArray = new Float32Array(firefliesCount) //number

for (let i = 0; i < firefliesCount; i++) {
  positionArray[i * 3 + 0] = (Math.random() - 0.5) * 4
  positionArray[i * 3 + 1] = Math.random() * 1.5 + 0.3
  positionArray[i * 3 + 2] = (Math.random() - 0.5) * 4 + 0.5

  scaleArray[i] = Math.random()
}

firefliesGeomerty.setAttribute(
  "position",
  new THREE.BufferAttribute(positionArray, 3) //xyz
)

firefliesGeomerty.setAttribute(
  "aScale",
  new THREE.BufferAttribute(scaleArray, 1) //number
)

const firefliesMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    uSize: { value: 200 },
    uTime: { value: 0 },
  },
  vertexShader: firefliesVertexShader,
  fragmentShader: firefliesFragmentShader,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
})

gui
  .add(firefliesMaterial.uniforms.uSize, "value")
  .min(0)
  .max(500)
  .step(1)
  .name("firefiessize")

//Points
const fireflies = new THREE.Points(firefliesGeomerty, firefliesMaterial)
scene.add(fireflies)

/**
 * Sizes
 */
const sizes = {
  width: window.innerWidth,
  height: window.innerHeight,
}

/**
 * Camera
 */
// Base camera
const camera = new THREE.PerspectiveCamera(
  35,
  sizes.width / sizes.height,
  0.1,
  100
)
//真上から
// camera.position.x = 0
// camera.position.y = 4
// camera.position.z = 0

//camera postion
camera.position.x = 4.1
camera.position.y = 2.8
camera.position.z = 4.1
scene.add(camera)

// Controls
const controls = new OrbitControls(camera, canvas)
controls.enableDamping = true

/**
 * Renderer
 */
const renderer = new THREE.WebGLRenderer({
  canvas: canvas,
  antialias: true,
})
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(sizes.width, sizes.height)
renderer.outputEncoding = THREE.sRGBEncoding

debugObject.clearColor = "#d49c9c"
renderer.setClearColor(debugObject.clearColor)
gui.addColor(debugObject, "clearColor").onChange(() => {
  renderer.setClearColor(debugObject.clearColor)
})

window.addEventListener("resize", () => {
  // Update sizes
  sizes.width = window.innerWidth
  sizes.height = window.innerHeight

  // Update camera
  camera.aspect = sizes.width / sizes.height
  camera.updateProjectionMatrix()

  // Update renderer
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(sizes.width, sizes.height)

  //Update fireflies
  firefliesMaterial.uniforms.uPixelRatio.value = Math.min(
    window.devicePixelRatio,
    2
  )

  // Resizing only touches GPU state. It never re-enters the resource
  // registry, so models and textures are not loaded again.
})

/**
 * Resources
 *
 * Every loadable asset is one task. A task is requested at most once per
 * successful outcome; retries only run the tasks that are not loaded yet
 * (i.e. failed, or waiting on a failed dependency).
 */
function defineResource(id, label, url, run, options = {}) {
  return {
    id,
    label,
    url,
    run,
    // Models need the Draco decoder; textures do not.
    needsDecoder: options.needsDecoder !== false,
    status: "idle",
    error: null,
  }
}

function runDecoder() {
  try {
    dracoLoader.preload()
    return dracoLoader.decoderPending
  } catch (error) {
    return Promise.reject(error)
  }
}

async function runMatcapTexture() {
  const texture = await loadTexture("./matcaps11.png")

  // Flow clones the koi material when the model is bent along the curve, so
  // the texture has to reach those clones too (the texture may finish after
  // the model, or on a retry after a failure).
  koiMaterial.matcap = texture
  koiMaterial.needsUpdate = true

  koiFlowMaterials.forEach((material) => {
    material.matcap = texture
    material.needsUpdate = true
  })
}

let koiModelApplied = false
let flowCreationCount = 0
let koiFlowMaterials = []

async function runKoiModel() {
  if (koiModelApplied) return

  const gltf = await loadGLTF("./koi.glb")

  // A timed-out attempt may still settle late; never create a second Flow or
  // add the model twice.
  if (koiModelApplied) return

  const koi = gltf.scene.children.find((child) => child.name === "fish")

  if (!koi) throw new Error("模型中未找到 fish 节点")
  if (!koi.children.length) throw new Error("fish 节点不包含可渲染对象")

  koi.children[0].material = koiMaterial

  const nextFlow = new Flow(gltf.scene) //move on the curve
  nextFlow.updateCurve(0, curve)

  // Remember the cloned materials so a late matcap can still be applied.
  const clonedMaterials = []
  nextFlow.object3D.traverse((child) => {
    if (child.isMesh && child.material) clonedMaterials.push(child.material)
  })

  koiFlowMaterials = clonedMaterials
  flow = nextFlow
  flowCreationCount += 1
  koiModelApplied = true
  scene.add(flow.object3D)
}

async function runBakedTexture() {
  const texture = await loadTexture("./jg-bake.jpg")
  texture.flipY = false
  texture.encoding = THREE.sRGBEncoding

  bakedMaterial.map = texture
  bakedMaterial.needsUpdate = true
}

let gardenModelApplied = false

async function runGardenModel() {
  if (gardenModelApplied) return

  const gltf = await loadGLTF("./japanese-garden.glb")

  // A timed-out attempt may still settle late; never add the model twice.
  if (gardenModelApplied) return

  const bakedMesh = gltf.scene.children.find((child) => child.name === "bake")
  const shishiodoshiMesh = gltf.scene.children.find(
    (child) => child.name === "shishi"
  )
  const lampMesh = gltf.scene.children.find((child) => child.name === "lamp")

  if (!bakedMesh || !shishiodoshiMesh || !lampMesh) {
    throw new Error("模型中缺少 bake / shishi / lamp 节点")
  }

  bakedMesh.material = shishiodoshiMesh.material = bakedMaterial
  lampMesh.material = lampMeshMaterial

  gardenModelApplied = true
  scene.add(gltf.scene)

  gsap.to(shishiodoshiMesh.rotation, {
    x: Math.PI * 0.25,
    repeat: -1,
    yoyo: true,
    repeatDelay: 2,
    ease: "power3.out",
    duration: 2,
  })
}

const resources = [
  defineResource("decoder", "模型解码器", "draco/", runDecoder),
  defineResource("matcap", "锦鲤材质贴图", "./matcaps11.png", runMatcapTexture, {
    needsDecoder: false,
  }),
  defineResource("koi", "锦鲤模型", "./koi.glb", runKoiModel),
  defineResource("baked", "庭院烘焙贴图", "./jg-bake.jpg", runBakedTexture, {
    needsDecoder: false,
  }),
  defineResource("garden", "庭院模型", "./japanese-garden.glb", runGardenModel),
]

const decoderTask = resources.find((task) => task.id === "decoder")
const textureTasks = resources.filter((task) => !task.needsDecoder)
const modelTasks = resources.filter(
  (task) => task.needsDecoder && task !== decoderTask
)

// A request that never settles (stalled network, broken decoder worker) would
// otherwise leave the overlay up forever. Timed out tasks are treated like any
// other failure: the overlay exits and the task can be retried.
const TASK_TIMEOUT = 20000

let cycleActive = false
let cyclePromise = null
let cycleIsRetry = false

function updateProgress() {
  if (!cycleActive) return

  const loadedCount = resources.filter((task) => task.status === "loaded").length
  const prefix = cycleIsRetry ? "正在重试失败资源" : "正在加载锦鲤池"
  overlayText.textContent =
    `${prefix}…（${loadedCount}/${resources.length}）`
}

function withTimeout(promise, label, timeout) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`等待 ${label} 超时（${timeout / 1000} 秒）`))
    }, timeout)

    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      }
    )
  })
}

async function attemptTask(task) {
  if (task.status === "loaded" || task.status === "loading") return

  task.status = "loading"
  task.error = null
  updateProgress()

  try {
    await withTimeout(Promise.resolve().then(task.run), task.label, TASK_TIMEOUT)
    task.status = "loaded"
  } catch (error) {
    task.status = "failed"
    task.error = error

    // A decoder failure (including a timeout while its init promise is still
    // pending) leaves the loader unusable, and DRACOLoader caches the rejected
    // init promise. Rebuild it before the next attempt; the decoder files that
    // already arrived stay cached, so nothing is downloaded twice. Decoder
    // init failures triggered from a model load are flagged by the wrapper
    // installed in createDracoLoader().
    if (task.id === "decoder") {
      dracoState.initFailed = true
    }

    console.error(
      `[koi-garden] Failed to load ${task.label} (${task.url})`,
      error
    )
  }

  updateProgress()
}

function finishCycle() {
  const failedTasks = resources.filter((task) => task.status === "failed")
  const blockedTasks = resources.filter((task) => task.status === "blocked")

  if (failedTasks.length > 0 || blockedTasks.length > 0) {
    showErrorPanel(failedTasks, blockedTasks)
    hideOverlay(true)
    return
  }

  hideErrorPanel()
  hideOverlay(false)
}

function runLoadingCycle() {
  if (cycleActive) return cyclePromise

  cycleActive = true
  cycleIsRetry = resources.some(
    (task) => task.status === "failed" || task.status === "blocked"
  )
  retryButton.disabled = true

  // Blocked tasks never ran; put them back in the queue for this round.
  resources.forEach((task) => {
    if (task.status === "blocked") task.status = "idle"
  })

  if (cycleIsRetry) {
    retryButton.textContent = "重试中…"
    // Hide the prompt while the retry runs; the overlay (and the disabled
    // button) make sure a second click cannot start another round.
    errorPanel.hidden = true
    showOverlay("正在重试失败资源…")
  } else {
    showOverlay("正在加载锦鲤池…")
  }

  updateProgress()

  cyclePromise = (async () => {
    try {
      // Models are Draco-compressed; make sure the decoder is available
      // before any model request starts, so a decoder failure never leaves
      // model downloads in a half-applied state. The decoder is also the only
      // task that can be poisoned by a failed init, so rebuild it first.
      if (dracoState.initFailed) {
        resetDracoLoader()
      }

      // Textures are independent of the decoder and can always run.
      const textureWork = Promise.all(
        textureTasks
          .filter((task) => task.status !== "loaded")
          .map((task) => attemptTask(task))
      )

      if (decoderTask.status !== "loaded") {
        await attemptTask(decoderTask)
      }

      if (decoderTask.status === "loaded") {
        await Promise.all([
          textureWork,
          ...modelTasks
            .filter((task) => task.status !== "loaded")
            .map((task) => attemptTask(task)),
        ])
      } else {
        await textureWork
        // Without the decoder no model request can succeed. Keep those tasks
        // untouched (and clearly marked) so the retry can still run them.
        modelTasks.forEach((task) => {
          if (task.status !== "loaded" && task.status !== "failed") {
            task.status = "blocked"
          }
        })
      }
    } finally {
      cycleActive = false
      finishCycle()
    }
  })()

  return cyclePromise
}

function requestRetry() {
  // A second click while a cycle is in flight must be a no-op.
  if (cycleActive) return
  if (
    !resources.some(
      (task) => task.status === "failed" || task.status === "blocked"
    )
  ) {
    return
  }

  runLoadingCycle()
}

retryButton.addEventListener("click", requestRetry)

/**
 * Animate
 */
const clock = new THREE.Clock()

const tick = () => {
  const elapsedTime = clock.getElapsedTime()

  //Update materials
  firefliesMaterial.uniforms.uTime.value = elapsedTime
  waterMaterial.uniforms.uTime.value = elapsedTime

  //Update Koi
  if (flow) {
    flow.moveAlongCurve(0.001)
  }

  // Update controls
  controls.update()

  // Render
  renderer.render(scene, camera)

  // Call tick again on the next frame
  window.requestAnimationFrame(tick)
}

tick()

// Small read-only surface used by the acceptance checks.
window.__koiGarden = {
  scene,
  camera,
  renderer,
  gui,
  get flow() {
    return flow
  },
  get flowCreationCount() {
    return flowCreationCount
  },
  get waterMaterial() {
    return waterMaterial
  },
  get waterColors() {
    return waterColors
  },
  get firefliesPixelRatio() {
    return firefliesMaterial.uniforms.uPixelRatio.value
  },
  get canvas() {
    return canvas
  },
  get isRetrying() {
    return cycleActive
  },
  getResources: () =>
    resources.map(({ id, label, url, status }) => ({
      id,
      label,
      url,
      status,
    })),
  retryLoading: requestRetry,
}

showOverlay("正在加载锦鲤池…")
runLoadingCycle()
