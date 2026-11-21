/**
 * Spine 4.3 binary exporter (`.skel`). It turns the JSON that exportSpineJson makes (already checked against the official runtime)
 * into the binary layout the official `SkeletonBinary` reads: the same structure, but names become indices, numbers become 32-bit
 * floats and most booleans / defaults are folded into flag bytes. Every choice here mirrors the reader, field by field.
 */
import type { SkeletonDoc } from '../model';
import { exportSpineJson } from './spineJson';
import type { SpineExportOptions } from './spineJson';

type J = any;

const INHERIT = ['normal', 'onlyTranslation', 'noRotationOrReflection', 'noScale', 'noScaleOrReflection'];
const BLEND = ['normal', 'additive', 'multiply', 'screen'];
const SCALE_Y = ['none', 'uniform', 'volume'];
const POSITION_MODE = ['fixed', 'percent'];
const SPACING_MODE = ['length', 'fixed', 'percent', 'proportional'];
const ROTATE_MODE = ['tangent', 'chain', 'chainScale'];
const FROM_PROP = ['rotate', 'x', 'y', 'scaleX', 'scaleY', 'shearY'];
const PHYSICS_TYPE: Record<string, number> = { inertia: 0, strength: 1, damping: 2, mass: 4, wind: 5, gravity: 6, mix: 7 };
const SEQUENCE_MODE: string[] = ['hold', 'once', 'loop', 'pingpong', 'onceReverse', 'loopReverse', 'pingpongReverse'];
const PHYSICS_RESET = 8;

