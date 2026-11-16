/**
 * Local, dependency-free tests for the FFmpeg export render engine.
 *
 * Run with:
 *   node --test components/video-editor/export-modal/lib/render-engine.test.ts
 *
 * Everything (FFmpeg virtual filesystem, html2canvas, canvas/DOM helpers) is
 * faked in-process — no browser, no WASM download and no network access.
 *
 * Node >= 22.6 strips TypeScript types natively, so no build step is needed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EmptyTimelineError,
  RenderCancelledError,
  computeFramePlan,
  frameFileName,
  getQualitySettings,
  getResolutionDimensions,
  renderVideo,
} from "./render-engine.ts";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class FakeFfmpeg {
  /** Virtual filesystem: path -> bytes. */
  files = new Map();
  execCalls = [];
  /** When set, exec() rejects while running the given argument fragment. */
  failExecContaining = null;

  async writeFile(name, data) {
    this.files.set(name, data);
  }

  async readFile(name) {
    if (!this.files.has(name)) throw new Error(`No such file: ${name}`);
    return this.files.get(name);
  }

  async deleteFile(name) {
    if (!this.files.has(name)) throw new Error(`No such file: ${name}`);
    this.files.delete(name);
  }

  async exec(args) {
    this.execCalls.push([...args]);
    if (this.failExecContaining && args.includes(this.failExecContaining)) {
      throw new Error(`ffmpeg exec failed near "${this.failExecContaining}"`);
    }

    // Simulate the output each command is expected to produce.
    if (args.includes("palette.png")) {
      this.files.set("palette.png", new Uint8Array([1, 2, 3]));
    }
    if (args.includes("output.gif")) {
      this.files.set("output.gif", new Uint8Array([9, 8, 7]));
    }
    if (args.includes("output.mp4")) {
      this.files.set("output.mp4", new Uint8Array([4, 5, 6]));
    }
  }
}

// A minimal PNG-ish byte prefix so the pipeline has real bytes to write.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makePlatform({ onCapture } = {}) {
  const seekTimes = [];
  const captured = [];
  let frameCounter = 0;

  return {
    seekTimes,
    captured,
    platform: {
      waitForFonts: async () => {},
      wait: async () => {},
      animationFrames: async () => {},
      getZoomPercent: () => 100,
      captureFramePng: async (element, targetWidth, targetHeight, options) => {
        const index = frameCounter++;
        captured.push({
          index,
          width: options.width,
          height: options.height,
          targetWidth,
          targetHeight,
        });
        onCapture?.();
        // Return a distinct copy per frame so writes are observable bytes.
        return Uint8Array.from(PNG_BYTES);
      },
    },
    seekTo: (time) => seekTimes.push(time),
    pause: () => {},
  };
}

const fakePreviewElement = {
  offsetHeight: 100,
  getBoundingClientRect: () => ({ width: 1920, height: 1080 }),
};

const baseSettings = {
  resolution: "1080p",
  quality: "high",
  speed: "balanced",
  fps: 30,
};

function makeDeps(overrides = {}) {
  const ffmpeg = overrides.ffmpeg ?? new FakeFfmpeg();
  const helper = makePlatform(overrides.platformOptions);
  const controller = new AbortController();

  const deps = {
    ffmpeg,
    previewElement: fakePreviewElement,
    exportSettings: { ...baseSettings, ...overrides.exportSettings },
    totalDuration:
      overrides.totalDuration === undefined ? 2 : overrides.totalDuration,
    signal: controller.signal,
    seekTo: helper.seekTo,
    pause: helper.pause,
    platform: helper.platform,
    phases: [],
    progress: [],
    onPhase(phase) {
      deps.phases.push(phase);
    },
    onProgress(current, total) {
      deps.progress.push([current, total]);
    },
  };

  return { deps, controller, ffmpeg, helper };
}

// ---------------------------------------------------------------------------
// computeFramePlan
// ---------------------------------------------------------------------------

test("computeFramePlan: MP4 keeps the output fps and ceil(duration*fps) frames", () => {
  const plan = computeFramePlan(2, { ...baseSettings, format: "mp4" });
  assert.equal(plan.format, "mp4");
  assert.equal(plan.effectiveFps, 30);
  assert.equal(plan.totalFrames, 60);
  assert.deepEqual(
    { width: plan.width, height: plan.height },
    getResolutionDimensions("1080p")
  );
});

test("computeFramePlan: GIF uses the reduced fps and aligns frame count to it", () => {
  const plan = computeFramePlan(2, { ...baseSettings, format: "gif" });
  assert.equal(plan.effectiveFps, 10);
  assert.equal(plan.totalFrames, 20); // 2s * 10fps, not 2s * 30fps
});

test("computeFramePlan: GIF below the cap keeps the user's lower fps", () => {
  const plan = computeFramePlan(1, {
    ...baseSettings,
    format: "gif",
    fps: 5,
  });
  assert.equal(plan.effectiveFps, 5);
  assert.equal(plan.totalFrames, 5);
});

