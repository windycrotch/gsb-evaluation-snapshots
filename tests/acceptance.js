/**
 * Acceptance checks for the koi garden loading flow.
 *
 * Runs the production bundle in headless Chrome and drives five scenarios:
 *   1. normal load
 *   2. single resource failure, then a successful retry
 *   3. clicking retry repeatedly while a retry is in flight
 *   4. draco decoder failure, then a successful retry
 *   5. resize + water color changes (including a drag before the material exists)
 *
 * Usage:
 *   npm run build
 *   npm install --no-save puppeteer-core
 *   node tests/acceptance.js
 *
 * puppeteer-core is not a project dependency (it is only needed to run these
 * checks and it requires a newer Node than the 2021 build toolchain targets),
 * so it is installed on demand rather than pinned into package.json.
 */
const path = require("path")
const fs = require("fs")

let puppeteer
try {
  puppeteer = require("puppeteer-core")
} catch (error) {
  console.error(
    "puppeteer-core is not installed. Run:\n  npm install --no-save puppeteer-core"
  )
  process.exit(1)
}

const { createServer } = require("./static-server")

const ROOT = path.resolve(__dirname, "..")
const DIST = path.join(ROOT, "dist")

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean)

const chromePath = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate))

if (!chromePath) {
  console.error("No Chrome/Edge binary found; set CHROME_PATH.")
  process.exit(1)
}

const results = []

function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail })
  const mark = condition ? "PASS" : "FAIL"
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(page, fn, { timeout = 30000, interval = 50 } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = await page.evaluate(fn)
    if (value) return value
    await sleep(interval)
  }
  throw new Error("waitFor timed out")
}

