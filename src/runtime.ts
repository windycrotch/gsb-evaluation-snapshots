import { Howl, Howler } from "howler";
import manifest from "./manifest.json";
import { AudioPermissionStatus, LibrarySoundName, SoundOptions } from "./types";

export type SoundName = LibrarySoundName | string;

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
 * Cache of preloaded sound blobs to avoid HTML5 audio pool exhaustion
 */
const soundBlobCache: Record<string, Promise<Blob>> = {};

// TODO: turn "subscriptions" into a list of ids for better lock tracking
export type HowlEntry = { instance: Howl; subscriptions: number };

/**
 * Cache of created Howl instances (only created when actually played)
 */
const howlInstanceCache: Record<string, HowlEntry> = {};

/**
 * In-flight Howl creations, keyed by sound name. This guarantees that
 * concurrent claims for the same sound only create a single Howl instance.
 */
const howlCreationPromises: Record<string, Promise<HowlEntry>> = {};

/**
 * Snapshot of the runtime cache state for a single sound.
 * Useful for debugging and for callers that need to verify reference counting.
 */
export interface SoundCacheState {
  /** The sound name this snapshot describes */
  name: SoundName;
  /** Whether a Howl instance currently exists in the cache */
  hasHowl: boolean;
  /** Alias of {@link hasHowl} */
  created: boolean;
  /** Number of outstanding claims (never negative) */
  subscriptions: number;
  /** Whether the Howl instance reports itself as playing */
  isPlaying: boolean;
  /** Alias of {@link isPlaying} */
  playing: boolean;
  /** Whether the blob for this sound is present in the blob cache */
  hasBlob: boolean;
  /** Alias of {@link hasBlob} */
  blobCached: boolean;
}

/**
 * Read-only view of the cache/reference-count state for a sound.
 * Returns zeroed values when the sound has never been loaded.
 */
export function getSoundCacheState(name: SoundName): SoundCacheState {
  const entry = howlInstanceCache[name];
  const hasHowl = Boolean(entry);

  let isPlaying = false;
  if (entry) {
    try {
      isPlaying = entry.instance.playing();
    } catch (_e) {
      isPlaying = false;
    }
  }

  const hasBlob = Boolean(soundBlobCache[name]);

  return {
    name,
    hasHowl,
    created: hasHowl,
    subscriptions: entry ? entry.subscriptions : 0,
    isPlaying,
    playing: isPlaying,
    hasBlob,
    blobCached: hasBlob,
  };
}

/**
 * Get (or start) the shared blob request for a sound. Failed requests are
 * removed from the cache so a later attempt can retry instead of being stuck
 * with a permanently rejected promise.
 */
function getOrFetchSoundBlob(name: SoundName): Promise<Blob> {
  const cached = soundBlobCache[name];
  if (cached) return cached;

  const promise = fetchSoundBlob(name);
  soundBlobCache[name] = promise;

  const forget = () => {
    if (soundBlobCache[name] === promise) delete soundBlobCache[name];
  };
  // `promise` itself is still returned/awaited by callers, so this derived
  // rejection handler does not swallow the error.
  promise.then(undefined, forget);

  return promise;
}

/**
 * Make a sound loader function that first tries local files then falls back to CDN
 */
export function makeRemoteSound(name: SoundName): () => Promise<HowlEntry> {
  return async () => {
    // First fetch the blob data if not already in cache
    getOrFetchSoundBlob(name);

    // Create or return the Howl instance
    return createOrGetHowlInstance(name);
  };
}

export async function claimSound(name: SoundName): Promise<Howl> {
  const entry = await makeRemoteSound(name)();
  entry.subscriptions += 1;

  return entry.instance;
}

export function freeSound(name: SoundName) {
  const entry = howlInstanceCache[name];
  // Never let the reference count go negative: freeing more often than
  // claiming is a no-op rather than a corruption of the count.
  if (entry && entry.subscriptions > 0) entry.subscriptions -= 1;

  cleanupUnusedSound(name);

  return null;
}

function soundUnavailableError(name: SoundName): Error {
  return new Error(
    `Failed to load sound "${name}": unavailable in local files and on the CDN (本地/CDN 均不可用)`
  );
}

/**
 * Fetches sound data as a blob, from local filesystem or CDN
 *
 * Local probing failures (non-2xx HEAD, non-audio content type, timeout,
 * network error) are never fatal: they always fall through to the CDN.
 */
