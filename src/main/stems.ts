import { spawn, execFile } from 'child_process'
import { app } from 'electron'
import { subprocessEnv } from './env'
import { createHash } from 'crypto'
import { promises as fs, existsSync, rmSync } from 'fs'
import { homedir } from 'os'
import path from 'path'

export interface StemResult {
  vocals?: string
  drums?: string
  bass?: string
  other?: string
  instrumental?: string
}

export interface SeparationOptions {
  model: string
  onProgress: (line: string) => void
  /** Optional abort signal: when it fires, this caller stops waiting with a
   *  SeparationCancelledError; the underlying process is killed once no
   *  callers remain interested in the result. */
  signal?: AbortSignal
}

/** Rejection used for every cancellation path so callers can tell "the user
 *  walked away" apart from a real separation failure. */
export class SeparationCancelledError extends Error {
  constructor(message = 'Separation cancelled') {
    super(message)
    this.name = 'SeparationCancelledError'
  }
}

/** Models exposed in the UI. htdemucs_ft is the 4-stem DJ default;
 *  BS-Roformer is SOTA for vocal/instrumental splits. */
export const STEM_MODELS = {
  'htdemucs_ft.yaml': { label: 'Demucs v4 FT (4 stems: vocals/drums/bass/other)', stems: 4 },
  'model_bs_roformer_ep_317_sdr_12.9755.ckpt': { label: 'BS-Roformer SOTA (vocals + instrumental)', stems: 2 }
} as const

/** Stems each model must produce for a cache directory to count as complete.
 *  A 4-stem cache must never satisfy a 2-stem query or vice versa. */
const FOUR_STEMS: (keyof StemResult)[] = ['vocals', 'drums', 'bass', 'other']
const TWO_STEMS: (keyof StemResult)[] = ['vocals', 'instrumental']
const EXPECTED_STEMS: Record<string, (keyof StemResult)[]> = Object.fromEntries(
  Object.entries(STEM_MODELS).map(([file, info]) => [
    file,
    info.stems === 4 ? FOUR_STEMS : TWO_STEMS
  ])
)

/** Written into a cache dir only after every expected stem exists on disk;
 *  it is what separates a finished cache from an interrupted one. */
const MARKER_FILE = 'stems.json'

const BIN_CANDIDATES = [
  'audio-separator',
  path.join(homedir(), '.local/bin/audio-separator'),
  '/opt/homebrew/bin/audio-separator',
  '/usr/local/bin/audio-separator'
]

let resolvedBin: string | null = null

/** Spawned separators, killed on app quit so they don't run orphaned. */
const liveProcesses = new Set<import('child_process').ChildProcess>()

/** Temp working dirs of in-flight jobs, removed synchronously on quit. */
const liveTempDirs = new Set<string>()

app.on('will-quit', () => {
  for (const job of jobs.values()) cancelJob(job)
  for (const proc of liveProcesses) killProcessTree(proc)
  for (const dir of liveTempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort during shutdown */
    }
  }
})

export async function findSeparatorBin(): Promise<string | null> {
  if (resolvedBin) return resolvedBin
  const override = process.env.STEMDECK_AUDIO_SEPARATOR
  const candidates = override ? [override, ...BIN_CANDIDATES] : BIN_CANDIDATES
  for (const bin of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      execFile(bin, ['--version'], { timeout: 15000, env: subprocessEnv() }, (err) =>
        resolve(!err)
      )
    })
    if (ok) {
      resolvedBin = bin
      return bin
    }
  }
  return null
}

function cacheDirFor(trackPath: string, model: string): string {
  const hash = createHash('sha1').update(`${trackPath}::${model}`).digest('hex').slice(0, 16)
  return path.join(app.getPath('userData'), 'stems', hash)
}

/** Map output files to stem names based on audio-separator's "(Stem)" naming convention. */
async function collectStems(dir: string): Promise<StemResult> {
  const result: StemResult = {}
  const files = await fs.readdir(dir)
  for (const file of files) {
    if (!/\.(wav|flac|mp3)$/i.test(file)) continue
    const lower = file.toLowerCase()
    const full = path.join(dir, file)
    if (lower.includes('(vocals)')) result.vocals = full
    else if (lower.includes('(drums)')) result.drums = full
    else if (lower.includes('(bass)')) result.bass = full
    else if (lower.includes('(other)')) result.other = full
    else if (lower.includes('(instrumental)')) result.instrumental = full
  }
  return result
}

function hasAnyStem(r: StemResult): boolean {
  return Boolean(r.vocals || r.drums || r.bass || r.other || r.instrumental)
}

function expectedStemsFor(model: string): (keyof StemResult)[] | null {
  return EXPECTED_STEMS[model] ?? null
}

function isCompleteForModel(stems: StemResult, model: string): boolean {
  const expected = expectedStemsFor(model)
  if (!expected) return hasAnyStem(stems)
  return expected.every((stem) => Boolean(stems[stem]))
}

async function writeMarker(dir: string, model: string, stems: StemResult): Promise<void> {
  await fs.writeFile(path.join(dir, MARKER_FILE), JSON.stringify({ model, stems }), 'utf8')
}

