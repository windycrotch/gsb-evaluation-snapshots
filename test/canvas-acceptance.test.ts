import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as pureimage from "../src/index";
import { encodePNGToStream, decodePNGFromStream } from "../src/index";

const px = (image: any, x: number, y: number) =>
  Array.from(image.getPixelRGBA_separate(x, y));

function makeImage(w: number, h: number) {
  const image = pureimage.make(w, h);
  const ctx = image.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  return { image, ctx };
}

describe("acceptance: normal drawing and PNG export", () => {
  it("draws shapes and round-trips through a PNG", async () => {
    const { image, ctx } = makeImage(20, 20);
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 20, 20);
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(5, 5, 10, 10);
    expect(px(image, 1, 1)).toEqual([255, 0, 0, 255]);
    expect(px(image, 10, 10)).toEqual([0, 255, 0, 255]);

    const path = "output/acceptance-export.png";
    await fs.promises.mkdir("output", { recursive: true });
    await encodePNGToStream(image, fs.createWriteStream(path));
    const decoded = await decodePNGFromStream(fs.createReadStream(path));
    expect(decoded.width).toBe(20);
    expect(decoded.height).toBe(20);
    expect(px(decoded, 1, 1)).toEqual([255, 0, 0, 255]);
    expect(px(decoded, 10, 10)).toEqual([0, 255, 0, 255]);
  });
});

describe("acceptance: nested save/restore", () => {
  it("restores clip, composite mode, alpha, styles and transform through several levels", () => {
    const { image, ctx } = makeImage(40, 40);
    ctx.fillStyle = "#ff0000";
    ctx.strokeStyle = "#00ff00";
    ctx.globalAlpha = 0.8;
    ctx.globalCompositeOperation = "multiply";
    ctx.translate(4, 8);

    ctx.save(); // level 1
    ctx.fillStyle = "#0000ff";
    ctx.strokeStyle = "#ffffff";
    ctx.globalAlpha = 0.2;
    ctx.globalCompositeOperation = "copy";
    ctx.translate(100, 200);
    ctx.beginPath();
    ctx.rect(0, 0, 10, 10);
    ctx.clip();

    ctx.save(); // level 2
    ctx.fillStyle = "#ffff00";
    ctx.globalAlpha = 0.1;
    ctx.globalCompositeOperation = "destination-out";
    ctx.scale(3, 3);
    ctx.beginPath();
    ctx.rect(0, 0, 5, 5);
    ctx.clip();
    ctx.restore(); // back to level 1 state

    expect(ctx.fillStyle).toBe("#0000ff");
    expect(ctx.strokeStyle).toBe("#ffffff");
    expect(ctx.globalAlpha).toBeCloseTo(0.2);
    expect(ctx.globalCompositeOperation).toBe("copy");
    expect(ctx.getTransform().e).toBe(104);
    expect(ctx.getTransform().f).toBe(208);

    ctx.restore(); // back to the original state
    expect(ctx.fillStyle).toBe("#ff0000");
    expect(ctx.strokeStyle).toBe("#00ff00");
    expect(ctx.globalAlpha).toBeCloseTo(0.8);
    expect(ctx.globalCompositeOperation).toBe("multiply");
    const m = ctx.getTransform();
    expect(m.a).toBe(1);
    expect(m.d).toBe(1);
    expect(m.e).toBe(4);
    expect(m.f).toBe(8);

    // every clip must be gone: a full-canvas fill reaches every pixel
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#0000ff";
    ctx.fillRect(-100, -100, 200, 200);
    expect(px(image, 39, 39)).toEqual([0, 0, 255, 255]);
  });

  it("restore on an empty stack changes nothing, including the transform", () => {
    const { ctx } = makeImage(10, 10);
    ctx.globalAlpha = 0.3;
    ctx.globalCompositeOperation = "multiply";
    ctx.translate(7, 8);
    ctx.restore();
    ctx.restore();
    expect(ctx.globalAlpha).toBeCloseTo(0.3);
    expect(ctx.globalCompositeOperation).toBe("multiply");
    expect(ctx.getTransform().e).toBe(7);
    expect(ctx.getTransform().f).toBe(8);
    // a later save/restore still works after the no-op restores
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.translate(1, 1);
    ctx.restore();
    expect(ctx.globalAlpha).toBeCloseTo(0.3);
    expect(ctx.getTransform().e).toBe(7);
  });

  it("does not restore the current path (the path is not part of the state)", () => {
    const { ctx } = makeImage(10, 10);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.save();
    ctx.lineTo(5, 5);
    ctx.restore();
    expect(ctx.path.length).toBe(2);
  });
});

