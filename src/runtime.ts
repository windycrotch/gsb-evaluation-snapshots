import { Howl, Howler } from "howler";
import manifest from "./manifest.json";
import {
  __resetPacksForTesting,
  addPack,
  CustomSoundNames,
  getPackSoundUrl,
  isPackSoundName,
  RegisterSoundsOptions,
  SoundPack,
} from "./packs";
import { AudioPermissionStatus, LibrarySoundName, SoundOptions } from "./types";

/**
 * A built-in sound, a sound from a registered pack, or the URL of an MP3 file.
 * (`string & {}` keeps editor autocompletion for the known names.)
 */
// eslint-disable-next-line @typescript-eslint/ban-types
export type SoundName = LibrarySoundName | keyof CustomSoundNames | (string & {});

export function isLibrarySoundName(name: any): name is LibrarySoundName {
  return name in manifest.sounds;
}

// Default CDN base URL
let cdnBaseUrl = "https://reactsounds.sfo3.cdn.digitaloceanspaces.com/v1";

// Global sound enabled state
let soundEnabledGlobal = true;

// Global event listeners for sound state changes
const soundStateListeners: Array<(enabled: boolean) => void> = [];

// Track if we've already set up audio context unlocking
let audioUnlockInitialized = false;

/**
 * Set a custom CDN base URL
 */
export function setCDNUrl(url: string): void {
  cdnBaseUrl = url;
}

/**
 * Get the CDN base URL
 */
export function getCDNUrl(): string {
  return cdnBaseUrl;
}

/**
 * Cache of preloaded sound blobs to avoid HTML5 audio pool exhaustion.
 * Rejected promises are removed so a later play can retry instead of replaying the failure.
 */
const soundBlobCache: Record<string, Promise<Blob>> = {};

/**
 * Which player a sound uses. Sounds play through an <audio> element (Howler's html5 mode), except
 * looped plays: those use Web Audio, which repeats the decoded sound without the short pause an
 * <audio> element makes every time it restarts. A sound that is played both ways gets one of each.
 */
export interface PlayerOptions {
  loop?: boolean;
}

const cacheKey = (name: SoundName, { loop = false }: PlayerOptions = {}) => (loop ? `${name}loop` : name);

/**
 * One created Howl instance plus the bookkeeping that keeps it alive.
 *
 * Every entry belongs to a `generation` of its cache key. When a sound pack changes a sound's
 * URL, the generation advances: the old entry keeps playing until its last reference is
 * released, while every new claim builds a fresh entry from the new URL.
 */
export type HowlEntry = {
  instance: Howl;
  /** Number of outstanding references (one per claim) */
  subscriptions: number;
  /** Cache key this entry was created for */
  key: string;
  /** Generation of the cache key this entry belongs to */
  generation: number;
  /** Object URL backing the Howl's src, revoked when the entry is destroyed */
  objectUrl?: string;
  /** Resolves once the Howl reports `loaded`; rejects on a load error */
  ready: Promise<void>;
  /** True after a load error or once the entry has been evicted */
  failed: boolean;
};

/**
 * A shared player handed out by {@link claimPlayer}. `release` gives back exactly one reference;
 * `isCurrent` tells whether a pack update has made this player stale (new plays create a new one).
 */
export interface SoundPlayer {
  howl: Howl;
  /** Resolves once the underlying Howl has loaded, rejects when loading fails */
  ready: Promise<void>;
  /** Release this caller's reference. Safe to call multiple times. */
  release: () => void;
  /** Whether this is still the newest player for its sound (false after a pack update) */
  isCurrent: () => boolean;
}

/** All live entries, keyed by `<cacheKey>#g<generation>` */
const howlEntries: Record<string, HowlEntry> = {};
/** The newest entry id for each cache key */
const currentEntryByKey: Record<string, string> = {};
/** In-flight claims for a cache key, shared by concurrent callers */
const pendingClaims: Record<string, Promise<HowlEntry>> = {};
/** Monotonic generation counter per cache key */
const generationByKey: Record<string, number> = {};

const entryId = (key: string, generation: number): string => `${key}#g${generation}`;

/**
 * Make a sound loader function that first tries local files then falls back to CDN
 */
