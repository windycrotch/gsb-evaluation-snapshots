/**
 * Cancelable deck-load session tests. Run with `npm test`. Plain assertions,
 * no framework — bundled with esbuild and executed by node, throws on the
 * first failure. The audio engine is replaced by a recording mock so the
 * ordering rules (supersede, failure-to-idle, intent binding) can be driven
 * deterministically with controllable promises.
 */
import { LoadSession, type DeckIntent, type LoadSessionDeps } from './loadSession'
import { emptyDeck, type AutotuneState, type DeckState, type TrackInfo } from '../state/store'

let checks = 0
function assert(condition: boolean, message: string): void {
  checks += 1
  if (!condition) throw new Error(`check ${checks} failed: ${message}`)
}
function equal(actual: unknown, expected: unknown, message: string): void {
  checks += 1
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `check ${checks} failed: ${message}\n  actual   ${JSON.stringify(actual)}\n  expected ${JSON.stringify(expected)}`
    )
  }
}

type MockDeck = LoadSessionDeps['deck']

/** A deferred promise so a load can be held open and resolved out of order. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: Error) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type StemsDeferred = ReturnType<typeof deferred<{ name: string; buffer: AudioBuffer }[]>>

function makeTrack(id: string, opts: Partial<TrackInfo> = {}): TrackInfo {
  return {
    id,
    path: `/music/${id}.mp3`,
    name: id,
    duration: 10,
    bpm: 120,
    firstBeat: 0,
    bpmConfidence: 1,
    musicalKey: opts.musicalKey ?? null,
    musicalScale: opts.musicalScale ?? null,
    keyStrength: 1,
    analysisV: 2,
    analyzing: false,
    stems: opts.stems ?? null,
    separating: false,
    stemStatus: '',
    folderId: null,
    sections: Array(10).fill(null)
  }
}

/** Minimal fake stems; only identity matters, no real audio decoding. */
function fakeStems(name: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({ name: `${name}-${i}`, buffer: {} as AudioBuffer }))
}

