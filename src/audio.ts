// Sound, in the manner of an old game: short dry recordings, each play pitched a little by chance.
//
//   samples ─▶ gain (its loudness, falls off with distance) ─▶ panner (left or right of the eye) ─┐
//   loops (wind, torch) ─▶ gain ──────────────────────────────────────────────────────────────────┼─▶ master
//   the song (an <audio> element, streamed) ─▶ gain ──────────────────────────────────────────────┘     │
//                                                                             speakers ◀── compressor ◀─┘
//
// A browser only lets a page make sound once the player has touched it: nothing exists before unlock().
// The files are in public/audio (sources in its CREDITS.md): mono 22 kHz recordings, low-fi on purpose.

const AUDIO_PATH = '/audio/'

// Each sound: its takes (one is picked by chance) and the gain it is played at. The files are levelled by
// family (steps and loops -32 LUFS, the hit -24, voices -22.5): the gains set how loud each is in the game.
const SOUNDS = {
  stepGrass: { files: ['step-grass-1', 'step-grass-2', 'step-grass-3', 'step-grass-4'], volume: 1.8 },
  stepGravel: { files: ['step-gravel-1', 'step-gravel-2', 'step-gravel-3', 'step-gravel-4'], volume: 1.8 },
  land: { files: ['land'], volume: 1.2 },
  swing: { files: ['swing'], volume: 1 },
  hit: { files: ['hit'], volume: 1.3 },
  hurt: { files: ['hurt'], volume: 1 },
  down: { files: ['down'], volume: 1 },
  heal: { files: ['heal'], volume: 0.5 },
  club: { files: ['club'], volume: 1.1 },
  goblinAlert: { files: ['goblin-alert-1', 'goblin-alert-2'], volume: 0.9 },
  goblinHurt: { files: ['goblin-hurt-1', 'goblin-hurt-2'], volume: 0.9 },
  goblinDeath: { files: ['goblin-death'], volume: 1 },
  goblinIdle: { files: ['goblin-idle-1', 'goblin-idle-2'], volume: 0.6 },
}
export type SoundName = keyof typeof SOUNDS

// Loops that never stop. The wind is as loud as the gust that passes: from `calm` of its volume to all of it.
const WIND = { file: 'wind', volume: 1.3, calm: 0.35 }
const TORCH = { file: 'torch', volume: 0.65 }
// the song is mastered loud (-11.7 LUFS): it plays under the game, at about -28
const SONG = { url: `${AUDIO_PATH}music.mp3`, volume: 0.15 }

// how much the pitch of a sample differs from play to play: 0.12 is 6% up or down
const PITCH_SPREAD = 0.12
// a sound this far from the eye is half as loud, metres; past HEARING_RANGE it is not played
const HALF_LOUD_DISTANCE = 7
const HEARING_RANGE = 45
// how far to one side a sound beside the eye is heard, 0..1
const PAN_MOST = 0.7
// seconds the wind takes to follow a gust
const WIND_EASE_SECONDS = 0.6

