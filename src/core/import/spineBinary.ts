/**
 * Spine 4.3 binary (`.skel`) reader. It does not build a skeleton itself: it turns the binary into the JSON the official 4.3 loader
 * reads (and Bone 2D's importSpineJson understands), so every feature of the JSON import — conversions, warnings, linked meshes —
 * applies to binary files too. The layout is read field by field in the order of the official `SkeletonBinary`.
 */

type J = any;

const INHERIT = ['normal', 'onlyTranslation', 'noRotationOrReflection', 'noScale', 'noScaleOrReflection'];
const BLEND = ['normal', 'additive', 'multiply', 'screen'];
const SCALE_Y = ['none', 'uniform', 'volume'];
const POSITION_MODE = ['fixed', 'percent'];
const SPACING_MODE = ['length', 'fixed', 'percent', 'proportional'];
const ROTATE_MODE = ['tangent', 'chain', 'chainScale'];
const PROP = ['rotate', 'x', 'y', 'scaleX', 'scaleY', 'shearY'];
const SEQUENCE_MODE = ['hold', 'once', 'loop', 'pingpong', 'onceReverse', 'loopReverse', 'pingpongReverse'];
const PHYSICS_NAME: Record<number, string> = { 0: 'inertia', 1: 'strength', 2: 'damping', 4: 'mass', 5: 'wind', 6: 'gravity', 7: 'mix' };

