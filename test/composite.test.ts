import { describe, expect, it } from "vitest";
import * as pureimage from "../src/index";
import { compositePixel } from "../src/composite";

function setup(w = 20, h = 20) {
  const image = pureimage.make(w, h);
  const ctx = image.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  return { image, ctx };
}

const px = (image, x: number, y: number) => Array.from(image.getPixelRGBA_separate(x, y));

describe("globalCompositeOperation", () => {
  it("accepts every Porter-Duff operator and blend mode", () => {
    const { ctx } = setup();
    for (const op of [
      "clear", "copy", "source-over", "source-in", "source-out", "source-atop",
      "destination-over", "destination-in", "destination-out", "destination-atop",
      "xor", "lighter", "multiply", "screen", "overlay", "darken", "lighten",
      "color-dodge", "color-burn", "hard-light", "soft-light", "difference",
      "exclusion", "hue", "saturation", "color", "luminosity",
    ]) {
      ctx.globalCompositeOperation = op;
      expect(ctx.globalCompositeOperation).toBe(op);
    }
  });

  it("ignores unknown, misspelled and differently-cased values", () => {
    const { ctx } = setup();
    ctx.globalCompositeOperation = "xor";
    for (const v of ["nonexistent", "Source-over", "over", "darker", "source-over\0", ""]) {
      ctx.globalCompositeOperation = v;
      expect(ctx.globalCompositeOperation).toBe("xor");
    }
  });

  it("is saved and restored", () => {
    const { ctx } = setup();
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.restore();
    expect(ctx.globalCompositeOperation).toBe("source-over");
  });
});

describe("Porter-Duff operators", () => {
  // red destination over the whole canvas, then a green source square at (5,5)-(15,15)
  function draw(op: string) {
    const { image, ctx } = setup();
    ctx.fillStyle = "#f00";
    ctx.fillRect(0, 0, 20, 20);
    ctx.globalCompositeOperation = op;
    ctx.fillStyle = "#0f0";
    ctx.fillRect(5, 5, 10, 10);
    return { inside: px(image, 10, 10), outside: px(image, 1, 1) };
  }

  it.each([
    // op, inside the shape, outside the shape
    ["source-over", [0, 255, 0, 255], [255, 0, 0, 255]],
    ["destination-over", [255, 0, 0, 255], [255, 0, 0, 255]],
    ["source-atop", [0, 255, 0, 255], [255, 0, 0, 255]],
    ["destination-out", [0, 0, 0, 0], [255, 0, 0, 255]],
    ["xor", [0, 0, 0, 0], [255, 0, 0, 255]],
    ["lighter", [255, 255, 0, 255], [255, 0, 0, 255]],
    // unbounded operators also clear the destination outside the shape
    ["copy", [0, 255, 0, 255], [0, 0, 0, 0]],
    ["source-in", [0, 255, 0, 255], [0, 0, 0, 0]],
    ["source-out", [0, 0, 0, 0], [0, 0, 0, 0]],
    ["destination-in", [255, 0, 0, 255], [0, 0, 0, 0]],
    ["destination-atop", [255, 0, 0, 255], [0, 0, 0, 0]],
    ["clear", [0, 0, 0, 0], [0, 0, 0, 0]],
  ])("%s", (op, inside, outside) => {
    const result = draw(op as string);
    expect(result.inside).toEqual(inside);
    expect(result.outside).toEqual(outside);
  });

  it("unbounded operators leave pixels outside the clip alone", () => {
    const { image, ctx } = setup();
    ctx.fillStyle = "#f00";
    ctx.fillRect(0, 0, 20, 20);
    ctx.beginPath();
    ctx.rect(0, 0, 10, 20);
    ctx.clip();
    ctx.globalCompositeOperation = "copy";
    ctx.fillStyle = "#0f0";
    ctx.fillRect(2, 2, 4, 4);
    expect(px(image, 3, 3)).toEqual([0, 255, 0, 255]);
    expect(px(image, 8, 15)).toEqual([0, 0, 0, 0]); // inside clip, outside shape
    expect(px(image, 15, 15)).toEqual([255, 0, 0, 255]); // outside clip
  });

  it("applies globalAlpha to the source", () => {
    const { image, ctx } = setup();
    ctx.globalCompositeOperation = "copy";
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = "#0f0";
    ctx.fillRect(0, 0, 20, 20);
    expect(px(image, 10, 10)).toEqual([0, 255, 0, 128]);
  });

  it("composites overlapping parts of one path once", () => {
    // with xor, a path drawn as two overlapping sub-paths is a single source shape,
    // so the overlap must not cancel itself out against the first sub-path
    const { image, ctx } = setup();
    ctx.globalCompositeOperation = "xor";
    ctx.fillStyle = "#0f0";
    ctx.beginPath();
    ctx.rect(0, 0, 12, 20);
    ctx.rect(8, 0, 12, 20);
    ctx.fill();
    expect(px(image, 4, 10)).toEqual([0, 255, 0, 255]);
  });

  it("works for strokes", () => {
    const { image, ctx } = setup();
    ctx.fillStyle = "#f00";
    ctx.fillRect(0, 0, 20, 20);
    ctx.globalCompositeOperation = "destination-out";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, 10);
    ctx.lineTo(20, 10);
    ctx.stroke();
    expect(px(image, 10, 10)[3]).toBe(0);
    expect(px(image, 10, 2)).toEqual([255, 0, 0, 255]);
  });

  it("works for drawImage, including the area the image does not cover", () => {
    const src = pureimage.make(5, 5);
    const sctx = src.getContext("2d");
    sctx.fillStyle = "#00f";
    sctx.fillRect(0, 0, 5, 5);

    const { image, ctx } = setup();
    ctx.fillStyle = "#f00";
    ctx.fillRect(0, 0, 20, 20);
    ctx.globalCompositeOperation = "source-in";
    ctx.drawImage(src, 0, 0);
    expect(px(image, 2, 2)).toEqual([0, 0, 255, 255]);
    expect(px(image, 10, 10)).toEqual([0, 0, 0, 0]);
  });

  it("unbounded operators respect the clip when stroking", () => {
    const { image, ctx } = setup();
    ctx.fillStyle = "#f00";
    ctx.fillRect(0, 0, 20, 20);
    ctx.beginPath();
    ctx.rect(0, 0, 10, 20);
    ctx.clip();
    ctx.globalCompositeOperation = "copy";
    ctx.strokeStyle = "#0f0";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(2, 2);
    ctx.lineTo(2, 18);
    ctx.stroke();
    expect(px(image, 2, 10)).toEqual([0, 255, 0, 255]); // stroked, inside clip
    expect(px(image, 8, 10)).toEqual([0, 0, 0, 0]); // inside clip, outside shape
    expect(px(image, 15, 10)).toEqual([255, 0, 0, 255]); // outside clip: untouched
  });

  it("unbounded operators respect the clip in drawImage", () => {
    const src = pureimage.make(4, 4);
    const sctx = src.getContext("2d");
    sctx.fillStyle = "#00f";
    sctx.fillRect(0, 0, 4, 4);

    const { image, ctx } = setup();
    ctx.fillStyle = "#f00";
    ctx.fillRect(0, 0, 20, 20);
    ctx.beginPath();
    ctx.rect(0, 0, 10, 20);
    ctx.clip();
    ctx.globalCompositeOperation = "copy";
    ctx.drawImage(src, 2, 2);
    expect(px(image, 3, 3)).toEqual([0, 0, 255, 255]); // image, inside clip
    expect(px(image, 8, 10)).toEqual([0, 0, 0, 0]); // inside clip, outside image
    expect(px(image, 15, 10)).toEqual([255, 0, 0, 255]); // outside clip: untouched
  });

  it("destination-in clears only inside the clip", () => {
    const { image, ctx } = setup();
    ctx.fillStyle = "#f00";
    ctx.fillRect(0, 0, 20, 20);
    ctx.beginPath();
    ctx.rect(0, 0, 10, 20);
    ctx.clip();
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = "#0f0";
    ctx.fillRect(2, 2, 4, 4);
    expect(px(image, 3, 3)).toEqual([255, 0, 0, 255]); // shape keeps destination
    expect(px(image, 8, 10)).toEqual([0, 0, 0, 0]); // inside clip, outside shape
    expect(px(image, 15, 10)).toEqual([255, 0, 0, 255]); // outside clip: untouched
  });

  it("switching operations between draws matches drawing each on its own canvas", () => {
    // one canvas: copy, then source-over
    const { image: switched, ctx } = setup();
    ctx.globalCompositeOperation = "copy";
    ctx.fillStyle = "#0f0";
    ctx.fillRect(0, 0, 10, 10);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgba(0, 0, 255, 0.5)";
    ctx.fillRect(0, 0, 5, 10);

    // reference canvases: one draw each, no switching
    const { image: copied, ctx: c1 } = setup();
    c1.globalCompositeOperation = "copy";
    c1.fillStyle = "#0f0";
    c1.fillRect(0, 0, 10, 10);

    const { image: overed, ctx: c2 } = setup();
    c2.fillStyle = "#0f0";
    c2.fillRect(0, 0, 10, 10);
    c2.fillStyle = "rgba(0, 0, 255, 0.5)";
    c2.fillRect(0, 0, 5, 10);

    // the earlier copy must not leak into the later source-over draw
    expect(px(switched, 7, 5)).toEqual(px(copied, 7, 5));
    expect(px(switched, 2, 5)).toEqual(px(overed, 2, 5));
  });
});

