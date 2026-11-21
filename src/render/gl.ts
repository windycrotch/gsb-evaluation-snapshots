/**
 * Minimal batched WebGL2 renderer for skeletons: textured triangles with per-vertex tint and Spine blend modes.
 * Straight (non-premultiplied) alpha throughout. Used by the editor viewport and by exported players.
 */
import { clipOutline, fanIndices, planClipping } from '@/core/clip';
import type { ClipState } from '@/core/clip';
import type { BlendMode, RGB, RGBA } from '@/core/model';
import { resolveSequenceIndex, sequenceFramePath } from '@/core/sequence';
import { REGION_TRIANGLES, REGION_UVS, meshWorldVertices, regionWorldVertices } from '@/core/skeleton';
import type { Skeleton, Slot } from '@/core/skeleton';

export interface TextureSource {
  /** Returns pixel source for a region/mesh `path`, or null when the image is missing. */
  get(name: string): { bitmap: ImageBitmap | HTMLImageElement | HTMLCanvasElement; version: number } | null;
}

export interface CameraView {
  x: number;
  y: number;
  /** device pixels per world unit */
  scale: number;
  /** canvas size in device pixels */
  width: number;
  height: number;
  /** The picture is mirrored left to right (Flip Viewport). */
  flip?: boolean;
}

const VS = `#version 300 es
in vec2 aPos;
in vec2 aUv;
in vec4 aColor;
in vec3 aDark;
uniform vec2 uCenter;
uniform vec2 uScale;
out vec2 vUv;
out vec4 vColor;
out vec3 vDark;
void main() {
  vUv = aUv;
  vColor = aColor;
  vDark = aDark;
  gl_Position = vec4((aPos - uCenter) * uScale, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec4 vColor;
in vec3 vDark;
uniform sampler2D uTex;
uniform float uTextured;
uniform float uFlat;
out vec4 outColor;
void main() {
  vec4 tex = uTextured > 0.5 ? texture(uTex, vUv) : vec4(1.0);
  // Two-color tinting, as in Spine's straight-alpha shader: the light color multiplies the texture, the dark color fills in
  // where the texture is dark. With a black dark color (no two-color tinting) this is the plain multiply.
  // flat: only the shape of the picture, filled with the colour (ghosts drawn as silhouettes)
  if (uFlat > 0.5) { outColor = vec4(vColor.rgb, tex.a * vColor.a); return; }
  outColor = vec4(tex.rgb * vColor.rgb + (1.0 - tex.rgb) * vDark, tex.a * vColor.a);
}`;

const MAX_VERTS = 16384;
const FLOATS = 11; // x, y, u, v, light r g b a, dark r g b

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('Shader error: ' + gl.getShaderInfoLog(sh));
  return sh;
}

export class GLRenderer {
  readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vbo: WebGLBuffer;
  private ibo: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private verts = new Float32Array(MAX_VERTS * FLOATS);
  private idx = new Uint16Array(MAX_VERTS * 3);
  private vCount = 0;
  private iCount = 0;
  private curTex: WebGLTexture | null = null;
  private curBlend: BlendMode = 'normal';
  /** Linear (smooth) textures; off = nearest, pixels as they are. */
  private smooth = true;
  private textures = new Map<string, { tex: WebGLTexture; version: number; w: number; h: number }>();
  private whiteTex: WebGLTexture;
  private uCenter: WebGLUniformLocation;
  private uScale: WebGLUniformLocation;
  private uTextured: WebGLUniformLocation;
  private uFlat: WebGLUniformLocation;
  private flat = false;
  private scratch = new Float32Array(4096);
  private cam: CameraView = { x: 0, y: 0, scale: 1, width: 1, height: 1 };
  private clipping = false;
  source: TextureSource | null = null;

