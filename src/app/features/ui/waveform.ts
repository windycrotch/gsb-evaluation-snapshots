import { getMusicPlayerInstance } from "@/app/stores/adapters";
import { getAppCoreInstance } from "@/app/stores/AppCoreImpl";
import { seekToProgress } from "@/app/use-cases";
import { decodeWaveformForCurrentTrack } from "@/app/use-cases/decode-waveform";
import { PLUME_CONSTANTS } from "@/domain/plume";
import { PLUME_CSS_CLASSES, PLUME_ELEM_SELECTORS } from "@/infra/elements/plume";
import { getString } from "@/shared/i18n";

// Peaks are cached per track and survive clearWaveform (track navigation back reuses the cache).
const peaksCache = new Map<string, Float32Array>();

// Per-canvas decode generations. Each new decode (or clearWaveform) bumps a canvas's generation,
// so an async decode result that resolves after a track switch can never paint the new track's
// canvas nor write peaks under the wrong cache key. A shared boolean flag would cross wires
// between the main and fullscreen canvases and between consecutive tracks.
const decodeGenerations = new WeakMap<HTMLCanvasElement, number>();

const bumpGeneration = (canvas: HTMLCanvasElement): number => {
  const next = (decodeGenerations.get(canvas) ?? 0) + 1;
  decodeGenerations.set(canvas, next);
  return next;
};

// Track number as cache key — unique within a page session.
const getCacheKey = (): string => {
  const { trackNumber } = getAppCoreInstance().getState();
  return trackNumber != null ? `t${trackNumber}` : "t0";
};

export const clearPeaksCache = (): void => {
  peaksCache.clear();
};

export const createWaveformCanvas = (): HTMLCanvasElement => {
  const canvas = document.createElement("canvas");
  canvas.id = PLUME_ELEM_SELECTORS.waveformCanvas.split("#")[1];
  canvas.ariaLabel = getString("ARIA__WAVEFORM_CANVAS");

  const { featureFlags } = getAppCoreInstance().getState();
  const isEnabled = featureFlags.waveform;
  if (!isEnabled) canvas.classList.add(PLUME_CSS_CLASSES.featureHidden);

  return canvas;
};

export const renderWaveform = (
  canvas: HTMLCanvasElement,
  peaks: Float32Array,
  progressFraction: number,
  accentColor: string
): void => {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const width = canvas.offsetWidth;
  const height = canvas.offsetHeight;
  if (width === 0 || height === 0) return;

  canvas.width = width;
  canvas.height = height;

  ctx.clearRect(0, 0, width, height);

  const peakCount = peaks.length;
  const columnWidth = width / peakCount;

  for (let i = 0; i < peakCount; i++) {
    const barHeight = height * 0.1 + (peaks[i] as number) * height * 0.9;
    const x = i * columnWidth;

    ctx.fillStyle = i / peakCount < progressFraction ? accentColor : "rgba(128,128,128,0.35)";
    ctx.fillRect(x, height - barHeight, Math.max(columnWidth - 1, 1), barHeight);
  }
};

export const triggerWaveformDecode = async (canvas: HTMLCanvasElement): Promise<void> => {
  const appState = getAppCoreInstance().getState();

  // Any in-flight decode for this canvas belongs to an older track (or was disabled):
  // bumping the generation invalidates it before any early return.
  const generation = bumpGeneration(canvas);

  if (!appState.featureFlags.waveform) {
    canvas.classList.add(PLUME_CSS_CLASSES.featureHidden);
    return;
  }

  const cacheKey = getCacheKey();

  // Tracks beyond the duration cap never get a waveform. This runs before the cache fast path so
  // an over-length track stays hidden even if peaks from another track are already cached, and no
  // decode is ever started for it.
  if (appState.duration > PLUME_CONSTANTS.WAVEFORM_MAX_DURATION_SECONDS) {
    canvas.classList.add(PLUME_CSS_CLASSES.featureHidden);
    return;
  }

  // Fast path: peaks already cached for this track — skip decode and render immediately.
  if (peaksCache.has(cacheKey)) {
    canvas.classList.remove(PLUME_CSS_CLASSES.featureHidden);
    const progressFraction =
      appState.currentTime != null && appState.duration ? appState.currentTime / appState.duration : 0;
    renderWaveform(canvas, peaksCache.get(cacheKey)!, progressFraction, getAccentColor());
    return;
  }

  // Show loading state while decode runs (CSS pulse + aria label; no canvas drawing)
  canvas.classList.remove(PLUME_CSS_CLASSES.featureHidden);
  canvas.classList.add(PLUME_CSS_CLASSES.waveformLoading);
  canvas.ariaLabel = getString("ARIA__WAVEFORM_CANVAS__LOADING");

  const peaks = await decodeWaveformForCurrentTrack();

  // The user switched track (or toggled the feature off) while the decode was in flight.
  // The canvas now belongs to a newer generation: drop the stale result entirely — never touch
  // the canvas and never write peaks under a cache key the caller no longer represents.
  if (decodeGenerations.get(canvas) !== generation) return;

  canvas.classList.remove(PLUME_CSS_CLASSES.waveformLoading);
  canvas.ariaLabel = getString("ARIA__WAVEFORM_CANVAS");

  if (!peaks) {
    canvas.classList.add(PLUME_CSS_CLASSES.featureHidden);
    return;
  }

  peaksCache.set(cacheKey, peaks);

  const newAppState = getAppCoreInstance().getState();
  const progressFraction = newAppState.duration ? newAppState.currentTime / newAppState.duration : 0;

  renderWaveform(canvas, peaks, progressFraction, getAccentColor());
};

export const clearWaveform = (canvas: HTMLCanvasElement): void => {
  // Invalidate any in-flight decode for this canvas. The peaks cache itself is preserved —
  // navigation back to this track still skips the decode.
  bumpGeneration(canvas);

  canvas.classList.remove(PLUME_CSS_CLASSES.waveformLoading);
  canvas.classList.add(PLUME_CSS_CLASSES.featureHidden);
  canvas.ariaLabel = getString("ARIA__WAVEFORM_CANVAS");

  const ctx = canvas.getContext("2d");
  ctx?.clearRect(0, 0, canvas.width, canvas.height);
};

export const attachWaveformSeekHandler = (canvas: HTMLCanvasElement): void => {
  canvas.addEventListener("click", (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    const rawFraction = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
    // Clamp to [0, 1] so clicks outside the canvas edges seek to the start/end rather than NaN.
    const fraction = Math.max(0, Math.min(1, rawFraction));
    seekToProgress(
      fraction * PLUME_CONSTANTS.PROGRESS_SLIDER_GRANULARITY,
      getAppCoreInstance(),
      getMusicPlayerInstance()
    );
  });
};

export const syncWaveformPlayhead = (canvas: HTMLCanvasElement, progressFraction: number): void => {
  const peaks = peaksCache.get(getCacheKey());
  if (!peaks) return;

  renderWaveform(canvas, peaks, progressFraction, getAccentColor());
};

// Reads the Bandcamp accent color from the CSS custom property set on :root.
const getAccentColor = (): string => {
  const plumeVersion = document.querySelector(PLUME_ELEM_SELECTORS.headerLogoVersion) as HTMLParagraphElement | null;
  const versionColor = plumeVersion ? getComputedStyle(plumeVersion).color : null;
  return versionColor || "#ffffff";
};