export async function fetchSoundBlob(name: SoundName): Promise<Blob> {
  try {
    // Try to fetch from local first
    const localPath = await getLocalSoundPath(name);
    if (localPath) {
      const response = await fetch(localPath);
      if (response.ok) return await response.blob();
      console.warn(`Local sound "${name}" returned status ${response.status}, falling back to CDN`);
    }
  } catch (error) {
    console.warn(`Error loading local sound "${name}", falling back to CDN:`, error);
  }

  // Only library sounds have a manifest entry to fall back to.
  if (!isLibrarySoundName(name)) throw soundUnavailableError(name);

  // Fall back to CDN
  const soundInfo = manifest.sounds[name];
  const soundUrl = `${cdnBaseUrl}/${soundInfo.src}`;

  let response: Response;
  try {
    response = await fetch(soundUrl);
  } catch (error) {
    console.warn(`Error fetching sound "${name}" from CDN:`, error);
    throw soundUnavailableError(name);
  }

  if (!response.ok) throw soundUnavailableError(name);

  return await response.blob();
}

/**
 * Creates a Howl instance from a cached blob or fetches it if needed.
 * Concurrent calls for the same name share a single in-flight creation.
 */
function createOrGetHowlInstance(name: SoundName): Promise<HowlEntry> {
  // Return existing instance if available
  const existing = howlInstanceCache[name];
  if (existing) return Promise.resolve(existing);

  // Join an in-flight creation if one exists
  const inFlight = howlCreationPromises[name];
  if (inFlight) return inFlight;

  const creation = (async () => {
    // Wait for the shared blob request to complete
    const blob = await getOrFetchSoundBlob(name);

    // Create object URL from blob
    const objectUrl = URL.createObjectURL(blob);

    // Create new Howl instance
    const howl = new Howl({
      src: [objectUrl],
      format: ["mp3"],
      html5: true, // Enable streaming to reduce memory usage
    });
    // Store object URL reference to revoke later
    (howl as any)._objectUrl = objectUrl;

    // Store in cache
    const entry: HowlEntry = { instance: howl, subscriptions: 0 };
    howlInstanceCache[name] = entry;

    return entry;
  })();

  howlCreationPromises[name] = creation;

  const clearInFlight = () => {
    if (howlCreationPromises[name] === creation) delete howlCreationPromises[name];
  };
  creation.then(clearInFlight, clearInFlight);

  return creation;
}

/**
 * Preload multiple sounds by fetching their data without creating Howl instances
 */
export function preloadSounds(names: SoundName[]): Promise<void[]> {
  return Promise.all(
    names.map(async (name) => {
      // Just ensure the shared blob request is fetched but don't create a Howl instance yet
      await getOrFetchSoundBlob(name);
    })
  );
}

/**
 * Play a sound by name
 */
export async function playSound(name: SoundName, options?: SoundOptions): Promise<void> {
  if (!isSoundEnabled()) return;

  const sound = await claimSound(name);
  let freed = false;

  if (options) {
    if (options.volume !== undefined) sound.volume(options.volume);
    if (options.rate !== undefined) sound.rate(options.rate);
    if (options.loop !== undefined) sound.loop(options.loop);
  }

  sound.on("end", () => {
    if (freed || options?.loop) return;
    freeSound(name);
    freed = true;
  });

  sound.play();
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
  if (typeof localStorage !== "undefined") localStorage.setItem("react-sounds-enabled", enabled ? "true" : "false");

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
  if (!isLibrarySoundName(name)) return name;

  const publicPath = `/sounds/${name}.mp3`;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    // Add a timeout of 300ms to quickly fall back to CDN if file isn't available
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 300);

    const response = await fetch(publicPath, { method: "HEAD", signal: controller.signal });

    if (!response.ok) return null;
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("audio")) return null;

    return publicPath;
  } catch (_e) { /* local file not available */ } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  return null;
}

/**
 * Clean up unused Howl instances and blob cache entries
 * Call this when running into memory constraints
 */
export function cleanupUnusedSound(name: string): void {
  const entry = howlInstanceCache[name];
  if (!entry) return;

  // Keep the instance around while it is claimed or still playing.
  if (entry.subscriptions > 0) return;
  let playing = false;
  try {
    playing = entry.instance.playing();
  } catch (_e) {
    playing = false;
  }
  if (playing) return;

  const { instance } = entry;
  if ((instance as any)._objectUrl) {
    URL.revokeObjectURL((instance as any)._objectUrl);
    delete (instance as any)._objectUrl;
  }
  instance.unload();
  delete howlInstanceCache[name];
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
  for (const key of Object.keys(howlInstanceCache)) delete howlInstanceCache[key];
  for (const key of Object.keys(howlCreationPromises)) delete howlCreationPromises[key];
}

// Initialize sound state
initSoundEnabledState();

// Initialize audio context unlocking if we're in a browser environment
if (typeof window !== "undefined") {
  initAudioContextUnlock();
}