export function buildAudio() {
  const closing = new AbortController()
  addEventListener('pagehide', () => closing.abort(), { once: true })
  const buffers = new Map<string, AudioBuffer>()
  const ear = { x: 0, z: 0, yaw: 0 }
  // all of these exist once the player has touched the page
  let live: { context: AudioContext; master: GainNode; wind: GainNode; song: HTMLAudioElement } | undefined
  let muted = false

  const start = () => {
    const context = new AudioContext()
    const master = context.createGain()
    master.gain.value = muted ? 0 : 1
    // a pack that cries out at once is held under full level and never clips
    master.connect(context.createDynamicsCompressor()).connect(context.destination)
    const gain = (volume: number) => {
      const node = context.createGain()
      node.gain.value = volume
      node.connect(master)
      return node
    }
    const wind = gain(WIND.volume * WIND.calm)
    const torch = gain(TORCH.volume)

    // the song goes through the graph, not through the element's own volume: iOS ignores that
    const song = new Audio(SONG.url)
    song.loop = true
    context.createMediaElementSource(song).connect(gain(SONG.volume))

    const load = async ({ file, signal }: { file: string; signal: AbortSignal }) => {
      const response = await fetch(`${AUDIO_PATH}${file}.wav`, { signal })
      if (!response.ok) throw new Error(`${file}.wav: ${response.status}`)
      buffers.set(file, await context.decodeAudioData(await response.arrayBuffer()))
    }
    const loop = ({ file, into }: { file: string; into: GainNode }) => {
      const source = context.createBufferSource()
      source.buffer = buffers.get(file) ?? null
      source.loop = true
      source.connect(into)
      source.start()
    }
    // A sound that fails to load is only missing: the game goes on without it.
    const missing = (error: Error) => {
      if (!closing.signal.aborted) console.warn('sound not loaded:', error)
    }
    for (const file of Object.values(SOUNDS).flatMap((sound) => sound.files)) load({ file, signal: closing.signal }).catch(missing)
    load({ file: WIND.file, signal: closing.signal })
      .then(() => loop({ file: WIND.file, into: wind }))
      .catch(missing)
    load({ file: TORCH.file, signal: closing.signal })
      .then(() => loop({ file: TORCH.file, into: torch }))
      .catch(missing)
    return { context, master, wind, song }
  }

  // a tab that is not seen makes no sound
  document.addEventListener('visibilitychange', () => {
    if (!live) return
    if (document.hidden) {
      live.song.pause()
      void live.context.suspend()
      return
    }
    void live.context.resume()
    live.song.play().catch(() => {})
  })

  return {
    /** Call from every key, click and touch: the first one starts the sound, a later one wakes it again. */
    unlock() {
      live ??= start()
      if (live.context.state === 'suspended') void live.context.resume()
      // refused until the browser counts a touch as one: the next touch asks again
      if (live.song.paused) live.song.play().catch(() => {})
    },
    /** Where the eye is and how hard the wind blows there, 0..1. Once a frame. */
    update({ x, z, yaw, gust }: { x: number; z: number; yaw: number; gust: number }) {
      Object.assign(ear, { x, z, yaw })
      if (!live) return
      const volume = WIND.volume * (WIND.calm + (1 - WIND.calm) * gust)
      live.wind.gain.setTargetAtTime(volume, live.context.currentTime, WIND_EASE_SECONDS)
    },
    /**
     * Plays one take of a sound. volume and rate scale its own. at: where in the world it is made (it is then
     * quieter with distance and heard to one side); without it the sound is the player's own. delay: seconds.
     */
    play({ sound, volume = 1, rate = 1, at, delay = 0 }: { sound: SoundName; volume?: number; rate?: number; at?: { x: number; z: number }; delay?: number }) {
      if (!live) return
      const { files, volume: own } = SOUNDS[sound]
      const buffer = buffers.get(files[Math.floor(Math.random() * files.length)])
      if (!buffer) return
      let loudness = own * volume
      let side = 0
      if (at) {
        const dx = at.x - ear.x
        const dz = at.z - ear.z
        const distance = Math.hypot(dx, dz)
        if (distance > HEARING_RANGE) return
        loudness /= 1 + (distance / HALF_LOUD_DISTANCE) ** 2
        // the eye looks along (-sin yaw, -cos yaw): its right is (cos yaw, -sin yaw)
        if (distance > 0) side = ((dx * Math.cos(ear.yaw) - dz * Math.sin(ear.yaw)) / distance) * PAN_MOST
      }
      const { context, master } = live
      const source = context.createBufferSource()
      source.buffer = buffer
      source.playbackRate.value = rate * (1 + (Math.random() - 0.5) * PITCH_SPREAD)
      const gain = context.createGain()
      gain.gain.value = loudness
      const panner = context.createStereoPanner()
      panner.pan.value = side
      source.connect(gain).connect(panner).connect(master)
      source.start(context.currentTime + delay)
    },
    /** Turns all sound off or on again. Returns whether it is off now. */
    toggleMute() {
      muted = !muted
      if (live) live.master.gain.value = muted ? 0 : 1
      return muted
    },
  }
}
