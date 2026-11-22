/**
 * Acceptance tests for the stem-separation cache/queue in stems.ts, run in
 * plain Node (see the `test` script in package.json):
 *
 *   esbuild src/main/stems.test.ts --bundle --platform=node \
 *     --alias:electron=./scripts/electron-stub.mjs ... && node out/test/stems.test.mjs
 *
 * The real audio-separator binary is replaced by the Node executable running
 * scripts/fake-audio-separator.mjs (the fake's path doubles as the "track").
 */
import assert from 'node:assert'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import {
  cancelSeparation,
  getCachedStems,
  separateStems,
  SeparationCancelledError,
  type StemResult
} from './stems'

const MODEL_4_STEM = 'htdemucs_ft.yaml'
const MODEL_2_STEM = 'model_bs_roformer_ep_317_sdr_12.9755.ckpt'

const userData = app.getPath('userData')
const stemsRoot = path.join(userData, 'stems')
const logFile = path.join(userData, 'invocations.jsonl')

process.env.STEMDECK_AUDIO_SEPARATOR = process.execPath
process.env.FAKE_SEP_LOG = logFile

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const noop = (): void => {}

interface Invocation {
  pid: number
  model: string
  outDir: string
}

async function invocations(): Promise<Invocation[]> {
  try {
    const raw = await readFile(logFile, 'utf8')
    return raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Invocation)
  } catch {
    return []
  }
}

function cacheDirFor(trackPath: string, model: string): string {
  const hash = createHash('sha1').update(`${trackPath}::${model}`).digest('hex').slice(0, 16)
  return path.join(stemsRoot, hash)
}

async function leftoverTempDirs(): Promise<string[]> {
  try {
    return (await readdir(stemsRoot)).filter((entry) => entry.includes('.tmp-'))
  } catch {
    return []
  }
}

