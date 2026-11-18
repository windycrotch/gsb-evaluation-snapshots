// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PLUME_CONSTANTS, PLUME_DEFAULTS } from "@/domain/plume";
import { PLUME_CSS_CLASSES } from "@/infra/elements/plume";
import { FakeAppCore } from "../../../fakes/FakeAppCore";

const mockDecodeWaveformForCurrentTrack = vi.hoisted(() => vi.fn());
const mockSeekToProgress = vi.hoisted(() => vi.fn());

vi.mock("@/app/use-cases/decode-waveform", () => ({
  decodeWaveformForCurrentTrack: mockDecodeWaveformForCurrentTrack,
}));
vi.mock("@/app/use-cases", () => ({ seekToProgress: mockSeekToProgress }));
vi.mock("@/shared/i18n", () => ({ getString: (k: string) => k }));

const fakeMusicPlayer = {};
vi.mock("@/app/stores/adapters", () => ({ getMusicPlayerInstance: () => fakeMusicPlayer }));

let fakeAppCore = new FakeAppCore();
vi.mock("@/app/stores/AppCoreImpl", () => ({ getAppCoreInstance: () => fakeAppCore }));

const PEAK_COUNT = 4;
const fakePeaks = new Float32Array([0.2, 0.8, 0.6, 0.4]);

const makeMockCtx = () => ({
  clearRect: vi.fn(),
  fillRect: vi.fn(),
  fillStyle: "" as string,
});

/** Build a canvas whose offsetWidth/offsetHeight are non-zero so renderWaveform doesn't bail. */
const makeCanvas = (width = 400, height = 40): HTMLCanvasElement => {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "offsetWidth", { value: width, configurable: true });
  Object.defineProperty(canvas, "offsetHeight", { value: height, configurable: true });
  return canvas;
};

/** Peaks used to distinguish tracks — a successful render draws exactly these bar heights. */
const track1Peaks = new Float32Array([0.2, 0.8, 0.6, 0.4]);
const track2Peaks = new Float32Array([0.9, 0.1, 0.5, 0.3]);

const switchToTrack = (trackNumber: string, duration = 100): void => {
  fakeAppCore = new FakeAppCore({
    featureFlags: { ...PLUME_DEFAULTS.featureFlags, waveform: true },
    currentTime: 0,
    duration,
    trackNumber,
  });
};

/** Reconstructs the peak-derived bar heights observed by fillRect calls on a mock 2D context. */
const drawnBarHeights = (ctx: ReturnType<typeof makeMockCtx>): number[] =>
  ctx.fillRect.mock.calls.map((call) => call[3] as number);

import {
  attachWaveformSeekHandler,
  clearPeaksCache,
  clearWaveform,
  createWaveformCanvas,
  renderWaveform,
  syncWaveformPlayhead,
  triggerWaveformDecode,
} from "@/app/features/ui/waveform";

beforeEach(() => {
  vi.clearAllMocks();
  fakeAppCore = new FakeAppCore({
    featureFlags: { ...PLUME_DEFAULTS.featureFlags, waveform: false },
    currentTime: 0,
    duration: 100,
  });
  mockDecodeWaveformForCurrentTrack.mockResolvedValue(null);

  // Reset all module-level state between tests
  clearPeaksCache();
  clearWaveform(makeCanvas()); // resets decodeAbortFlag
});

describe("createWaveformCanvas", () => {
  it("returns a canvas element with the correct id", () => {
    const canvas = createWaveformCanvas();

    expect(canvas.tagName).toBe("CANVAS");
    expect(canvas.id).toBe("plume-waveform-canvas");
  });

  it("is hidden when the waveform feature flag is off", () => {
    const canvas = createWaveformCanvas();

    expect(canvas.classList.contains(PLUME_CSS_CLASSES.featureHidden)).toBe(true);
  });

  it("is visible when the waveform feature flag is on", () => {
    fakeAppCore = new FakeAppCore({
      featureFlags: { ...PLUME_DEFAULTS.featureFlags, waveform: true },
    });

    const canvas = createWaveformCanvas();

    expect(canvas.classList.contains(PLUME_CSS_CLASSES.featureHidden)).toBe(false);
  });

  it("has an aria-label set", () => {
    const canvas = createWaveformCanvas();

    expect(canvas.ariaLabel).toBeTruthy();
  });
});