/** A cache dir is only trustworthy with a marker whose model matches and
 *  whose stem files all still exist. */
async function readMarkedCache(dir: string, model: string): Promise<StemResult | null> {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(dir, MARKER_FILE), 'utf8'))
    if (!marker || marker.model !== model || !marker.stems) return null
    const stems: StemResult = marker.stems
    const files = Object.values(stems)
    if (files.length === 0) return null
    for (const file of files) {
      if (typeof file !== 'string' || !existsSync(file)) return null
    }
    return stems
  } catch {
    return null
  }
}

export async function getCachedStems(trackPath: string, model: string): Promise<StemResult | null> {
  void sweepStaleTempDirs()
  const dir = cacheDirFor(trackPath, model)
  if (!existsSync(dir)) return null

  const marked = await readMarkedCache(dir, model)
  if (marked) return marked

  // Legacy or interrupted directory without a valid marker: only trust it
  // when it holds every stem the model is supposed to produce; anything
  // short of that is a partial result and must never be served as a cache
  // hit — delete it so the next call starts clean.
  const stems = await collectStems(dir)
  if (!isCompleteForModel(stems, model)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    return null
  }
  await writeMarker(dir, model, stems).catch(() => {})
  return stems
}

// ---------- Single-flight job registry ----------

interface Job {
  key: string
  tmpDir: string
  proc: import('child_process').ChildProcess | null
  cancelled: boolean
  lastLines: string[]
  listeners: Set<(line: string) => void>
  waiters: number
  promise: Promise<StemResult>
}

/** In-flight separations keyed by `trackPath::model`: any number of callers
 *  for the same key share exactly one audio-separator process. */
const jobs = new Map<string, Job>()
let tmpCounter = 0

function killProcessTree(proc: import('child_process').ChildProcess | null): void {
  if (!proc || proc.pid == null || proc.exitCode !== null || proc.signalCode !== null) return
  if (process.platform === 'win32') {
    // Best-effort sweep for grandchildren (audio-separator may spawn worker
    // processes). taskkill can be slow, so it runs in the background…
    execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], () => {})
    // …while the direct child is terminated right away, so the job's close
    // handler, cleanup, and waiting callers are not blocked on taskkill.
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
  } else {
    // Spawned detached, so the child leads its own process group — signal
    // the whole group to take worker processes down with it.
    try {
      process.kill(-proc.pid, 'SIGTERM')
    } catch {
      try {
        proc.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-proc.pid!, 'SIGKILL')
      } catch {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }, 3000)
    timer.unref?.()
  }
}

function cancelJob(job: Job): void {
  if (job.cancelled) return
  job.cancelled = true
  // Unregister right away: a retry after cancellation must start a fresh
  // job, never attach to one that is about to reject. The cancelled job
  // still finishes its own cleanup in the background.
  if (jobs.get(job.key) === job) jobs.delete(job.key)
  killProcessTree(job.proc)
}

/** Cancel the running separation for one track+model, if any. Every waiter
 *  is rejected with SeparationCancelledError and the temp dir is removed. */
export function cancelSeparation(trackPath: string, model: string): void {
  const job = jobs.get(`${trackPath}::${model}`)
  if (job) cancelJob(job)
}

/** Cancel everything in flight (window closed / app quitting). */
export function cancelAllSeparations(): void {
  for (const job of jobs.values()) cancelJob(job)
}

let swept = false
/** Remove temp dirs left behind by a crashed or force-killed previous run. */
async function sweepStaleTempDirs(): Promise<void> {
  if (swept) return
  swept = true
  try {
    const root = path.join(app.getPath('userData'), 'stems')
    const entries = await fs.readdir(root)
    const active = new Set([...jobs.values()].map((job) => path.basename(job.tmpDir)))
    await Promise.all(
      entries
        .filter((entry) => entry.includes('.tmp-') && !active.has(entry))
        .map((entry) =>
          fs.rm(path.join(root, entry), { recursive: true, force: true }).catch(() => {})
        )
    )
  } catch {
    /* stems root may not exist yet */
  }
}

function broadcast(job: Job, data: Buffer): void {
  // tqdm progress bars update via \r without newlines
  for (const raw of data.toString().split(/[\r\n]+/)) {
    const line = raw.trim()
    if (!line) continue
    job.lastLines.push(line)
    if (job.lastLines.length > 20) job.lastLines = job.lastLines.slice(-20)
    for (const listener of job.listeners) {
      try {
        listener(line)
      } catch {
        /* a broken listener must not kill the job */
      }
    }
  }
}

function runProcess(job: Job, bin: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(bin, args, {
      env: subprocessEnv(),
      windowsHide: true,
      // Own process group on POSIX so cancellation can signal the whole tree.
      detached: process.platform !== 'win32'
    })
    job.proc = proc
    liveProcesses.add(proc)
    // Cancellation may have landed between the pre-spawn check and now.
    if (job.cancelled) killProcessTree(proc)
    proc.stdout.on('data', (data: Buffer) => broadcast(job, data))
    proc.stderr.on('data', (data: Buffer) => broadcast(job, data))
    proc.on('error', (err) => {
      job.proc = null
      liveProcesses.delete(proc)
      reject(err)
    })
    proc.on('close', (code, signal) => {
      job.proc = null
      liveProcesses.delete(proc)
      if (job.cancelled) {
        reject(new SeparationCancelledError())
      } else if (code === 0) {
        resolve()
      } else {
        reject(
          new Error(
            `audio-separator exited with code ${code ?? signal}:\n${job.lastLines.join('\n')}`
          )
        )
      }
    })
  })
}