export function makeRemoteSound(name: SoundName, options?: PlayerOptions): () => Promise<HowlEntry> {
  return () => claimEntry(name, options);
}

/**
 * Fetch the blob for a sound, caching the in-flight promise. A rejected fetch is removed from the
 * cache immediately so the next attempt retries rather than inheriting the failure.
 */
function fetchAndCacheBlob(name: SoundName): Promise<Blob> {
  const cached = soundBlobCache[name];
  if (cached) return cached;

  const promise = fetchSoundBlob(name).catch((error) => {
    if (soundBlobCache[name] === promise) delete soundBlobCache[name];
    throw error;
  });
  soundBlobCache[name] = promise;
  return promise;
}

/**
 * Fetch the blob for a build targeting a specific generation. After a pack update the blob cache
 * holds the previous URL's data, so a non-initial generation bypasses the cache and fetches the
 * current URL directly, repopulating the cache for the next ordinary claim.
 */
async function fetchBlobForGeneration(name: SoundName, generation: number): Promise<Blob> {
  if (generation === 0) return fetchAndCacheBlob(name);

  const blob = await fetchSoundBlob(name);
  soundBlobCache[name] = Promise.resolve(blob);
  return blob;
}

/**
 * Claim a shared player for a sound. Concurrent claims for the same sound reuse one Howl instance;
 * each returned player carries its own reference, released via `player.release()`.
 */
export async function claimPlayer(name: SoundName, options?: PlayerOptions): Promise<SoundPlayer> {
  const key = cacheKey(name, options);
  // Every claim counts as one reference, including concurrent ones sharing an in-flight build
  const entry = await claimEntry(name, options);
  entry.subscriptions += 1;
  let released = false;

  return {
    howl: entry.instance,
    ready: entry.ready,
    release: () => {
      if (released) return;
      released = true;
      releaseEntry(key, entry.generation);
    },
    isCurrent: () => currentEntryByKey[key] === entryId(key, entry.generation),
  };
}

/**
 * Build (or reuse) the current entry for a cache key. In-flight builds are shared so concurrent
 * callers never construct duplicate Howls.
 */
async function claimEntry(name: SoundName, options?: PlayerOptions): Promise<HowlEntry> {
  const key = cacheKey(name, options);

  const currentId = currentEntryByKey[key];
  const current = currentId ? howlEntries[currentId] : undefined;
  if (current && !current.failed) return current;

  const pending = pendingClaims[key];
  if (pending) return pending;

  const promise = buildEntry(name, key, options).finally(() => {
    if (pendingClaims[key] === promise) delete pendingClaims[key];
  });
  // Swallow the shared promise's rejection so callers that lose the race don't create an
  // unhandled-rejection crash; each caller still receives the rejection through its own await.
  promise.catch(() => { /* retried by the next claim */ });
  pendingClaims[key] = promise;
  return promise;
}

/**
 * Construct an entry for the cache key's generation at call time. If a pack update advances the
 * generation while the blob is in flight, the stale object URL is discarded and the build restarts
 * for the newest generation, looping until a build completes in its own generation.
 */
async function buildEntry(name: SoundName, key: string, options?: PlayerOptions): Promise<HowlEntry> {
  // Retry loop: each pass targets the generation observed when that pass started.
  for (;;) {
    const targetGeneration = generationByKey[key] ?? 0;
    const blob = await fetchBlobForGeneration(name, targetGeneration);
    const objectUrl = URL.createObjectURL(blob);

    // A pack update may have advanced the key while the blob was loading.
    if ((generationByKey[key] ?? 0) !== targetGeneration) {
      URL.revokeObjectURL(objectUrl);
      continue; // rebuild against the newer generation; pendingClaims still owns this promise
    }

    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const howl = new Howl({
      src: [objectUrl],
      format: ["mp3"],
      // <audio> streams and keeps memory low; Web Audio (for loops) decodes the whole sound, so it can
      // repeat it without a gap
      html5: !options?.loop,
    });

    const entry: HowlEntry = {
      instance: howl,
      subscriptions: 0,
      key,
      generation: targetGeneration,
      objectUrl,
      ready,
      failed: false,
    };
    // Howler invokes these asynchronously once the underlying load settles. Register both before
    // the entry is published so no outcome can be missed.
    howl.on("load", () => resolveReady());
    howl.on("loaderror", (_id, error) => {
      if (entry.failed) return;
      entry.failed = true;
      rejectReady(
        new Error(`Failed to load sound "${name}": ${typeof error === "string" ? error : "decode error"}`)
      );
      // A poisoned Howl must not stay cached: evict it so the next play retries from scratch.
      evictEntry(entry);
    });
    // Don't let an unawaited ready rejection crash the process (callers await it via play/claim)
    entry.ready.catch(() => { /* surfaced through play()/player.ready */ });

    // Re-check the fence after the synchronous Howl construction
    if ((generationByKey[key] ?? 0) !== targetGeneration) {
      URL.revokeObjectURL(objectUrl);
      howl.unload();
      continue; // a newer generation won the race; build that one next
    }

    const id = entryId(key, targetGeneration);
    howlEntries[id] = entry;
    currentEntryByKey[key] = id;
    return entry;
  }
}