describe("renderWaveform", () => {
  it("calls fillRect exactly once per peak", () => {
    const canvas = makeCanvas();
    const ctx = makeMockCtx();
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    renderWaveform(canvas, fakePeaks, 0, "#ff0000");

    expect(ctx.fillRect).toHaveBeenCalledTimes(PEAK_COUNT);
  });

  it("colors bars before progressFraction with accent color", () => {
    const canvas = makeCanvas();
    const ctx = makeMockCtx();
    const filledColors: string[] = [];
    Object.defineProperty(ctx, "fillStyle", {
      set(v: string) {
        filledColors.push(v);
      },
      get() {
        return "";
      },
    });
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    // progressFraction = 0.5 → first 2 of 4 columns played
    renderWaveform(canvas, fakePeaks, 0.5, "#ff0000");

    expect(filledColors[0]).toBe("#ff0000");
    expect(filledColors[1]).toBe("#ff0000");
    expect(filledColors[2]).not.toBe("#ff0000");
    expect(filledColors[3]).not.toBe("#ff0000");
  });

  it("calls clearRect before drawing", () => {
    const canvas = makeCanvas();
    const ctx = makeMockCtx();
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    renderWaveform(canvas, fakePeaks, 0, "#ff0000");

    expect(ctx.clearRect).toHaveBeenCalledOnce();
  });

  it("is a no-op when the canvas has zero dimensions", () => {
    const canvas = makeCanvas(0, 0);
    const ctx = makeMockCtx();
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    renderWaveform(canvas, fakePeaks, 0, "#ff0000");

    expect(ctx.fillRect).not.toHaveBeenCalled();
  });

  it("uses muted color for all bars when progressFraction is 0", () => {
    const canvas = makeCanvas();
    const ctx = makeMockCtx();
    const filledColors: string[] = [];
    Object.defineProperty(ctx, "fillStyle", {
      set(v: string) {
        filledColors.push(v);
      },
      get() {
        return "";
      },
    });
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    renderWaveform(canvas, fakePeaks, 0, "#ff0000");

    expect(filledColors.every((c) => c !== "#ff0000")).toBe(true);
  });

  it("uses accent color for all bars when progressFraction is 1", () => {
    const canvas = makeCanvas();
    const ctx = makeMockCtx();
    const filledColors: string[] = [];
    Object.defineProperty(ctx, "fillStyle", {
      set(v: string) {
        filledColors.push(v);
      },
      get() {
        return "";
      },
    });
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    renderWaveform(canvas, fakePeaks, 1, "#ff0000");

    expect(filledColors.every((c) => c === "#ff0000")).toBe(true);
  });

  it("handles empty peaks without throwing and draws nothing", () => {
    const canvas = makeCanvas();
    const ctx = makeMockCtx();
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    expect(() => renderWaveform(canvas, new Float32Array(0), 0, "#ff0000")).not.toThrow();
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });
});

describe("clearWaveform", () => {
  it("calls clearRect on the canvas context", () => {
    const canvas = makeCanvas();
    const ctx = makeMockCtx();
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    clearWaveform(canvas);

    expect(ctx.clearRect).toHaveBeenCalledOnce();
  });

  it("adds plume-feature-hidden to the canvas", () => {
    const canvas = makeCanvas();
    const ctx = makeMockCtx();
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    canvas.classList.remove(PLUME_CSS_CLASSES.featureHidden);

    clearWaveform(canvas);

    expect(canvas.classList.contains(PLUME_CSS_CLASSES.featureHidden)).toBe(true);
  });

  it("makes syncWaveformPlayhead a no-op (peaks cleared)", () => {
    // First seed peaks via triggerWaveformDecode, then clear
    const canvas = makeCanvas();
    const ctx = makeMockCtx();
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    clearWaveform(canvas);
    ctx.fillRect.mockClear();

    syncWaveformPlayhead(canvas, 0.5);

    expect(ctx.fillRect).not.toHaveBeenCalled();
  });
});

