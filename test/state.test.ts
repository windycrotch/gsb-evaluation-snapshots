import { describe, beforeEach, expect, it } from "vitest";
import * as pureimage from "../src/index";

// values that differ from the defaults, for every property that save()/restore() must cover
const STATE_PROPS: [string, any][] = [
  ["fillStyle", "#ff0000"],
  ["strokeStyle", "#00ff00"],
  ["lineWidth", 5],
  ["lineCap", "round"],
  ["lineJoin", "round"],
  ["miterLimit", 3],
  ["globalAlpha", 0.5],
  ["globalCompositeOperation", "copy"],
  ["shadowBlur", 5],
  ["shadowColor", "#ff0000"],
  ["shadowOffsetX", 5],
  ["shadowOffsetY", 5],
  ["textAlign", "center"],
  ["textBaseline", "top"],
  ["imageSmoothingEnabled", false],
  ["font", "20px Arial"],
];

describe("canvas state", () => {
  let image;
  let ctx;

  beforeEach(() => {
    image = pureimage.make(100, 50);
    ctx = image.getContext("2d");
  });

  it.each(STATE_PROPS)("save/restore round-trips %s", (prop, value) => {
    const old = ctx[prop];
    ctx.save();
    ctx[prop] = value;
    expect(ctx[prop]).not.toEqual(old);
    ctx.restore();
    expect(ctx[prop]).toEqual(old);
  });

  it("has spec default values", () => {
    expect(ctx.fillStyle).toBe("#000000");
    expect(ctx.strokeStyle).toBe("#000000");
    expect(ctx.lineWidth).toBe(1);
    expect(ctx.lineCap).toBe("butt");
    expect(ctx.lineJoin).toBe("miter");
    expect(ctx.miterLimit).toBe(10);
    expect(ctx.globalAlpha).toBe(1);
    expect(ctx.globalCompositeOperation).toBe("source-over");
    expect(ctx.shadowBlur).toBe(0);
    expect(ctx.shadowOffsetX).toBe(0);
    expect(ctx.shadowOffsetY).toBe(0);
  });

  it("restored fillStyle is used for drawing", () => {
    ctx.fillStyle = "#00ff00";
    ctx.save();
    ctx.fillStyle = "#ff0000";
    ctx.restore();
    ctx.fillRect(0, 0, 100, 50);
    expect(image.getPixelRGBA_separate(10, 10)).toEqual(new Uint8Array([0, 255, 0, 255]));
  });

  it("nested saves restore in LIFO order", () => {
    ctx.lineWidth = 1;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.save();
    ctx.lineWidth = 3;
    ctx.restore();
    expect(ctx.lineWidth).toBe(2);
    ctx.restore();
    expect(ctx.lineWidth).toBe(1);
  });

  it("supports a deep stack of saves", () => {
    const depth = 512;
    for (let i = 1; i <= depth; i++) {
      ctx.lineWidth = i;
      ctx.save();
    }
    for (let i = depth; i >= 1; i--) {
      ctx.restore();
      expect(ctx.lineWidth).toBe(i);
    }
  });

  it("restore with an empty stack does nothing", () => {
    ctx.lineWidth = 4;
    ctx.restore();
    ctx.restore();
    expect(ctx.lineWidth).toBe(4);
  });

  it("restore does not change the current path", () => {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.save();
    ctx.lineTo(10, 10);
    ctx.restore();
    expect(ctx.path.length).toBe(2);
  });

  it("clip works without calling beginPath first", () => {
    ctx.rect(0, 0, 10, 10);
    expect(() => ctx.clip()).not.toThrow();
  });

  it("restore removes the clip", () => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, 10, 10);
    ctx.clip();
    ctx.restore();
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 100, 50);
    expect(image.getPixelRGBA_separate(50, 25)).toEqual(new Uint8Array([255, 0, 0, 255]));
  });

  it("restore restores the transform", () => {
    ctx.save();
    ctx.translate(10, 10);
    ctx.restore();
    const m = ctx.getTransform();
    expect(m.e).toBe(0);
    expect(m.f).toBe(0);
  });

  it("path functions before beginPath do not throw", () => {
    expect(() => {
      ctx.moveTo(0, 0);
      ctx.lineTo(5, 5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }).not.toThrow();
  });

  it("closePath and fill with an empty path do nothing", () => {
    ctx.closePath();
    ctx.fill();
    expect(ctx.path.length).toBe(0);
  });

  it("save/restore round-trips a gradient fillStyle", () => {
    ctx.clearRect(0, 0, 100, 50);
    const grad = ctx.createLinearGradient(0, 0, 100, 0);
    grad.addColorStop(0, "#ff0000");
    grad.addColorStop(1, "#0000ff");
    ctx.fillStyle = grad;
    ctx.save();
    ctx.fillStyle = "#00ff00";
    ctx.restore();
    expect(ctx.fillStyle).toBe(grad);
    ctx.fillRect(0, 0, 100, 50);
    expect(image.getPixelRGBA_separate(0, 25)).toEqual(new Uint8Array([255, 0, 0, 255]));
  });

  it("save/restore restores the composite operation used for drawing", () => {
    ctx.clearRect(0, 0, 100, 50);
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 100, 50);
    ctx.save();
    ctx.globalCompositeOperation = "copy";
    ctx.restore();
    // if the copy operation had leaked past restore, this fill would clear
    // the pixels outside the rect instead of leaving them red
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(0, 0, 50, 50);
    expect(image.getPixelRGBA_separate(25, 25)).toEqual(new Uint8Array([0, 255, 0, 255]));
    expect(image.getPixelRGBA_separate(75, 25)).toEqual(new Uint8Array([255, 0, 0, 255]));
  });

  it("save/restore restores globalAlpha used for drawing", () => {
    ctx.clearRect(0, 0, 100, 50);
    ctx.globalAlpha = 0.5;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.restore();
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 100, 50);
    expect(image.getPixelRGBA_separate(50, 25)[3]).toBe(128);
  });

  it("reset() restores source-over and the default fill style", () => {
    const grad = ctx.createLinearGradient(0, 0, 100, 0);
    grad.addColorStop(0, "#ff0000");
    grad.addColorStop(1, "#0000ff");
    ctx.fillStyle = grad;
    ctx.globalCompositeOperation = "copy";
    ctx.reset();
    expect(ctx.globalCompositeOperation).toBe("source-over");
    expect(ctx.fillStyle).toBe("#000000");
    // the bitmap is cleared and a default black fill composites as source-over
    expect(image.getPixelRGBA_separate(50, 25)).toEqual(new Uint8Array([0, 0, 0, 0]));
    ctx.fillRect(0, 0, 50, 50);
    expect(image.getPixelRGBA_separate(25, 25)).toEqual(new Uint8Array([0, 0, 0, 255]));
    expect(image.getPixelRGBA_separate(75, 25)).toEqual(new Uint8Array([0, 0, 0, 0]));
  });

  it("resizing the bitmap resets the composite operation and fill style", () => {
    const grad = ctx.createLinearGradient(0, 0, 100, 0);
    grad.addColorStop(0, "#ff0000");
    grad.addColorStop(1, "#0000ff");
    ctx.fillStyle = grad;
    ctx.globalCompositeOperation = "copy";
    image.width = 30;
    expect(ctx.globalCompositeOperation).toBe("source-over");
    expect(ctx.fillStyle).toBe("#000000");
    expect(image.getPixelRGBA_separate(5, 5)).toEqual(new Uint8Array([0, 0, 0, 0]));
  });
});