/** Growable byte buffer with the primitives of the Spine binary format (big endian). */
export class Out {
  private buf = new Uint8Array(4096);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private need(n: number) {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  byte(v: number) {
    this.need(1);
    this.buf[this.length++] = v & 255;
  }
  bool(v: boolean) {
    this.byte(v ? 1 : 0);
  }
  int32(v: number) {
    this.need(4);
    this.view.setInt32(this.length, v | 0);
    this.length += 4;
  }
  float(v: number) {
    this.need(4);
    this.view.setFloat32(this.length, Number.isFinite(v) ? v : 0);
    this.length += 4;
  }
  /** Variable length integer, 1 to 5 bytes. `positive` = small non-negative numbers are short; otherwise zigzag. A negative number written as `positive` takes 5 bytes. */
  varint(value: number, positive: boolean) {
    let v = positive ? value >>> 0 : ((value << 1) ^ (value >> 31)) >>> 0;
    for (let i = 0; i < 5; i++) {
      const low = v & 0x7f;
      v >>>= 7;
      if (v === 0) {
        this.byte(low);
        return;
      }
      this.byte(low | 0x80);
    }
  }
  /** null = 0, "" = 1, else byte count + 1 and the characters as 1 to 3 byte sequences (one per UTF-16 unit, like the reader decodes them). */
  string(s: string | null | undefined) {
    if (s === null || s === undefined) return this.varint(0, true);
    if (s === '') return this.varint(1, true);
    const bytes: number[] = [];
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    this.varint(bytes.length + 1, true);
    for (const b of bytes) this.byte(b);
  }
  raw(other: Out) {
    this.need(other.length);
    this.buf.set(other.buf.subarray(0, other.length), this.length);
    this.length += other.length;
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/** "rrggbbaa" / "rrggbb" -> [r, g, b, a] bytes. */
function hexBytes(hex: string | undefined, fallback: number[]): number[] {
  if (!hex) return fallback;
  const out = [0, 0, 0, 255];
  for (let i = 0; i < 4; i++) {
    const part = hex.slice(i * 2, i * 2 + 2);
    if (part.length === 2) out[i] = parseInt(part, 16) || 0;
  }
  return out;
}
const rgba8888 = ([r, g, b, a]: number[]) => (r << 24) | (g << 16) | (b << 8) | a | 0;
const rgb888 = ([r, g, b]: number[]) => (r << 16) | (g << 8) | b;

const num = (v: unknown, def: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : def);

/** The four numbers of one bezier segment of one channel are the exported `curve` entries `4 * channel .. 4 * channel + 3`. */
function isBezier(curve: unknown): curve is number[] {
  return Array.isArray(curve);
}

/** How many bezier segments a key list has, counted per channel (the reader preallocates for them). */
function bezierCount(keys: J[], channels: number): number {
  let n = 0;
  for (let i = 0; i < keys.length - 1; i++) if (isBezier(keys[i].curve)) n += channels;
  return n;
}

/** The curve byte of a key and its bezier control points for every channel. */
function writeCurve(out: Out, key: J, channels: number) {
  const c = key.curve;
  if (c === 'stepped') return out.byte(1);
  if (!isBezier(c)) return out.byte(0);
  out.byte(2);
  for (let i = 0; i < channels * 4; i++) out.float(num(c[i], 0));
}

/** Converts the exported JSON (see exportSpineJson) to the binary format. */
export function jsonToBinary(json: J): Uint8Array {
  const skeleton = json.skeleton ?? {};
  const nonessential = skeleton.fps !== undefined || skeleton.images !== undefined;
  const bones: J[] = json.bones ?? [];
  const slots: J[] = json.slots ?? [];
  const constraints: J[] = json.constraints ?? [];
  const skins: J[] = json.skins ?? [];
  const eventNames = Object.keys(json.events ?? {});
  const animationNames = Object.keys(json.animations ?? {});

  const boneIndex = new Map<string, number>(bones.map((b, i) => [b.name, i] as const));
  const slotIndex = new Map<string, number>(slots.map((s, i) => [s.name, i] as const));
  const constraintIndex = new Map<string, number>(); // "type:name" -> index in the constraint list
  // two constraints of one type may share a name; the loader finds the first, so does the file
  constraints.forEach((c, i) => {
    const key = `${c.type}:${c.name}`;
    if (!constraintIndex.has(key)) constraintIndex.set(key, i);
  });
  const skinIndex = new Map<string, number>(skins.map((s, i) => [s.name, i] as const));
  const animationIndex = new Map<string, number>(animationNames.map((n, i) => [n, i] as const));
  const eventIndex = new Map<string, number>(eventNames.map((n, i) => [n, i] as const));

  const bone = (name: string): number => {
    const i = boneIndex.get(name);
    if (i === undefined) throw new Error(`Binary export: unknown bone "${name}"`);
    return i;
  };
  const slot = (name: string): number => {
    const i = slotIndex.get(name);
    if (i === undefined) throw new Error(`Binary export: unknown slot "${name}"`);
    return i;
  };
  const constraint = (type: string, name: string): number => {
    const i = constraintIndex.get(`${type}:${name}`);
    if (i === undefined) throw new Error(`Binary export: unknown ${type} constraint "${name}"`);
    return i;
  };

  // names the file stores once, in the string table, and refers to by number
  const table: string[] = [];
  const tableIndex = new Map<string, number>();
  const ref = (out: Out, s: string | null | undefined) => {
    if (s === null || s === undefined) return out.varint(0, true);
    let i = tableIndex.get(s);
    if (i === undefined) {
      table.push(s);
      i = table.length;
      tableIndex.set(s, i);
    }
    out.varint(i, true);
  };

  const body = new Out();

  body.varint(bones.length, true);
  bones.forEach((b, i) => {
    body.string(b.name);
    if (i > 0) body.varint(bone(b.parent), true);
    body.float(num(b.rotation, 0));
    body.float(num(b.x, 0));
    body.float(num(b.y, 0));
    body.float(num(b.scaleX, 1));
    body.float(num(b.scaleY, 1));
    body.float(num(b.shearX, 0));
    body.float(num(b.shearY, 0));
    body.byte(Math.max(0, INHERIT.indexOf(b.inherit ?? 'normal')));
    body.float(num(b.length, 0));
    body.bool(!!b.skin);
    if (nonessential) {
      body.int32(rgba8888(hexBytes(b.color, [0x98, 0x98, 0x98, 255])));
      body.string(null); // icon
      body.float(1); // icon size
      body.float(0); // icon rotation
      body.bool(true); // visible
    }
  });

  body.varint(slots.length, true);
  for (const s of slots) {
    body.string(s.name);
    body.varint(bone(s.bone), true);
    body.int32(rgba8888(hexBytes(s.color, [255, 255, 255, 255])));
    body.int32(s.dark ? rgb888(hexBytes(s.dark, [0, 0, 0, 255])) : -1);
    ref(body, s.attachment ?? null);
    body.varint(Math.max(0, BLEND.indexOf(s.blend ?? 'normal')), true);
    if (nonessential) body.bool(true);
  }

  body.varint(constraints.length, true);
  for (const c of constraints) {
    body.string(c.name);
    switch (c.type) {
      case 'ik': {
        body.byte(0);
        body.varint(c.bones.length, true);
        for (const b of c.bones) body.varint(bone(b), true);
        body.varint(bone(c.target), true);
        const mix = num(c.mix, 1);
        const softness = num(c.softness, 0);
        const scaleY = c.scaleY !== undefined ? Math.max(0, SCALE_Y.indexOf(c.scaleY)) : 0;
        let flags = 0;
        if (c.skin) flags |= 1;
        if (c.scaleY !== undefined) flags |= 2;
        if (c.bendPositive === false) flags |= 4;
        if (c.compress) flags |= 8;
        if (c.stretch) flags |= 16;
        if (mix !== 0) flags |= 32;
        if (mix !== 0 && mix !== 1) flags |= 64;
        if (softness !== 0) flags |= 128;
        body.byte(flags);
        if (flags & 2) body.byte(scaleY);
        if (flags & 64) body.float(mix);
        if (flags & 128) body.float(softness);
        break;
      }
      case 'transform': {
        body.byte(2);
        body.varint(c.bones.length, true);
        for (const b of c.bones) body.varint(bone(b), true);
        body.varint(bone(c.source), true);
        const props = Object.entries<J>(c.properties ?? {}).filter(([, f]) => Object.keys(f.to ?? {}).length > 0);
        let flags = 0;
        if (c.skin) flags |= 1;
        if (c.localSource) flags |= 2;
        if (c.localTarget) flags |= 4;
        if (c.additive) flags |= 8;
        if (c.clamp) flags |= 16;
        flags |= props.length << 5;
        body.byte(flags);
        const used = new Set<string>();
        for (const [fromName, from] of props) {
          body.byte(Math.max(0, FROM_PROP.indexOf(fromName)));
          body.float(num(from.offset, 0));
          const tos = Object.entries<J>(from.to);
          body.byte(tos.length);
          for (const [toName, to] of tos) {
            used.add(toName);
            body.byte(Math.max(0, FROM_PROP.indexOf(toName)));
            body.float(num(to.offset, 0));
            body.float(num(to.max, 1));
            body.float(num(to.scale, 1));
          }
        }
        const offsets: [string, number][] = [
          ['rotation', 0],
          ['x', 0],
          ['y', 0],
          ['scaleX', 0],
          ['scaleY', 0],
          ['shearY', 0],
        ];
        let off = 0;
        offsets.forEach(([key], i) => {
          if (num(c[key], 0) !== 0) off |= 1 << i;
        });
        body.byte(off);
        offsets.forEach(([key], i) => {
          if (off & (1 << i)) body.float(num(c[key], 0));
        });
        const mixes = ['mixRotate', 'mixX', 'mixY', 'mixScaleX', 'mixScaleY', 'mixShearY'];
        const mixFlags = mixes.reduce((acc, key, i) => (c[key] !== undefined && used.has(FROM_PROP[i]) ? acc | (1 << i) : acc), 0);
        body.byte(mixFlags);
        mixes.forEach((key, i) => {
          if (mixFlags & (1 << i)) body.float(num(c[key], 1));
        });
        break;
      }
      case 'path': {
        body.byte(1);
        body.varint(c.bones.length, true);
        for (const b of c.bones) body.varint(bone(b), true);
        body.varint(slot(c.slot), true);
        const positionMode = Math.max(0, POSITION_MODE.indexOf(c.positionMode ?? 'percent'));
        const spacingMode = Math.max(0, SPACING_MODE.indexOf(c.spacingMode ?? 'length'));
        const rotateMode = Math.max(0, ROTATE_MODE.indexOf(c.rotateMode ?? 'tangent'));
        const offsetRotation = num(c.rotation, 0);
        let flags = 0;
        if (c.skin) flags |= 1;
        flags |= positionMode << 1;
        flags |= spacingMode << 2;
        flags |= rotateMode << 4;
        if (offsetRotation !== 0) flags |= 128;
        body.byte(flags);
        if (flags & 128) body.float(offsetRotation);
        body.float(num(c.position, 0));
        body.float(num(c.spacing, 0));
        const mixX = num(c.mixX, 1);
        body.float(num(c.mixRotate, 1));
        body.float(mixX);
        body.float(num(c.mixY, mixX));
        break;
      }
      case 'physics': {
        body.byte(3);
        body.varint(bone(c.bone), true);
        const limit = num(c.limit, 5000);
        const mass = num(c.mass, 1);
        // The reader tells the scale mode from the sign of scaleX (uniform: -1 - x, volume: -2 - x, so x must be above 0 for volume and
        // at most 1 for uniform). A mode with no scale does nothing, so it is left out.
        const scaleX = num(c.scaleX, 0);
        let scaleYMode = c.scaleY !== undefined ? Math.max(0, SCALE_Y.indexOf(c.scaleY)) : 0;
        if (scaleX <= 0 && scaleYMode !== 0) scaleYMode = 0;
        const scaleXWritten = scaleYMode === 1 ? Math.min(scaleX, 1) : scaleX;
        let flags = 0;
        if (c.skin) flags |= 1;
        if (num(c.x, 0) !== 0) flags |= 2;
        if (num(c.y, 0) !== 0) flags |= 4;
        if (num(c.rotate, 0) !== 0) flags |= 8;
        if (scaleX !== 0) flags |= 16;
        if (num(c.shearX, 0) !== 0) flags |= 32;
        if (limit !== 5000) flags |= 64;
        if (mass !== 1) flags |= 128;
        body.byte(flags);
        if (flags & 2) body.float(num(c.x, 0));
        if (flags & 4) body.float(num(c.y, 0));
        if (flags & 8) body.float(num(c.rotate, 0));
        if (flags & 16) body.float(scaleYMode === 2 ? -2 - scaleXWritten : scaleYMode === 1 ? -1 - scaleXWritten : scaleXWritten);
        if (flags & 32) body.float(num(c.shearX, 0));
        if (flags & 64) body.float(limit);
        body.byte(Math.round(num(c.fps, 60)));
        body.float(num(c.inertia, 0.5));
        body.float(num(c.strength, 100));
        body.float(num(c.damping, 0.85));
        if (flags & 128) body.float(1 / mass);
        body.float(num(c.wind, 0));
        body.float(num(c.gravity, 0));
        const mix = num(c.mix, 1);
        let global = 0;
        (['inertia', 'strength', 'damping', 'mass', 'wind', 'gravity', 'mix'] as const).forEach((p, i) => {
          if (c[`${p}Global`]) global |= 1 << i;
        });
        if (mix !== 1) global |= 128;
        body.byte(global);
        if (global & 128) body.float(mix);
        break;
      }
      case 'slider': {
        body.byte(4);
        const driven = c.bone !== undefined;
        const mix = num(c.mix, 1);
        const value = driven ? num(c.max, 0) : num(c.time, 0);
        const hasValue = nonessential && driven ? value !== 0 : !driven && value !== 0;
        let flags = 0;
        if (c.skin) flags |= 1;
        if (c.loop) flags |= 2;
        if (c.additive) flags |= 4;
        if (hasValue) flags |= 8;
        if (mix !== 0) flags |= 16;
        if (mix !== 0 && mix !== 1) flags |= 32;
        if (driven) flags |= 64;
        if (driven && c.local) flags |= 128;
        body.byte(flags);
        if (flags & 8) body.float(value);
        if (flags & 32) body.float(mix);
        if (driven) {
          body.varint(bone(c.bone), true);
          body.float(num(c.from, 0));
          body.byte(Math.max(0, FROM_PROP.indexOf(c.property)));
          body.float(num(c.to, 0));
          body.float(num(c.scale, 1));
        }
        break;
      }
      default:
        throw new Error(`Binary export: unknown constraint type "${c.type}"`);
    }
  }

  const defaultSkin = skins.find((s) => s.name === 'default') ?? skins[0];
  const otherSkins = skins.filter((s) => s !== defaultSkin);
  const skinWriter = (skin: J, isDefault: boolean) => {
    const attachments: [string, Record<string, J>][] = Object.entries(skin.attachments ?? {});
    if (isDefault) body.varint(attachments.length, true);
    else {
      body.string(skin.name);
      if (nonessential) body.int32(rgba8888(hexBytes(skin.color, [0xfe, 0x9e, 0x4f, 255])));
      body.varint((skin.bones ?? []).length, true);
      for (const b of skin.bones ?? []) body.varint(bone(b), true);
      const list: number[] = [];
      for (const type of ['ik', 'transform', 'path', 'physics', 'slider'])
        for (const name of skin[type] ?? []) list.push(constraint(type, name));
      body.varint(list.length, true);
      for (const i of list) body.varint(i, true);
      body.varint(attachments.length, true);
    }
    for (const [slotName, perSlot] of attachments) {
      body.varint(slot(slotName), true);
      const entries = Object.entries(perSlot);
      body.varint(entries.length, true);
      for (const [placeholder, att] of entries) {
        ref(body, placeholder);
        writeAttachment(att, placeholder, slotName, skin.name);
      }
    }
  };

  const writeVertices = (vertexCount: number, vertices: number[], weighted: boolean) => {
    body.varint(vertexCount, true);
    if (!weighted) {
      for (let i = 0; i < vertexCount * 2; i++) body.float(num(vertices[i], 0));
      return;
    }
    // [count, (bone, x, y, weight) * count] per vertex
    let entries = 0;
    for (let i = 0; i < vertices.length;) {
      const n = vertices[i];
      entries += 1 + n;
      i += 1 + n * 4;
    }
    body.varint(entries, true);
    for (let i = 0; i < vertices.length;) {
      const n = vertices[i++];
      body.varint(n, true);
      for (let k = 0; k < n; k++, i += 4) {
        body.varint(vertices[i], true);
        body.float(vertices[i + 1]);
        body.float(vertices[i + 2]);
        body.float(vertices[i + 3]);
      }
    }
  };
  const isWeighted = (vertices: number[], vertexCount: number) => vertices.length !== vertexCount * 2;

  const writeSequence = (s: J) => {
    body.varint(num(s.count, 1), true);
    body.varint(num(s.start, 1), true);
    body.varint(num(s.digits, 0), true);
    body.varint(num(s.setup, 0), true);
  };

  // the slots (other than their own) that show a linked mesh sharing the deform of a mesh: the loader of the binary format reads
  // them from the source mesh (the JSON loader works them out itself)
  const followerSlots = new Map<string, Set<number>>();
  for (const skin of skins) {
    for (const [slotName, perSlot] of Object.entries<Record<string, J>>(skin.attachments ?? {})) {
      for (const att of Object.values(perSlot)) {
        if (att.type !== 'linkedmesh' || att.timelines === false) continue;
        const sourceSlot: string = att.slot ?? slotName;
        if (sourceSlot === slotName) continue;
        const key = `${att.skin ?? defaultSkin.name}|${sourceSlot}|${att.source}`;
        const set = followerSlots.get(key) ?? new Set<number>();
        set.add(slot(slotName));
        followerSlots.set(key, set);
      }
    }
  }

  const writeAttachment = (att: J, placeholder: string, slotName: string, skinName: string) => {
    const name: string = att.name ?? placeholder;
    const type: string = att.type ?? 'region';
    const color = att.color !== undefined ? rgba8888(hexBytes(att.color, [255, 255, 255, 255])) : null;
    const whiteColor = 0xffffffff | 0;
    const hasName = name !== placeholder ? 8 : 0;
    switch (type) {
      case 'region': {
        const path: string = att.path ?? name;
        const hasPath = path !== name;
        const rotation = num(att.rotation, 0);
        const colorValue = color ?? whiteColor;
        let flags = 0 | hasName;
        if (hasPath) flags |= 16;
        if (colorValue !== whiteColor) flags |= 32;
        if (att.sequence) flags |= 64;
        if (rotation !== 0) flags |= 128;
        body.byte(flags);
        if (flags & 8) ref(body, name);
        if (flags & 16) ref(body, path);
        if (flags & 32) body.int32(colorValue);
        if (flags & 64) writeSequence(att.sequence);
        if (flags & 128) body.float(rotation);
        body.float(num(att.x, 0));
        body.float(num(att.y, 0));
        body.float(num(att.scaleX, 1));
        body.float(num(att.scaleY, 1));
        body.float(num(att.width, 0));
        body.float(num(att.height, 0));
        break;
      }
      case 'mesh': {
        const path: string = att.path ?? name;
        const uvs: number[] = att.uvs ?? [];
        const vertexCount = uvs.length >> 1;
        const vertices: number[] = att.vertices ?? [];
        const weighted = isWeighted(vertices, vertexCount);
        const triangles: number[] = att.triangles ?? [];
        const colorValue = color ?? whiteColor;
        let flags = 2 | hasName;
        if (path !== name) flags |= 16;
        if (colorValue !== whiteColor) flags |= 32;
        if (att.sequence) flags |= 64;
        if (weighted) flags |= 128;
        body.byte(flags);
        if (flags & 8) ref(body, name);
        if (flags & 16) ref(body, path);
        if (flags & 32) body.int32(colorValue);
        if (flags & 64) writeSequence(att.sequence);
        // the reader derives the triangle count from the hull: (2 * vertices - hull - 2) triangles
        let hull = num(att.hull, 0);
        const expected = 2 * vertexCount - hull - 2;
        if (triangles.length / 3 !== expected) hull = Math.max(0, 2 * vertexCount - 2 - triangles.length / 3);
        body.varint(hull, true);
        writeVertices(vertexCount, vertices, weighted);
        for (const v of uvs) body.float(v);
        for (const t of triangles.slice(0, Math.max(0, (2 * vertexCount - hull - 2) * 3))) body.varint(t, true);
        for (let i = triangles.length; i < (2 * vertexCount - hull - 2) * 3; i++) body.varint(0, true);
        const followers = [...(followerSlots.get(`${skinName}|${slotName}|${placeholder}`) ?? [])];
        body.varint(followers.length, true); // timeline slots
        for (const s of followers) body.varint(s, true);
        if (nonessential) {
          const edges: number[] = att.edges ?? []; // the manual edges (editor data)
          body.varint(edges.length, true);
          for (const e of edges) body.varint(e, true);
          body.float(num(att.width, 0));
          body.float(num(att.height, 0));
        }
        break;
      }
      case 'linkedmesh': {
        const path: string = att.path ?? name;
        const colorValue = color ?? whiteColor;
        let flags = 3 | hasName;
        if (path !== name) flags |= 16;
        if (colorValue !== whiteColor) flags |= 32;
        if (att.sequence) flags |= 64;
        if (att.timelines !== false) flags |= 128;
        body.byte(flags);
        if (flags & 8) ref(body, name);
        if (flags & 16) ref(body, path);
        if (flags & 32) body.int32(colorValue);
        if (flags & 64) writeSequence(att.sequence);
        body.varint(slot(att.slot ?? slotName), true);
        const sourceSkin = skinIndex.get(att.skin ?? defaultSkin.name);
        if (sourceSkin === undefined) throw new Error(`Binary export: unknown skin "${att.skin}"`);
        body.varint(sourceSkin, true);
        ref(body, att.source);
        if (nonessential) {
          body.float(num(att.width, 0));
          body.float(num(att.height, 0));
        }
        break;
      }
      case 'boundingbox':
      case 'clipping': {
        const vertexCount = num(att.vertexCount, 0);
        const vertices: number[] = att.vertices ?? [];
        const weighted = isWeighted(vertices, vertexCount);
        let flags = (type === 'boundingbox' ? 1 : 6) | hasName;
        if (weighted) flags |= 16;
        if (type === 'clipping') {
          if (att.convex) flags |= 32;
          if (att.inverse) flags |= 64;
        }
        body.byte(flags);
        if (flags & 8) ref(body, name);
        if (type === 'clipping') {
          // without an end slot the clip runs to the end of the draw order; the format has no "none", so it ends at the last slot
          body.varint(att.end !== undefined ? slot(att.end) : Math.max(0, slots.length - 1), true);
        }
        writeVertices(vertexCount, vertices, weighted);
        if (nonessential) body.int32(rgba8888(hexBytes(att.color, type === 'clipping' ? [0xce, 0x3a, 0x3a, 255] : [0x61, 0xf0, 0, 255])));
        break;
      }
      case 'path': {
        const vertexCount = num(att.vertexCount, 0);
        const vertices: number[] = att.vertices ?? [];
        const weighted = isWeighted(vertices, vertexCount);
        let flags = 4 | hasName;
        if (att.closed) flags |= 16;
        if (att.constantSpeed !== false) flags |= 32;
        if (weighted) flags |= 64;
        body.byte(flags);
        if (flags & 8) ref(body, name);
        writeVertices(vertexCount, vertices, weighted);
        const lengths: number[] = att.lengths ?? [];
        for (let i = 0; i < vertexCount / 3; i++) body.float(num(lengths[i], 0));
        if (nonessential) body.int32(rgba8888(hexBytes(att.color, [255, 128, 0, 255])));
        break;
      }
      case 'point': {
        body.byte(5 | hasName);
        if (hasName) ref(body, name);
        body.float(num(att.rotation, 0));
        body.float(num(att.x, 0));
        body.float(num(att.y, 0));
        if (nonessential) body.int32(rgba8888(hexBytes(att.color, [0xf1, 0xf1, 0, 255])));
        break;
      }
      default:
        throw new Error(`Binary export: unknown attachment type "${type}"`);
    }
  };

  if (defaultSkin) skinWriter(defaultSkin, true);
  else body.varint(0, true);
  body.varint(otherSkins.length, true);
  for (const s of otherSkins) skinWriter(s, false);

  const eventDefs: J = json.events ?? {};
  body.varint(eventNames.length, true);
  for (const name of eventNames) {
    const e = eventDefs[name];
    body.string(name);
    body.varint(num(e.int, 0), false);
    body.float(num(e.float, 0));
    body.string(e.string ?? '');
    body.string(e.audio ?? null);
    if (e.audio) {
      body.float(num(e.volume, 1));
      body.float(num(e.balance, 0));
    }
  }

  body.varint(animationNames.length, true);
  for (const name of animationNames) {
    body.string(name);
    writeAnimation(body, json.animations[name]);
  }
  for (const c of constraints) if (c.type === 'slider') body.varint(animationIndex.get(c.animation) ?? 0, true);

  function writeAnimation(out: Out, a: J) {
    const timelines = new Out();
    let count = 0;

    /** keys of one value timeline: time, values..., curve, in the reader's order. */
    const valueTimeline = (keys: J[], channels: number, fields: string[], scale = (v: number) => v) => {
      const first = keys[0];
      out2.float(num(first.time, 0));
      for (let c = 0; c < channels; c++) out2.float(scale(num(first[fields[c]], 0)));
      for (let i = 1; i < keys.length; i++) {
        out2.float(num(keys[i].time, 0));
        for (let c = 0; c < channels; c++) out2.float(scale(num(keys[i][fields[c]], 0)));
        writeCurve(out2, keys[i - 1], channels);
      }
    };
    const out2 = timelines;

    /** Colors: 4 (or 3 / 7) bytes per key. */
    const colorTimeline = (keys: J[], channels: number, bytesOf: (k: J) => number[]) => {
      out2.float(num(keys[0].time, 0));
      for (const b of bytesOf(keys[0])) out2.byte(b);
      for (let i = 1; i < keys.length; i++) {
        out2.float(num(keys[i].time, 0));
        for (const b of bytesOf(keys[i])) out2.byte(b);
        writeCurve(out2, keys[i - 1], channels);
      }
    };

    // slots
    const slotAnims = Object.entries<J>(a.slots ?? {});
    out2.varint(slotAnims.length, true);
    for (const [slotName, tl] of slotAnims) {
      out2.varint(slot(slotName), true);
      const kinds = ['attachment', 'rgba', 'rgb', 'alpha', 'rgba2'].filter((k) => tl[k]?.length);
      out2.varint(kinds.length, true);
      for (const kind of kinds) {
        const keys: J[] = tl[kind];
        count++;
        if (kind === 'attachment') {
          out2.byte(0);
          out2.varint(keys.length, true);
          for (const k of keys) {
            out2.float(num(k.time, 0));
            ref(out2, k.name ?? null);
          }
        } else if (kind === 'rgb') {
          out2.byte(2);
          out2.varint(keys.length, true);
          out2.varint(bezierCount(keys, 3), true);
          colorTimeline(keys, 3, (k) => hexBytes(k.color, [255, 255, 255, 255]).slice(0, 3));
        } else if (kind === 'alpha') {
          out2.byte(5);
          out2.varint(keys.length, true);
          out2.varint(bezierCount(keys, 1), true);
          colorTimeline(keys, 1, (k) => [Math.max(0, Math.min(255, Math.round(num(k.value, 0) * 255)))]);
        } else if (kind === 'rgba') {
          out2.byte(1);
          out2.varint(keys.length, true);
          out2.varint(bezierCount(keys, 4), true);
          colorTimeline(keys, 4, (k) => hexBytes(k.color, [255, 255, 255, 255]));
        } else {
          out2.byte(3);
          out2.varint(keys.length, true);
          out2.varint(bezierCount(keys, 7), true);
          colorTimeline(keys, 7, (k) => [...hexBytes(k.light, [255, 255, 255, 255]), ...hexBytes(k.dark, [0, 0, 0, 255]).slice(0, 3)]);
        }
      }
    }

    // bones
    const boneAnims = Object.entries<J>(a.bones ?? {});
    out2.varint(boneAnims.length, true);
    for (const [boneName, tl] of boneAnims) {
      out2.varint(bone(boneName), true);
      const kinds: [string, number, number, string[]][] = [
        ['rotate', 0, 1, ['value']],
        ['translate', 1, 2, ['x', 'y']],
        ['translatex', 2, 1, ['value']],
        ['translatey', 3, 1, ['value']],
        ['scale', 4, 2, ['x', 'y']],
        ['scalex', 5, 1, ['value']],
        ['scaley', 6, 1, ['value']],
        ['shear', 7, 2, ['x', 'y']],
        ['shearx', 8, 1, ['value']],
        ['sheary', 9, 1, ['value']],
      ];
      const present = kinds.filter(([k]) => tl[k]?.length);
      out2.varint(present.length, true);
      for (const [kind, type, channels, fields] of present) {
        const keys: J[] = tl[kind];
        count++;
        out2.byte(type);
        out2.varint(keys.length, true);
        out2.varint(bezierCount(keys, channels), true);
        valueTimeline(keys, channels, fields);
      }
    }

    // ik
    const ikAnims = Object.entries<J>(a.ik ?? {});
    out2.varint(ikAnims.length, true);
    for (const [cname, keys] of ikAnims as [string, J[]][]) {
      count++;
      out2.varint(constraint('ik', cname), true);
      out2.varint(keys.length, true);
      out2.varint(bezierCount(keys, 2), true);
      const flagsOf = (k: J, curve: J) => {
        const mix = num(k.mix, 1);
        const softness = num(k.softness, 0);
        let f = 0;
        if (mix !== 0) f |= 1;
        if (mix !== 0 && mix !== 1) f |= 2;
        if (softness !== 0) f |= 4;
        if (k.bendPositive !== false) f |= 8;
        if (k.compress) f |= 16;
        if (k.stretch) f |= 32;
        if (curve === 'stepped') f |= 64;
        else if (isBezier(curve)) f |= 128;
        return f;
      };
      const writeKey = (k: J, flags: number) => {
        out2.float(num(k.time, 0));
        if (flags & 2) out2.float(num(k.mix, 1));
        if (flags & 4) out2.float(num(k.softness, 0));
      };
      let flags = flagsOf(keys[0], undefined);
      out2.byte(flags & 63);
      writeKey(keys[0], flags);
      for (let i = 1; i < keys.length; i++) {
        flags = flagsOf(keys[i], keys[i - 1].curve);
        out2.byte(flags);
        writeKey(keys[i], flags);
        if (flags & 128) for (let j = 0; j < 8; j++) out2.float(num(keys[i - 1].curve[j], 0));
      }
    }

    // transform
    const transformAnims = Object.entries<J>(a.transform ?? {});
    out2.varint(transformAnims.length, true);
    for (const [cname, keys] of transformAnims as [string, J[]][]) {
      count++;
      out2.varint(constraint('transform', cname), true);
      out2.varint(keys.length, true);
      out2.varint(bezierCount(keys, 6), true);
      valueTimeline(keys, 6, ['mixRotate', 'mixX', 'mixY', 'mixScaleX', 'mixScaleY', 'mixShearY']);
    }

    // path
    const pathAnims = Object.entries<J>(a.path ?? {});
    out2.varint(pathAnims.length, true);
    for (const [cname, tl] of pathAnims) {
      out2.varint(constraint('path', cname), true);
      const kinds: [string, number, number, string[]][] = [
        ['position', 0, 1, ['value']],
        ['spacing', 1, 1, ['value']],
        ['mix', 2, 3, ['mixRotate', 'mixX', 'mixY']],
      ];
      const present = kinds.filter(([k]) => tl[k]?.length);
      out2.varint(present.length, true);
      for (const [kind, type, channels, fields] of present) {
        const keys: J[] = tl[kind];
        count++;
        out2.byte(type);
        out2.varint(keys.length, true);
        out2.varint(bezierCount(keys, channels), true);
        valueTimeline(keys, channels, fields);
      }
    }

    // physics (the constraint index is shifted by one: 0 is "every constraint")
    const physicsAnims = Object.entries<J>(a.physics ?? {});
    out2.varint(physicsAnims.length, true);
    for (const [cname, tl] of physicsAnims) {
      out2.varint(cname === '' ? 0 : constraint('physics', cname) + 1, true);
      const present = Object.keys(PHYSICS_TYPE).filter((p) => tl[p]?.length);
      const hasReset = tl.reset?.length > 0;
      out2.varint(present.length + (hasReset ? 1 : 0), true);
      for (const p of present) {
        const keys: J[] = tl[p];
        count++;
        out2.byte(PHYSICS_TYPE[p]);
        out2.varint(keys.length, true);
        out2.varint(bezierCount(keys, 1), true);
        valueTimeline(keys, 1, ['value'], p === 'mass' ? (v) => v : (v) => v);
      }
      if (hasReset) {
        count++;
        out2.byte(PHYSICS_RESET);
        out2.varint(tl.reset.length, true);
        for (const k of tl.reset) out2.float(num(k.time, 0));
      }
    }

    // sliders
    const sliderAnims = Object.entries<J>(a.slider ?? {});
    out2.varint(sliderAnims.length, true);
    for (const [cname, tl] of sliderAnims) {
      out2.varint(constraint('slider', cname), true);
      const present = (['time', 'mix'] as const).filter((k) => tl[k]?.length);
      out2.varint(present.length, true);
      for (const kind of present) {
        const keys: J[] = tl[kind];
        count++;
        out2.byte(kind === 'time' ? 0 : 1);
        out2.varint(keys.length, true);
        out2.varint(bezierCount(keys, 1), true);
        valueTimeline(keys, 1, ['value']);
      }
    }

    // deform: skin -> slot -> attachment
    const deformSkins = Object.entries<J>(a.attachments ?? {});
    out2.varint(deformSkins.length, true);
    for (const [skinName, perSlot] of deformSkins) {
      const si = skinIndex.get(skinName);
      if (si === undefined) throw new Error(`Binary export: unknown skin "${skinName}"`);
      out2.varint(si, true);
      const slotsList = Object.entries<J>(perSlot);
      out2.varint(slotsList.length, true);
      for (const [slotName, perAtt] of slotsList) {
        out2.varint(slot(slotName), true);
        // every attachment has one entry per kind of timeline: deform (0) and sequence (1)
        const atts: [string, 'deform' | 'sequence', J[]][] = [];
        for (const [attName, tl] of Object.entries<J>(perAtt)) {
          if (tl.deform) atts.push([attName, 'deform', tl.deform]);
          if (tl.sequence) atts.push([attName, 'sequence', tl.sequence]);
        }
        out2.varint(atts.length, true);
        for (const [attName, kind, keys] of atts) {
          ref(out2, attName);
          count++;
          if (kind === 'sequence') {
            out2.byte(1);
            out2.varint(keys.length, true);
            for (const k of keys) {
              out2.float(num(k.time, 0));
              out2.int32(Math.max(0, SEQUENCE_MODE.indexOf(k.mode ?? 'hold')) | (num(k.index, 0) << 4));
              out2.float(num(k.delay, 0));
            }
            continue;
          }
          out2.byte(0);
          out2.varint(keys.length, true);
          out2.varint(bezierCount(keys, 1), true);
          out2.float(num(keys[0].time, 0));
          for (let i = 0; i < keys.length; i++) {
            const verts: number[] = keys[i].vertices ?? [];
            out2.varint(verts.length, true);
            if (verts.length > 0) {
              out2.varint(num(keys[i].offset, 0), true);
              for (const v of verts) out2.float(v);
            }
            if (i === keys.length - 1) break;
            out2.float(num(keys[i + 1].time, 0));
            writeCurve(out2, keys[i], 1);
          }
        }
      }
    }

    // draw order
    const draw: J[] = a.drawOrder ?? [];
    out2.varint(draw.length, true);
    if (draw.length > 0) count++;
    for (const k of draw) {
      out2.float(num(k.time, 0));
      const offsets: J[] = (k.offsets ?? []).map((o: J) => ({ index: slot(o.slot), offset: o.offset }));
      offsets.sort((x, y) => x.index - y.index);
      out2.varint(offsets.length, true);
      for (const o of offsets) {
        out2.varint(o.index, true);
        out2.varint(o.offset, true);
      }
    }
    // draw order folders: the slots of the folder (global indices), then keys whose offsets index the folder's own list
    const folders: J[] = a.drawOrderFolder ?? [];
    out2.varint(folders.length, true);
    if (folders.length > 0) count += folders.length;
    for (const f of folders) {
      const members: string[] = f.slots ?? [];
      out2.varint(members.length, true);
      for (const name of members) out2.varint(slot(name), true);
      const keys: J[] = f.keys ?? [];
      out2.varint(keys.length, true);
      for (const k of keys) {
        out2.float(num(k.time, 0));
        const offsets: J[] = (k.offsets ?? []).map((o: J) => ({ index: members.indexOf(o.slot), offset: o.offset }));
        offsets.sort((x, y) => x.index - y.index);
        out2.varint(offsets.length, true);
        for (const o of offsets) {
          out2.varint(o.index, true);
          out2.varint(o.offset, true);
        }
      }
    }

    // events
    const events: J[] = a.events ?? [];
    out2.varint(events.length, true);
    if (events.length > 0) count++;
    for (const k of events) {
      const di = eventIndex.get(k.name);
      if (di === undefined) throw new Error(`Binary export: unknown event "${k.name}"`);
      const def = eventDefs[k.name];
      out2.float(num(k.time, 0));
      out2.varint(di, true);
      out2.varint(num(k.int, num(def.int, 0)), false);
      out2.float(num(k.float, num(def.float, 0)));
      out2.string(k.string ?? null);
      if (def.audio) {
        out2.float(num(k.volume, num(def.volume, 1)));
        out2.float(num(k.balance, num(def.balance, 0)));
      }
    }

    out.varint(count, true);
    out.raw(timelines);
    if (nonessential) out.int32(rgba8888([255, 255, 255, 255]));
  }

  const head = new Out();
  const hash = decodeHash(skeleton.hash);
  head.int32(hash.low);
  head.int32(hash.high);
  head.string(skeleton.spine ?? '4.3.13');
  head.float(num(skeleton.x, 0));
  head.float(num(skeleton.y, 0));
  head.float(num(skeleton.width, 0));
  head.float(num(skeleton.height, 0));
  head.float(num(skeleton.referenceScale, 100));
  head.bool(nonessential);
  if (nonessential) {
    head.float(num(skeleton.fps, 30));
    head.string(skeleton.images ?? null);
    head.string(skeleton.audio ?? null);
  }
  head.varint(table.length, true);
  for (const s of table) head.string(s);
  head.raw(body);
  return head.bytes();
}

/** The two 32-bit halves of the hash the exporter wrote (base64 of 8 bytes); zero when there is none. */
function decodeHash(hash: unknown): { low: number; high: number } {
  if (typeof hash !== 'string' || !hash) return { low: 0, high: 0 };
  try {
    const b64 = hash.replace(/-/g, '+').replace(/_/g, '/');
    const raw =
      typeof atob === 'function' ? atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)) : Buffer.from(b64, 'base64').toString('binary');
    const bytes = Array.from(raw, (c) => c.charCodeAt(0));
    while (bytes.length < 8) bytes.push(0);
    const int = (o: number) => (bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3] | 0;
    return { low: int(0), high: int(4) };
  } catch {
    return { low: 0, high: 0 };
  }
}

/** Exports a skeleton as Spine 4.3 binary data (the contents of a .skel file). */
export function exportSpineBinary(doc: SkeletonDoc, options: SpineExportOptions = {}): Uint8Array {
  return jsonToBinary(exportSpineJson(doc, options));
}