describe("syncWaveformPlayhead", () => {
  it("is a no-op when no peaks are cached", () => {
    const canvas = makeCanvas();
    const ctx = makeMockCtx();
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    syncWaveformPlayhead(canvas, 0.5);

    expect(ctx.fillRect).not.toHaveBeenCalled();
  });

  it("renders when peaks are cached after triggerWaveformDecode", async () => {
    fakeAppCore = new FakeAppCore({
      featureFlags: { ...PLUME_DEFAULTS.featureFlags, waveform: true },
      currentTime: 0,
      duration: 100,
    });
    mockDecodeWaveformForCurrentTrack.mockResolvedValue(fakePeaks);

    const canvas = makeCanvas();
    const ctx = makeMockCtx();
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    await triggerWaveformDecode(canvas);
    ctx.fillRect.mockClear();

    syncWaveformPlayhead(canvas, 0.5);

    expect(ctx.fillRect).toHaveBeenCalledTimes(PEAK_COUNT);
  });
});

describe("triggerWaveformDecode", () => {
  beforeEach(() => {
    fakeAppCore = new FakeAppCore({
      featureFlags: { ...PLUME_DEFAULTS.featureFlags, waveform: true },
      currentTime: 0,
      duration: 100,
    });
  });

  it("removes plume-feature-hidden on successful decode", async () => {
    mockDecodeWaveformForCurrentTrack.mockResolvedValue(fakePeaks);
    const canvas = makeCanvas();
    canvas.classList.add(PLUME_CSS_CLASSES.featureHidden);
    vi.spyOn(canvas, "getContext").mockReturnValue(makeMockCtx() as unknown as CanvasRenderingContext2D);

    await triggerWaveformDecode(canvas);

    expect(canvas.classList.contains(PLUME_CSS_CLASSES.featureHidden)).toBe(false);
  });

  it("calls renderWaveform (fillRect N times) after decode succeeds", async () => {
    mockDecodeWaveformForCurrentTrack.mockResolvedValue(fakePeaks);
    const canvas = makeCanvas();
    const ctx = makeMockCtx();
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    await triggerWaveformDecode(canvas);

    expect(ctx.fillRect).toHaveBeenCalledTimes(PEAK_COUNT);
  });

  it("does not render and does not remove hidden class when decode returns null", async () => {
    mockDecodeWaveformForCurrentTrack.mockResolvedValue(null);
    const canvas = makeCanvas();
    canvas.classList.add(PLUME_CSS_CLASSES.featureHidden);
    const ctx = makeMockCtx();
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    await triggerWaveformDecode(canvas);

    expect(canvas.classList.contains(PLUME_CSS_CLASSES.featureHidden)).toBe(true);
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });

  it("discards result when clearWaveform is called during an in-flight decode", async () => {
    let resolveDecode!: (peaks: Float32Array | null) => void;
    mockDecodeWaveformForCurrentTrack.mockReturnValue(new Promise((r) => (resolveDecode = r)));

    const canvas = makeCanvas();
    const ctx = makeMockCtx();
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    const decodePromise = triggerWaveformDecode(canvas);
    clearWaveform(canvas); // abort before resolve
    resolveDecode(fakePeaks);
    await decodePromise;

    expect(ctx.fillRect).not.toHaveBeenCalled();
  });

  it("skips decode and renders immediately when peaks are already cached (fast-path)", async () => {
    mockDecodeWaveformForCurrentTrack.mockResolvedValue(fakePeaks);

    // First call seeds the cache
    const canvas1 = makeCanvas();
    vi.spyOn(canvas1, "getContext").mockReturnValue(makeMockCtx() as unknown as CanvasRenderingContext2D);
    await triggerWaveformDecode(canvas1);
    mockDecodeWaveformForCurrentTrack.mockClear();

    // Simulate track navigation: clearWaveform hides display but preserves cache
    clearWaveform(canvas1);

    // Second call for the same track uses cache — no decode
    const canvas2 = makeCanvas();
    const ctx2 = makeMockCtx();
    vi.spyOn(canvas2, "getContext").mockReturnValue(ctx2 as unknown as CanvasRenderingContext2D);
    await triggerWaveformDecode(canvas2);

    expect(mockDecodeWaveformForCurrentTrack).not.toHaveBeenCalled();
    expect(ctx2.fillRect).toHaveBeenCalledTimes(PEAK_COUNT);
  });

  it("uses fast path on a second call to the same canvas without clearWaveform between", async () => {
    mockDecodeWaveformForCurrentTrack.mockResolvedValue(fakePeaks);

    const canvas = makeCanvas();
    const ctx = makeMockCtx();
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    await triggerWaveformDecode(canvas);
    mockDecodeWaveformForCurrentTrack.mockClear();
    ctx.fillRect.mockClear();

    await triggerWaveformDecode(canvas);

    expect(mockDecodeWaveformForCurrentTrack).not.toHaveBeenCalled();
    expect(ctx.fillRect).toHaveBeenCalledTimes(PEAK_COUNT);
  });

  it("keeps canvas hidden and does not decode when featureFlags.waveform is false", async () => {
    fakeAppCore = new FakeAppCore({
      featureFlags: { ...PLUME_DEFAULTS.featureFlags, waveform: false },
      currentTime: 0,
      duration: 100,
    });
    const canvas = makeCanvas();
    canvas.classList.remove(PLUME_CSS_CLASSES.featureHidden);

    await triggerWaveformDecode(canvas);

    expect(canvas.classList.contains(PLUME_CSS_CLASSES.featureHidden)).toBe(true);
    expect(mockDecodeWaveformForCurrentTrack).not.toHaveBeenCalled();
  });

  it("hides canvas without decoding when featureFlags.waveform is false even with cached peaks", async () => {
    // Seed the cache while flag is on (inherited from nested beforeEach)
    mockDecodeWaveformForCurrentTrack.mockResolvedValue(fakePeaks);
    const seedCanvas = makeCanvas();
    vi.spyOn(seedCanvas, "getContext").mockReturnValue(makeMockCtx() as unknown as CanvasRenderingContext2D);
    await triggerWaveformDecode(seedCanvas);
    mockDecodeWaveformForCurrentTrack.mockClear();

    // Now disable the flag — guard must run before the fast path
    fakeAppCore = new FakeAppCore({
      featureFlags: { ...PLUME_DEFAULTS.featureFlags, waveform: false },
      currentTime: 0,
      duration: 100,
    });
    const canvas = makeCanvas();
    canvas.classList.remove(PLUME_CSS_CLASSES.featureHidden);

    await triggerWaveformDecode(canvas);

    expect(canvas.classList.contains(PLUME_CSS_CLASSES.featureHidden)).toBe(true);
    expect(mockDecodeWaveformForCurrentTrack).not.toHaveBeenCalled();
  });

  it("keeps canvas hidden and skips fetch when duration exceeds WAVEFORM_MAX_DURATION_SECS", async () => {
    fakeAppCore = new FakeAppCore({
      featureFlags: { ...PLUME_DEFAULTS.featureFlags, waveform: true },
      currentTime: 0,
      duration: PLUME_CONSTANTS.WAVEFORM_MAX_DURATION_SECONDS + 1,
    });
    const canvas = makeCanvas();
    canvas.classList.remove(PLUME_CSS_CLASSES.featureHidden);

    await triggerWaveformDecode(canvas);

    expect(canvas.classList.contains(PLUME_CSS_CLASSES.featureHidden)).toBe(true);
    expect(mockDecodeWaveformForCurrentTrack).not.toHaveBeenCalled();
  });

  it("proceeds with decode when duration equals WAVEFORM_MAX_DURATION_SECS exactly", async () => {
    fakeAppCore = new FakeAppCore({
      featureFlags: { ...PLUME_DEFAULTS.featureFlags, waveform: true },
      currentTime: 0,
      duration: PLUME_CONSTANTS.WAVEFORM_MAX_DURATION_SECONDS,
    });
    mockDecodeWaveformForCurrentTrack.mockResolvedValue(fakePeaks);
    const canvas = makeCanvas();
    const ctx = makeMockCtx();
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    await triggerWaveformDecode(canvas);

    expect(mockDecodeWaveformForCurrentTrack).toHaveBeenCalled();
    expect(ctx.fillRect).toHaveBeenCalledTimes(PEAK_COUNT);
  });
});

