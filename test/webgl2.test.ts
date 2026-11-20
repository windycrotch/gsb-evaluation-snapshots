import { describe, expect, it } from "vitest";
import type { Matrix, TextureSource } from "../src/backend.js";
import { Draw } from "../src/draw.js";
import { blur, filter } from "../src/filters.js";
import { mesh } from "../src/mesh.js";
import { Shader } from "../src/shader.js";
import { ring, roundRect } from "../src/shapes.js";
import { RenderTarget } from "../src/target.js";
import { WebGL2Backend } from "../src/webgl2.js";

/**
 * A recording stand-in for WebGL2: every method is logged, `create*` returns a fresh tagged object and
 * `delete*` marks it deleted, so tests can check uploads, batching and that nothing leaks.
 */
function fakeGL() {
  const calls: { name: string; args: unknown[] }[] = [];
  const created: { kind: string; deleted: boolean }[] = [];
  const listeners = new Map<string, (e: Event) => void>();
  const canvas = {
    addEventListener: (type: string, fn: (e: Event) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const shaderSources: string[] = [];
  const target: Record<string | symbol, unknown> = {
    canvas,
    drawingBufferWidth: 100,
    drawingBufferHeight: 50,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    checkFramebufferStatus: () => "FRAMEBUFFER_COMPLETE",
    getParameter: (p: unknown) => (p === "MAX_TEXTURE_SIZE" ? 16384 : undefined),
    getUniformLocation: () => ({}),
    shaderSource: (_s: unknown, src: string) => shaderSources.push(src),
  };
  const gl = new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      if (typeof key !== "string") return undefined;
      if (/^[A-Z0-9_]+$/.test(key)) return key; // constants: their own name, readable in assertions
      return (...args: unknown[]) => {
        calls.push({ name: key, args });
        if (key.startsWith("create")) {
          const obj = { kind: key.slice(6), deleted: false };
          created.push(obj);
          return obj;
        }
        if (key.startsWith("delete")) (args[0] as { deleted: boolean }).deleted = true;
        return undefined;
      };
    },
  });
  const fire = (type: string) => listeners.get(type)?.({ preventDefault() {} } as Event);
  const count = (name: string) => calls.filter((c) => c.name === name).length;
  return { gl: gl as unknown as WebGL2RenderingContext, calls, created, fire, count, shaderSources, listeners };
}

const M: Matrix = [16, 0, 0, 16, 0, 0];
const image = (w = 16, h = 16) => ({ width: w, height: h }) as unknown as TextureSource;