class In {
  private view: DataView;
  index = 0;
  strings: string[] = [];
  constructor(data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  private check(n: number) {
    if (this.index + n > this.view.byteLength) throw new Error('The binary file is cut off or damaged');
  }
  byte(): number {
    this.check(1);
    return this.view.getInt8(this.index++);
  }
  ubyte(): number {
    this.check(1);
    return this.view.getUint8(this.index++);
  }
  int32(): number {
    this.check(4);
    const v = this.view.getInt32(this.index);
    this.index += 4;
    return v;
  }
  float(): number {
    this.check(4);
    const v = this.view.getFloat32(this.index);
    this.index += 4;
    return v;
  }
  bool(): boolean {
    return this.byte() !== 0;
  }
  varint(positive: boolean): number {
    let b = this.byte();
    let result = b & 0x7f;
    if (b & 0x80) {
      b = this.byte();
      result |= (b & 0x7f) << 7;
      if (b & 0x80) {
        b = this.byte();
        result |= (b & 0x7f) << 14;
        if (b & 0x80) {
          b = this.byte();
          result |= (b & 0x7f) << 21;
          if (b & 0x80) {
            b = this.byte();
            result |= (b & 0x7f) << 28;
          }
        }
      }
    }
    return positive ? result : (result >>> 1) ^ -(result & 1);
  }
  ref(): string | null {
    const i = this.varint(true);
    if (i === 0) return null;
    const s = this.strings[i - 1];
    if (s === undefined) throw new Error('The binary file refers to a string that is not in its table');
    return s;
  }
  string(): string | null {
    let count = this.varint(true);
    if (count === 0) return null;
    if (count === 1) return '';
    count--;
    let out = '';
    for (let i = 0; i < count;) {
      const b = this.ubyte();
      switch (b >> 4) {
        case 12:
        case 13:
          out += String.fromCharCode(((b & 0x1f) << 6) | (this.byte() & 0x3f));
          i += 2;
          break;
        case 14:
          out += String.fromCharCode(((b & 0x0f) << 12) | ((this.byte() & 0x3f) << 6) | (this.byte() & 0x3f));
          i += 3;
          break;
        default:
          out += String.fromCharCode(b);
          i++;
      }
    }
    return out;
  }
}

/** The shortest decimal that is the same 32-bit float, so a value read from the file is exactly the value the official reader gets. */
const f = (v: number): number => {
  if (!Number.isFinite(v)) return 0;
  for (let digits = 1; digits < 9; digits++) {
    const r = +v.toPrecision(digits);
    if (Math.fround(r) === v) return r;
  }
  return +v.toPrecision(9);
};

function hex(v: number, alpha: boolean): string {
  const u = v >>> 0;
  const s = u.toString(16).padStart(8, '0');
  return alpha ? s : s.slice(2);
}
const hexBytes = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join('');

function nameOf<T extends { name: string }>(list: T[], i: number, what: string): string {
  const item = list[i];
  if (!item) throw new Error(`The binary file refers to a ${what} that does not exist (index ${i})`);
  return item.name;
}

/** Reads the binary data into the JSON structure the official 4.3 loader expects. */
export function binaryToJson(data: Uint8Array): J {
  const input = new In(data);
  const low = input.int32();
  const high = input.int32();
  const version = input.string() ?? '';
  if (!/^4\.3(\.|$)/.test(version)) {
    throw new Error(
      `This binary file is Spine ${version || '(unknown version)'}; only 4.3 binary files can be read. Export JSON from Spine, or save the file as 4.3.`,
    );
  }
  const skeleton: J = { hash: low === 0 && high === 0 ? '' : high.toString(16) + low.toString(16), spine: version };
  skeleton.x = f(input.float());
  skeleton.y = f(input.float());
  skeleton.width = f(input.float());
  skeleton.height = f(input.float());
  skeleton.referenceScale = f(input.float());
  const nonessential = input.bool();
  if (nonessential) {
    skeleton.fps = f(input.float());
    skeleton.images = input.string() ?? '';
    skeleton.audio = input.string() ?? '';
  }
  const stringCount = input.varint(true);
  for (let i = 0; i < stringCount; i++) {
    const s = input.string();
    if (!s) throw new Error('A string in the string table must not be empty');
    input.strings.push(s);
  }

  const bones: J[] = [];
  const boneCount = input.varint(true);
  for (let i = 0; i < boneCount; i++) {
    const name = input.string();
    if (!name) throw new Error('A bone has no name');
    const b: J = { name };
    if (i > 0) b.parent = nameOf(bones, input.varint(true), 'bone');
    b.rotation = f(input.float());
    b.x = f(input.float());
    b.y = f(input.float());
    b.scaleX = f(input.float());
    b.scaleY = f(input.float());
    b.shearX = f(input.float());
    b.shearY = f(input.float());
    b.inherit = INHERIT[input.byte()] ?? 'normal';
    b.length = f(input.float());
    if (input.bool()) b.skin = true;
    if (nonessential) {
      b.color = hex(input.int32(), true);
      const icon = input.string();
      if (icon) b.icon = icon;
      const iconSize = f(input.float());
      if (iconSize !== 1) b.iconSize = iconSize;
      const iconRotation = f(input.float());
      if (iconRotation !== 0) b.iconRotation = iconRotation;
      if (!input.bool()) b.visible = false;
    }
    bones.push(b);
  }

  const slots: J[] = [];
  const slotCount = input.varint(true);
  for (let i = 0; i < slotCount; i++) {
    const name = input.string();
    if (!name) throw new Error('A slot has no name');
    const s: J = { name, bone: nameOf(bones, input.varint(true), 'bone') };
    s.color = hex(input.int32(), true);
    const dark = input.int32();
    if (dark !== -1) s.dark = hex(dark, false);
    const attachment = input.ref();
    if (attachment) s.attachment = attachment;
    s.blend = BLEND[input.varint(true)] ?? 'normal';
    if (nonessential && !input.bool()) s.visible = false;
    slots.push(s);
  }

  const constraints: J[] = [];
  const constraintCount = input.varint(true);
  for (let i = 0; i < constraintCount; i++) {
    const name = input.string();
    if (!name) throw new Error('A constraint has no name');
    const type = input.byte();
    switch (type) {
      case 0: {
        const c: J = { type: 'ik', name, bones: [] };
        for (let n = input.varint(true); n > 0; n--) c.bones.push(nameOf(bones, input.varint(true), 'bone'));
        c.target = nameOf(bones, input.varint(true), 'bone');
        const flags = input.byte() & 255;
        if (flags & 1) c.skin = true;
        if (flags & 2) c.scaleY = SCALE_Y[input.ubyte()] ?? 'none';
        c.bendPositive = (flags & 4) === 0;
        c.compress = (flags & 8) !== 0;
        c.stretch = (flags & 16) !== 0;
        c.mix = flags & 32 ? (flags & 64 ? f(input.float()) : 1) : 0;
        c.softness = flags & 128 ? f(input.float()) : 0;
        constraints.push(c);
        break;
      }
      case 2: {
        const c: J = { type: 'transform', name, bones: [] };
        for (let n = input.varint(true); n > 0; n--) c.bones.push(nameOf(bones, input.varint(true), 'bone'));
        c.source = nameOf(bones, input.varint(true), 'bone');
        let flags = input.ubyte();
        if (flags & 1) c.skin = true;
        if (flags & 2) c.localSource = true;
        if (flags & 4) c.localTarget = true;
        if (flags & 8) c.additive = true;
        if (flags & 16) c.clamp = true;
        const properties: J = {};
        const used = new Set<string>();
        for (let n = flags >> 5; n > 0; n--) {
          const from = PROP[input.byte()];
          const entry: J = { offset: f(input.float()), to: {} };
          for (let t = input.byte(); t > 0; t--) {
            const to = PROP[input.byte()];
            used.add(to);
            entry.to[to] = { offset: f(input.float()), max: f(input.float()), scale: f(input.float()) };
          }
          if (from) properties[from] = entry;
        }
        c.properties = properties;
        flags = input.byte();
        const offsets = ['rotation', 'x', 'y', 'scaleX', 'scaleY', 'shearY'];
        offsets.forEach((key, k) => {
          if (flags & (1 << k)) c[key] = f(input.float());
        });
        flags = input.byte();
        ['mixRotate', 'mixX', 'mixY', 'mixScaleX', 'mixScaleY', 'mixShearY'].forEach((key, k) => {
          if (flags & (1 << k)) c[key] = f(input.float());
        });
        constraints.push(c);
        break;
      }
      case 1: {
        const c: J = { type: 'path', name, bones: [] };
        for (let n = input.varint(true); n > 0; n--) c.bones.push(nameOf(bones, input.varint(true), 'bone'));
        c.slot = nameOf(slots, input.varint(true), 'slot');
        const flags = input.byte() & 255;
        if (flags & 1) c.skin = true;
        c.positionMode = POSITION_MODE[(flags >> 1) & 1];
        c.spacingMode = SPACING_MODE[(flags >> 2) & 3];
        c.rotateMode = ROTATE_MODE[(flags >> 4) & 3] ?? 'tangent';
        if (flags & 128) c.rotation = f(input.float());
        c.position = f(input.float());
        c.spacing = f(input.float());
        c.mixRotate = f(input.float());
        c.mixX = f(input.float());
        c.mixY = f(input.float());
        constraints.push(c);
        break;
      }
      case 3: {
        const c: J = { type: 'physics', name, bone: nameOf(bones, input.varint(true), 'bone') };
        let flags = input.byte() & 255;
        if (flags & 1) c.skin = true;
        if (flags & 2) c.x = f(input.float());
        if (flags & 4) c.y = f(input.float());
        if (flags & 8) c.rotate = f(input.float());
        if (flags & 16) {
          let scaleX = input.float();
          if (scaleX < -2) {
            c.scaleY = 'volume';
            scaleX = -2 - scaleX;
          } else if (scaleX < 0) {
            c.scaleY = 'uniform';
            scaleX = -1 - scaleX;
          }
          c.scaleX = f(scaleX);
        }
        if (flags & 32) c.shearX = f(input.float());
        c.limit = flags & 64 ? f(input.float()) : 5000;
        c.fps = Math.round(input.ubyte());
        c.inertia = f(input.float());
        c.strength = f(input.float());
        c.damping = f(input.float());
        c.mass = flags & 128 ? f(1 / input.float()) : 1;
        c.wind = f(input.float());
        c.gravity = f(input.float());
        flags = input.byte() & 255;
        ['inertia', 'strength', 'damping', 'mass', 'wind', 'gravity', 'mix'].forEach((p, k) => {
          if (flags & (1 << k)) c[`${p}Global`] = true;
        });
        c.mix = flags & 128 ? f(input.float()) : 1;
        constraints.push(c);
        break;
      }
      case 4: {
        const c: J = { type: 'slider', name };
        const flags = input.byte() & 255;
        if (flags & 1) c.skin = true;
        if (flags & 2) c.loop = true;
        if (flags & 4) c.additive = true;
        let value = 0;
        if (flags & 8) value = f(input.float());
        c.mix = flags & 16 ? (flags & 32 ? f(input.float()) : 1) : 0;
        if (flags & 64) {
          if (nonessential) c.max = value;
          if (flags & 128) c.local = true;
          c.bone = nameOf(bones, input.varint(true), 'bone');
          c.from = f(input.float());
          c.property = PROP[input.byte()] ?? 'rotate';
          c.to = f(input.float());
          c.scale = f(input.float());
        } else c.time = value;
        constraints.push(c);
        break;
      }
      default:
        throw new Error(`Unknown constraint type ${type} in the binary file`);
    }
  }

  interface Linked {
    mesh: J;
    skin: number;
    slot: number;
    sourceSlot: number;
    source: string;
    inherit: boolean;
    placeholder: string;
  }
  const skins: J[] = [];
  const linked: Linked[] = [];

  const readSequence = (has: boolean): J | null => {
    if (!has) return null;
    const count = input.varint(true);
    const start = input.varint(true);
    const digits = input.varint(true);
    const setup = input.varint(true);
    return { count, start, digits, setup };
  };
  const readVertices = (weighted: boolean): { vertexCount: number; vertices: number[] } => {
    const vertexCount = input.varint(true);
    const vertices: number[] = [];
    if (!weighted) {
      for (let i = 0; i < vertexCount * 2; i++) vertices.push(f(input.float()));
      return { vertexCount, vertices };
    }
    const entries = input.varint(true);
    for (let b = 0; b < entries;) {
      const n = input.varint(true);
      vertices.push(n);
      b++;
      for (let k = 0; k < n; k++, b++) {
        vertices.push(input.varint(true));
        vertices.push(f(input.float()), f(input.float()), f(input.float()));
      }
    }
    return { vertexCount, vertices };
  };

  const readAttachment = (skinIndex: number, slotIndex: number, placeholder: string): J | null => {
    const flags = input.byte() & 255;
    const name = flags & 8 ? input.ref() : placeholder;
    if (!name) throw new Error('An attachment has no name');
    const out: J = {};
    if (name !== placeholder) out.name = name;
    const type = flags & 7;
    switch (type) {
      case 0: {
        const path = flags & 16 ? input.ref() : null;
        const color = flags & 32 ? input.int32() : -1;
        const sequence = readSequence((flags & 64) !== 0);
        const rotation = flags & 128 ? input.float() : 0;
        Object.assign(out, { type: 'region' });
        if (path) out.path = path;
        out.x = f(input.float());
        out.y = f(input.float());
        out.scaleX = f(input.float());
        out.scaleY = f(input.float());
        out.rotation = f(rotation);
        out.width = f(input.float());
        out.height = f(input.float());
        if (color !== -1) out.color = hex(color, true);
        if (sequence) out.sequence = sequence;
        return out;
      }
      case 1: {
        const v = readVertices((flags & 16) !== 0);
        Object.assign(out, { type: 'boundingbox', vertexCount: v.vertexCount, vertices: v.vertices });
        if (nonessential) out.color = hex(input.int32(), true);
        return out;
      }
      case 2: {
        const path = flags & 16 ? input.ref() : null;
        const color = flags & 32 ? input.int32() : -1;
        const sequence = readSequence((flags & 64) !== 0);
        const hull = input.varint(true);
        const v = readVertices((flags & 128) !== 0);
        const uvs: number[] = [];
        for (let i = 0; i < v.vertexCount * 2; i++) uvs.push(f(input.float()));
        const triangles: number[] = [];
        const triangleCount = (v.vertexCount * 2 - hull - 2) * 3;
        for (let i = 0; i < triangleCount; i++) triangles.push(input.varint(true));
        for (let n = input.varint(true); n > 0; n--) input.varint(true); // slots whose timelines the mesh shares
        Object.assign(out, { type: 'mesh' });
        if (path) out.path = path;
        if (color !== -1) out.color = hex(color, true);
        if (sequence) out.sequence = sequence;
        out.uvs = uvs;
        out.triangles = triangles;
        out.vertices = v.vertices;
        out.hull = hull;
        if (nonessential) {
          const edges: number[] = [];
          for (let n = input.varint(true); n > 0; n--) edges.push(input.varint(true));
          if (edges.length) out.edges = edges;
          out.width = f(input.float());
          out.height = f(input.float());
        }
        return out;
      }
      case 3: {
        const path = flags & 16 ? input.ref() : name;
        const color = flags & 32 ? input.int32() : -1;
        const sequence = readSequence((flags & 64) !== 0);
        const inherit = (flags & 128) !== 0;
        const sourceSlot = input.varint(true);
        const skin = input.varint(true);
        const source = input.ref();
        Object.assign(out, { type: 'linkedmesh' });
        if (path && path !== name) out.path = path;
        if (color !== -1) out.color = hex(color, true);
        if (sequence) out.sequence = sequence;
        if (nonessential) {
          out.width = f(input.float());
          out.height = f(input.float());
        }
        if (!source) throw new Error('A linked mesh has no source');
        linked.push({ mesh: out, skin: skinIndex, slot: slotIndex, sourceSlot, source, inherit, placeholder });
        // (the skin of the source is a number here; it becomes a name once every skin is read)
        out.__skin = skin;
        return out;
      }
      case 4: {
        Object.assign(out, { type: 'path' });
        if (flags & 16) out.closed = true;
        if (!(flags & 32)) out.constantSpeed = false;
        const v = readVertices((flags & 64) !== 0);
        out.vertexCount = v.vertexCount;
        out.vertices = v.vertices;
        const lengths: number[] = [];
        for (let i = 0; i < v.vertexCount / 3; i++) lengths.push(f(input.float()));
        out.lengths = lengths;
        if (nonessential) out.color = hex(input.int32(), true);
        return out;
      }
      case 5: {
        Object.assign(out, { type: 'point' });
        out.rotation = f(input.float());
        out.x = f(input.float());
        out.y = f(input.float());
        if (nonessential) out.color = hex(input.int32(), true);
        return out;
      }
      case 6: {
        const end = input.varint(true);
        const v = readVertices((flags & 16) !== 0);
        Object.assign(out, { type: 'clipping', end: nameOf(slots, end, 'slot'), vertexCount: v.vertexCount, vertices: v.vertices });
        if (flags & 32) out.convex = true;
        if (flags & 64) out.inverse = true;
        if (nonessential) out.color = hex(input.int32(), true);
        return out;
      }
      default:
        throw new Error(`Unknown attachment type ${type} in the binary file`);
    }
  };

  const readSkin = (isDefault: boolean, skinIndex: number): J | null => {
    const skin: J = {};
    let slotTotal = 0;
    if (isDefault) {
      slotTotal = input.varint(true);
      if (slotTotal === 0) return null;
      skin.name = 'default';
    } else {
      skin.name = input.string();
      if (!skin.name) throw new Error('A skin has no name');
      if (nonessential) skin.color = hex(input.int32(), true);
      const skinBones: string[] = [];
      for (let n = input.varint(true); n > 0; n--) skinBones.push(nameOf(bones, input.varint(true), 'bone'));
      if (skinBones.length) skin.bones = skinBones;
      for (let n = input.varint(true); n > 0; n--) {
        const c = constraints[input.varint(true)];
        if (!c) throw new Error('A skin refers to a constraint that does not exist');
        (skin[c.type] ??= []).push(c.name);
      }
      slotTotal = input.varint(true);
    }
    skin.attachments = {};
    for (let i = 0; i < slotTotal; i++) {
      const slotIndex = input.varint(true);
      const slotName = nameOf(slots, slotIndex, 'slot');
      const perSlot: J = (skin.attachments[slotName] ??= {});
      for (let n = input.varint(true); n > 0; n--) {
        const placeholder = input.ref();
        if (!placeholder) throw new Error('An attachment has no name');
        const att = readAttachment(skinIndex, slotIndex, placeholder);
        if (att) perSlot[placeholder] = att;
      }
    }
    return skin;
  };

  const defaultSkin = readSkin(true, 0);
  if (defaultSkin) skins.push(defaultSkin);
  const extra = input.varint(true);
  for (let i = 0; i < extra; i++) {
    const skin = readSkin(false, skins.length);
    if (!skin) throw new Error('A skin could not be read');
    skins.push(skin);
  }
  // a skin the file does not carry (an empty default skin) is still the first skin of the skeleton
  if (!defaultSkin) skins.unshift({ name: 'default', attachments: {} });
  const skinShift = defaultSkin ? 0 : 1;

  for (const l of linked) {
    const att = l.mesh;
    const sourceSkin = skins[(att.__skin as number) + skinShift];
    delete att.__skin;
    att.source = l.source;
    att.parent = l.source; // the older key, which Bone 2D's importer reads
    if (sourceSkin && sourceSkin !== skins[l.skin + skinShift]) att.skin = sourceSkin.name;
    if (l.sourceSlot !== l.slot) att.slot = nameOf(slots, l.sourceSlot, 'slot');
    if (!l.inherit) att.timelines = false;
  }

  const events: J = {};
  const eventList: { name: string; audio: boolean }[] = [];
  for (let n = input.varint(true); n > 0; n--) {
    const name = input.string();
    if (!name) throw new Error('An event has no name');
    const e: J = {};
    e.int = input.varint(false);
    e.float = f(input.float());
    const s = input.string();
    if (s) e.string = s;
    const audio = input.string();
    if (audio) {
      e.audio = audio;
      e.volume = f(input.float());
      e.balance = f(input.float());
    }
    events[name] = e;
    eventList.push({ name, audio: !!audio });
  }

  const animations: J = {};
  const animationNames: string[] = [];

  const skinOf = (i: number): J => {
    const s = skins[i];
    if (!s) throw new Error('An animation refers to a skin that does not exist');
    return s;
  };
  const curveBytes = (n: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(f(input.float()));
    return out;
  };
  /**
   * A timeline of `channels` numbers per key, written as `time, values..., curve` with the curve belonging to the key before.
   * `make` receives the time and the raw values of a key and returns its JSON object (without the curve).
   */
  const keyed = (frameCount: number, channels: number, readValues: () => number[], make: (time: number, values: number[]) => J): J[] => {
    const keys: J[] = [];
    let time = input.float();
    let values = readValues();
    for (let frame = 0; ; frame++) {
      keys.push(make(time, values));
      if (frame === frameCount - 1) break;
      const time2 = input.float();
      const values2 = readValues();
      const kind = input.byte();
      if (kind === 1) keys[frame].curve = 'stepped';
      else if (kind === 2) keys[frame].curve = curveBytes(channels * 4);
      time = time2;
      values = values2;
    }
    return keys;
  };
  const t = (o: J, time: number) => {
    const rt = f(time);
    if (rt !== 0) o.time = rt;
    return o;
  };
  const floats = (n: number) => () => {
    const v: number[] = [];
    for (let i = 0; i < n; i++) v.push(input.float());
    return v;
  };
  const bytesN = (n: number) => () => {
    const v: number[] = [];
    for (let i = 0; i < n; i++) v.push(input.ubyte());
    return v;
  };
  const withCurveOrder = <T extends J>(o: T) => o;

  const readAnimation = (): J => {
    const out: J = {};
    input.varint(true); // number of timelines

    // slots
    for (let i = input.varint(true); i > 0; i--) {
      const slotName = nameOf(slots, input.varint(true), 'slot');
      const tl: J = (out.slots ??= {})[slotName] ?? {};
      for (let n = input.varint(true); n > 0; n--) {
        const type = input.byte();
        const frameCount = input.varint(true);
        switch (type) {
          case 0: {
            const keys: J[] = [];
            for (let k = 0; k < frameCount; k++) {
              const time = input.float();
              const name = input.ref();
              keys.push(t(name ? { name } : {}, time));
            }
            tl.attachment = keys;
            break;
          }
          case 1:
            input.varint(true);
            tl.rgba = keyed(frameCount, 4, bytesN(4), (time, v) => t({ color: hexBytes(v) }, time));
            break;
          case 2:
            input.varint(true);
            tl.rgb = keyed(frameCount, 3, bytesN(3), (time, v) => t({ color: hexBytes(v) }, time));
            break;
          case 3:
            input.varint(true);
            tl.rgba2 = keyed(frameCount, 7, bytesN(7), (time, v) =>
              t({ light: hexBytes(v.slice(0, 4)), dark: hexBytes(v.slice(4)) }, time),
            );
            break;
          case 4:
            input.varint(true);
            tl.rgb2 = keyed(frameCount, 6, bytesN(6), (time, v) => t({ light: hexBytes(v.slice(0, 3)), dark: hexBytes(v.slice(3)) }, time));
            break;
          case 5:
            input.varint(true);
            tl.alpha = keyed(frameCount, 1, bytesN(1), (time, v) => t({ value: f(v[0] / 255) }, time));
            break;
          default:
            throw new Error(`Unknown slot timeline type ${type} in the binary file`);
        }
      }
      out.slots[slotName] = tl;
    }

    // bones
    for (let i = input.varint(true); i > 0; i--) {
      const boneName = nameOf(bones, input.varint(true), 'bone');
      const tl: J = (out.bones ??= {})[boneName] ?? {};
      for (let n = input.varint(true); n > 0; n--) {
        const type = input.byte();
        const frameCount = input.varint(true);
        if (type === 10) {
          const keys: J[] = [];
          for (let k = 0; k < frameCount; k++) {
            const time = input.float();
            keys.push(t({ inherit: INHERIT[input.byte()] ?? 'normal' }, time));
          }
          tl.inherit = keys;
          continue;
        }
        input.varint(true); // bezier count
        const one = (name: string) => {
          tl[name] = keyed(frameCount, 1, floats(1), (time, v) => t({ value: f(v[0]) }, time));
        };
        const two = (name: string) => {
          tl[name] = keyed(frameCount, 2, floats(2), (time, v) => t({ x: f(v[0]), y: f(v[1]) }, time));
        };
        switch (type) {
          case 0:
            one('rotate');
            break;
          case 1:
            two('translate');
            break;
          case 2:
            one('translatex');
            break;
          case 3:
            one('translatey');
            break;
          case 4:
            two('scale');
            break;
          case 5:
            one('scalex');
            break;
          case 6:
            one('scaley');
            break;
          case 7:
            two('shear');
            break;
          case 8:
            one('shearx');
            break;
          case 9:
            one('sheary');
            break;
          default:
            throw new Error(`Unknown bone timeline type ${type} in the binary file`);
        }
      }
      out.bones[boneName] = tl;
    }

    // ik
    for (let i = input.varint(true); i > 0; i--) {
      const c = constraints[input.varint(true)];
      if (!c) throw new Error('An animation refers to a constraint that does not exist');
      const frameCount = input.varint(true);
      input.varint(true); // bezier count
      const keys: J[] = [];
      let flags = input.byte() & 255;
      let time = input.float();
      let mix = flags & 1 ? (flags & 2 ? input.float() : 1) : 0;
      let softness = flags & 4 ? input.float() : 0;
      for (let frame = 0; ; frame++) {
        const key = t(
          {
            mix: f(mix),
            softness: f(softness),
            bendPositive: (flags & 8) !== 0,
            compress: (flags & 16) !== 0,
            stretch: (flags & 32) !== 0,
          },
          time,
        );
        keys.push(key);
        if (frame === frameCount - 1) break;
        flags = input.byte() & 255;
        const time2 = input.float();
        const mix2 = flags & 1 ? (flags & 2 ? input.float() : 1) : 0;
        const softness2 = flags & 4 ? input.float() : 0;
        if (flags & 64) key.curve = 'stepped';
        else if (flags & 128) key.curve = curveBytes(8);
        time = time2;
        mix = mix2;
        softness = softness2;
      }
      (out.ik ??= {})[c.name] = keys;
    }

    // transform
    for (let i = input.varint(true); i > 0; i--) {
      const c = constraints[input.varint(true)];
      if (!c) throw new Error('An animation refers to a constraint that does not exist');
      const frameCount = input.varint(true);
      input.varint(true);
      (out.transform ??= {})[c.name] = keyed(frameCount, 6, floats(6), (time, v) =>
        t({ mixRotate: f(v[0]), mixX: f(v[1]), mixY: f(v[2]), mixScaleX: f(v[3]), mixScaleY: f(v[4]), mixShearY: f(v[5]) }, time),
      );
    }

    // path
    for (let i = input.varint(true); i > 0; i--) {
      const c = constraints[input.varint(true)];
      if (!c) throw new Error('An animation refers to a constraint that does not exist');
      const tl: J = ((out.path ??= {})[c.name] ??= {});
      for (let n = input.varint(true); n > 0; n--) {
        const type = input.byte();
        const frameCount = input.varint(true);
        input.varint(true);
        if (type === 2)
          tl.mix = keyed(frameCount, 3, floats(3), (time, v) => t({ mixRotate: f(v[0]), mixX: f(v[1]), mixY: f(v[2]) }, time));
        else if (type === 0 || type === 1)
          tl[type === 0 ? 'position' : 'spacing'] = keyed(frameCount, 1, floats(1), (time, v) => t({ value: f(v[0]) }, time));
        else throw new Error(`Unknown path timeline type ${type} in the binary file`);
      }
    }

    // physics (the index is shifted by one: 0 is "every constraint")
    for (let i = input.varint(true); i > 0; i--) {
      const index = input.varint(true) - 1;
      const c = index >= 0 ? constraints[index] : null;
      if (index >= 0 && !c) throw new Error('An animation refers to a constraint that does not exist');
      const tl: J = ((out.physics ??= {})[c ? c.name : ''] ??= {});
      for (let n = input.varint(true); n > 0; n--) {
        const type = input.byte();
        const frameCount = input.varint(true);
        if (type === 8) {
          const keys: J[] = [];
          for (let k = 0; k < frameCount; k++) keys.push(t({}, input.float()));
          tl.reset = keys;
          continue;
        }
        const name = PHYSICS_NAME[type];
        if (!name) throw new Error(`Unknown physics timeline type ${type} in the binary file`);
        input.varint(true);
        tl[name] = keyed(frameCount, 1, floats(1), (time, v) => t({ value: f(v[0]) }, time));
      }
    }

    // sliders
    for (let i = input.varint(true); i > 0; i--) {
      const c = constraints[input.varint(true)];
      if (!c) throw new Error('An animation refers to a constraint that does not exist');
      const tl: J = ((out.slider ??= {})[c.name] ??= {});
      for (let n = input.varint(true); n > 0; n--) {
        const type = input.byte();
        const frameCount = input.varint(true);
        input.varint(true);
        if (type !== 0 && type !== 1) throw new Error(`Unknown slider timeline type ${type} in the binary file`);
        tl[type === 0 ? 'time' : 'mix'] = keyed(frameCount, 1, floats(1), (time, v) => t({ value: f(v[0]) }, time));
      }
    }

    // deform and sequence timelines: skin -> slot -> attachment
    for (let i = input.varint(true); i > 0; i--) {
      const skin = skinOf(input.varint(true) + skinShift);
      for (let ii = input.varint(true); ii > 0; ii--) {
        const slotName = nameOf(slots, input.varint(true), 'slot');
        for (let iii = input.varint(true); iii > 0; iii--) {
          const attName = input.ref();
          if (!attName) throw new Error('A timeline refers to an attachment with no name');
          const type = input.byte();
          const frameCount = input.varint(true);
          const target: J = ((((out.attachments ??= {})[skin.name] ??= {})[slotName] ??= {})[attName] ??= {});
          if (type === 0) {
            input.varint(true);
            const keys: J[] = [];
            let time = input.float();
            for (let frame = 0; ; frame++) {
              const key: J = t({}, time);
              const count = input.varint(true);
              if (count > 0) {
                const start = input.varint(true);
                if (start > 0) key.offset = start;
                const verts: number[] = [];
                for (let v = 0; v < count; v++) verts.push(f(input.float()));
                key.vertices = verts;
              }
              keys.push(key);
              if (frame === frameCount - 1) break;
              const time2 = input.float();
              const kind = input.byte();
              if (kind === 1) key.curve = 'stepped';
              else if (kind === 2) key.curve = curveBytes(4);
              time = time2;
            }
            target.deform = keys;
          } else if (type === 1) {
            const keys: J[] = [];
            for (let k = 0; k < frameCount; k++) {
              const time = input.float();
              const modeAndIndex = input.int32();
              const delay = f(input.float());
              keys.push(t({ mode: SEQUENCE_MODE[modeAndIndex & 0xf] ?? 'hold', index: modeAndIndex >> 4, delay }, time));
            }
            target.sequence = keys;
          } else throw new Error(`Unknown attachment timeline type ${type} in the binary file`);
        }
      }
    }

    // draw order: each key lists the slots that moved (slot, offset)
    const readOffsets = (folderSlots: string[] | null): J[] | null => {
      const changes = input.varint(true);
      if (changes === 0) return null;
      const list: J[] = [];
      for (let k = 0; k < changes; k++) {
        const index = input.varint(true);
        const offset = input.varint(true);
        list.push({ slot: folderSlots ? folderSlots[index] : nameOf(slots, index, 'slot'), offset: offset | 0 });
      }
      return list;
    };
    const drawCount = input.varint(true);
    if (drawCount > 0) {
      const keys: J[] = [];
      for (let k = 0; k < drawCount; k++) {
        const time = input.float();
        const offsets = readOffsets(null);
        const key: J = t({}, time);
        if (offsets) key.offsets = offsets;
        keys.push(key);
      }
      out.drawOrder = keys;
    }
    const folderCount = input.varint(true);
    for (let k = 0; k < folderCount; k++) {
      const folderSlots: string[] = [];
      for (let n = input.varint(true); n > 0; n--) folderSlots.push(nameOf(slots, input.varint(true), 'slot'));
      const keys: J[] = [];
      for (let n = input.varint(true); n > 0; n--) {
        const time = input.float();
        const offsets = readOffsets(folderSlots);
        const key: J = t({}, time);
        if (offsets) key.offsets = offsets;
        keys.push(key);
      }
      (out.drawOrderFolder ??= []).push({ slots: folderSlots, keys });
    }

    // events
    const eventCount = input.varint(true);
    if (eventCount > 0) {
      const keys: J[] = [];
      for (let k = 0; k < eventCount; k++) {
        const time = input.float();
        const index = input.varint(true);
        const def = eventList[index];
        if (!def) throw new Error('An animation fires an event that does not exist');
        const key: J = t({ name: def.name }, time);
        key.int = input.varint(false);
        key.float = f(input.float());
        const s = input.string();
        if (s !== null) key.string = s;
        if (def.audio) {
          key.volume = f(input.float());
          key.balance = f(input.float());
        }
        keys.push(key);
      }
      out.events = keys;
    }
    if (nonessential) input.int32(); // the animation's color (editor only)
    return withCurveOrder(out);
  };

  for (let n = input.varint(true); n > 0; n--) {
    const name = input.string();
    if (!name) throw new Error('An animation has no name');
    animations[name] = readAnimation();
    animationNames.push(name);
  }
  // the animation of each slider comes after all animations
  for (const c of constraints) {
    if (c.type === 'slider') c.animation = animationNames[input.varint(true)] ?? '';
  }

  const out: J = { skeleton, bones };
  if (slots.length) out.slots = slots;
  if (constraints.length) out.constraints = constraints;
  if (skins.length) out.skins = skins;
  if (eventList.length) out.events = events;
  if (animationNames.length) out.animations = animations;
  return out;
}

/** True when the bytes look like Spine binary data rather than JSON text. */
export function looksLikeBinary(bytes: Uint8Array): boolean {
  for (let i = 0; i < Math.min(bytes.length, 64); i++) if (bytes[i] === 0) return true;
  const first = bytes.find((b) => b !== 32 && b !== 9 && b !== 10 && b !== 13);
  return first !== 0x7b; // '{'
}