async function openPage(browser, url) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1024, height: 700, deviceScaleFactor: 1 })

  const errors = []
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`))
  page.on("console", (message) => {
    if (message.type() === "error") {
      const text = message.text()
      // Failed requests are expected in the failure scenarios (the app also
      // logs them on purpose); anything else is a real error.
      if (
        text.includes("[koi-garden]") ||
        text.includes("Failed to load resource")
      ) {
        return
      }
      errors.push(text)
    }
  })

  await page.goto(url, { waitUntil: "domcontentloaded" })
  return { page, errors }
}

async function readUi(page) {
  return page.evaluate(() => {
    const overlay = document.getElementById("loading-overlay")
    const panel = document.getElementById("load-error")
    const retry = document.getElementById("load-retry")
    const state = window.__koiGarden

    const overlayStyle = getComputedStyle(overlay)
    const overlayVisible =
      overlayStyle.display !== "none" &&
      Number(overlayStyle.opacity) > 0.01 &&
      overlay.getAttribute("aria-hidden") !== "true"

    return {
      overlayVisible,
      overlayState: overlay.dataset.state,
      panelVisible: !panel.hidden,
      panelText: document.getElementById("load-error-message").textContent,
      failedIds: (panel.dataset.failedIds || "").split(" ").filter(Boolean),
      retryDisabled: retry.disabled,
      retryLabel: retry.textContent.trim(),
      isRetrying: state ? state.isRetrying : null,
      resources: state ? state.getResources() : [],
      flowCreationCount: state ? state.flowCreationCount : null,
      sceneChildren: state ? state.scene.children.length : null,
    }
  })
}

async function waitForSettled(page) {
  await waitFor(page, () => {
    const state = window.__koiGarden
    if (!state) return false
    const settled = state
      .getResources()
      .every((resource) => resource.status !== "loading" && resource.status !== "idle")
    return settled && !state.isRetrying
  })
}

async function scenarioNormal(browser, url) {
  console.log("\n1) normal load")
  const { page, errors } = await openPage(browser, url)

  await waitForSettled(page)
  await waitFor(page, () => {
    const overlay = document.getElementById("loading-overlay")
    return getComputedStyle(overlay).display === "none"
  })
  await sleep(300)

  const ui = await readUi(page)
  check("overlay exits after all resources load", !ui.overlayVisible)
  check(
    "all resources report loaded",
    ui.resources.every((resource) => resource.status === "loaded"),
    ui.resources.map((r) => `${r.id}:${r.status}`).join(", ")
  )
  check("no error prompt shown", !ui.panelVisible)
  check("koi flow created once", ui.flowCreationCount === 1, `count=${ui.flowCreationCount}`)

  const animation = await page.evaluate(async () => {
    const state = window.__koiGarden
    const before = state.waterMaterial.uniforms.uTime.value
    await new Promise((resolve) => setTimeout(resolve, 350))
    return {
      waterTimeAdvanced: state.waterMaterial.uniforms.uTime.value > before,
      hasFlow: state.flow !== null,
    }
  })
  check("water animation clock advances", animation.waterTimeAdvanced)
  check("koi flow object exists", animation.hasFlow)
  check("no page errors", errors.length === 0, errors.join(" | "))

  await page.close()
}

async function scenarioFailureThenRetry(browser, url, server) {
  console.log("\n2) single resource failure, then retry succeeds")
  server.state.failing = new Set(["koi.glb"])

  const { page, errors } = await openPage(browser, url)
  await waitForSettled(page)
  await sleep(300)

  const failed = await readUi(page)
  check("overlay exits despite the failure", !failed.overlayVisible)
  check("error prompt is readable", failed.panelVisible && failed.panelText.length > 0, failed.panelText)
  check(
    "error prompt names the failed resource",
    failed.failedIds.length === 1 && failed.failedIds[0] === "koi",
    failed.failedIds.join(",")
  )
  check("retry button enabled", !failed.retryDisabled)
  check(
    "other resources already loaded",
    failed.resources.filter((r) => r.status === "loaded").length === 4,
    failed.resources.map((r) => `${r.id}:${r.status}`).join(", ")
  )
  check("no koi flow yet", failed.flowCreationCount === 0, `count=${failed.flowCreationCount}`)

  // Each successful resource must not be requested again on retry.
  const hitsBefore = new Map(server.state.hits)
  const sceneBefore = failed.sceneChildren

  server.state.failing = new Set()
  await page.click("#load-retry")
  await waitForSettled(page)
  await sleep(400)

  const retried = await readUi(page)
  check("overlay exits after successful retry", !retried.overlayVisible)
  check("error prompt cleared", !retried.panelVisible)
  check(
    "failed resource retried successfully",
    retried.resources.every((resource) => resource.status === "loaded"),
    retried.resources.map((r) => `${r.id}:${r.status}`).join(", ")
  )
  check("koi flow created exactly once", retried.flowCreationCount === 1, `count=${retried.flowCreationCount}`)
  check(
    "scene grew by exactly one flow object",
    retried.sceneChildren === sceneBefore + 1,
    `${sceneBefore} -> ${retried.sceneChildren}`
  )

  const newHits = (key) => (server.state.hits.get(key) || 0) - (hitsBefore.get(key) || 0)
  check("retry re-requests the failed model", newHits("koi.glb") === 1, `hits=${newHits("koi.glb")}`)
  check("retry did not re-request the garden model", newHits("japanese-garden.glb") === 0, `hits=${newHits("japanese-garden.glb")}`)
  check("retry did not re-request the matcap texture", newHits("matcaps11.png") === 0, `hits=${newHits("matcaps11.png")}`)
  check("retry did not re-request the baked texture", newHits("jg-bake.jpg") === 0, `hits=${newHits("jg-bake.jpg")}`)

  // A late retry click with nothing left to do must be ignored.
  const sceneAfterRetry = retried.sceneChildren
  await page.click("#load-retry").catch(() => {})
  await sleep(300)
  const idleClick = await readUi(page)
  check(
    "retry click after success does not reload anything",
    idleClick.sceneChildren === sceneAfterRetry && idleClick.flowCreationCount === 1,
    `${sceneAfterRetry} -> ${idleClick.sceneChildren}`
  )
  check("no page errors", errors.length === 0, errors.join(" | "))

  await page.close()
}

async function scenarioConcurrentRetry(browser, url, server) {
  console.log("\n3) clicking retry while a retry is in flight")
  server.state.failing = new Set(["matcaps11.png"])

  const { page, errors } = await openPage(browser, url)
  await waitForSettled(page)
  await sleep(200)

  const failed = await readUi(page)
  check("failure is reported before retry", failed.panelVisible && failed.failedIds[0] === "matcap")

  server.state.failing = new Set()
  server.state.delayMs = 500

  const hitsBefore = server.state.hits.get("matcaps11.png") || 0

  // Three clicks in quick succession; only the first may start a round.
  await page.evaluate(() => {
    const button = document.getElementById("load-retry")
    button.click()
    button.click()
    button.click()
  })

  await sleep(120)
  const during = await page.evaluate(() => ({
    isRetrying: window.__koiGarden.isRetrying,
    retryDisabled: document.getElementById("load-retry").disabled,
    overlayVisible:
      getComputedStyle(document.getElementById("loading-overlay")).display !== "none",
  }))
  check("retry in flight is observable", during.isRetrying)
  check("retry button disabled while retrying", during.retryDisabled)
  check("overlay covers the scene while retrying", during.overlayVisible)

  await waitForSettled(page)
  await sleep(300)
  server.state.delayMs = 0

  const after = await readUi(page)
  const matcapHits = (server.state.hits.get("matcaps11.png") || 0) - hitsBefore
  check("only one retry round ran", matcapHits === 1, `matcap requests=${matcapHits}`)
  check("retry completed successfully", after.resources.every((r) => r.status === "loaded"))
  check("koi flow still created once", after.flowCreationCount === 1, `count=${after.flowCreationCount}`)
  check("error prompt cleared", !after.panelVisible && !after.overlayVisible)
  check("no page errors", errors.length === 0, errors.join(" | "))

  await page.close()
}

async function scenarioDecoderFailure(browser, url, server) {
  console.log("\n5) draco decoder file failure, then retry succeeds")
  // The WASM decoder is the piece DRACOLoader caches internally, so this is the
  // path most likely to stay permanently broken after a single failure.
  server.state.failing = new Set(["draco/draco_decoder.wasm"])

  const hitsAtStart = new Map(server.state.hits)
  const { page, errors } = await openPage(browser, url)
  await waitForSettled(page)
  await sleep(300)

  const failed = await readUi(page)
  check("overlay exits when the decoder fails", !failed.overlayVisible)
  check("decoder failure is readable", failed.panelVisible && failed.panelText.length > 0, failed.panelText)
  check("decoder failure is reported", failed.failedIds.includes("decoder"), failed.failedIds.join(","))
  check(
    "decoder failure does not block independent textures",
    failed.resources
      .filter((resource) => resource.id === "matcap" || resource.id === "baked")
      .every((resource) => resource.status === "loaded"),
    failed.resources.map((r) => `${r.id}:${r.status}`).join(", ")
  )
  check("no koi flow after decoder failure", failed.flowCreationCount === 0, `count=${failed.flowCreationCount}`)

  const hitsBefore = new Map(server.state.hits)
  const newHits = (key) => (server.state.hits.get(key) || 0) - (hitsBefore.get(key) || 0)

  check(
    "blocked models were never requested before the retry",
    (server.state.hits.get("koi.glb") || 0) - (hitsAtStart.get("koi.glb") || 0) === 0 &&
      (server.state.hits.get("japanese-garden.glb") || 0) -
        (hitsAtStart.get("japanese-garden.glb") || 0) ===
        0,
    `koi=${(server.state.hits.get("koi.glb") || 0) - (hitsAtStart.get("koi.glb") || 0)}, ` +
      `garden=${(server.state.hits.get("japanese-garden.glb") || 0) - (hitsAtStart.get("japanese-garden.glb") || 0)}`
  )

  server.state.failing = new Set()

  await page.click("#load-retry")
  await waitForSettled(page)
  await sleep(400)

  const retried = await readUi(page)
  check("overlay exits after decoder retry", !retried.overlayVisible)
  check("error prompt cleared after decoder retry", !retried.panelVisible)
  check(
    "all resources loaded after decoder retry",
    retried.resources.every((resource) => resource.status === "loaded"),
    retried.resources.map((r) => `${r.id}:${r.status}`).join(", ")
  )
  check("koi flow created once after decoder retry", retried.flowCreationCount === 1, `count=${retried.flowCreationCount}`)

  check(
    "retry re-requested only the failed decoder file",
    newHits("draco/draco_decoder.wasm") === 1 &&
      newHits("draco/draco_wasm_wrapper.js") === 0,
    `wasm=${newHits("draco/draco_decoder.wasm")}, wrapper=${newHits("draco/draco_wasm_wrapper.js")}`
  )
  check(
    "retry runs only the blocked models, not textures",
    newHits("koi.glb") === 1 &&
      newHits("japanese-garden.glb") === 1 &&
      newHits("jg-bake.jpg") === 0 &&
      newHits("matcaps11.png") === 0,
    `koi=${newHits("koi.glb")}, garden=${newHits("japanese-garden.glb")}, ` +
      `baked=${newHits("jg-bake.jpg")}, matcap=${newHits("matcaps11.png")}`
  )
  check("no page errors", errors.length === 0, errors.join(" | "))

  await page.close()
}

async function scenarioResizeAndColor(browser, url, server) {
  console.log("\n4) resize and water color timing")
  server.state.failing = new Set(["jg-bake.jpg"])

  const { page, errors } = await openPage(browser, url)
  await waitForSettled(page)
  await page.close()

  server.state.failing = new Set()
  const second = await openPage(browser, url)
  await waitForSettled(second.page)
  await sleep(300)

  // The GUI is built before the water material exists; the binding must
  // tolerate drags in that window and apply the latest selection afterwards.
  const earlyDrag = await second.page.evaluate(() => {
    const state = window.__koiGarden
    const controller = state.gui.__controllers.find(
      (item) => item.property === "waterColor1"
    )
    const uniform = state.waterMaterial.uniforms.uColor1.value

    state.waterColors.detachMaterial()
    try {
      const uniformBefore = uniform.getHexString()
      controller.setValue("#ff0000")
      controller.setValue("#00ff00")
      return {
        threw: false,
        ready: state.waterColors.ready,
        uniformUntouched: uniform.getHexString() === uniformBefore,
        selection: state.waterColors.selection.uColor1,
      }
    } catch (error) {
      return { threw: true, message: String(error && error.message) }
    } finally {
      state.waterColors.attachMaterial(state.waterMaterial)
    }
  })
  check(
    "dragging colors before the material is ready does not throw",
    !earlyDrag.threw,
    earlyDrag.message || ""
  )
  check("binding reports not ready while detached", earlyDrag.ready === false)
  check("detached drag leaves the uniform untouched", earlyDrag.uniformUntouched)
  check(
    "detached drag records the current selection",
    earlyDrag.selection === "#00ff00",
    earlyDrag.selection
  )

  const colors = await second.page.evaluate(() => {
    const state = window.__koiGarden
    return {
      ready: state.waterColors.ready,
      uniform: `#${state.waterMaterial.uniforms.uColor1.value.getHexString()}`,
    }
  })
  check(
    "current selection is applied once the material is ready",
    colors.uniform === "#00ff00",
    colors.uniform
  )

  // A later drag keeps working.
  const lateDrag = await second.page.evaluate(() => {
    const state = window.__koiGarden
    const controller = state.gui.__controllers.find(
      (item) => item.property === "waterColor2"
    )
    controller.setValue("#123456")
    return `#${state.waterMaterial.uniforms.uColor2.value.getHexString()}`
  })
  check("color changes still apply after load", lateDrag === "#123456", lateDrag)

  const loadHitsBefore = new Map(server.state.hits)

  await second.page.setViewport({ width: 800, height: 500, deviceScaleFactor: 2 })
  await sleep(250)
  await second.page.evaluate(() => window.dispatchEvent(new Event("resize")))
  await sleep(250)

  const resized = await second.page.evaluate(() => {
    const state = window.__koiGarden
    const target = { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; return this } }
    state.renderer.getSize(target)
    return {
      aspect: state.camera.aspect,
      pixelRatio: state.renderer.getPixelRatio(),
      fireflyRatio: state.firefliesPixelRatio,
      expectedAspect: window.innerWidth / window.innerHeight,
      expectedRatio: Math.min(window.devicePixelRatio, 2),
      size: { x: target.x, y: target.y },
    }
  })

  check(
    "camera aspect follows resize",
    Math.abs(resized.aspect - resized.expectedAspect) < 1e-6,
    `${resized.aspect} vs ${resized.expectedAspect}`
  )
  check(
    "renderer pixel ratio follows resize",
    resized.pixelRatio === resized.expectedRatio,
    `${resized.pixelRatio} vs ${resized.expectedRatio}`
  )
  check(
    "firefly pixel ratio follows resize",
    resized.fireflyRatio === resized.expectedRatio,
    `${resized.fireflyRatio} vs ${resized.expectedRatio}`
  )
  check(
    "renderer size follows resize",
    Math.abs(resized.size.x - 800) <= 1 && Math.abs(resized.size.y - 500) <= 1,
    `${resized.size.x}x${resized.size.y}`
  )

  const reloads = ["koi.glb", "japanese-garden.glb", "jg-bake.jpg", "matcaps11.png"].map(
    (key) => [key, (server.state.hits.get(key) || 0) - (loadHitsBefore.get(key) || 0)]
  )
  check(
    "resize does not reload resources",
    reloads.every(([, count]) => count === 0),
    reloads.map(([key, count]) => `${key}:${count}`).join(", ")
  )

  const flowAfterResize = await second.page.evaluate(
    () => window.__koiGarden.flowCreationCount
  )
  check("resize keeps a single koi flow", flowAfterResize === 1, `count=${flowAfterResize}`)
  check("no page errors", second.errors.length === 0, second.errors.join(" | "))

  await second.page.close()
}

async function main() {
  const server = createServer(DIST)
  const url = await server.listen(0)

  // Chrome refuses remote debugging with its default profile, and relative or
  // forward-slash profile paths are unreliable on Windows; use an absolute one.
  const userDataDir = path.resolve(ROOT, "tests", ".chrome-profile")
  fs.rmSync(userDataDir, { recursive: true, force: true })

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    userDataDir,
    protocolTimeout: 180000,
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-extensions",
      "--use-gl=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  })

  try {
    await scenarioNormal(browser, url)
    await scenarioFailureThenRetry(browser, url, server)
    await scenarioConcurrentRetry(browser, url, server)
    await scenarioDecoderFailure(browser, url, server)
    await scenarioResizeAndColor(browser, url, server)
  } finally {
    await browser.close()
    await server.close()
  }

  const failedChecks = results.filter((result) => !result.ok)
  console.log(
    `\n${results.length - failedChecks.length}/${results.length} checks passed`
  )

  if (failedChecks.length > 0) {
    console.log("Failed checks:")
    failedChecks.forEach((result) => console.log(`  - ${result.name}`))
    process.exit(1)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