function makeDeps(tracks: Map<string, TrackInfo>, resolvers: Map<string, StemsDeferred>) {
  let state: DeckState = emptyDeck()
  const calls: string[] = []
  const deck: MockDeck = {
    duration: 42,
    load: (stems: { name: string }[]) => calls.push(`load:${stems.map((s) => s.name).join('|')}`),
    unload: () => calls.push('unload'),
    setTempo: (rate: number) => calls.push(`tempo:${rate}`),
    setPitch: (semitones: number) => calls.push(`pitch:${semitones}`),
    setKeylock: (enabled: boolean) => calls.push(`keylock:${enabled}`),
    setAutotune: (settings: Partial<AutotuneState>) =>
      calls.push(`autotune:${JSON.stringify(settings)}`)
  }
  const hiPeaks: (unknown | null)[] = []
  const peaks: (unknown | null)[] = []
  const errors: string[] = []
  const deps: LoadSessionDeps = {
    getTrack: (id) => tracks.get(id),
    resolveStems: (track) => {
      const d = resolvers.get(track.id)!
      return d.promise
    },
    computeHiPeaks: () => ({ data: new Float32Array(2), buckets: 1 }),
    getTrackPeaks: (id) => (id === 'no-peaks' ? null : ({ data: new Float32Array(2), buckets: 1 })),
    deck,
    resetDeck: () => emptyDeck(),
    commitState: (patch) => {
      state = { ...state, ...patch }
      return state
    },
    setHiPeaks: (p) => {
      hiPeaks.length = 0
      hiPeaks.push(p)
    },
    setPeaks: (p) => {
      peaks.length = 0
      peaks.push(p)
    },
    onLoadError: (m) => errors.push(m)
  }
  return {
    deps,
    deck,
    calls,
    getState: () => state,
    hiPeaks,
    peaks,
    errors
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

// ---------- 1. Out-of-order loads: the later load wins, the older is discarded ----------
{
  const tracks = new Map([
    ['old', makeTrack('old')],
    ['new', makeTrack('new')]
  ])
  const oldD = deferred<{ name: string; buffer: AudioBuffer }[]>()
  const newD = deferred<{ name: string; buffer: AudioBuffer }[]>()
  const resolvers = new Map([
    ['old', oldD],
    ['new', newD]
  ])
  const harness = makeDeps(tracks, resolvers)

  const s1 = LoadSession.begin(0, 'old', harness.deps)
  const p1 = s1.run(harness.deps)
  const s2 = LoadSession.begin(0, 'new', harness.deps)
  const p2 = s2.run(harness.deps)
  assert(LoadSession.current(0) === s2, 'second session is current immediately')
  assert(s1.id < s2.id, 'session ids increase per deck')

  // New load resolves first, then the stale old load.
  newD.resolve(fakeStems('new', 1))
  await flush()
  oldD.resolve(fakeStems('old', 1))
  await Promise.all([p1, p2])

  const s = harness.getState()
  assert(s.loading === false, 'deck not loading')
  equal(s.trackId, 'new', 'winning track is the second-loaded song')
  equal(s.title, 'new', 'title belongs to the winning song')
  assert(!harness.calls.some((c) => c.startsWith('load:old')), 'old audio never reached the engine')
  assert(harness.calls.some((c) => c === 'load:new-0'), 'new audio reached the engine')
  assert(LoadSession.current(0) === null, 'session cleared after settle')
}

// ---------- 2. A failed live load returns the deck to a fully idle, retryable state ----------
{
  const tracks = new Map([['boom', makeTrack('boom')]])
  const d = deferred<{ name: string; buffer: AudioBuffer }[]>()
  const harness = makeDeps(tracks, new Map([['boom', d]]))

  const s1 = LoadSession.begin(0, 'boom', harness.deps)
  const p1 = s1.run(harness.deps)
  d.reject(new Error('disk exploded'))
  await p1

  const s = harness.getState()
  equal(s, emptyDeck(), 'failed load leaves a pristine empty deck in the store')
  assert(harness.hiPeaks[0] === null && harness.peaks[0] === null, 'no half-waveform left behind')
  assert(harness.calls.includes('unload'), 'engine audio was dropped')
  assert(harness.errors.length === 1 && harness.errors[0].includes('disk exploded'), 'error surfaced')
  assert(LoadSession.current(0) === null, 'no live session after failure')

  // Retry the same track: a fresh session must be able to commit normally.
  const d2 = deferred<{ name: string; buffer: AudioBuffer }[]>()
  const harness2Resolvers = new Map([['boom', d2]])
  const retry = makeDeps(tracks, harness2Resolvers)
  const s2 = LoadSession.begin(0, 'boom', retry.deps)
  const p2 = s2.run(retry.deps)
  d2.resolve(fakeStems('boom', 1))
  await p2
  equal(retry.getState().trackId, 'boom', 'same track can be loaded again after failure')
  assert(retry.getState().loading === false, 'retry settles out of loading')

  // A failed load keeps the same user prefs that a successful swap would.
  const prefTracks = new Map([['pf', makeTrack('pf')]])
  const prefD = deferred<{ name: string; buffer: AudioBuffer }[]>()
  const prefHarness = makeDeps(prefTracks, new Map([['pf', prefD]]))
  prefHarness.deps.preserved = () => ({ pitchRange: 0.5, reverb: 0.3, sectionPhrase: 2, sectionLoop: true })
  const prefSession = LoadSession.begin(0, 'pf', prefHarness.deps)
  const prefRun = prefSession.run(prefHarness.deps)
  prefD.reject(new Error('nope'))
  await prefRun
  equal(prefHarness.getState().pitchRange, 0.5, 'pitch range survives a failed load')
  equal(prefHarness.getState().reverb, 0.3, 'reverb survives a failed load')
  equal(prefHarness.getState().sectionPhrase, 2, 'phrase survives a failed load')
  equal(prefHarness.getState().sectionLoop, true, 'section loop survives a failed load')
  assert(prefHarness.getState().trackId === null, 'but no track remains loaded')
}

// ---------- 3. A load that fails after being superseded must not reset the winner ----------
{
  const tracks = new Map([
    ['a', makeTrack('a')],
    ['b', makeTrack('b')]
  ])
  const aD = deferred<{ name: string; buffer: AudioBuffer }[]>()
  const bD = deferred<{ name: string; buffer: AudioBuffer }[]>()
  const harness = makeDeps(
    tracks,
    new Map([
      ['a', aD],
      ['b', bD]
    ])
  )

  const s1 = LoadSession.begin(0, 'a', harness.deps)
  const p1 = s1.run(harness.deps)
  LoadSession.begin(0, 'b', harness.deps).run(harness.deps)
  bD.resolve(fakeStems('b', 2))
  await flush()
  aD.reject(new Error('late failure'))
  await p1
  await flush()

  equal(harness.getState().trackId, 'b', 'stale failure cannot wipe the winning track')
  assert(!harness.calls.includes('unload'), 'winner engine audio was not unloaded')
  assert(harness.errors.length === 0, 'stale failure produces no user-visible error')
}

// ---------- 4. Intents during a load replay onto the winning song's engine only ----------
{
  const tracks = new Map([['k', makeTrack('k', { musicalKey: 7, musicalScale: 'minor' })]])
  const d = deferred<{ name: string; buffer: AudioBuffer }[]>()
  const harness = makeDeps(tracks, new Map([['k', d]]))

  const session = LoadSession.begin(0, 'k', harness.deps)
  const p = session.run(harness.deps)

  // User changes tempo, keylock, pitch, autotune while decoding.
  const intents: DeckIntent[] = [
    { kind: 'tempo', rate: 1.05 },
    { kind: 'keylock', enabled: true, pitchReset: false },
    { kind: 'pitch', semitones: 2 },
    { kind: 'autotune', patch: { enabled: true } }
  ]
  for (const intent of intents) session.intents.push(intent)

  // No engine control calls beyond the initial autotune reset while pending.
  const pendingCalls = [...harness.calls]
  assert(
    pendingCalls.every((c) => c.startsWith('autotune:')),
    'intents never touch the outgoing song engine graph'
  )

  d.resolve(fakeStems('k', 4))
  await p

  const calls = harness.calls
  const loadIdx = calls.findIndex((c) => c.startsWith('load:'))
  const afterLoad = calls.slice(loadIdx)
  // Neutral transport immediately after the audio swap, then the intents in
  // arrival order.
  equal(
    afterLoad.slice(0, 4),
    ['load:k-0|k-1|k-2|k-3', 'tempo:1', 'pitch:0', 'keylock:false'],
    'fresh track starts from neutral transport'
  )
  assert(afterLoad.includes('tempo:1.05'), 'tempo intent replayed')
  assert(afterLoad.includes('keylock:true'), 'keylock intent replayed')
  assert(afterLoad.includes('pitch:2'), 'pitch intent replayed')
  assert(
    afterLoad.some((c) => c.includes('"enabled":true')),
    'autotune enable intent replayed onto the new graph'
  )
}

// ---------- 5. Manual key during load suppresses the detected key ----------
{
  const tracks = new Map([['m', makeTrack('m', { musicalKey: 7, musicalScale: 'minor' })]])
  const d = deferred<{ name: string; buffer: AudioBuffer }[]>()
  const harness = makeDeps(tracks, new Map([['m', d]]))

  const session = LoadSession.begin(0, 'm', harness.deps)
  const p = session.run(harness.deps)
  session.manualKey = true
  session.intents.push({ kind: 'autotune', patch: { key: 2, scale: 'majorPentatonic' } })
  d.resolve(fakeStems('m', 4))
  await p

  const at = harness.getState().autotune
  equal(at.key, 2, 'manual key kept')
  equal(at.scale, 'majorPentatonic', 'manual scale kept')
  assert(
    !harness.calls.some((c) => c.includes('"key":7')),
    'detected key never overwrote the manual choice in the engine'
  )
}

// ---------- 6. No manual key: detected pentatonic key is applied after commit ----------
{
  const tracks = new Map([['d', makeTrack('d', { musicalKey: 9, musicalScale: 'major' })]])
  const dfd = deferred<{ name: string; buffer: AudioBuffer }[]>()
  const harness = makeDeps(tracks, new Map([['d', dfd]]))

  const session = LoadSession.begin(0, 'd', harness.deps)
  const p = session.run(harness.deps)
  dfd.resolve(fakeStems('d', 4))
  await p

  const at = harness.getState().autotune
  equal(at.key, 9, 'detected root applied')
  equal(at.scale, 'majorPentatonic', 'detected mode converted to pentatonic')
  assert(
    harness.calls.some((c) => c.includes('"key":9') && c.includes('majorPentatonic')),
    'detected key applied to engine after the load committed'
  )
}

// ---------- 7. Detected key without a manual choice still respects an enable intent ----------
{
  const tracks = new Map([['e', makeTrack('e', { musicalKey: 5, musicalScale: 'minor' })]])
  const dfd = deferred<{ name: string; buffer: AudioBuffer }[]>()
  const harness = makeDeps(tracks, new Map([['e', dfd]]))

  const session = LoadSession.begin(0, 'e', harness.deps)
  const p = session.run(harness.deps)
  session.intents.push({ kind: 'autotune', patch: { enabled: true } })
  dfd.resolve(fakeStems('e', 4))
  await p

  const at: AutotuneState = harness.getState().autotune
  assert(at.enabled === true, 'enable intent survives the detected-key merge')
  equal(at.key, 5, 'detected key merged alongside the manual enable')
  equal(at.scale, 'minorPentatonic', 'minor detected mode maps to minor pentatonic')
}

// ---------- 8. Full-mix and stem paths share the same session semantics ----------
{
  const mixTrack = makeTrack('mix')
  const stemTrack = makeTrack('stem', {
    stems: { vocals: '/v.wav', drums: '/d.wav', bass: '/b.wav', other: '/o.wav', instrumental: '/i.wav' }
  })
  for (const [track, stemCount] of [
    [mixTrack, 1],
    [stemTrack, 5]
  ] as const) {
    const tracks = new Map([[track.id, track]])
    const dfd = deferred<{ name: string; buffer: AudioBuffer }[]>()
    const harness = makeDeps(tracks, new Map([[track.id, dfd]]))
    const session = LoadSession.begin(0, track.id, harness.deps)
    const p = session.run(harness.deps)
    dfd.resolve(fakeStems(track.id, stemCount))
    await p
    equal(harness.getState().usingStems, stemCount > 1, `usingStems correct for ${track.id}`)
    equal(
      harness.getState().stems.length,
      stemCount,
      `stem list length correct for ${track.id}`
    )
  }
}

// ---------- 9. Preferences are preserved across the reset; everything else is not ----------
{
  const tracks = new Map([['p', makeTrack('p')]])
  const dfd = deferred<{ name: string; buffer: AudioBuffer }[]>()
  const harness = makeDeps(tracks, new Map([['p', dfd]]))
  harness.deps.preserved = () => ({ pitchRange: 0.5, reverb: 0.4, sectionPhrase: 4, sectionLoop: true })

  const session = LoadSession.begin(0, 'p', harness.deps)
  const p = session.run(harness.deps)
  dfd.resolve(fakeStems('p', 1))
  await p

  const s = harness.getState()
  equal(s.pitchRange, 0.5, 'pitch range survived the load')
  equal(s.reverb, 0.4, 'reverb survived the load')
  equal(s.sectionPhrase, 4, 'section phrase survived the load')
  equal(s.sectionLoop, true, 'section loop survived the load')
  equal(s.tempo, 1, 'transport reset')
  equal(s.hotCues, [null, null, null, null], 'hot cues reset')
}

// ---------- 10. Sessions on the two decks are independent ----------
{
  const tracks = new Map([
    ['a', makeTrack('a')],
    ['b', makeTrack('b')]
  ])
  const aD = deferred<{ name: string; buffer: AudioBuffer }[]>()
  const bD = deferred<{ name: string; buffer: AudioBuffer }[]>()
  const harness = makeDeps(
    tracks,
    new Map([
      ['a', aD],
      ['b', bD]
    ])
  )

  const sa = LoadSession.begin(0, 'a', harness.deps)
  const pa = sa.run(harness.deps)
  const sb = LoadSession.begin(1, 'b', harness.deps)
  const pb = sb.run(harness.deps)
  assert(LoadSession.current(0) === sa && LoadSession.current(1) === sb, 'both decks have live sessions')
  aD.resolve(fakeStems('a', 1))
  await pa
  assert(LoadSession.current(0) === null && LoadSession.current(1) === sb, 'settling one deck leaves the other live')
  bD.resolve(fakeStems('b', 1))
  await pb
  assert(LoadSession.current(1) === null, 'second deck settles independently')
}

// ---------- 11. Re-dragging the SAME track starts a fresh, independent session ----------
{
  const tracks = new Map([['same', makeTrack('same')]])
  const d1 = deferred<{ name: string; buffer: AudioBuffer }[]>()
  const d2 = deferred<{ name: string; buffer: AudioBuffer }[]>()
  let which = 0
  const deps: LoadSessionDeps = {
    ...makeDeps(tracks, new Map()).deps,
    resolveStems: () => (which++ === 0 ? d1.promise : d2.promise)
  }
  const calls: string[] = []
  // Wrap the deck to observe calls while reusing the shared harness adapter.
  const wrappedDeck: MockDeck = {
    duration: 42,
    load: (s) => calls.push(`load:${s.length}`),
    unload: () => calls.push('unload'),
    setTempo: () => {},
    setPitch: () => {},
    setKeylock: () => {},
    setAutotune: () => {}
  }
  deps.deck = wrappedDeck

  const s1 = LoadSession.begin(0, 'same', deps)
  const p1 = s1.run(deps)
  const s2 = LoadSession.begin(0, 'same', deps)
  const p2 = s2.run(deps)
  assert(s1.id !== s2.id && LoadSession.current(0) === s2, 're-drag gets a new live session')
  d1.resolve(fakeStems('same', 3))
  await flush()
  assert(!calls.some((c) => c === 'load:3'), 'superseded same-track load never publishes')
  d2.resolve(fakeStems('same', 2))
  await Promise.all([p1, p2])
  assert(calls.includes('load:2'), 'second same-track load commits its own stems')
}

// ---------- 12. Repeated intents of one kind: last write wins, in order ----------
{
  const tracks = new Map([['r', makeTrack('r')]])
  const dfd = deferred<{ name: string; buffer: AudioBuffer }[]>()
  const harness = makeDeps(tracks, new Map([['r', dfd]]))
  const session = LoadSession.begin(0, 'r', harness.deps)
  const p = session.run(harness.deps)
  session.intents.push(
    { kind: 'tempo', rate: 1.02 },
    { kind: 'tempo', rate: 1.04 },
    { kind: 'tempo', rate: 0.97 }
  )
  dfd.resolve(fakeStems('r', 1))
  await p
  const tempoCalls = harness.calls.filter((c) => c.startsWith('tempo:'))
  equal(
    tempoCalls,
    ['tempo:1', 'tempo:1.02', 'tempo:1.04', 'tempo:0.97'],
    'all tempo intents replay in order, leaving the last value effective'
  )
  equal(harness.getState().loading, false, 'deck settled')
}

// ---------- 13. A missing track id settles the deck idle without an error toast ----------
{
  const tracks = new Map<string, TrackInfo>()
  const dfd = deferred<{ name: string; buffer: AudioBuffer }[]>()
  const harness = makeDeps(tracks, new Map([['ghost', dfd]]))
  const session = LoadSession.begin(0, 'ghost', harness.deps)
  await session.run(harness.deps)
  equal(harness.getState(), emptyDeck(), 'unknown track leaves an idle deck')
  assert(harness.errors.length === 0, 'vanished track is not reported as a load failure')
  assert(harness.calls.includes('unload'), 'engine unloaded anyway')
}

console.log(`loadSession: ${checks} checks passed`)