/** Drop one reference from the entry of a given generation, destroying it when it was the last. */
function releaseEntry(key: string, generation: number): void {
  const entry = howlEntries[entryId(key, generation)];
  if (!entry) return;

  if (entry.subscriptions > 0) entry.subscriptions -= 1;
  if (entry.subscriptions === 0) destroyEntry(entry);
}

/**
 * Unload an entry and revoke its object URL, but only when nobody holds a reference and nothing is
 * playing (e.g. an old-generation player finishing its tail is kept until the next release).
 */
function destroyEntry(entry: HowlEntry): void {
  if (entry.subscriptions > 0 || entry.instance.playing()) return;

  const id = entryId(entry.key, entry.generation);
  if (howlEntries[id] !== entry) return;

  if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
  entry.objectUrl = undefined;
  entry.instance.unload();
  delete howlEntries[id];
  if (currentEntryByKey[entry.key] === id) delete currentEntryByKey[entry.key];
}

/** Unconditionally remove a dead entry (load error), regardless of outstanding references. */
function evictEntry(entry: HowlEntry): void {
  const id = entryId(entry.key, entry.generation);
  if (howlEntries[id] !== entry) return;

  if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
  entry.objectUrl = undefined;
  entry.instance.unload();
  delete howlEntries[id];
  if (currentEntryByKey[entry.key] === id) delete currentEntryByKey[entry.key];
}

/**
 * Legacy single-entry API: claim a Howl and increment its reference count.
 * Prefer {@link claimPlayer} in new code.
 */
export async function claimSound(name: SoundName, options?: PlayerOptions): Promise<Howl> {
  const entry = await claimEntry(name, options);
  entry.subscriptions += 1;
  return entry.instance;
}

/**
 * Legacy reference-count API keyed by sound name. Releases one reference from the *current*
 * generation. Callers holding an old-generation player (created before a pack update) should use
 * the `release` handle from {@link claimPlayer} instead.
 */
export function freeSound(name: SoundName, options?: PlayerOptions) {
  const key = cacheKey(name, options);
  const id = currentEntryByKey[key];
  const entry = id ? howlEntries[id] : undefined;
  if (!entry) return null;

  if (entry.subscriptions > 0) entry.subscriptions -= 1;
  if (entry.subscriptions === 0) destroyEntry(entry);

  return null;
}

/**
 * Fetches sound data as a blob, from local filesystem or CDN
 */