test("computeFramePlan: zero duration yields zero frames", () => {
  const plan = computeFramePlan(0, baseSettings);
  assert.equal(plan.totalFrames, 0);
});

test("computeFramePlan: missing fps falls back to 30", () => {
  const plan = computeFramePlan(1, {
    resolution: "720p",
    quality: "high",
    speed: "balanced",
  });
  assert.equal(plan.effectiveFps, 30);
  assert.equal(plan.totalFrames, 30);
});

// ---------------------------------------------------------------------------
// Empty timeline boundary
// ---------------------------------------------------------------------------

test("empty timeline (duration 0): fails explicitly, writes no frames, never execs ffmpeg", async () => {
  const { deps, ffmpeg } = makeDeps({ totalDuration: 0 });

  await assert.rejects(() => renderVideo(deps), EmptyTimelineError);
  assert.equal(ffmpeg.execCalls.length, 0);
  assert.equal(ffmpeg.files.size, 0);
});

test("non-finite duration: fails explicitly without touching ffmpeg", async () => {
  const { deps, ffmpeg } = makeDeps({ totalDuration: Number.NaN });

  await assert.rejects(() => renderVideo(deps), EmptyTimelineError);
  assert.equal(ffmpeg.execCalls.length, 0);
  assert.equal(ffmpeg.files.size, 0);
});