describe("blend modes", () => {
  const rgba = (r: number, g: number, b: number, a = 255) =>
    ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
  const bytes = (c: number) => [c >>> 24, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff];

  it.each([
    // op, source, destination, expected
    ["multiply", rgba(255, 128, 0), rgba(128, 255, 255), [128, 128, 0, 255]],
    ["screen", rgba(255, 128, 0), rgba(128, 128, 128), [255, 192, 128, 255]],
    ["darken", rgba(200, 50, 100), rgba(100, 150, 100), [100, 50, 100, 255]],
    ["lighten", rgba(200, 50, 100), rgba(100, 150, 100), [200, 150, 100, 255]],
    ["difference", rgba(200, 50, 100), rgba(100, 150, 100), [100, 100, 0, 255]],
    ["exclusion", rgba(255, 0, 255), rgba(255, 255, 0), [0, 255, 255, 255]],
    ["luminosity", rgba(255, 255, 255), rgba(255, 0, 0), [255, 255, 255, 255]],
    ["color", rgba(0, 0, 0), rgba(255, 0, 0), [77, 77, 77, 255]], // black at red's luminance (0.3)
  ])("%s", (op, src, dst, expected) => {
    expect(bytes(compositePixel(op as any, src as number, 1, dst as number))).toEqual(expected);
  });

  it("over a transparent backdrop draws the source unchanged", () => {
    for (const op of ["multiply", "difference", "hue", "color-burn"] as const) {
      expect(compositePixel(op, rgba(10, 200, 30), 1, 0)).toBe(rgba(10, 200, 30));
    }
  });

  it("multiply on canvas", () => {
    const { image, ctx } = setup();
    ctx.fillStyle = "#ff8000";
    ctx.fillRect(0, 0, 20, 20);
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, 20, 20);
    expect(px(image, 10, 10)).toEqual([128, 64, 0, 255]);
  });
});