async function processAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(cond: () => Promise<boolean>, label: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting for: ${label}`)
    await sleep(50)
  }
}

async function expectCancelled(promise: Promise<StemResult>, label: string): Promise<void> {
  try {
    await promise
    assert.fail(`${label}: expected SeparationCancelledError, got a successful result`)
  } catch (err) {
    assert.ok(
      err instanceof SeparationCancelledError || /cancelled/i.test((err as Error).message),
      `${label}: expected a cancellation error, got: ${err}`
    )
  }
}

/** Each "track" is a copy of the fake separator so distinct tracks get
 *  distinct cache keys while all staying runnable by Node. */
async function makeTrack(name: string): Promise<string> {
  const dest = path.join(userData, name)
  await copyFile(path.resolve('scripts/fake-audio-separator.mjs'), dest)
  return dest
}

const tests: { name: string; run: () => Promise<void> }[] = []
const test = (name: string, run: () => Promise<void>): void => {
  tests.push({ name, run })
}

test('concurrent calls for the same track+model share one process and one result', async () => {
  const track = await makeTrack('track-concurrent.mjs')
  process.env.FAKE_SEP_DURATION_MS = '600'
  const lines1: string[] = []
  const lines2: string[] = []

  const [r1, r2] = await Promise.all([
    separateStems(track, { model: MODEL_4_STEM, onProgress: (l) => lines1.push(l) }),
    separateStems(track, { model: MODEL_4_STEM, onProgress: (l) => lines2.push(l) })
  ])

  assert.deepEqual(r1, r2, 'both callers must receive the same stems')
  assert.ok(r1.vocals && r1.drums && r1.bass && r1.other, '4-stem result must be complete')
  for (const file of Object.values(r1)) {
    assert.ok(existsSync(file), `stem file must exist at its final path: ${file}`)
  }

  const runs = (await invocations()).filter((i) => i.model === MODEL_4_STEM)
  assert.equal(runs.length, 1, `expected exactly 1 separator process, got ${runs.length}`)

  assert.ok(lines1.length > 0, 'first caller must receive progress')
  assert.ok(lines2.length > 0, 'concurrent waiter must receive progress')

  // A third call is a pure cache hit — still only one process overall.
  const cached = await separateStems(track, { model: MODEL_4_STEM, onProgress: noop })
  assert.deepEqual(cached, r1)
  assert.equal((await invocations()).filter((i) => i.model === MODEL_4_STEM).length, 1)
})

test('different models never share a cache', async () => {
  const track = await makeTrack('track-models.mjs')
  process.env.FAKE_SEP_DURATION_MS = '50'

  const four = await separateStems(track, { model: MODEL_4_STEM, onProgress: noop })
  assert.ok(four.drums && four.bass && four.other, '4-stem model must yield 4 stems')

  // The 2-stem model must not hit the 4-stem cache — a new process runs.
  assert.equal(await getCachedStems(track, MODEL_2_STEM), null)
  const two = await separateStems(track, { model: MODEL_2_STEM, onProgress: noop })
  assert.ok(two.vocals && two.instrumental, '2-stem model must yield vocals + instrumental')
  assert.ok(!two.drums && !two.bass && !two.other, '2-stem result must not borrow 4-stem files')

  const runs = await invocations()
  assert.ok(runs.some((i) => i.model === MODEL_2_STEM), '2-stem model must run its own process')

  // …and the 4-stem cache is still intact afterwards.
  assert.deepEqual(await getCachedStems(track, MODEL_4_STEM), four)
})

test('cancel kills the process, cleans up, and a retry succeeds', async () => {
  const track = await makeTrack('track-cancel.mjs')
  process.env.FAKE_SEP_DURATION_MS = '30000'

  const pending = separateStems(track, { model: MODEL_4_STEM, onProgress: noop })
  await sleep(500) // let the process actually start
  cancelSeparation(track, MODEL_4_STEM)
  await expectCancelled(pending, 'cancelled separation')

  const runs = (await invocations()).filter((i) => i.outDir.includes('.tmp-'))
  const last = runs[runs.length - 1]
  assert.ok(last, 'a separator process must have started')
  assert.equal(await processAlive(last.pid), false, 'cancelled process must not survive')

  assert.equal(await getCachedStems(track, MODEL_4_STEM), null, 'cancel leaves no cache')
  assert.deepEqual(await leftoverTempDirs(), [], 'cancel leaves no temp dir')

  process.env.FAKE_SEP_DURATION_MS = '50'
  const retried = await separateStems(track, { model: MODEL_4_STEM, onProgress: noop })
  assert.ok(retried.vocals && retried.drums && retried.bass && retried.other, 'retry must succeed')
})

test('aborting the last waiter via AbortSignal cancels the job', async () => {
  const track = await makeTrack('track-abort.mjs')
  process.env.FAKE_SEP_DURATION_MS = '30000'

  const controller = new AbortController()
  const pending = separateStems(track, {
    model: MODEL_4_STEM,
    onProgress: noop,
    signal: controller.signal
  })
  await sleep(500)
  controller.abort()
  await expectCancelled(pending, 'aborted separation')
  // Killing the process tree and removing the temp dir finishes shortly
  // after the waiter is released — wait for it to settle.
  await waitFor(async () => (await leftoverTempDirs()).length === 0, 'temp dir cleanup')
  const runs = (await invocations()).filter((i) => i.outDir.includes('.tmp-'))
  const last = runs[runs.length - 1]
  assert.ok(last, 'a separator process must have started')
  await waitFor(async () => !(await processAlive(last.pid)), 'aborted process to die')

  process.env.FAKE_SEP_DURATION_MS = '50'
  const retried = await separateStems(track, { model: MODEL_4_STEM, onProgress: noop })
  assert.ok(retried.vocals, 'retry after abort must succeed')
})

test('a partial cache directory is never reused', async () => {
  const track = await makeTrack('track-partial.mjs')
  process.env.FAKE_SEP_DURATION_MS = '50'

  // Simulate an interrupted run: one stem of four, no completion marker.
  const dir = cacheDirFor(track, MODEL_4_STEM)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'Song (Vocals).wav'), 'half a split')

  assert.equal(await getCachedStems(track, MODEL_4_STEM), null, 'partial dir must not be served')
  assert.equal(existsSync(dir), false, 'partial dir must be removed')

  const before = (await invocations()).length
  const stems = await separateStems(track, { model: MODEL_4_STEM, onProgress: noop })
  assert.ok(stems.vocals && stems.drums && stems.bass && stems.other)
  assert.equal((await invocations()).length, before + 1, 'partial cache must trigger a real run')

  // A markerless dir that DOES hold every stem (legacy cache) is still valid.
  const legacyTrack = await makeTrack('track-legacy.mjs')
  const legacyDir = cacheDirFor(legacyTrack, MODEL_2_STEM)
  await mkdir(legacyDir, { recursive: true })
  await writeFile(path.join(legacyDir, 'Song (Vocals).wav'), 'v')
  await writeFile(path.join(legacyDir, 'Song (Instrumental).wav'), 'i')
  const legacy = await getCachedStems(legacyTrack, MODEL_2_STEM)
  assert.ok(legacy?.vocals && legacy.instrumental, 'complete legacy dir is a valid cache')
  // …but the same files must not satisfy the 4-stem model.
  assert.equal(await getCachedStems(legacyTrack, MODEL_4_STEM), null)
})

test('a non-zero exit keeps exit code + log tail, cleans up, and allows retry', async () => {
  const track = await makeTrack('track-fail.mjs')
  process.env.FAKE_SEP_DURATION_MS = '50'
  process.env.FAKE_SEP_FAIL = '3'

  try {
    await separateStems(track, { model: MODEL_4_STEM, onProgress: noop })
    assert.fail('expected the separation to fail')
  } catch (err) {
    const message = (err as Error).message
    assert.ok(message.includes('code 3'), `error must keep the exit code: ${message}`)
    assert.ok(
      message.includes('something went horribly wrong'),
      `error must keep the log tail: ${message}`
    )
  }

  assert.equal(await getCachedStems(track, MODEL_4_STEM), null, 'failure leaves no cache')
  assert.equal(existsSync(cacheDirFor(track, MODEL_4_STEM)), false, 'no half-written cache dir')
  assert.deepEqual(await leftoverTempDirs(), [], 'failure leaves no temp dir')

  delete process.env.FAKE_SEP_FAIL
  const retried = await separateStems(track, { model: MODEL_4_STEM, onProgress: noop })
  assert.ok(retried.vocals && retried.drums, 'retry after failure must succeed')
})

async function main(): Promise<void> {
  await mkdir(stemsRoot, { recursive: true })
  let failed = 0
  for (const { name, run } of tests) {
    try {
      await run()
      console.log(`ok - ${name}`)
    } catch (err) {
      failed++
      console.error(`FAIL - ${name}`)
      console.error(err)
    }
  }

  // Global invariants: nothing left running, nothing left on disk but caches.
  const tempDirs = await leftoverTempDirs()
  assert.deepEqual(tempDirs, [], `temp dirs left behind: ${tempDirs}`)
  for (const run of await invocations()) {
    assert.equal(await processAlive(run.pid), false, `separator process ${run.pid} still alive`)
  }

  if (failed > 0) {
    console.error(`${failed} test(s) failed`)
    process.exit(1)
  }
  console.log(`all ${tests.length} stems tests passed`)
}

await main()