describe("loading state", () => {
  beforeEach(() => {
    fakeAppCore = new FakeAppCore({
      featureFlags: { ...PLUME_DEFAULTS.featureFlags, waveform: true },
      currentTime: 0,
      duration: 100,
    });
  });

  it("shows canvas with loading class while decode is in progress, removes it after", async () => {
    let resolveDecode!: (peaks: Float32Array | null) => void;
    mockDecodeWaveformForCurrentTrack.mockReturnValue(new Promise((r) => (resolveDecode = r)));

    const canvas = makeCanvas();
    canvas.classList.add(PLUME_CSS_CLASSES.featureHidden);
    vi.spyOn(canvas, "getContext").mockReturnValue(makeMockCtx() as unknown as CanvasRenderingContext2D);

    const promise = triggerWaveformDecode(canvas);

    // Synchronous portion has run: canvas visible, loading class present
    expect(canvas.classList.contains(PLUME_CSS_CLASSES.featureHidden)).toBe(false);
    expect(canvas.classList.contains(PLUME_CSS_CLASSES.waveformLoading)).toBe(true);

    resolveDecode(fakePeaks);
    await promise;

    // After decode: loading class removed, canvas stays visible
    expect(canvas.classList.contains(PLUME_CSS_CLASSES.waveformLoading)).toBe(false);
    expect(canvas.classList.contains(PLUME_CSS_CLASSES.featureHidden)).toBe(false);
  });

  it("removes loading class and hides canvas when decode is aborted", async () => {
    let resolveDecode!: (peaks: Float32Array | null) => void;
    mockDecodeWaveformForCurrentTrack.mockReturnValue(new Promise((r) => (resolveDecode = r)));

    const canvas = makeCanvas();
    vi.spyOn(canvas, "getContext").mockReturnValue(makeMockCtx() as unknown as CanvasRenderingContext2D);

    const promise = triggerWaveformDecode(canvas);
    clearWaveform(canvas);
    resolveDecode(fakePeaks);
    await promise;

    expect(canvas.classList.contains(PLUME_CSS_CLASSES.waveformLoading)).toBe(false);
    expect(canvas.classList.contains(PLUME_CSS_CLASSES.featureHidden)).toBe(true);
  });
});