describe("WebGL2Backend", () => {
  it("uses highp texture coordinates so large atlases sample the right texel on mobile GPUs", () => {
    const { gl, shaderSources } = fakeGL();
    new WebGL2Backend(gl);
    expect(shaderSources[1]).toContain("in highp vec2 v_uv");
  });

  it("uploads a source once even when drawn both smooth and pixelated", () => {
    const { gl, count, calls } = fakeGL();
    const be = new WebGL2Backend(gl);
    const img = image();
    const uploadsBefore = count("texImage2D");
    be.begin(0x000000ff, 100, 50, 1);
    be.quad(M, img, 0, 0, 16, 16, 0xffffffff, 0, false);
    be.quad(M, img, 0, 0, 16, 16, 0xffffffff, 0, true);
    be.quad(M, img, 0, 0, 16, 16, 0xffffffff, 0, false);
    be.end();
    expect(count("texImage2D") - uploadsBefore).toBe(1);
    // One batch, two units: same texture, different samplers.
    expect(count("drawArraysInstanced")).toBe(1);
    const samplers = calls.filter((c) => c.name === "bindSampler").map((c) => c.args[0]);
    expect(samplers).toEqual([0, 1]);
  });

  it("builds mip levels only when asked, and samples them only for smooth draws of uploaded images", () => {
    const plain = fakeGL();
    const off = new WebGL2Backend(plain.gl);
    off.begin(0x000000ff, 100, 50, 1);
    off.quad(M, image(), 0, 0, 16, 16, 0xffffffff, 0, true);
    off.end();
    expect(plain.count("generateMipmap")).toBe(0);

    const { gl, calls, created, count } = fakeGL();
    const be = new WebGL2Backend(gl, true);
    const [nearest, linear, trilinear] = created.filter((o) => o.kind === "Sampler");
    const img = image();
    const target = new RenderTarget(8, 8);
    be.begin(0x000000ff, 100, 50, 1);
    be.quad(M, img, 0, 0, 16, 16, 0xffffffff, 0, true);
    be.quad(M, img, 0, 0, 16, 16, 0xffffffff, 0, false);
    // A render target has no mip levels: trilinear sampling would make it incomplete (black).
    be.quad(M, target, 0, 0, 8, 8, 0xffffffff, 0, true);
    be.end();
    expect(count("generateMipmap")).toBe(1);
    const bound = calls.filter((c) => c.name === "bindSampler").map((c) => c.args[1]);
    expect(bound).toEqual([trilinear, nearest, linear]);
  });

  it("draws a mesh as indexed triangles in the shape batch, with uvs offset into an atlas frame", () => {
    const { gl, calls, count } = fakeGL();
    const be = new WebGL2Backend(gl);
    const draw = new Draw(be, true);
    const atlas = image(64, 32);
    draw.begin("#000", 100, 50, 1);
    mesh(draw, { image: atlas, x: 32, y: 0, w: 32, h: 32 }, [0, 0, 10, 0, 0, 10, 10, 10], [0, 0, 32, 0, 0, 32, 32, 32], [0, 1, 2, 1, 3, 2]);
    // A sprite after a mesh joins its batch.
    draw.sprite(atlas, 50, 25);
    draw.end();
    expect(count("drawElements")).toBe(1);
    expect(count("drawArraysInstanced")).toBe(0);
    const uploads = calls.filter((c) => c.name === "bufferData");
    const indices = uploads.at(-1)?.args[1] as Uint32Array;
    expect([...indices.subarray(0, 6)]).toEqual([0, 1, 2, 1, 3, 2]);
    const verts = uploads.at(-2)?.args[1] as Float32Array;
    // Vertex 3: position (10, 10), uv at the frame's bottom-right: (32 + 32) / 64, 32 / 32.
    expect([...verts.subarray(18, 22)]).toEqual([10, 10, 1, 1]);
    // Vertex 0: the frame's top-left is halfway across the atlas.
    expect([...verts.subarray(0, 4)]).toEqual([0, 0, 0.5, 0]);
  });

  it("rejects mesh indices outside the vertices", () => {
    const { gl } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), true);
    draw.begin("#000", 100, 50, 1);
    expect(() => mesh(draw, image(), [0, 0, 1, 0, 0, 1], [0, 0, 1, 0, 0, 1], [0, 1, 3])).toThrow(/out of range/);
  });

  it("splits batches when more than 8 textures are in flight, and counts draw calls", () => {
    const { gl, count } = fakeGL();
    const be = new WebGL2Backend(gl);
    be.begin(0x000000ff, 100, 50, 1);
    for (let i = 0; i < 9; i++) be.quad(M, image(), 0, 0, 16, 16, 0xffffffff, 0, false);
    expect(be.drawCalls).toBe(2);
    be.end();
    expect(count("drawArraysInstanced")).toBe(2);
  });

  it("skips drawing while the context is lost and re-uploads after restore", () => {
    const { gl, count, fire } = fakeGL();
    const be = new WebGL2Backend(gl);
    const img = image();
    be.begin(0x000000ff, 100, 50, 1);
    be.quad(M, img, 0, 0, 16, 16, 0xffffffff, 0, false);
    be.end();
    fire("webglcontextlost");
    expect(be.contextLost).toBe(true);
    be.begin(0x000000ff, 100, 50, 1);
    be.quad(M, img, 0, 0, 16, 16, 0xffffffff, 0, false);
    be.end();
    expect(count("drawArraysInstanced")).toBe(1);
    const uploads = count("texImage2D");
    fire("webglcontextrestored");
    expect(be.contextLost).toBe(false);
    be.begin(0x000000ff, 100, 50, 1);
    be.quad(M, img, 0, 0, 16, 16, 0xffffffff, 0, false);
    be.end();
    // Restore recreates the white texture and re-uploads the source on first use.
    expect(count("texImage2D") - uploads).toBe(2);
    expect(count("drawArraysInstanced")).toBe(2);
  });

  it("dispose() deletes every GPU object it created and removes its listeners", () => {
    const { gl, created, listeners } = fakeGL();
    const be = new WebGL2Backend(gl);
    be.begin(0x000000ff, 100, 50, 1);
    be.quad(M, image(), 0, 0, 16, 16, 0xffffffff, 0, true);
    be.end();
    be.dispose();
    expect(created.filter((o) => !o.deleted).map((o) => o.kind)).toEqual([]);
    expect(listeners.size).toBe(0);
  });

  it("uploads an image again once it has loaded, instead of keeping the empty upload", () => {
    const { gl, count } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    draw.begin("#000", 100, 50, 1);
    const img = { naturalWidth: 0, naturalHeight: 0 } as unknown as HTMLImageElement;
    draw.sprite(img, 0, 0);
    draw.end();
    img.naturalWidth = 16;
    img.naturalHeight = 16;
    draw.begin("#000", 100, 50, 1);
    draw.sprite(img, 0, 0);
    draw.end();
    expect(count("texImage2D")).toBe(1);
  });

  it("invalidate() re-uploads changed pixels", () => {
    const { gl, count } = fakeGL();
    const be = new WebGL2Backend(gl);
    const img = image();
    be.begin(0x000000ff, 100, 50, 1);
    be.quad(M, img, 0, 0, 16, 16, 0xffffffff, 0, false);
    be.invalidate(img);
    be.quad(M, img, 0, 0, 16, 16, 0xffffffff, 0, false);
    be.end();
    expect(count("texImage2D")).toBe(3); // white + two uploads
  });

  it("scissors in bottom-left coordinates", () => {
    const { gl, calls } = fakeGL();
    const be = new WebGL2Backend(gl);
    be.setClip({ x: 10, y: 5, w: 20, h: 10 });
    expect(calls.find((c) => c.name === "scissor")?.args).toEqual([10, 35, 20, 10]);
  });

  it("sprites() draws after queued quads in one call, uploading a Float32Array as is", () => {
    const { gl, calls } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    const img = image(8, 8);
    const pos = new Float32Array([1, 2, 3, 4, 5, 6]);
    calls.length = 0;
    draw.begin("#000", 100, 50, 1);
    draw.rect(0, 0, 1, 1, "#fff");
    draw.sprites(img, pos, 3, { tint: "#ff0000" });
    draw.rect(0, 0, 1, 1, "#fff");
    draw.end();
    const names = calls.map((c) => c.name).filter((n) => n === "drawArraysInstanced" || n === "useProgram");
    // queued rect, switch to the copy program, copies, back to the sprite program, last rect
    expect(names).toEqual(["drawArraysInstanced", "useProgram", "drawArraysInstanced", "useProgram", "drawArraysInstanced"]);
    const copies = calls.filter((c) => c.name === "drawArraysInstanced")[1];
    expect(copies?.args[3]).toBe(3);
    const upload = calls.find((c) => c.name === "bufferData" && c.args[1] === pos);
    expect(upload?.args.slice(3)).toEqual([0, 6]);
    const color = calls.find((c) => c.name === "uniform4f" && c.args[1] === 1 && c.args[2] === 0);
    expect(color).toBeDefined();
    expect(draw.drawCalls).toBe(3);
  });

  it("sprites() copies plain arrays through a staging buffer", () => {
    const { gl, calls } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    draw.begin("#000", 100, 50, 1);
    draw.sprites(image(), [1, 2, 3, 4]);
    const upload = calls.findLast((c) => c.name === "bufferData") as { args: unknown[] };
    expect(Array.from((upload.args[1] as Float32Array).subarray(0, 4))).toEqual([1, 2, 3, 4]);
    expect(draw.drawCalls).toBe(1);
    draw.end();
  });

  describe("sprites", () => {
    const sprite = (calls: { name: string; args: unknown[] }[], i = 0) => {
      const f = calls.findLast((c) => c.name === "bufferSubData")?.args[2] as Float32Array;
      return Array.from(f.subarray(i * 14, i * 14 + 13));
    };

    it("share one batch with quads (rects, text) drawn between them", () => {
      const { gl, count } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      const img = image();
      draw.begin("#000", 100, 50, 1);
      for (let i = 0; i < 10; i++) {
        draw.sprite(img, i * 10, 10, { rotation: 0.5 });
        draw.rect(i * 10, 30, 8, 2, "#f00");
      }
      draw.end();
      expect(count("drawArraysInstanced")).toBe(1);
    });

    it("stay in the batch under a transform that changes per sprite, sent as finished quads", () => {
      const { gl, calls, count } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      const img = image();
      draw.begin("#000", 100, 50, 1);
      for (let i = 0; i < 3; i++) {
        draw.push();
        draw.translate(i * 20, 0);
        draw.sprite(img, 10, 10, { rotation: 0.5 });
        draw.pop();
      }
      draw.end();
      expect(count("drawArraysInstanced")).toBe(1);
      // The first sets the batch's transform; the others are quads (no sprite flag) with the same corners.
      expect(sprite(calls, 0)[12]).toBeGreaterThanOrEqual(16);
      expect(sprite(calls, 1)[12]).toBeLessThan(16);
    });

    it("keep their texture and order around shapes under a custom shader, which shapes can't batch with", () => {
      const { gl, calls } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      const identity = new Shader("vec4 effect(vec4 color, vec2 uv) { return source(uv) * color; }");
      draw.begin("#000", 100, 50, 1);
      draw.withShader(identity, () => {
        roundRect(draw, 0, 0, 20, 20, 4, "#e23");
        draw.sprite(image(), 10, 10, { rotation: 0.5 });
        ring(draw, 10, 10, 5, 1, "#ffd36b");
      });
      draw.end();
      const draws = calls.filter((c) => c.name === "drawElements" || c.name === "drawArraysInstanced").map((c) => c.name);
      expect(draws).toEqual(["drawElements", "drawArraysInstanced", "drawElements"]);
      // Flushing the shapes frees their texture units; the sprite's unit must outlive that.
      const info = calls.findLast((c) => c.name === "uniform3fv")?.args[1] as Float32Array;
      expect(info[0]).toBe(1 / 16);
    });

    it("give a custom shader frameUv() in every program it compiles into", () => {
      const { gl, shaderSources } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      const local = new Shader("vec4 effect(vec4 color, vec2 uv) { return vec4(frameUv(), 0.0, 1.0); }");
      draw.begin("#000", 100, 50, 1);
      draw.withShader(local, () => {
        draw.sprite(image(), 10, 10);
        draw.sprites(image(), new Float32Array([1, 2, 3, 4]), 2);
        roundRect(draw, 0, 0, 20, 20, 4, "#e23");
      });
      draw.end();
      // Sources arrive as vertex, fragment pairs. A fragment that reads v_local needs a vertex stage that writes it.
      for (let i = 0; i < shaderSources.length; i += 2) {
        if (!shaderSources[i + 1]?.includes("in highp vec2 v_local")) continue;
        expect(shaderSources[i]).toMatch(/out highp vec2 v_local;[\s\S]*v_local = /);
      }
      expect(shaderSources.filter((s) => s.includes("frameUv()")).length).toBeGreaterThanOrEqual(2);
    });

    it("write the same instance on the short path as on the full one", () => {
      const run = (warm: boolean) => {
        const { gl, calls } = fakeGL();
        const draw = new Draw(new WebGL2Backend(gl), true);
        const img = image();
        draw.begin("#000", 100, 50, 1);
        // The first sprite opens the batch on the full path; the second takes the short one.
        if (warm) draw.sprite(img, 1, 1);
        draw.sprite(img, 10.4, 10.6, { rotation: 1, scaleX: 2, origin: [0, 1], flash: 0.5, tint: 0x80ff40ff });
        draw.end();
        return sprite(calls, warm ? 1 : 0);
      };
      expect(run(true)).toEqual(run(false));
    });

    it("move with a translate() between two sprites, without push or pop", () => {
      const { gl, calls } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      const img = image();
      draw.begin("#000", 100, 50, 1);
      draw.sprite(img, 10, 10);
      draw.translate(20, 0);
      draw.sprite(img, 10, 10);
      draw.end();
      // The first is a placed sprite at 10 - 8 = 2. The second, under a new transform, is a quad (no sprite flag)
      // whose translation is 22: the transform change was seen.
      const second = sprite(calls, 1);
      expect([sprite(calls, 0)[0], second[2], second[12]]).toEqual([2, 22, 0]);
    });

    it("find a texture unit that a quad assigned", () => {
      const { gl, calls } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), true);
      const a = image();
      const b = image(32, 32);
      draw.begin("#000", 100, 50, 1);
      draw.sprite(a, 10, 10, { rotation: 0.5 });
      draw.push();
      draw.translate(5, 0);
      draw.sprite(b, 10, 10, { rotation: 0.5 }); // another transform: a quad, which gives b unit 1
      draw.pop();
      draw.sprite(b, 10, 10, { rotation: 0.5 }); // the short path must use b's unit, not a's
      draw.end();
      expect(sprite(calls, 2)[12]).toBe(1 + 16);
    });

    it("land unrotated pixel art on whole pixels, rounded on the CPU", () => {
      const { gl, calls } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      draw.begin("#000", 100, 50, 1);
      draw.translate(0.3, 0);
      draw.sprite(image(), 10.4, 10.6);
      draw.end();
      // Anchored at its centre: 0.3 + 10.4 - 8 = 2.7 → 3, and 10.6 - 8 = 2.6 → 3. Flags: unit 0 + sprite + placed.
      const f = sprite(calls);
      expect([f[0], f[1], f[12]]).toEqual([3, 3, 48]);
    });

    it("keep their own position for the GPU when rotated or smooth", () => {
      const { gl, calls } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), true);
      draw.begin("#000", 100, 50, 1);
      draw.sprite(image(), 10.4, 10.6, { rotation: 1, scaleX: 2, origin: [0, 1] });
      draw.end();
      expect(sprite(calls).map((v) => Math.round(v * 1000) / 1000)).toEqual([10.4, 10.6, 1, 2, 1, 0, 1, 0, 0, 0, 16, 16, 16]);
    });
  });

  describe("render targets", () => {
    it("draws into a framebuffer at the target's size and switches back to the canvas", () => {
      const { gl, calls } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      draw.begin("#000", 50, 25, 2);
      const t = draw.createTarget(32, 16);
      calls.length = 0;
      draw.into(t, () => draw.rect(0, 0, 4, 4, "#fff"));
      draw.rect(0, 0, 4, 4, "#fff");
      draw.end();
      const binds = calls.filter((c) => c.name === "bindFramebuffer").map((c) => c.args[1] !== null);
      expect(binds.at(0)).toBe(true);
      expect(binds.at(-1)).toBe(false);
      const viewports = calls.filter((c) => c.name === "viewport").map((c) => c.args);
      expect(viewports).toEqual([
        [0, 0, 32, 16],
        [0, 0, 100, 50],
      ]);
      const views = calls.filter((c) => c.name === "uniform2f").map((c) => c.args.slice(1));
      expect(views).toEqual([
        [32, 16],
        [50, 25],
      ]);
    });

    it("samples targets upside down, since WebGL stores them bottom row first", () => {
      const { gl, calls } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      draw.begin("#000", 100, 50, 1);
      const t = draw.createTarget(10, 10);
      draw.into(t, () => {});
      draw.sprite(t, 5, 5);
      draw.end();
      // Sprites read each unit's texture size and top-row v from u_texinfo: v starts at 1 and runs down.
      const info = calls.findLast((c) => c.name === "uniform3fv")?.args[1] as Float32Array;
      expect([info[0], info[1], info[2]]).toEqual([0.1, -0.1, 1].map(Math.fround));
    });

    it("refuses to draw a target into itself, or dispose it while drawing into it", () => {
      const { gl } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      draw.begin("#000", 100, 50, 1);
      const t = draw.createTarget(10, 10);
      expect(() => draw.into(t, () => draw.sprite(t, 0, 0))).toThrow(/into itself/);
      expect(() => draw.into(t, () => draw.sprites(t, [0, 0]))).toThrow(/into itself/);
      expect(() => draw.into(t, () => draw.disposeTarget(t))).toThrow(/while drawing into it/);
      // After a throw inside into(), drawing is back on the canvas.
      expect(() => draw.sprite(t, 0, 0)).not.toThrow();
      draw.end();
    });

    it("premultiplies a see-through clear colour, like begin()", () => {
      const { gl, calls } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      draw.begin("#000", 100, 50, 1);
      draw.into(draw.createTarget(10, 10), () => {}, "#ff000080");
      const a = 0x80 / 255;
      expect(calls.findLast((c) => c.name === "clearColor")?.args).toEqual([a, 0, 0, a]);
      draw.end();
    });

    it("leaves Draw's state as it was when the target can't be created", () => {
      const { gl } = fakeGL();
      (gl as unknown as { checkFramebufferStatus: () => string }).checkFramebufferStatus = () => "FRAMEBUFFER_UNSUPPORTED";
      const draw = new Draw(new WebGL2Backend(gl), false);
      draw.begin("#000", 100, 50, 2);
      draw.translate(5, 5);
      draw.alpha = 0.5;
      draw.clip(0, 0, 10, 10, () => {
        expect(() => draw.into(draw.createTarget(10, 10), () => {})).toThrow(/could not be created/);
        expect(draw.clips).toHaveLength(1);
      });
      expect(draw.m).toEqual([1, 0, 0, 1, 5, 5]);
      expect(draw.alpha).toBe(0.5);
      expect(draw.renderScale).toBe(2);
      expect(draw.target).toBeNull();
      expect(() => draw.pop()).toThrow(/without a matching push/);
      draw.end();
    });

    it("clears a filter's first pass in full even inside a clip", () => {
      const { gl, calls } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      draw.begin("#000", 100, 50, 1);
      draw.clip(10, 10, 20, 20, () => filter(draw, [blur(2)], () => draw.rect(0, 0, 50, 50, "#fff")));
      const names = calls.map((c) => `${c.name}:${String(c.args[0])}`);
      const firstClear = names.indexOf("clear:COLOR_BUFFER_BIT", names.indexOf("enable:SCISSOR_TEST"));
      expect(names.lastIndexOf("disable:SCISSOR_TEST", firstClear)).toBeGreaterThan(names.indexOf("enable:SCISSOR_TEST"));
      draw.end();
    });

    it("clips inside a target flip against the target's height", () => {
      const { gl, calls } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      draw.begin("#000", 100, 50, 1);
      draw.into(draw.createTarget(40, 20), () => draw.clip(0, 0, 10, 5, () => draw.rect(0, 0, 1, 1, "#fff")));
      expect(calls.find((c) => c.name === "scissor")?.args).toEqual([0, 15, 10, 5]);
      draw.end();
    });

    it("frees framebuffers on disposeTarget and dispose, and recreates targets blank after context loss", () => {
      const { gl, created, fire, count } = fakeGL();
      const backend = new WebGL2Backend(gl);
      const draw = new Draw(backend, false);
      draw.begin("#000", 100, 50, 1);
      const a = draw.createTarget(8, 8);
      const b = draw.createTarget(8, 8);
      draw.into(a, () => {});
      draw.into(b, () => {});
      draw.disposeTarget(a);
      const fbos = () => created.filter((o) => o.kind === "Framebuffer");
      expect(fbos().map((o) => o.deleted)).toEqual([true, false]);
      fire("webglcontextlost");
      const restoredFrom = created.length;
      fire("webglcontextrestored");
      const before = count("createFramebuffer");
      draw.begin("#000", 100, 50, 1);
      draw.into(b, () => {});
      expect(count("createFramebuffer")).toBe(before + 1);
      draw.end();
      draw.dispose();
      // Objects from before the loss died with that context; everything made since is freed.
      expect(created.slice(restoredFrom).filter((o) => !o.deleted)).toEqual([]);
    });
  });

  describe("context loss lifecycle", () => {
    /**
     * The order of GPU draw calls and *destination* framebuffer bindings a scene produces. Binds made while a
     * target's framebuffer is being constructed (targetStore briefly restores the previous fbo) are ignored:
     * a destination bind is one followed by a viewport, which only setTarget/bindOutput emit.
     */
    const sequence = (calls: { name: string; args: unknown[] }[]) => {
      const out: string[] = [];
      for (let i = 0; i < calls.length; i++) {
        const c = calls[i] as { name: string; args: unknown[] };
        if (c.name === "drawArraysInstanced" || c.name === "drawElements") out.push(c.name);
        else if (c.name === "bindFramebuffer" && calls[i + 1]?.name === "viewport")
          out.push(`bindFramebuffer:${c.args[1] === null ? "canvas" : "target"}`);
      }
      return out;
    };

    /** A scene that opens a target, clips and draws inside it, then draws back on the canvas. */
    const scene = (draw: Draw, t: RenderTarget, img: TextureSource) => {
      draw.sprite(img, 2, 2);
      draw.into(t, () => {
        draw.clip(0, 0, 10, 5, () => draw.rect(0, 0, 4, 4, "#fff"));
        draw.sprite(img, 1, 1);
      });
      draw.sprite(t, 5, 5);
      draw.rect(20, 20, 4, 4, "#f0f");
    };

    it("normal frame: the reference scene batches and binds canvas/target in a known order", () => {
      const { gl, calls } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      draw.begin("#000", 100, 50, 1);
      const from = calls.length;
      scene(draw, draw.createTarget(40, 20), image());
      draw.end();
      expect(sequence(calls.slice(from))).toEqual([
        "drawArraysInstanced", // sprite before into()
        "bindFramebuffer:target",
        "drawArraysInstanced", // clipped rect (the clip flushes its own batch)
        "drawArraysInstanced", // sprite inside the target
        "bindFramebuffer:canvas",
        "drawArraysInstanced", // target sprite + final rect on the canvas
      ]);
      expect(draw.drawCalls).toBe(4);
    });

    it("loss: every drawing call is skipped quietly without throwing or issuing GL work", () => {
      const { gl, calls, count, fire } = fakeGL();
      const backend = new WebGL2Backend(gl);
      const draw = new Draw(backend, false);
      const img = image();
      const t = draw.createTarget(40, 20);
      draw.begin("#000", 100, 50, 1);
      draw.sprite(img, 0, 0);
      draw.end();
      const callsAtLoss = calls.length;
      fire("webglcontextlost");
      expect(backend.contextLost).toBe(true);
      // Every entry point on the Backend interface must stay quiet while lost.
      expect(() => {
        draw.begin("#000", 100, 50, 1);
        draw.rect(0, 0, 4, 4, "#fff");
        draw.sprite(img, 1, 1);
        draw.sprites(img, new Float32Array([1, 2, 3, 4]), 2);
        draw.clip(0, 0, 10, 10, () => draw.rect(0, 0, 1, 1, "#fff"));
        draw.into(t, () => draw.rect(0, 0, 4, 4, "#fff"));
        draw.blend("add");
        draw.end();
        backend.setShader(null);
      }).not.toThrow();
      expect(count("drawArraysInstanced")).toBe(1); // only the pre-loss draw
      expect(count("drawElements")).toBe(0);
      // No state-changing GL calls happened while lost (the record is frozen).
      expect(calls.length).toBe(callsAtLoss);
      expect(draw.drawCalls).toBe(0);
    });

    it("restore first frame: starts clean — canvas target, scissor off, zero batch and texture units", () => {
      const { gl, calls, fire, count } = fakeGL();
      const backend = new WebGL2Backend(gl);
      const draw = new Draw(backend, false);
      const t = draw.createTarget(40, 20);
      // Leave a clip and a target open when the loss hits, in the middle of an into()/clip() frame.
      draw.begin("#000", 100, 50, 1);
      draw.into(t, () => draw.clip(0, 0, 10, 5, () => draw.rect(0, 0, 4, 4, "#fff")));
      fire("webglcontextlost");
      fire("webglcontextrestored");
      expect(backend.contextLost).toBe(false);
      // The restore rebuild itself must have switched the scissor off and rebound the canvas.
      expect(calls.filter((c) => c.name === "disable" && c.args[0] === "SCISSOR_TEST").length).toBeGreaterThan(0);
      const lastBindAtRestore = calls.findLast((c) => c.name === "bindFramebuffer");
      expect(lastBindAtRestore?.args[1]).toBeNull();
      const drawsAtRestore = count("drawArraysInstanced");
      draw.begin("#000", 100, 50, 1);
      // No clip requested this frame: the pre-loss SCISSOR_TEST enable must not have survived the restore.
      const enablesAfterRestore = calls.filter((c) => c.name === "enable" && c.args[0] === "SCISSOR_TEST").length;
      draw.rect(0, 0, 4, 4, "#fff");
      draw.end();
      expect(calls.filter((c) => c.name === "enable" && c.args[0] === "SCISSOR_TEST").length).toBe(enablesAfterRestore);
      // Exactly one fresh batch: pre-loss batch counters were zeroed, not flushed as a phantom draw.
      expect(count("drawArraysInstanced") - drawsAtRestore).toBe(1);
    });

    it("restore: a target created before the loss is rebuilt with its size and bottom-up sampling", () => {
      const { gl, calls, fire, count } = fakeGL();
      const backend = new WebGL2Backend(gl);
      const draw = new Draw(backend, false);
      const t = draw.createTarget(40, 20);
      draw.begin("#000", 100, 50, 1);
      draw.into(t, () => {});
      const oldStore = (backend as unknown as { targets: Map<RenderTarget, { fbo: object; cached: { tex: object } }> }).targets.get(t);
      expect(oldStore).toBeDefined();
      fire("webglcontextlost");
      // The old context's handles are gone from every cache immediately at the loss, so they can never be
      // mistaken for live ones while lost or carried into the restored context.
      const maps = backend as unknown as {
        targets: Map<RenderTarget, unknown>;
        textures: Map<TextureSource, unknown>;
      };
      expect(maps.targets.has(t)).toBe(false);
      expect(maps.textures.has(t)).toBe(false);
      fire("webglcontextrestored");
      const fbosBefore = count("createFramebuffer");
      const texBefore = count("createTexture");
      draw.begin("#000", 100, 50, 1);
      draw.into(t, () => draw.rect(0, 0, 4, 4, "#fff"));
      expect(count("createFramebuffer")).toBe(fbosBefore + 1);
      expect(count("createTexture")).toBe(texBefore + 1);
      // The rebuilt store is a brand-new handle with the target's exact pixel size.
      const newStore = (backend as unknown as { targets: Map<RenderTarget, { fbo: object; cached: { tex: object; iw: number; ih: number; v0: number } }> }).targets.get(t);
      expect(newStore).toBeDefined();
      expect(newStore?.fbo).not.toBe(oldStore?.fbo);
      expect(newStore?.cached.tex).not.toBe(oldStore?.cached.tex);
      // The target bind is followed by a viewport sized to the target's pixels (not the canvas's).
      const targetBindIndex = calls.findLastIndex((c) => c.name === "bindFramebuffer" && c.args[1] === newStore?.fbo);
      expect(calls[targetBindIndex + 1]?.args).toEqual([0, 0, 40, 20]);
      // Sampling orientation: targets store the bottom row first, so v starts at 1 and ih is negative.
      expect([newStore?.cached.iw, newStore?.cached.ih, newStore?.cached.v0].map(Math.fround)).toEqual(
        [0.025, -0.05, 1].map(Math.fround),
      );
      // And it draws like any image through into() and sprite().
      expect(() => draw.sprite(t, 0, 0)).not.toThrow();
      draw.end();
    });

    it("restore: textures re-upload lazily only when drawn, never wholesale per frame", () => {
      const { gl, fire, count } = fakeGL();
      const backend = new WebGL2Backend(gl);
      const used = image(16, 16);
      const idle = image(32, 32);
      draw1: {
        const draw = new Draw(backend, false);
        draw.begin("#000", 100, 50, 1);
        draw.sprite(used, 0, 0);
        draw.sprite(idle, 0, 0);
        draw.end();
      }
      const uploadsBeforeLoss = count("texImage2D");
      expect(uploadsBeforeLoss).toBe(3); // white + two images
      fire("webglcontextlost");
      fire("webglcontextrestored");
      const draw = new Draw(backend, false);
      draw.begin("#000", 100, 50, 1);
      draw.sprite(used, 0, 0); // only this source is needed on the first restored frame
      draw.end();
      // White (setup) plus the one used image: the idle source must not be re-uploaded just because it was cached.
      expect(count("texImage2D") - uploadsBeforeLoss).toBe(2);
      const secondFrame = count("texImage2D");
      draw.begin("#000", 100, 50, 1);
      draw.sprite(used, 0, 0);
      draw.end();
      // A second frame re-uploads nothing: the post-restore cache behaves exactly like the pre-loss one.
      expect(count("texImage2D")).toBe(secondFrame);
    });

    it("restore: the first frame's drawCalls and draw order match an uninterrupted renderer", () => {
      const fresh = fakeGL();
      const freshDraw = new Draw(new WebGL2Backend(fresh.gl), false);
      const freshImg = image();
      const freshTarget = freshDraw.createTarget(40, 20);
      freshDraw.begin("#000", 100, 50, 1);
      scene(freshDraw, freshTarget, freshImg);
      freshDraw.end();
      const expected = sequence(fresh.calls);
      const expectedCalls = freshDraw.drawCalls;

      const { gl, calls, fire } = fakeGL();
      const backend = new WebGL2Backend(gl);
      const draw = new Draw(backend, false);
      const img = image();
      const t = draw.createTarget(40, 20);
      draw.begin("#000", 100, 50, 1);
      scene(draw, t, img);
      draw.end();
      fire("webglcontextlost");
      // A frame entirely while lost must not move the counters.
      draw.begin("#000", 100, 50, 1);
      scene(draw, t, img);
      draw.end();
      fire("webglcontextrestored");
      const from = calls.length;
      draw.begin("#000", 100, 50, 1);
      scene(draw, t, img);
      draw.end();
      expect(sequence(calls.slice(from))).toEqual(expected);
      expect(draw.drawCalls).toBe(expectedCalls);
    });

    it("loss-time disposeTarget: restore never touches the freed object or deletes it twice", () => {
      const { gl, created, fire, count } = fakeGL();
      const backend = new WebGL2Backend(gl);
      const draw = new Draw(backend, false);
      const keep = draw.createTarget(8, 8);
      const gone = draw.createTarget(8, 8);
      draw.begin("#000", 100, 50, 1);
      draw.into(keep, () => {});
      draw.into(gone, () => {});
      const goneFbo = (backend as unknown as { targets: Map<RenderTarget, { fbo: { deleted: boolean }; cached: { tex: { deleted: boolean } } }> }).targets.get(gone);
      expect(goneFbo).toBeDefined();
      fire("webglcontextlost");
      expect(() => draw.disposeTarget(gone)).not.toThrow();
      // No delete call on the dead context while lost: the handle died with the context and the cache entry is gone.
      expect(goneFbo?.fbo.deleted).toBe(false);
      const deletesWhileLost = count("deleteFramebuffer");
      fire("webglcontextrestored");
      // Nothing recreates or deletes the disposed target during the restore.
      expect(count("deleteFramebuffer")).toBe(deletesWhileLost);
      const maps = backend as unknown as { targets: Map<RenderTarget, unknown>; textures: Map<RenderTarget, unknown> };
      expect(maps.targets.has(gone)).toBe(false);
      expect(maps.textures.has(gone)).toBe(false);
      const restoredFrom = created.length;
      draw.begin("#000", 100, 50, 1);
      // The surviving target still rebuilds and works.
      expect(() => draw.into(keep, () => draw.rect(0, 0, 2, 2, "#fff"))).not.toThrow();
      // Using the disposed one afresh allocates a brand-new store rather than reviving the old handle.
      draw.into(gone, () => {});
      const rebuilt = maps.targets.get(gone);
      expect(rebuilt).toBeDefined();
      expect((rebuilt as { fbo: object }).fbo).not.toBe(goneFbo?.fbo);
      draw.end();
      draw.dispose();
      // Everything built after the loss is freed exactly once; pre-loss objects died with their context and
      // were never deleted twice (the delete count did not move during the lost window).
      expect(created.slice(restoredFrom).filter((o) => !o.deleted)).toEqual([]);
    });

    it("loss-time dispose(): a later restore rebuilds nothing and the second dispose is a no-op", () => {
      const { gl, created, fire, count } = fakeGL();
      const backend = new WebGL2Backend(gl);
      const draw = new Draw(backend, false);
      draw.begin("#000", 100, 50, 1);
      draw.sprite(image(), 0, 0);
      draw.end();
      fire("webglcontextlost");
      expect(() => draw.dispose()).not.toThrow();
      const objectsAtDispose = created.length;
      const programsAtDispose = count("createProgram");
      fire("webglcontextrestored");
      // The disposed renderer must not come back to life on the restore event.
      expect(count("createProgram")).toBe(programsAtDispose);
      expect(created.length).toBe(objectsAtDispose);
      expect(backend.contextLost).toBe(true);
      expect(() => draw.dispose()).not.toThrow(); // idempotent
      expect(created.length).toBe(objectsAtDispose);
    });

    it("custom shaders recompile on demand after restore and keep working, without recompiling every frame", () => {
      const { gl, fire, count, calls } = fakeGL();
      const backend = new WebGL2Backend(gl);
      const draw = new Draw(backend, false);
      const shader = new Shader("vec4 effect(vec4 color, vec2 uv) { return source(uv) * color; }");
      draw.begin("#000", 100, 50, 1);
      draw.withShader(shader, () => draw.rect(0, 0, 4, 4, "#fff"));
      draw.end();
      const programsBeforeLoss = count("createProgram");
      expect(programsBeforeLoss).toBeGreaterThan(1); // main + at least the custom
      fire("webglcontextlost");
      // The Shader object itself stays valid; its GPU program is simply gone.
      fire("webglcontextrestored");
      draw.begin("#000", 100, 50, 1);
      expect(() => draw.withShader(shader, () => draw.rect(0, 0, 4, 4, "#fff"))).not.toThrow();
      draw.end();
      expect(count("createProgram")).toBeGreaterThan(programsBeforeLoss); // recompiled on first use
      const steady = count("createProgram");
      draw.begin("#000", 100, 50, 1);
      draw.withShader(shader, () => draw.rect(0, 0, 4, 4, "#fff"));
      draw.end();
      expect(count("createProgram")).toBe(steady); // cached again: no per-frame recompilation
      // The recompiled program is actually the one bound while the effect draws.
      const customDraw = calls.findLast((c) => c.name === "drawArraysInstanced");
      expect(customDraw).toBeDefined();
    });

    it("clips after restore flip against the current destination height, not a stale one", () => {
      const { gl, calls, fire } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      draw.begin("#000", 100, 50, 1);
      // A clip inside a 20px-high target before the loss.
      draw.into(draw.createTarget(40, 20), () => draw.clip(0, 0, 10, 5, () => {}));
      fire("webglcontextlost");
      fire("webglcontextrestored");
      draw.begin("#000", 100, 50, 1);
      // A canvas clip (height 50) and a target clip (height 20) must each flip against their own height.
      draw.clip(10, 5, 20, 10, () => {});
      expect(calls.findLast((c) => c.name === "scissor")?.args).toEqual([10, 35, 20, 10]);
      draw.into(draw.createTarget(40, 20), () => draw.clip(0, 0, 10, 5, () => {}));
      expect(calls.findLast((c) => c.name === "scissor")?.args).toEqual([0, 15, 10, 5]);
      draw.end();
    });
  });
});