async function runJob(job: Job, trackPath: string, model: string, outDir: string): Promise<StemResult> {
  const bin = await findSeparatorBin()
  if (!bin) {
    throw new Error(
      'audio-separator not found. Install it with: pipx install "audio-separator[cpu]" (see README)'
    )
  }

  // Work in a temp dir and only move it into place once every expected stem
  // exists — the cache location therefore never holds a partial result.
  const tmpDir = job.tmpDir
  await fs.rm(tmpDir, { recursive: true, force: true })
  await fs.mkdir(tmpDir, { recursive: true })
  liveTempDirs.add(tmpDir)

  const finish = async (): Promise<StemResult> => {
    const stems = await collectStems(tmpDir)
    if (!hasAnyStem(stems)) {
      throw new Error(`Separation finished but no stem files were found in ${tmpDir}`)
    }
    if (!isCompleteForModel(stems, model)) {
      const missing = (expectedStemsFor(model) ?? []).filter((stem) => !stems[stem])
      throw new Error(`Separation finished but stems are missing: ${missing.join(', ')}`)
    }
    // Replace any stale/partial directory atomically-ish: same-volume rename.
    await fs.rm(outDir, { recursive: true, force: true })
    await fs.rename(tmpDir, outDir)
    liveTempDirs.delete(tmpDir)
    // Paths changed with the rename — re-collect so both the marker and
    // the returned result point at the final cache location.
    const finalStems = await collectStems(outDir)
    await writeMarker(outDir, model, finalStems)
    return finalStems
  }

  try {
    // Cancellation may have landed while the binary was being resolved.
    if (job.cancelled) throw new SeparationCancelledError()
    await runProcess(job, bin, [
      trackPath,
      '--model_filename',
      model,
      '--output_dir',
      tmpDir,
      '--output_format',
      'wav',
      '--log_level',
      'info'
    ])
    return await finish()
  } catch (err) {
    liveTempDirs.delete(tmpDir)
    // Cancelled or failed runs must not leave anything that a later call
    // could mistake for a finished cache.
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

function startJob(trackPath: string, model: string): Job {
  const key = `${trackPath}::${model}`
  const outDir = cacheDirFor(trackPath, model)
  const job: Job = {
    key,
    tmpDir: `${outDir}.tmp-${process.pid}-${tmpCounter++}`,
    proc: null,
    cancelled: false,
    lastLines: [],
    listeners: new Set(),
    waiters: 0,
    promise: null as unknown as Promise<StemResult> // assigned immediately below
  }
  job.promise = (async () => {
    // A previous run may have completed while no job was registered.
    const cached = await getCachedStems(trackPath, model)
    if (cached) return cached
    return runJob(job, trackPath, model, outDir)
  })()
  // Waiters attach their own handlers; this keeps the shared promise from
  // ever surfacing as an unhandled rejection.
  job.promise.catch(() => {})
  jobs.set(key, job)
  const unregister = (): void => {
    if (jobs.get(key) === job) jobs.delete(key)
  }
  // Not .finally(): that would leave a derived promise that rejects unhandled.
  job.promise.then(unregister, unregister)
  return job
}

function waitForJob(job: Job, signal?: AbortSignal): Promise<StemResult> {
  job.waiters++
  return new Promise<StemResult>((resolve, reject) => {
    let settled = false
    const release = (): void => {
      job.waiters--
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      if (settled) return
      settled = true
      release()
      reject(new SeparationCancelledError())
      // The process only earns its keep while someone is waiting for it.
      if (job.waiters === 0) cancelJob(job)
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    job.promise.then(
      (stems) => {
        if (settled) return
        settled = true
        release()
        resolve(stems)
      },
      (err) => {
        if (settled) return
        settled = true
        release()
        reject(err)
      }
    )
  })
}

export async function separateStems(trackPath: string, opts: SeparationOptions): Promise<StemResult> {
  if (opts.signal?.aborted) throw new SeparationCancelledError()
  void sweepStaleTempDirs()
  const key = `${trackPath}::${opts.model}`
  // Registered synchronously so concurrent callers can never start a second
  // process for the same track+model, no matter how they interleave.
  const job = jobs.get(key) ?? startJob(trackPath, opts.model)
  job.listeners.add(opts.onProgress)
  // Late joiners immediately see where the run is at.
  const lastLine = job.lastLines[job.lastLines.length - 1]
  if (lastLine) {
    try {
      opts.onProgress(lastLine)
    } catch {
      /* ignore listener errors */
    }
  }
  try {
    return await waitForJob(job, opts.signal)
  } finally {
    job.listeners.delete(opts.onProgress)
  }
}