describe("globalAlpha", () => {
  it("ignores out-of-range and non-finite values", () => {
    const ctx = pureimage.make(10, 10).getContext("2d");
    ctx.globalAlpha = 0.5;
    for (const v of [Infinity, -Infinity, NaN, -0.1, 1.1, 2]) {
      ctx.globalAlpha = v;
      expect(ctx.globalAlpha).toBe(0.5);
    }
    ctx.globalAlpha = 0;
    expect(ctx.globalAlpha).toBe(0);
  });
});

describe("globalAlpha compositing", () => {
  it("drawing with globalAlpha 0 leaves transparent pixels transparent", () => {
    const image = pureimage.make(10, 10);
    const ctx = image.getContext("2d");
    ctx.clearRect(0, 0, 10, 10);
    ctx.globalAlpha = 0;
    ctx.fillStyle = "#f00";
    ctx.beginPath();
    ctx.rect(0, 0, 10, 10);
    ctx.fill();
    expect(image.getPixelRGBA(5, 5)).toBe(0x00000000);
  });

  it("fillRect respects globalAlpha", () => {
    const image = pureimage.make(10, 10);
    const ctx = image.getContext("2d");
    ctx.clearRect(0, 0, 10, 10);
    ctx.globalAlpha = 0;
    ctx.fillStyle = "#f00";
    ctx.fillRect(0, 0, 10, 10);
    expect(image.getPixelRGBA(5, 5)).toBe(0x00000000);
  });

  it("source-over on a transparent pixel keeps the source alpha", () => {
    const image = pureimage.make(10, 10);
    const ctx = image.getContext("2d");
    ctx.clearRect(0, 0, 10, 10);
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = "#f00";
    ctx.fillRect(0, 0, 10, 10);
    expect(image.getPixelRGBA(5, 5)).toBe(0xff000080);
  });
});
