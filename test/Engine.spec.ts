import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Engine } from "../src/Engine.js";
import { Layer } from "../src/Layer.js";
import {
  ERROR_INVALID_LAYER_ARRAY,
  ERROR_INVALID_LAYER_ITEM,
} from "../src/constants/index.js";
import {
  FakeCanvas,
  createdImages,
  rafControl,
  resetFakes,
} from "./fakes.js";

/** Flush the microtask queue so async sources settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const makeCanvasLayer = (options = {}) =>
  new Layer({ source: new FakeCanvas() as unknown as HTMLCanvasElement, ...options });

beforeEach(resetFakes);

describe("setLayers — whole-stack replacement", () => {
  it("replaces the stack and redraws once with only the new stack when stopped", async () => {
    const target = new FakeCanvas();
    const oldLayer = makeCanvasLayer();
    const engine = new Engine({ target, layers: [oldLayer] });
    await flush();

    const first = makeCanvasLayer();
    const second = makeCanvasLayer();
    await flush();

    target.context.reset();
    engine.setLayers([first, second]);

    expect(engine.layers).toEqual([first, second]);
    // exactly one redraw: one clear, then the new stack in order
    expect(target.context.count("clearRect")).toBe(1);
    expect(target.context.drawnImages()).toEqual([first.source, second.source]);
  });

  it("rejects the whole array when any item is not a Layer and keeps the old stack", async () => {
    const target = new FakeCanvas();
    const oldLayer = makeCanvasLayer();
    const engine = new Engine({ target, layers: [oldLayer] });
    await flush();

    target.context.reset();
    expect(() =>
      engine.setLayers([makeCanvasLayer(), {} as Layer])
    ).toThrow(ERROR_INVALID_LAYER_ITEM);

    expect(engine.layers).toEqual([oldLayer]);
    expect(target.context.calls).toHaveLength(0); // no redraw happened
  });

  it("throws for non-array input", async () => {
    const engine = new Engine({});
    await flush();

    expect(() => engine.setLayers(null as unknown as Layer[])).toThrow(
      ERROR_INVALID_LAYER_ARRAY
    );
    expect(() => engine.setLayers({} as unknown as Layer[])).toThrow(
      ERROR_INVALID_LAYER_ARRAY
    );
    expect(engine.layers).toEqual([]);
  });

  it("applies the same validation to constructor layers", () => {
    expect(() => new Engine({ layers: [{} as Layer] })).toThrow(
      ERROR_INVALID_LAYER_ITEM
    );
    expect(
      () => new Engine({ layers: "nope" as unknown as Layer[] })
    ).toThrow(ERROR_INVALID_LAYER_ARRAY);

    const layer = makeCanvasLayer();
    const engine = new Engine({ layers: [layer] });
    expect(engine.layers).toEqual([layer]);
  });

  it("does not redraw synchronously while running, but the next frame uses the new stack", async () => {
    const target = new FakeCanvas();
    const oldLayer = makeCanvasLayer();
    const engine = new Engine({ target, layers: [oldLayer] });
    await flush();

    engine.start();

    const newLayer = makeCanvasLayer();
    await flush();

    target.context.reset();
    engine.setLayers([newLayer]);
    expect(target.context.calls).toHaveLength(0); // no extra draw while running

    rafControl.step();
    expect(target.context.drawnImages()).toEqual([newLayer.source]);

    engine.stop();
  });
});

describe("drawing with asynchronously-ready sources", () => {
  it("skips layers that are not ready yet, without throwing or drawing blanks", async () => {
    const target = new FakeCanvas();
    const ready = makeCanvasLayer();
    const engine = new Engine({ target, layers: [ready] });
    await flush();

    const pending = new Layer({ imageSrc: "pending.png" });
    engine.addLayer(pending, false);
    await flush();

    target.context.reset();
    expect(() => engine.draw()).not.toThrow();
    expect(target.context.drawnImages()).toEqual([ready.source]);
  });

  it("draws a stopped engine's late-ready layer only after an explicit draw()", async () => {
    const target = new FakeCanvas();
    const ready = makeCanvasLayer();
    const engine = new Engine({ target, layers: [ready] });
    await flush();

    const pending = new Layer({ imageSrc: "late.png" });
    engine.addLayer(pending); // default shouldDraw=true, but engine is stopped
    await flush();

    const image = createdImages.at(-1)!;
    image.succeed();
    await flush();

    // readiness alone must not paint while the engine is stopped
    expect(target.context.drawnImages()).not.toContain(image);

    target.context.reset();
    engine.draw();
    expect(target.context.drawnImages()).toEqual([ready.source, image]);
  });

  it("handles constructor layers that resolve after construction", async () => {
    const target = new FakeCanvas();
    const pending = new Layer({ imageSrc: "slow.png" });
    const engine = new Engine({ target, layers: [pending] });
    await flush();

    expect(() => engine.draw()).not.toThrow();
    expect(target.context.drawnImages()).toEqual([]);

    const image = createdImages.at(-1)!;
    image.succeed();
    await flush(); // the constructor's deferred initial draw fires now

    expect(target.context.drawnImages()).toEqual([image]);
  });
});

describe("removeLayer", () => {
  it("removes only the first occurrence of a duplicated instance", async () => {
    const target = new FakeCanvas();
    const duplicated = makeCanvasLayer();
    const other = makeCanvasLayer();
    const engine = new Engine({
      target,
      layers: [duplicated, other, duplicated],
    });
    await flush();

    engine.removeLayer(duplicated, false);
    expect(engine.layers).toEqual([other, duplicated]);

    target.context.reset();
    engine.draw();
    expect(target.context.drawnImages()).toEqual([
      other.source,
      duplicated.source,
    ]);
  });

  it("never draws a layer again after it was removed", async () => {
    const target = new FakeCanvas();
    const first = makeCanvasLayer();
    const second = makeCanvasLayer();
    const engine = new Engine({ target, layers: [first, second] });
    await flush();

    target.context.reset();
    engine.removeLayer(first); // triggers a redraw by default
    expect(engine.layers).toEqual([second]);
    expect(target.context.drawnImages()).toEqual([second.source]);

    target.context.reset();
    engine.removeLayer(second);
    expect(engine.layers).toEqual([]);
    expect(target.context.drawnImages()).toEqual([]);
    expect(target.context.count("clearRect")).toBe(1);
  });

  it("is a no-op for layers that are not in the stack", async () => {
    const target = new FakeCanvas();
    const engine = new Engine({ target, layers: [makeCanvasLayer()] });
    await flush();

    target.context.reset();
    expect(() => engine.removeLayer(makeCanvasLayer())).not.toThrow();
    expect(target.context.calls).toHaveLength(0); // not even a redraw
  });
});

describe("start/stop loop", () => {
  let now: number;

  beforeEach(() => {
    now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits no draws or onStep callbacks after stop()", async () => {
    const target = new FakeCanvas();
    const onStep = vi.fn();
    const engine = new Engine({
      target,
      layers: [makeCanvasLayer()],
      onStep,
    });
    await flush();

    engine.start();
    expect(onStep).toHaveBeenCalledTimes(1);

    now += 16;
    rafControl.step();
    expect(onStep).toHaveBeenCalledTimes(2);

    engine.stop();
    expect(rafControl.pending()).toBe(0);

    target.context.reset();
    now += 16;
    rafControl.step();
    now += 16;
    rafControl.step();

    expect(onStep).toHaveBeenCalledTimes(2);
    expect(target.context.calls).toHaveLength(0);
  });

  it("resets the time base on restart so the first offset excludes downtime", async () => {
    const onStep = vi.fn();
    const engine = new Engine({
      target: new FakeCanvas(),
      layers: [makeCanvasLayer()],
      onStep,
    });
    await flush();

    engine.start();
    now += 16;
    rafControl.step();
    engine.stop();

    now += 5000; // downtime must not leak into the next offset
    engine.start();
    expect(onStep.mock.calls.at(-1)![0].offset).toBe(0);

    now += 16;
    rafControl.step();
    expect(onStep.mock.calls.at(-1)![0].offset).toBe(16);

    engine.stop();
  });

  it("ignores start() while already running (single loop, single time base)", async () => {
    const onStep = vi.fn();
    const engine = new Engine({
      target: new FakeCanvas(),
      layers: [makeCanvasLayer()],
      onStep,
    });
    await flush();

    engine.start();
    engine.start();
    expect(onStep).toHaveBeenCalledTimes(1);

    now += 16;
    rafControl.step();
    expect(onStep).toHaveBeenCalledTimes(2); // exactly one loop is running

    engine.stop();
  });
});