test("sub-frame duration rounds up to one frame instead of zero", async () => {
  const { deps } = makeDeps({
    totalDuration: 0.01,
    exportSettings: { ...baseSettings, fps: 30 },
  });

  const result = await renderVideo(deps);
  assert.equal(result.frameCount, 1);
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

test("cancel during capture stops the frame loop and leaves no temp files", async () => {
  const { deps, controller, ffmpeg, helper } = makeDeps({
    totalDuration: 1,
    exportSettings: { ...baseSettings, fps: 30 },
    platformOptions: {
      onCapture: () => {
        if (helper.captured.length === 3) controller.abort();
      },
    },
  });

  await assert.rejects(() => renderVideo(deps), RenderCancelledError);

  // Loop stopped after a handful of frames, never ran the encoder.
  assert.ok(helper.captured.length <= 4, `captured ${helper.captured.length}`);
  assert.equal(ffmpeg.execCalls.length, 0);
  // Every frame that was written has been cleaned up again.
  assert.equal(ffmpeg.files.size, 0);
});

test("cancel before start aborts before any capture or ffmpeg work", async () => {
  const { deps, ffmpeg } = makeDeps();
  deps.signal = AbortSignal.abort();

  await assert.rejects(() => renderVideo(deps), RenderCancelledError);
  assert.equal(ffmpeg.execCalls.length, 0);
  assert.equal(ffmpeg.files.size, 0);
});

test("cancel between palette and gif encode rejects and cleans palette + frames", async () => {
  const { deps, controller, ffmpeg } = makeDeps({
    totalDuration: 1,
    exportSettings: { ...baseSettings, format: "gif", fps: 10 },
  });

  const originalExec = ffmpeg.exec.bind(ffmpeg);
  ffmpeg.exec = async (args) => {
    await originalExec(args);
    if (args.includes("palette.png")) {
      // Abort after the palette was generated, before the GIF encode.
      controller.abort();
    }
  };

  await assert.rejects(() => renderVideo(deps), RenderCancelledError);
  assert.equal(ffmpeg.files.size, 0);
  assert.ok(!ffmpeg.files.has("palette.png"));
});

// ---------------------------------------------------------------------------
// GIF branch
// ---------------------------------------------------------------------------

test("GIF success: reduced framerate is used for input and filters, frame count matches", async () => {
  const { deps, ffmpeg, helper } = makeDeps({
    totalDuration: 2,
    exportSettings: { ...baseSettings, format: "gif", fps: 30 },
  });

  const result = await renderVideo(deps);

  assert.equal(result.format, "gif");
  assert.equal(result.fileName, "video.gif");
  assert.equal(result.fps, 10);
  assert.equal(result.frameCount, 20);
  assert.equal(helper.captured.length, 20);

  // Both ffmpeg commands must use 10fps everywhere, never the raw 30.
  assert.equal(ffmpeg.execCalls.length, 2);
  for (const args of ffmpeg.execCalls) {
    const framerateIdx = args.indexOf("-framerate");
    assert.equal(args[framerateIdx + 1], "10");
    assert.ok(
      args.some((a) => typeof a === "string" && a.startsWith("fps=10")),
      `expected fps=10 filter in ${JSON.stringify(args)}`
    );
    assert.ok(!args.some((a) => a === "30" || a === "fps=30"));
  }

  // Frame files were named frame00000..frame00019 and all consumed/removed.
  assert.ok(ffmpeg.files.size === 0);
  assert.ok(!ffmpeg.files.has("palette.png"));
  assert.ok(!ffmpeg.files.has("output.gif"));

  // Seek times follow the reduced rate. Index 0 is the initial seekTo(0)
  // before the loop; frame N seeks to N / effectiveFps.
  assert.deepEqual(helper.seekTimes[0], 0);
  assert.deepEqual(helper.seekTimes[2], 0.1);
  assert.deepEqual(helper.seekTimes[20], 1.9);
});

test("GIF encode failure: error propagates and no temp files remain", async () => {
  const ffmpeg = new FakeFfmpeg();
  ffmpeg.failExecContaining = "output.gif";

  const { deps } = makeDeps({
    ffmpeg,
    totalDuration: 1,
    exportSettings: { ...baseSettings, format: "gif", fps: 10 },
  });

  await assert.rejects(() => renderVideo(deps), /ffmpeg exec failed/);

  assert.equal(ffmpeg.files.size, 0);
  const names = [...ffmpeg.files.keys()];
  assert.ok(!names.some((n) => n.startsWith("frame")));
  assert.ok(!names.includes("palette.png"));
});

// ---------------------------------------------------------------------------
// MP4 branch — mappings preserved
// ---------------------------------------------------------------------------

test("MP4 success: quality/speed mapping and resolution mapping are unchanged", async () => {
  const { deps, ffmpeg } = makeDeps({
    totalDuration: 1,
    exportSettings: {
      ...baseSettings,
      format: "mp4",
      quality: "ultra",
      speed: "slowest",
      resolution: "720p",
      fps: 24,
    },
  });

  const result = await renderVideo(deps);
  assert.equal(result.fileName, "video.mp4");
  assert.equal(result.fps, 24);
  assert.equal(result.frameCount, 24);

  const expected = getQualitySettings("ultra", "slowest");
  const args = ffmpeg.execCalls[0];
  assert.equal(args[args.indexOf("-preset") + 1], expected.preset);
  assert.equal(args[args.indexOf("-crf") + 1], String(expected.crf));
  assert.equal(args[args.indexOf("-framerate") + 1], "24");
  assert.deepEqual(
    {
      width: getResolutionDimensions("720p").width,
      height: getResolutionDimensions("720p").height,
    },
    { width: 1280, height: 720 }
  );

  // All temporary files are gone after a successful export.
  assert.equal(ffmpeg.files.size, 0);
  assert.ok(!ffmpeg.files.has("output.mp4"));
});

test("MP4 encode failure still cleans up every captured frame", async () => {
  const ffmpeg = new FakeFfmpeg();
  ffmpeg.failExecContaining = "output.mp4";

  const { deps } = makeDeps({
    ffmpeg,
    totalDuration: 1,
    exportSettings: { ...baseSettings, fps: 10 },
  });

  await assert.rejects(() => renderVideo(deps), /ffmpeg exec failed/);

  // Encoding blew up, but the frame files written during capture are removed.
  assert.equal(ffmpeg.files.size, 0);
  const names = [...ffmpeg.files.keys()];
  assert.ok(!names.some((n) => n.startsWith("frame")));
  assert.ok(!names.includes("output.mp4"));
});

test("a failed single frame capture is skipped but still cleans up on completion", async () => {
  // Mirrors the original resilience: one broken capture must not abort the
  // whole export, and the run still leaves no temp files behind.
  const { deps, ffmpeg, helper } = makeDeps({
    totalDuration: 1,
    exportSettings: { ...baseSettings, fps: 5 },
  });

  const original = helper.platform.captureFramePng.bind(helper.platform);
  let attempts = 0;
  helper.platform.captureFramePng = async (
    element,
    targetWidth,
    targetHeight,
    options
  ) => {
    attempts += 1;
    if (attempts === 3) {
      throw new Error("capture blew up on one frame");
    }
    return original(element, targetWidth, targetHeight, options);
  };

  const result = await renderVideo(deps);
  assert.equal(result.frameCount, 5);
  // Five frames were attempted; four succeeded (one failed) and all temp
  // files produced for them were cleaned up.
  assert.equal(attempts, 5);
  assert.equal(ffmpeg.files.size, 0);
});

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

test("frameFileName zero-pads to five digits", () => {
  assert.equal(frameFileName(0), "frame00000.png");
  assert.equal(frameFileName(42), "frame00042.png");
  assert.equal(frameFileName(12345), "frame12345.png");
});

test("progress reports frame indices against the total frame count", async () => {
  const { deps } = makeDeps({
    totalDuration: 1,
    exportSettings: { ...baseSettings, format: "gif", fps: 5 },
  });

  await renderVideo(deps);
  assert.equal(deps.progress.length, 5);
  assert.deepEqual(deps.progress[0], [1, 5]);
  assert.deepEqual(deps.progress.at(-1), [5, 5]);
  assert.deepEqual(deps.phases, ["preparing", "capturing", "encoding"]);
});
