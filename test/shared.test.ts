import { describe, expect, it } from "vitest";
import type { Matrix, TextureSource } from "../src/backend.js";
import { createSharedRenderer } from "../src/shared.js";
import { RenderTarget } from "../src/target.js";

/** A recording WebGL2 stand-in whose context-loss and scissor state the test controls. */
function hostGL() {
  const calls: { name: string; args: unknown[] }[] = [];
  const listeners = new Map<string, unknown>();
  const state = { lost: false, scissor: null as number[] | null };
  const target: Record<string | symbol, unknown> = {
    canvas: {
      addEventListener: (type: string, fn: unknown) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    },
    drawingBufferWidth: 100,
    drawingBufferHeight: 50,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    checkFramebufferStatus: () => "FRAMEBUFFER_COMPLETE",
    getParameter: (p: unknown) => (p === "MAX_TEXTURE_SIZE" ? 16384 : p === "SCISSOR_BOX" ? state.scissor : undefined),
    getUniformLocation: () => ({}),
    isContextLost: () => state.lost,
    isEnabled: (cap: unknown) => cap === "SCISSOR_TEST" && state.scissor !== null,
  };
  const gl = new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      if (typeof key !== "string") return undefined;
      if (/^[A-Z0-9_]+$/.test(key)) return key;
      return (...args: unknown[]) => {
        calls.push({ name: key, args });
        return key.startsWith("create") ? { kind: key.slice(6) } : undefined;
      };
    },
  });
  const named = (name: string) => calls.filter((c) => c.name === name);
  const since = (from: number, name: string) => calls.slice(from).filter((c) => c.name === name);
  return { gl: gl as unknown as WebGL2RenderingContext, calls, named, since, listeners, state };
}

const M: Matrix = [16, 0, 0, 16, 0, 0];
const image = { width: 16, height: 16 } as unknown as TextureSource;