describe("acceptance: composite modes at the clip boundary", () => {
  it("multiply only changes pixels inside the clip", () => {
    const { image, ctx } = makeImage(20, 20);
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 20, 20);
    ctx.beginPath();
    ctx.rect(0, 0, 10, 20);
    ctx.clip();
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(5, 5, 10, 10); // straddles the x=10 clip edge

    expect(px(image, 7, 7)).toEqual([0, 0, 0, 255]); // red * green inside clip
    expect(px(image, 15, 7)).toEqual([255, 0, 0, 255]); // inside shape, outside clip: untouched
    expect(px(image, 15, 15)).toEqual([255, 0, 0, 255]); // outside both: untouched
  });

  it("an unbounded operator (copy) stays inside the clip", () => {
    const { image, ctx } = makeImage(20, 20);
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 20, 20);
    ctx.beginPath();
    ctx.rect(0, 0, 10, 20);
    ctx.clip();
    ctx.globalCompositeOperation = "copy";
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(5, 5, 10, 10);

    expect(px(image, 7, 7)).toEqual([0, 255, 0, 255]); // inside clip: copied source
    expect(px(image, 8, 15)).toEqual([0, 0, 0, 0]); // inside clip, outside shape: cleared
    expect(px(image, 15, 7)).toEqual([255, 0, 0, 255]); // outside clip: untouched
  });

  it("overlapping parts of one shape composite once, with no seam", () => {
    const { image, ctx } = makeImage(20, 20);
    ctx.globalCompositeOperation = "xor";
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = "#00ff00";
    ctx.beginPath();
    ctx.rect(0, 0, 12, 20);
    ctx.rect(8, 0, 12, 20);
    ctx.fill();
    // the overlap is one source shape (source alpha 0.5), not two stacked writes
    expect(px(image, 4, 10)).toEqual([0, 255, 0, 128]);
    expect(px(image, 10, 10)).toEqual([0, 255, 0, 128]);
    expect(px(image, 16, 10)).toEqual([0, 255, 0, 128]);
  });
});

describe("acceptance: resize resets the context", () => {
  it("returns the context to its initial state, including clip, blend mode, path and transform", () => {
    const image = pureimage.make(20, 20);
    const ctx = image.getContext("2d");
    ctx.fillStyle = "#ff0000";
    ctx.strokeStyle = "#00ff00";
    ctx.globalAlpha = 0.4;
    ctx.globalCompositeOperation = "multiply";
    ctx.translate(9, 9);
    ctx.beginPath();
    ctx.rect(0, 0, 5, 5);
    ctx.clip();
    ctx.save();

    image.width = 30;

    expect(image.width).toBe(30);
    expect(image.height).toBe(20);
    expect(image.data.length).toBe(30 * 20 * 4);
    expect(px(image, 0, 0)).toEqual([0, 0, 0, 0]); // cleared to transparent black
    expect(ctx.fillStyle).toBe("#000000");
    expect(ctx.strokeStyle).toBe("#000000");
    expect(ctx.globalAlpha).toBe(1);
    expect(ctx.globalCompositeOperation).toBe("source-over");
    expect(ctx.getTransform().isIdentity).toBe(true);
    expect(ctx.path.length).toBe(0);

    // the saved-state stack was cleared: restore must not resurrect old state
    ctx.restore();
    expect(ctx.globalCompositeOperation).toBe("source-over");

    // the clip is gone: a full fill covers the new area
    ctx.fillStyle = "#0000ff";
    ctx.fillRect(0, 0, 30, 20);
    expect(px(image, 25, 15)).toEqual([0, 0, 255, 255]);
  });

  it.each([-1, NaN, Infinity, -Infinity, -0.5])("rolls back invalid size %s", (bad) => {
    const image = pureimage.make(20, 20);
    const ctx = image.getContext("2d");
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 20, 20); // red backdrop everywhere first
    ctx.globalCompositeOperation = "multiply";
    ctx.translate(3, 4);
    ctx.beginPath();
    ctx.rect(0, 0, 8, 8);
    ctx.clip();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(-3, -4, 20, 20); // white keeps red under multiply, limited to the clip
    const pixelsBefore = image.data.slice();

    expect(() => {
      image.width = bad as number;
    }).toThrow(TypeError);
    expect(() => {
      image.height = bad as number;
    }).toThrow(TypeError);

    // dimensions, pixel buffer and its contents are untouched
    expect(image.width).toBe(20);
    expect(image.height).toBe(20);
    expect(image.data.length).toBe(20 * 20 * 4);
    expect(Array.from(image.data)).toEqual(Array.from(pixelsBefore));
    expect(px(image, 5, 5)).toEqual([255, 0, 0, 255]);

    // context state is untouched too: blend mode, transform, clip all survive
    expect(ctx.globalCompositeOperation).toBe("multiply");
    const m = ctx.getTransform();
    expect(m.e).toBe(3);
    expect(m.f).toBe(4);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#0000ff";
    ctx.fillRect(-3, -4, 20, 20);
    expect(px(image, 5, 5)).toEqual([0, 0, 255, 255]); // inside the surviving clip: replaced
    expect(px(image, 15, 15)).toEqual([255, 0, 0, 255]); // outside the surviving clip: untouched red
  });
});