export async function fetchSoundBlob(name: SoundName): Promise<Blob> {
  try {
    // Try to fetch from local first
    const localPath = await getLocalSoundPath(name);
    if (localPath) {
      const response = await fetch(localPath);
      if (response.ok) return await response.blob();
    }
  } catch (error) {
    console.warn(`Error loading local sound "${name}", falling back to CDN:`, error);
  }

  const packUrl = getPackSoundUrl(name);
  if (packUrl) {
    const response = await fetch(packUrl);
    if (!response.ok) throw new Error(`Failed to fetch sound "${name}" from ${packUrl} (HTTP ${response.status})`);
    return await response.blob();
  }

  if (!isLibrarySoundName(name)) {
    throw new Error(
      `Failed to load custom sound "${name}". ` +
        "If this is a URL on another domain, make sure it serves an MP3 file with CORS headers (Access-Control-Allow-Origin)."
    );
  }

  // Fall back to CDN
  const soundInfo = manifest.sounds[name];
  const soundUrl = `${cdnBaseUrl}/${soundInfo.src}`;

  const response = await fetch(soundUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch sound "${name}" from CDN`);
  }

  return await response.blob();
}

/**
 * Register a sound pack so its sounds can be played by name, e.g. `useSound("my-ui-pack/save")`.
 * Registering the same pack again is a no-op; registering a changed pack advances the affected
 * sounds' generations: currently playing players keep their old URLs until released, and the next
 * play loads the new URL.
 */
export function registerSounds(pack: SoundPack, options?: RegisterSoundsOptions): void {
  for (const name of addPack(pack, options)) {
    // Drop stale blob data for sounds whose URL changed
    delete soundBlobCache[name];

    // Advance both player kinds (once / loop). Old entries stay in howlEntries until their last
    // reference is released; nothing currently playing is destroyed here. In-flight builds are
    // left in pendingClaims: they fence themselves against the new generation after their blob
    // resolves and retry, so deleting the slot would only orphan their awaiters.
    for (const key of [cacheKey(name), cacheKey(name, { loop: true })]) {
      generationByKey[key] = (generationByKey[key] ?? 0) + 1;
      delete currentEntryByKey[key];
    }
  }
}

/**
 * Resolve the URL a sound is loaded from (ignoring locally downloaded copies).
 */
export function resolveSoundUrl(name: SoundName): string {
  if (isLibrarySoundName(name)) return `${cdnBaseUrl}/${manifest.sounds[name].src}`;
  return getPackSoundUrl(name) ?? name;
}

/**
 * Preload multiple sounds by fetching their data without creating Howl instances
 */
export function preloadSounds(names: SoundName[]): Promise<void[]> {
  return Promise.all(
    names.map(async (name) => {
      // Just ensure the blob is fetched but don't create Howl instance yet
      await fetchAndCacheBlob(name);
    })
  );
}

/**
 * Play a sound by name. The returned promise resolves when the sound finishes naturally or is
 * stopped/unloaded while playing, and rejects if the sound fails to load.
 */
export async function playSound(name: SoundName, options?: SoundOptions): Promise<void> {
  if (!isSoundEnabled()) return;

  const playerOptions = options?.loop ? { loop: true } : undefined;
  const player = await claimPlayer(name, playerOptions);

  try {
    const sound = player.howl;
    await player.ready;

    if (options) {
      if (options.volume !== undefined) sound.volume(options.volume);
      if (options.rate !== undefined) sound.rate(options.rate);
      if (options.loop !== undefined) sound.loop(options.loop);
    }

    if (options?.loop) {
      sound.play();
      return;
    }

    await new Promise<void>((resolve) => {
      const done = () => {
        sound.off("end", done);
        sound.off("stop", done);
        resolve();
      };
      sound.on("end", done);
      sound.on("stop", done);
      sound.play();
    });
  } finally {
    player.release();
  }
}

/**
 * Check if sounds are enabled
 */
export function isSoundEnabled(): boolean {
  if (typeof window === "undefined") return false; // Server environment not supported
  return soundEnabledGlobal;
}

/**
 * Enable or disable all sounds
 * This is used internally by the SoundProvider
 */
export function setSoundEnabled(enabled: boolean): void {
  soundEnabledGlobal = enabled;

  // Store in localStorage for persistence
  if (typeof localStorage !== "undefined") {
    localStorage.setItem("react-sounds-enabled", enabled ? "true" : "false");
  }

  soundStateListeners.forEach((listener) => listener(enabled));
}

/**
 * Initialize the sound enabled state
 * Called at startup to load saved preference
 */
export function initSoundEnabledState(): void {
  if (typeof localStorage === "undefined") return;

  const savedPreference = localStorage.getItem("react-sounds-enabled");
  if (savedPreference !== null) {
    soundEnabledGlobal = savedPreference !== "false";
  }
}

/**
 * Subscribe to sound enabled state changes
 */
export function subscribeSoundState(callback: (enabled: boolean) => void): () => void {
  soundStateListeners.push(callback);

  // Return unsubscribe function
  return () => {
    const index = soundStateListeners.indexOf(callback);
    if (index !== -1) soundStateListeners.splice(index, 1);
  };
}

/**
 * Get the local path for a sound when using the offline mode
 */
export async function getLocalSoundPath(name: SoundName): Promise<string | null> {
  const isPack = isPackSoundName(name);
  if (!isLibrarySoundName(name) && !isPack) return name;

  const publicPath = `/sounds/${name}.mp3`;
  // Pack files that are already served locally are loaded directly by fetchSoundBlob
  if (isPack && getPackSoundUrl(name) === publicPath) return null;

  try {
    // Add a timeout of 300ms to quickly fall back to CDN if file isn't available
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300);

    const response = await fetch(publicPath, { method: "HEAD", signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) return null;
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("audio")) return null;

    return publicPath;
  } catch (_e) { /* local file not available */ }

  return null;
}

/**
 * Clean up unused Howl instances and blob cache entries
 * Call this when running into memory constraints
 */
export function cleanupUnusedSound(name: string): void {
  for (const id of Object.keys(howlEntries)) {
    const entry = howlEntries[id];
    if (entry.key !== name || entry.subscriptions > 0 || entry.instance.playing()) continue;
    destroyEntry(entry);
  }
}

/**
 * Unlock the audio context globally to allow playback without direct user interaction
 */
export async function unlockAudioContext(): Promise<void> {
  if (typeof window === "undefined" || !Howler.ctx) return;
  if (Howler.ctx.state !== "suspended") return;

  try {
    await Howler.ctx.resume();
  } catch (error) {
    console.warn("Failed to unlock audio context:", error);
  }
}

/**
 * Setup global event listeners to unlock audio context on user interaction
 * Can be called multiple times safely (will only set up listeners once)
 */
export function initAudioContextUnlock(): () => void {
  if (typeof window === "undefined" || audioUnlockInitialized) return () => { /* noop */ };

  audioUnlockInitialized = true;

  const events = ["click", "touchstart", "keydown"];

  const handleInteraction = () => {
    unlockAudioContext();
    events.forEach((event) => document.removeEventListener(event, handleInteraction));
  };

  events.forEach((event) => document.addEventListener(event, handleInteraction));

  // Return cleanup function
  return () => {
    events.forEach((event) => document.removeEventListener(event, handleInteraction));
  };
}

/**
 * Check the browser's audio permission status.
 * Uses AudioContext.state to determine if audio playback is allowed.
 */
export async function checkAudioPermission(): Promise<AudioPermissionStatus> {
  if (typeof window === "undefined") return "unavailable";
  if (Howler.noAudio) return "unavailable";

  let state: string;

  if (Howler.ctx) {
    state = Howler.ctx.state;
  } else {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return "unavailable";
      const tempCtx = new AudioCtx();
      state = tempCtx.state;
      await tempCtx.close().catch(() => { /* ignore close errors */ });
    } catch {
      return "unavailable";
    }
  }

  switch (state) {
    case "running":
      return "granted";
    case "suspended":
      return "prompt";
    default:
      return "unavailable";
  }
}

/**
 * Reset all module-level state for testing purposes.
 * @internal
 */
export function __resetForTesting(): void {
  cdnBaseUrl = "https://reactsounds.sfo3.cdn.digitaloceanspaces.com/v1";
  soundEnabledGlobal = true;
  soundStateListeners.length = 0;
  audioUnlockInitialized = false;
  for (const key of Object.keys(soundBlobCache)) delete soundBlobCache[key];
  for (const key of Object.keys(howlEntries)) delete howlEntries[key];
  for (const key of Object.keys(currentEntryByKey)) delete currentEntryByKey[key];
  for (const key of Object.keys(pendingClaims)) delete pendingClaims[key];
  for (const key of Object.keys(generationByKey)) delete generationByKey[key];
  __resetPacksForTesting();
}

// Initialize sound state
initSoundEnabledState();

// Initialize audio context unlocking if we're in a browser environment
if (typeof window !== "undefined") {
  initAudioContextUnlock();
}