describe("attachWaveformSeekHandler", () => {
  const mockRect = (left: number, width: number): DOMRect =>
    ({ left, width, top: 0, bottom: 40, right: left + width, height: 40, x: left, y: 0, toJSON: () => {} }) as DOMRect;

  it("calls seekToProgress with fraction × PROGRESS_SLIDER_GRANULARITY on click", () => {
    const canvas = makeCanvas(400, 40);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(mockRect(0, 400));

    attachWaveformSeekHandler(canvas);
    canvas.dispatchEvent(new MouseEvent("click", { clientX: 200, bubbles: true }));

    expect(mockSeekToProgress).toHaveBeenCalledWith(
      0.5 * PLUME_CONSTANTS.PROGRESS_SLIDER_GRANULARITY,
      expect.anything(),
      fakeMusicPlayer
    );
  });

  it("clamps fraction to 0 when clicking before the left edge", () => {
    const canvas = makeCanvas(400, 40);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(mockRect(100, 400));

    attachWaveformSeekHandler(canvas);
    canvas.dispatchEvent(new MouseEvent("click", { clientX: 50, bubbles: true })); // 50 < left(100)

    expect(mockSeekToProgress).toHaveBeenCalledWith(0, expect.anything(), fakeMusicPlayer);
  });

  it("clamps fraction to PROGRESS_SLIDER_GRANULARITY when clicking past the right edge", () => {
    const canvas = makeCanvas(400, 40);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(mockRect(0, 400));

    attachWaveformSeekHandler(canvas);
    canvas.dispatchEvent(new MouseEvent("click", { clientX: 500, bubbles: true })); // 500 > right(400)

    expect(mockSeekToProgress).toHaveBeenCalledWith(
      PLUME_CONSTANTS.PROGRESS_SLIDER_GRANULARITY,
      expect.anything(),
      fakeMusicPlayer
    );
  });

  it("seeks to 0 instead of NaN when the canvas reports a zero width", () => {
    const canvas = makeCanvas(400, 40);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(mockRect(0, 0));

    attachWaveformSeekHandler(canvas);
    canvas.dispatchEvent(new MouseEvent("click", { clientX: 10, bubbles: true }));

    expect(mockSeekToProgress).toHaveBeenCalledWith(0, expect.anything(), fakeMusicPlayer);
  });

  it("seeks to full granularity on a zero-width canvas click at a negative clientX", () => {
    const canvas = makeCanvas(400, 40);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(mockRect(0, 0));

    attachWaveformSeekHandler(canvas);
    canvas.dispatchEvent(new MouseEvent("click", { clientX: -5, bubbles: true }));

    // width 0 → raw fraction 0 → clamped 0 (no NaN, no negative value)
    expect(mockSeekToProgress).toHaveBeenCalledWith(0, expect.anything(), fakeMusicPlayer);
  });
});