  /** `alpha` keeps transparency in the canvas (renders for files); `preserveDrawingBuffer` lets the picture be read after the frame is drawn. */
  constructor(canvas: HTMLCanvasElement, opts: { alpha?: boolean; preserveDrawingBuffer?: boolean } = {}) {
    const gl = canvas.getContext('webgl2', {
      alpha: opts.alpha ?? false,
      antialias: true,
      stencil: true,
      preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    const vs = compile(gl, gl.VERTEX_SHADER, VS);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FS);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.bindAttribLocation(prog, 1, 'aUv');
    gl.bindAttribLocation(prog, 2, 'aColor');
    gl.bindAttribLocation(prog, 3, 'aDark');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Program link error: ' + gl.getProgramInfoLog(prog));
    this.program = prog;
    this.uCenter = gl.getUniformLocation(prog, 'uCenter')!;
    this.uScale = gl.getUniformLocation(prog, 'uScale')!;
    this.uTextured = gl.getUniformLocation(prog, 'uTextured')!;
    this.uFlat = gl.getUniformLocation(prog, 'uFlat')!;
    gl.useProgram(prog);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.verts.byteLength, gl.DYNAMIC_DRAW);
    const stride = FLOATS * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, stride, 32);
    this.ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.idx.byteLength, gl.DYNAMIC_DRAW);

    this.whiteTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.whiteTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.enable(gl.BLEND);
    this.setBlend('normal');
  }

  private setBlend(mode: BlendMode) {
    const gl = this.gl;
    switch (mode) {
      case 'additive':
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE);
        break;
      case 'multiply':
        gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        break;
      case 'screen':
        gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        break;
      default:
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
    this.curBlend = mode;
  }

  /** Looks up (uploading if needed) the GL texture for an image name. */
  texture(name: string): { tex: WebGLTexture; w: number; h: number } | null {
    const src = this.source?.get(name);
    if (!src) {
      const old = this.textures.get(name);
      if (old) {
        this.gl.deleteTexture(old.tex);
        this.textures.delete(name);
      }
      return null;
    }
    const hit = this.textures.get(name);
    if (hit && hit.version === src.version) return hit;
    const gl = this.gl;
    const tex = hit?.tex ?? gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src.bitmap);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.filter(tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const entry = { tex, version: src.version, w: src.bitmap.width, h: src.bitmap.height };
    this.textures.set(name, entry);
    return entry;
  }

  private filter(tex: WebGLTexture) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.smooth ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this.smooth ? gl.LINEAR : gl.NEAREST);
  }

  /** Smooth or nearest texture filtering for every image (the Settings window). */
  setSmoothing(on: boolean) {
    if (on === this.smooth) return;
    this.smooth = on;
    for (const t of this.textures.values()) this.filter(t.tex);
  }

  begin(cam: CameraView, clear: RGBA = [0.075, 0.082, 0.1, 1]) {
    const gl = this.gl;
    this.cam = cam;
    gl.viewport(0, 0, cam.width, cam.height);
    gl.clearColor(clear[0], clear[1], clear[2], clear[3]);
    gl.disable(gl.STENCIL_TEST);
    gl.stencilMask(0xff);
    gl.colorMask(true, true, true, true);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    this.clipping = false;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(this.uCenter, cam.x, cam.y);
    gl.uniform2f(this.uScale, ((cam.flip ? -2 : 2) * cam.scale) / cam.width, (2 * cam.scale) / cam.height);
    this.vCount = 0;
    this.iCount = 0;
    this.curTex = null;
    this.setBlend('normal');
  }

  flush() {
    if (this.iCount === 0) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.verts, 0, this.vCount * FLOATS);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, this.idx, 0, this.iCount);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.curTex ?? this.whiteTex);
    gl.uniform1f(this.uTextured, this.curTex ? 1 : 0);
    gl.uniform1f(this.uFlat, this.flat ? 1 : 0);
    gl.drawElements(gl.TRIANGLES, this.iCount, gl.UNSIGNED_SHORT, 0);
    this.vCount = 0;
    this.iCount = 0;
  }

  /** Pushes triangles. `world` holds x,y pairs; `uvs` is null for untextured geometry; `dark` is the slot's dark color (two-color tinting). */
  pushGeometry(
    world: ArrayLike<number>,
    uvs: ArrayLike<number> | null,
    tris: ArrayLike<number>,
    vertexCount: number,
    triIndexCount: number,
    color: RGBA,
    tex: WebGLTexture | null,
    blend: BlendMode,
    dark: RGB | null = null,
  ) {
    if (vertexCount > MAX_VERTS) return;
    if (
      tex !== this.curTex ||
      blend !== this.curBlend ||
      this.vCount + vertexCount > MAX_VERTS ||
      this.iCount + triIndexCount > this.idx.length
    ) {
      this.flush();
      this.curTex = tex;
      if (blend !== this.curBlend) this.setBlend(blend);
    }
    const base = this.vCount;
    let o = base * FLOATS;
    const v = this.verts;
    for (let i = 0; i < vertexCount; i++) {
      v[o++] = world[i * 2];
      v[o++] = world[i * 2 + 1];
      v[o++] = uvs ? uvs[i * 2] : 0;
      v[o++] = uvs ? uvs[i * 2 + 1] : 0;
      v[o++] = color[0];
      v[o++] = color[1];
      v[o++] = color[2];
      v[o++] = color[3];
      v[o++] = dark ? dark[0] : 0;
      v[o++] = dark ? dark[1] : 0;
      v[o++] = dark ? dark[2] : 0;
    }
    for (let i = 0; i < triIndexCount; i++) this.idx[this.iCount + i] = base + tris[i];
    this.vCount += vertexCount;
    this.iCount += triIndexCount;
  }

  /** Per-vertex colored geometry (weight heat maps etc). `colors` holds r,g,b,a per vertex. */
  pushColored(world: ArrayLike<number>, colors: ArrayLike<number>, tris: ArrayLike<number>, vertexCount: number, triIndexCount: number) {
    if (vertexCount > MAX_VERTS) return;
    if (
      this.curTex !== null ||
      this.curBlend !== 'normal' ||
      this.vCount + vertexCount > MAX_VERTS ||
      this.iCount + triIndexCount > this.idx.length
    ) {
      this.flush();
      this.curTex = null;
      if (this.curBlend !== 'normal') this.setBlend('normal');
    }
    const base = this.vCount;
    let o = base * FLOATS;
    const v = this.verts;
    for (let i = 0; i < vertexCount; i++) {
      v[o++] = world[i * 2];
      v[o++] = world[i * 2 + 1];
      v[o++] = 0;
      v[o++] = 0;
      v[o++] = colors[i * 4];
      v[o++] = colors[i * 4 + 1];
      v[o++] = colors[i * 4 + 2];
      v[o++] = colors[i * 4 + 3];
      v[o++] = 0;
      v[o++] = 0;
      v[o++] = 0;
    }
    for (let i = 0; i < triIndexCount; i++) this.idx[this.iCount + i] = base + tris[i];
    this.vCount += vertexCount;
    this.iCount += triIndexCount;
  }

  /**
   * Starts clipping: until `clipEnd()` everything is limited to the inside of the polygon (the outside when `inverse`).
   * The polygon goes into the stencil buffer as a triangle fan with the INVERT operation, so overlaps cancel out and any
   * simple polygon (also a concave one) is filled correctly.
   */
  clipBegin(polygon: ArrayLike<number>, n: number, inverse: boolean) {
    if (n < 3 || this.clipping) return;
    this.flush();
    const gl = this.gl;
    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(0xff);
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.colorMask(false, false, false, false);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
    const tris = fanIndices(n);
    this.pushGeometry(polygon, null, tris, n, tris.length, [1, 1, 1, 1], null, 'normal');
    this.flush();
    gl.colorMask(true, true, true, true);
    gl.stencilMask(0);
    gl.stencilFunc(inverse ? gl.EQUAL : gl.NOTEQUAL, 0, 0xff);
    this.clipping = true;
  }

  clipEnd() {
    if (!this.clipping) return;
    this.flush();
    this.gl.disable(this.gl.STENCIL_TEST);
    this.clipping = false;
  }

  /**
   * Draws every visible slot of the skeleton in draw order. `skip` can hide individual slots.
   * Clipping follows Spine's `SkeletonRendererCore` (see `planClipping`).
   */
  drawSkeleton(
    skeleton: Skeleton,
    opts: { skip?: (slot: Slot) => boolean; alpha?: number; tint?: RGBA; flat?: boolean; offset?: [number, number] } = {},
  ) {
    this.flush();
    this.flat = !!opts.flat;
    const [dx, dy] = opts.offset ?? [0, 0];
    const shift = (a: Float32Array, n: number) => {
      if (dx === 0 && dy === 0) return;
      for (let k = 0; k < n; k++) {
        a[k * 2] += dx;
        a[k * 2 + 1] += dy;
      }
    };
    const tint = opts.tint ?? [1, 1, 1, 1];
    const alpha = opts.alpha ?? 1;
    const plan = planClipping(skeleton, opts.skip);
    let active: ClipState | null = null;
    const order = skeleton.drawOrder;
    for (let i = 0; i < order.length; i++) {
      const slot = order[i];
      if (opts.skip?.(slot)) continue;
      const att = skeleton.slotAttachment(slot);
      if (!att || (att.kind !== 'region' && att.kind !== 'mesh')) continue;
      const sc = slot.color;
      const ac = att.color;
      const color: RGBA = [
        skeleton.color[0] * sc[0] * ac[0] * tint[0],
        skeleton.color[1] * sc[1] * ac[1] * tint[1],
        skeleton.color[2] * sc[2] * ac[2] * tint[2],
        skeleton.color[3] * sc[3] * ac[3] * tint[3] * alpha,
      ];
      if (color[3] <= 0) continue;
      const want = plan[i];
      if (want !== active) {
        this.clipEnd();
        active = null;
        if (want) {
          const n = want.att.vertexCount;
          if (n * 2 > this.scratch.length) this.scratch = new Float32Array(n * 2 * 2);
          meshWorldVertices(skeleton, want.slot, want.att, null, this.scratch);
          shift(this.scratch, n);
          const outline = clipOutline(this.scratch, n, want.att.convex, want.att.inverse);
          this.clipBegin(outline.vertices, outline.count, want.att.inverse);
          if (this.clipping) active = want;
        }
      }
      const seq = att.src.sequence;
      const t = this.texture(seq ? sequenceFramePath(att.path, seq, resolveSequenceIndex(seq, slot.sequenceIndex)) : att.path);
      if (att.kind === 'region') {
        regionWorldVertices(att, slot.bone, this.scratch);
        shift(this.scratch, 4);
        this.pushGeometry(this.scratch, REGION_UVS, REGION_TRIANGLES, 4, 6, color, t?.tex ?? null, slot.data.blend, slot.dark);
      } else {
        const n = att.vertexCount;
        if (n * 2 > this.scratch.length) this.scratch = new Float32Array(n * 2 * 2);
        meshWorldVertices(skeleton, slot, att, slot.deform.length ? slot.deform : null, this.scratch);
        shift(this.scratch, n);
        this.pushGeometry(this.scratch, att.uvs, att.triangles, n, att.triangles.length, color, t?.tex ?? null, slot.data.blend, slot.dark);
      }
    }
    this.clipEnd();
    this.flush();
    this.flat = false;
  }

  end() {
    this.clipEnd();
    this.flush();
  }

  get camera(): CameraView {
    return this.cam;
  }

  dispose() {
    const gl = this.gl;
    for (const t of this.textures.values()) gl.deleteTexture(t.tex);
    this.textures.clear();
    gl.deleteBuffer(this.vbo);
    gl.deleteBuffer(this.ibo);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
    // Do not call loseContext(): the canvas keeps returning the same (then dead) context, which breaks
    // React StrictMode's mount/unmount/mount cycle and HMR remounts.
  }
}