describe("createSharedRenderer", () => {
  it("notes context events without claiming them, and sizes itself to the drawing buffer until told otherwise", () => {
    const { gl, listeners } = hostGL();
    const shared = createSharedRenderer(gl);
    expect([...listeners.keys()].sort()).toEqual(["webglcontextlost", "webglcontextrestored"]);
    expect([shared.draw.backingW, shared.draw.backingH]).toEqual([100, 50]);
    shared.target(null, 64, 32);
    expect([shared.draw.backingW, shared.draw.backingH]).toEqual([64, 32]);
    shared.draw.dispose();
    expect(listeners.size).toBe(0);
  });

  it("rebuilds at the next begin after a loss and restore that happened between frames", () => {
    const { gl, named, listeners } = hostGL();
    const shared = createSharedRenderer(gl);
    const programs = named("createProgram").length;
    const fire = (name: string) => (listeners.get(name) as (e: object) => void)({ preventDefault: () => {} });
    fire("webglcontextlost");
    expect(shared.draw.contextLost).toBe(true);
    fire("webglcontextrestored");
    // isContextLost() is already false again: begin() must still rebuild, since the old objects are dead.
    shared.draw.begin(null, 100, 50, 1);
    expect(shared.draw.contextLost).toBe(false);
    expect(named("createProgram").length).toBeGreaterThan(programs);
    shared.draw.sprite(image, 10, 10);
    shared.draw.end();
    expect(named("drawArraysInstanced")).toHaveLength(1);
    // A restore alone (the loss event missed) rebuilds too.
    const again = named("createProgram").length;
    fire("webglcontextrestored");
    shared.draw.begin(null, 100, 50, 1);
    expect(named("createProgram").length).toBeGreaterThan(again);
    shared.draw.end();
  });

  it("rebinds what it needs at begin, draws into the host's framebuffer at its size, and doesn't clear", () => {
    const { gl, calls, since } = hostGL();
    const shared = createSharedRenderer(gl);
    const fb = { kind: "host" } as unknown as WebGLFramebuffer;
    shared.target(fb, 200, 100);
    const from = calls.length;
    shared.draw.begin(null, 200, 100, 1);
    const names = calls.slice(from).map((c) => c.name);
    for (const n of ["useProgram", "bindVertexArray", "blendEquation", "blendFunc", "colorMask", "pixelStorei"]) expect(names).toContain(n);
    expect(since(from, "bindFramebuffer").at(-1)?.args).toEqual(["FRAMEBUFFER", fb]);
    expect(since(from, "viewport").at(-1)?.args).toEqual([0, 0, 200, 100]);
    expect(since(from, "disable").map((c) => c.args[0])).toEqual(expect.arrayContaining(["DEPTH_TEST", "CULL_FACE", "SCISSOR_TEST"]));
    expect(since(from, "clear")).toHaveLength(0);
    shared.draw.end();
  });

  it("flips clips against the host framebuffer's height, and turns the scissor off at end when the host had none", () => {
    const { gl, calls, since } = hostGL();
    const shared = createSharedRenderer(gl);
    shared.target(null, 200, 100);
    shared.draw.begin(null, 200, 100, 1);
    const from = calls.length;
    shared.draw.clip(10, 5, 20, 10, () => shared.draw.rect(0, 0, 1, 1, "#fff"));
    expect(since(from, "scissor")[0]?.args).toEqual([10, 85, 20, 10]);
    expect(since(from, "disable").map((c) => c.args[0])).toContain("SCISSOR_TEST");
    shared.draw.end();
    expect(calls.at(-1)?.name).toBe("bindSampler");
  });

  it("intersects clips with the host's scissor and gives the host's back afterwards, including at end", () => {
    const { gl, calls, since, state } = hostGL();
    state.scissor = [50, 0, 100, 100];
    const shared = createSharedRenderer(gl);
    shared.target(null, 200, 100);
    shared.draw.begin(null, 200, 100, 1);
    const from = calls.length;
    shared.draw.clip(10, 5, 60, 10, () => shared.draw.rect(0, 0, 1, 1, "#fff"));
    // Clip (10, 85, 60, 10) in GL coordinates, cut to x >= 50.
    expect(since(from, "scissor").map((c) => c.args)).toEqual([
      [50, 85, 20, 10],
      [50, 0, 100, 100],
    ]);
    expect(since(from, "disable").map((c) => c.args[0])).not.toContain("SCISSOR_TEST");
    const end = calls.length;
    shared.draw.end();
    expect(since(end, "scissor").at(-1)?.args).toEqual([50, 0, 100, 100]);
    expect(since(end, "bindSampler").map((c) => c.args)).toEqual(Array.from({ length: 8 }, (_, i) => [i, null]));
  });

  it("draws render targets unscissored and restores the host's scissor on the way back", () => {
    const { gl, calls, since, state } = hostGL();
    state.scissor = [0, 0, 100, 100];
    const shared = createSharedRenderer(gl);
    shared.target(null, 200, 100);
    shared.draw.begin(null, 200, 100, 1);
    const t = new RenderTarget(8, 8);
    const from = calls.length;
    shared.draw.into(t, () => shared.draw.clip(1, 1, 4, 4, () => shared.draw.rect(0, 0, 8, 8, "#fff")));
    const names = calls.slice(from).map((c) => `${c.name}:${c.args[0]}`);
    // Scissor off before the target is bound and cleared; the clip inside flips against the target's height.
    expect(names.indexOf("disable:SCISSOR_TEST")).toBeLessThan(names.indexOf("clear:COLOR_BUFFER_BIT"));
    expect(since(from, "scissor")[0]?.args).toEqual([1, 3, 4, 4]);
    // Back on the host framebuffer: its scissor again.
    expect(since(from, "scissor").at(-1)?.args).toEqual([0, 0, 100, 100]);
    expect(since(from, "bindFramebuffer").at(-1)?.args).toEqual(["FRAMEBUFFER", null]);
    shared.draw.end();
  });

  it("goes back to the host's framebuffer after creating a target's store mid-frame", () => {
    const { gl, named } = hostGL();
    const fb = { kind: "host" } as unknown as WebGLFramebuffer;
    const shared = createSharedRenderer(gl);
    shared.target(fb, 200, 100);
    shared.draw.begin(null, 200, 100, 1);
    // Drawn as an image before ever being drawn into: its framebuffer is made on the spot.
    shared.draw.sprite(new RenderTarget(8, 8), 10, 10);
    expect(named("bindFramebuffer").at(-1)?.args).toEqual(["FRAMEBUFFER", fb]);
    shared.draw.end();
  });

  it("notices a lost context at begin, draws nothing while lost, and rebuilds when it's back", () => {
    const { gl, named, state } = hostGL();
    const shared = createSharedRenderer(gl);
    const programs = named("createProgram").length;
    // Populate a target store before the loss, so we can prove its dead handles are dropped.
    const t = new RenderTarget(8, 8);
    shared.draw.begin(null, 100, 50, 1);
    shared.draw.into(t, () => {});
    const backend = shared.draw.backend as unknown as {
      targets: Map<RenderTarget, unknown>;
      textures: Map<RenderTarget, unknown>;
    };
    expect(backend.targets.has(t)).toBe(true);
    state.lost = true;
    shared.draw.begin(null, 100, 50, 1);
    expect(shared.draw.contextLost).toBe(true);
    // The loss was discovered at begin() with no event, yet the GPU caches were still dropped.
    expect(backend.targets.has(t)).toBe(false);
    expect(backend.textures.has(t)).toBe(false);
    shared.draw.sprite(image, 10, 10);
    shared.draw.end();
    expect(named("drawArraysInstanced")).toHaveLength(0);
    state.lost = false;
    shared.draw.begin(null, 100, 50, 1);
    expect(shared.draw.contextLost).toBe(false);
    expect(named("createProgram").length).toBeGreaterThan(programs);
    shared.draw.sprite(image, 10, 10);
    shared.draw.end();
    expect(named("drawArraysInstanced")).toHaveLength(1);
  });

  it("still clears when begin() is given a colour", () => {
    const { gl, named } = hostGL();
    const shared = createSharedRenderer(gl);
    shared.draw.begin("#f00", 100, 50, 1);
    expect(named("clear")).toHaveLength(1);
    shared.draw.end();
  });

  it("is a plain Draw otherwise: quads batch and draw", () => {
    const { gl, named } = hostGL();
    const shared = createSharedRenderer(gl, { smooth: false });
    shared.draw.begin(null, 100, 50, 1);
    shared.draw.sprite(image, 1, 1);
    shared.draw.sprite(image, 2, 2);
    shared.draw.end();
    expect(named("drawArraysInstanced")).toHaveLength(1);
    expect(named("drawArraysInstanced")[0]?.args).toEqual(["TRIANGLE_STRIP", 0, 4, 2]);
    void M;
  });

  describe("context loss lifecycle", () => {
    const fire = (listeners: Map<string, unknown>, name: string) =>
      (listeners.get(name) as (e: object) => void)({ preventDefault: () => {} });

    it("drops every GPU-handle cache at the loss, so dead textures and targets are never reused", () => {
      const { gl, listeners } = hostGL();
      const shared = createSharedRenderer(gl);
      const backend = shared.draw.backend as unknown as {
        textures: Map<TextureSource, unknown>;
        targets: Map<RenderTarget, unknown>;
        target: RenderTarget | null;
      };
      const t = new RenderTarget(8, 8);
      shared.draw.begin(null, 100, 50, 1);
      shared.draw.into(t, () => {});
      expect(backend.targets.has(t)).toBe(true);
      expect(backend.textures.has(t)).toBe(true);
      fire(listeners, "webglcontextlost");
      expect(shared.draw.contextLost).toBe(true);
      expect(backend.targets.has(t)).toBe(false);
      expect(backend.textures.has(t)).toBe(false);
      expect(backend.target).toBeNull();
      shared.draw.dispose();
    });

    it("rebuilds render targets lazily after restore with the right size and bottom-up sampling", () => {
      const { gl, named, listeners, calls } = hostGL();
      const shared = createSharedRenderer(gl);
      const t = new RenderTarget(40, 20);
      shared.draw.begin(null, 100, 50, 1);
      shared.draw.into(t, () => {});
      const backend = shared.draw.backend as unknown as {
        targets: Map<RenderTarget, { fbo: object; cached: { iw: number; ih: number; v0: number } }>;
      };
      const oldFbo = backend.targets.get(t)?.fbo;
      fire(listeners, "webglcontextlost");
      fire(listeners, "webglcontextrestored");
      // The rebuild happens inside the host's slot at the next begin().
      shared.draw.begin(null, 100, 50, 1);
      expect(shared.draw.contextLost).toBe(false);
      shared.draw.into(t, () => {});
      const store = backend.targets.get(t);
      expect(store).toBeDefined();
      expect(store?.fbo).not.toBe(oldFbo);
      expect(calls.find((c) => c.name === "viewport" && (c.args as unknown[]).join() === "0,0,40,20")).toBeDefined();
      expect([store?.cached.iw, store?.cached.ih, store?.cached.v0].map(Math.fround)).toEqual(
        [0.025, -0.05, 1].map(Math.fround),
      );
      expect(() => shared.draw.sprite(t, 0, 0)).not.toThrow();
      shared.draw.end();
      expect(named("drawArraysInstanced").length).toBeGreaterThan(0);
      shared.draw.dispose();
    });

    it("a target disposed while lost is neither revived nor double-freed at restore", () => {
      const { gl, listeners } = hostGL();
      const shared = createSharedRenderer(gl);
      const keep = new RenderTarget(8, 8);
      const gone = new RenderTarget(8, 8);
      shared.draw.begin(null, 100, 50, 1);
      shared.draw.into(keep, () => {});
      shared.draw.into(gone, () => {});
      const backend = shared.draw.backend as unknown as {
        targets: Map<RenderTarget, unknown>;
        textures: Map<RenderTarget, unknown>;
      };
      fire(listeners, "webglcontextlost");
      expect(() => shared.draw.disposeTarget(gone)).not.toThrow();
      fire(listeners, "webglcontextrestored");
      shared.draw.begin(null, 100, 50, 1);
      expect(backend.targets.has(gone)).toBe(false);
      expect(backend.textures.has(gone)).toBe(false);
      expect(() => shared.draw.into(keep, () => {})).not.toThrow();
      shared.draw.end();
      shared.draw.dispose();
    });

    it("reuploads only the textures each restored frame actually draws, not every cached one", () => {
      const { gl, named, listeners } = hostGL();
      const shared = createSharedRenderer(gl);
      const a = { width: 16, height: 16 } as unknown as TextureSource;
      const b = { width: 32, height: 32 } as unknown as TextureSource;
      shared.draw.begin(null, 100, 50, 1);
      shared.draw.sprite(a, 0, 0);
      shared.draw.sprite(b, 0, 0);
      shared.draw.end();
      fire(listeners, "webglcontextlost");
      fire(listeners, "webglcontextrestored");
      // The restore's setup (white texture) happens inside this begin; snapshot only after it.
      shared.draw.begin(null, 100, 50, 1);
      const before = named("texImage2D").length;
      shared.draw.sprite(a, 0, 0); // only a is needed this frame
      shared.draw.end();
      const firstFrameUploads = named("texImage2D").length - before;
      shared.draw.begin(null, 100, 50, 1);
      shared.draw.sprite(a, 0, 0);
      shared.draw.end();
      // The restored frame uploads just the one source it draws; the next frame uploads nothing (cache holds).
      expect(firstFrameUploads).toBe(1);
      expect(named("texImage2D").length - before).toBe(1);
      shared.draw.dispose();
    });
  });
});