describe("per-track peaks cache", () => {
  beforeEach(() => {
    switchToTrack("1/3");
  });

  it("caches peaks under the current track number and decodes a different track separately", async () => {
    mockDecodeWaveformForCurrentTrack.mockResolvedValueOnce(track1Peaks).mockResolvedValueOnce(track2Peaks);

    // Track 1: decode + render, cache key t1/3
    const canvas1 = makeCanvas();
    const ctx1 = makeMockCtx();
    vi.spyOn(canvas1, "getContext").mockReturnValue(ctx1 as unknown as CanvasRenderingContext2D);
    await triggerWaveformDecode(canvas1);
    expect(drawnBarHeights(ctx1)).toHaveLength(track1Peaks.length);
    expect(mockDecodeWaveformForCurrentTrack).toHaveBeenCalledTimes(1);

    // Switch to track 2 on the same canvas — the old peaks must not be reused
    clearWaveform(canvas1);
    switchToTrack("2/3");
    const ctx2 = makeMockCtx();
    vi.spyOn(canvas1, "getContext").mockReturnValue(ctx2 as unknown as CanvasRenderingContext2D);
    await triggerWaveformDecode(canvas1);

    expect(mockDecodeWaveformForCurrentTrack).toHaveBeenCalledTimes(2);
    expect(drawnBarHeights(ctx2)).toEqual(Array.from(track2Peaks, (p) => 40 * 0.1 + p * 40 * 0.9));
  });

  it("reuses the cached peaks of a track when navigating back without re-decoding", async () => {
    mockDecodeWaveformForCurrentTrack.mockResolvedValueOnce(track1Peaks).mockResolvedValueOnce(track2Peaks);

    const canvas = makeCanvas();
    const ctx = makeMockCtx();
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    await triggerWaveformDecode(canvas); // track 1 decoded
    clearWaveform(canvas);
    switchToTrack("2/3");
    await triggerWaveformDecode(canvas); // track 2 decoded
    clearWaveform(canvas);
    switchToTrack("1/3"); // back to track 1
    ctx.fillRect.mockClear();

    await triggerWaveformDecode(canvas);

    expect(mockDecodeWaveformForCurrentTrack).toHaveBeenCalledTimes(2); // no third decode
    // Rendered bars match track 1 peaks, not track 2
    const height = 40;
    const expected = Array.from(track1Peaks, (p) => height * 0.1 + p * height * 0.9);
    expect(drawnBarHeights(ctx)).toEqual(expected);
  });

  it("keeps distinct cache entries per track simultaneously", async () => {
    mockDecodeWaveformForCurrentTrack.mockResolvedValueOnce(track1Peaks).mockResolvedValueOnce(track2Peaks);

    const canvas = makeCanvas();
    const ctx = makeMockCtx();
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    await triggerWaveformDecode(canvas); // seeds t1/3
    clearWaveform(canvas);
    switchToTrack("2/3");
    await triggerWaveformDecode(canvas); // seeds t2/3
    mockDecodeWaveformForCurrentTrack.mockClear();

    // Both tracks now hit their own cache and render their own peaks
    clearWaveform(canvas);
    switchToTrack("2/3");
    ctx.fillRect.mockClear();
    await triggerWaveformDecode(canvas);
    const track2Heights = drawnBarHeights(ctx);

    clearWaveform(canvas);
    switchToTrack("1/3");
    ctx.fillRect.mockClear();
    await triggerWaveformDecode(canvas);
    const track1Heights = drawnBarHeights(ctx);

    expect(mockDecodeWaveformForCurrentTrack).not.toHaveBeenCalled();
    expect(track1Heights).not.toEqual(track2Heights);
    expect(track1Heights).toEqual(Array.from(track1Peaks, (p) => 40 * 0.1 + p * 40 * 0.9));
    expect(track2Heights).toEqual(Array.from(track2Peaks, (p) => 40 * 0.1 + p * 40 * 0.9));
  });
});