describe("acceptance: repeated drawing on the same canvas does not cross-contaminate state", () => {
  it("interleaved drawings on separate canvases keep their own clip and composite mode", () => {
    const a = makeImage(20, 20);
    const b = makeImage(20, 20);

    a.ctx.fillStyle = "#ff0000";
    a.ctx.fillRect(0, 0, 20, 20);
    b.ctx.fillStyle = "#00ff00";
    b.ctx.fillRect(0, 0, 20, 20);

    a.ctx.beginPath();
    a.ctx.rect(0, 0, 10, 20);
    a.ctx.clip();
    a.ctx.globalCompositeOperation = "multiply";

    // canvas B never saw A's clip or blend mode
    b.ctx.fillStyle = "#0000ff";
    b.ctx.fillRect(0, 0, 20, 20);
    expect(px(b.image, 15, 15)).toEqual([0, 0, 255, 255]);
    expect(b.ctx.globalCompositeOperation).toBe("source-over");

    // canvas A's blend mode still applies, and still respects its clip
    a.ctx.fillStyle = "#ffffff";
    a.ctx.fillRect(0, 0, 20, 20);
    expect(px(a.image, 5, 5)).toEqual([255, 0, 0, 255]); // red * white = red, inside clip
    expect(px(a.image, 15, 15)).toEqual([255, 0, 0, 255]); // outside clip untouched
  });

  it("each drawing operation starts from the context's configured state, with no layer leakage", () => {
    const { image, ctx } = makeImage(20, 20);
    // a non-source-over draw with a clip must not leave a temporary layer behind,
    // so subsequent plain draws behave normally everywhere the clip allows
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 20, 20);
    ctx.beginPath();
    ctx.rect(0, 0, 10, 20);
    ctx.clip();
    ctx.globalCompositeOperation = "copy";
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(2, 2, 6, 6);

    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#0000ff";
    ctx.fillRect(5, 12, 4, 4); // inside the clip
    expect(px(image, 7, 14)).toEqual([0, 0, 255, 255]);
    expect(px(image, 5, 5)).toEqual([0, 255, 0, 255]);
    expect(px(image, 15, 5)).toEqual([255, 0, 0, 255]); // outside the clip, never touched
  });

  it("many sequential fill/stroke/text operations produce stable pixels when repeated", () => {
    const draw = () => {
      const { image, ctx } = makeImage(30, 30);
      for (let i = 0; i < 8; i++) {
        ctx.save();
        ctx.globalCompositeOperation = i % 2 ? "multiply" : "source-over";
        ctx.globalAlpha = 0.5 + i * 0.05;
        ctx.beginPath();
        ctx.rect(i, i, 10, 10);
        ctx.clip();
        ctx.fillStyle = `rgb(${i * 20}, 100, 200)`;
        ctx.fillRect(0, 0, 30, 30);
        ctx.lineWidth = 1 + (i % 3);
        ctx.beginPath();
        ctx.moveTo(0, i);
        ctx.lineTo(30, i);
        ctx.stroke();
        ctx.restore();
      }
      return image.data.slice();
    };
    const first = draw();
    for (let run = 0; run < 5; run++) {
      expect(Array.from(draw())).toEqual(Array.from(first));
    }
  });
});