describe("over-length tracks", () => {
  beforeEach(() => {
    switchToTrack("1/2");
  });

  it("hides the canvas and skips decode above the duration cap even with another track cached", async () => {
    mockDecodeWaveformForCurrentTrack.mockResolvedValue(track1Peaks);

    // Seed a normal track's cache first
    const seedCanvas = makeCanvas();
    vi.spyOn(seedCanvas, "getContext").mockReturnValue(makeMockCtx() as unknown as CanvasRenderingContext2D);
    await triggerWaveformDecode(seedCanvas);
    mockDecodeWaveformForCurrentTrack.mockClear();

    // Navigate to an over-length track
    switchToTrack("2/2", PLUME_CONSTANTS.WAVEFORM_MAX_DURATION_SECONDS + 1);
    const canvas = makeCanvas();
    canvas.classList.remove(PLUME_CSS_CLASSES.featureHidden);

    await triggerWaveformDecode(canvas);

    expect(canvas.classList.contains(PLUME_CSS_CLASSES.featureHidden)).toBe(true);
    expect(mockDecodeWaveformForCurrentTrack).not.toHaveBeenCalled();
  });

  it("does not serve cached peaks from another track to an over-length track", async () => {
    mockDecodeWaveformForCurrentTrack.mockResolvedValue(track1Peaks);
    const seedCanvas = makeCanvas();
    vi.spyOn(seedCanvas, "getContext").mockReturnValue(makeMockCtx() as unknown as CanvasRenderingContext2D);
    await triggerWaveformDecode(seedCanvas);

    switchToTrack("2/2", PLUME_CONSTANTS.WAVEFORM_MAX_DURATION_SECONDS + 1);
    const canvas = makeCanvas();
    const ctx = makeMockCtx();
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    await triggerWaveformDecode(canvas);

    expect(ctx.fillRect).not.toHaveBeenCalled();
  });
});

describe("async decode races across track switches", () => {
  beforeEach(() => {
    switchToTrack("1/2");
  });

  it("drops a stale decode result after switching tracks: no paint on the new canvas", async () => {
    let resolveTrack1!: (peaks: Float32Array | null) => void;
    mockDecodeWaveformForCurrentTrack
      .mockReturnValueOnce(new Promise((r) => (resolveTrack1 = r)))
      .mockResolvedValueOnce(track2Peaks);

    const canvas = makeCanvas();
    const ctx = makeMockCtx();
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    const track1Promise = triggerWaveformDecode(canvas);
    // User switches to track 2 before track 1's decode returns
    clearWaveform(canvas);
    switchToTrack("2/2");
    const track2Promise = triggerWaveformDecode(canvas);

    // Track 2's decode resolves first and renders
    await track2Promise;
    const track2Heights = drawnBarHeights(ctx);
    expect(track2Heights).toEqual(Array.from(track2Peaks, (p) => 40 * 0.1 + p * 40 * 0.9));

    // Track 1's stale decode resolves afterwards — it must not repaint the canvas
    ctx.fillRect.mockClear();
    resolveTrack1(track1Peaks);
    await track1Promise;

    expect(ctx.fillRect).not.toHaveBeenCalled();
    // Canvas still shows track 2's peaks
    expect(canvas.classList.contains(PLUME_CSS_CLASSES.featureHidden)).toBe(false);
  });

  it("never writes a stale decode result into the new track's cache key", async () => {
    let resolveTrack1!: (peaks: Float32Array | null) => void;
    mockDecodeWaveformForCurrentTrack
      .mockReturnValueOnce(new Promise((r) => (resolveTrack1 = r)))
      .mockResolvedValueOnce(track2Peaks);

    const canvas = makeCanvas();
    const ctx = makeMockCtx();
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    const stalePromise = triggerWaveformDecode(canvas);
    clearWaveform(canvas);
    switchToTrack("2/2");
    await triggerWaveformDecode(canvas); // t2/2 cache seeded with track2Peaks

    resolveTrack1(track1Peaks);
    await stalePromise;

    // A later trigger for track 2 must render track 2 peaks from its own cache — no decode, no track 1 data
    mockDecodeWaveformForCurrentTrack.mockClear();
    ctx.fillRect.mockClear();
    await triggerWaveformDecode(canvas);

    expect(mockDecodeWaveformForCurrentTrack).not.toHaveBeenCalled();
    expect(drawnBarHeights(ctx)).toEqual(Array.from(track2Peaks, (p) => 40 * 0.1 + p * 40 * 0.9));
  });

  it("treats a feature-flag toggle-off during decode as a stale generation", async () => {
    let resolveDecode!: (peaks: Float32Array | null) => void;
    mockDecodeWaveformForCurrentTrack.mockReturnValue(new Promise((r) => (resolveDecode = r)));

    const canvas = makeCanvas();
    const ctx = makeMockCtx();
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    const promise = triggerWaveformDecode(canvas);

    fakeAppCore = new FakeAppCore({
      featureFlags: { ...PLUME_DEFAULTS.featureFlags, waveform: false },
      currentTime: 0,
      duration: 100,
      trackNumber: "1/2",
    });
    await triggerWaveformDecode(canvas); // flag off → hidden, generation bumped
    ctx.fillRect.mockClear();

    resolveDecode(track1Peaks);
    await promise;

    expect(canvas.classList.contains(PLUME_CSS_CLASSES.featureHidden)).toBe(true);
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });

  it("invalidates decodes per canvas: two canvases keep independent generations", async () => {
    let resolveSlow!: (peaks: Float32Array | null) => void;
    mockDecodeWaveformForCurrentTrack
      .mockReturnValueOnce(new Promise((r) => (resolveSlow = r))) // canvas A, track 1 (slow)
      .mockResolvedValueOnce(track2Peaks); // canvas B, track 2

    const canvasA = makeCanvas();
    const ctxA = makeMockCtx();
    vi.spyOn(canvasA, "getContext").mockReturnValue(ctxA as unknown as CanvasRenderingContext2D);
    const canvasB = makeCanvas();
    const ctxB = makeMockCtx();
    vi.spyOn(canvasB, "getContext").mockReturnValue(ctxB as unknown as CanvasRenderingContext2D);

    const slowPromise = triggerWaveformDecode(canvasA);

    // Canvas A is explicitly cleared (e.g. main player hidden) while its decode is still running
    clearWaveform(canvasA);

    // A different canvas keeps decoding independently and finishes with track 2 peaks
    switchToTrack("2/2");
    await triggerWaveformDecode(canvasB);

    expect(drawnBarHeights(ctxB)).toEqual(Array.from(track2Peaks, (p) => 40 * 0.1 + p * 40 * 0.9));

    // Canvas A's stale decode resolves — its own generation invalidates it, canvas B stays untouched
    resolveSlow(track1Peaks);
    await slowPromise;

    expect(ctxA.fillRect).not.toHaveBeenCalled();
    expect(drawnBarHeights(ctxB)).toEqual(Array.from(track2Peaks, (p) => 40 * 0.1 + p * 40 * 0.9));
  });
});

describe("syncWaveformPlayhead cache gating across tracks", () => {
  beforeEach(() => {
    switchToTrack("1/2");
  });

  it("stays blank when the current track has no cached peaks even if another track does", async () => {
    mockDecodeWaveformForCurrentTrack.mockResolvedValue(track1Peaks);
    const seedCanvas = makeCanvas();
    vi.spyOn(seedCanvas, "getContext").mockReturnValue(makeMockCtx() as unknown as CanvasRenderingContext2D);
    await triggerWaveformDecode(seedCanvas); // seeds only t1/2

    // New track without its own cache
    switchToTrack("2/2");
    const canvas = makeCanvas();
    const ctx = makeMockCtx();
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    syncWaveformPlayhead(canvas, 0.75);

    expect(ctx.fillRect).not.toHaveBeenCalled();
  });

  it("redraws with the current track's cached peaks during playback", async () => {
    mockDecodeWaveformForCurrentTrack.mockResolvedValue(track1Peaks);
    const canvas = makeCanvas();
    const ctx = makeMockCtx();
    vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    await triggerWaveformDecode(canvas);
    ctx.fillRect.mockClear();

    syncWaveformPlayhead(canvas, 0.5);

    expect(drawnBarHeights(ctx)).toEqual(Array.from(track1Peaks, (p) => 40 * 0.1 + p * 40 * 0.9));
  });
});
