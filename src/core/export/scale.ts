/**
 * Export scale: the same skeleton at another size (0.5 for half-size textures). It rescales the exported JSON the way the official
 * loader rescales what it reads (`SkeletonJson.scale`): every length, position, offset, image size, vertex and translation — and
 * nothing that is an angle, a color, a time or a ratio. The tests load the unscaled JSON with the official loader at this scale and
 * the scaled JSON at scale 1 and compare the two skeletons.
 */

type J = any;

const round5 = (v: number) => Math.round(v * 1e5) / 1e5;
/** Rounds like the exporter does for coordinates, so a scaled file is as tidy as an unscaled one. */
const q = (v: number) => (Number.isFinite(v) ? (Object.is(round5(v), -0) ? 0 : round5(v)) : 0);

/** Scales the listed fields of every key of a timeline (and the value handles of its curves). */
function scaleKeys(keys: J[] | undefined, fields: string[], s: number): void {
  if (!Array.isArray(keys)) return;
  for (const k of keys) {
    for (const f of fields) if (typeof k[f] === 'number') k[f] = q(k[f] * s);
    // a curve has four numbers per channel; only the channels that carry scaled values scale
    if (Array.isArray(k.curve)) k.curve = scaleCurveChannels(k.curve, fields.length, s);
  }
}

function scaleCurveChannels(curve: number[], channels: number, s: number): number[] {
  return curve.map((v, i) => {
    const channel = Math.floor(i / 4);
    const inValue = i % 4 === 1 || i % 4 === 3;
    return inValue && channel < channels ? q(v * s) : v;
  });
}

/** Scales a vertex array of a mesh or polygon: plain x,y, or per vertex [count, (bone, x, y, weight)*]. */
function scaleVertices(vertices: number[], vertexCount: number, s: number): number[] {
  if (vertices.length === vertexCount * 2) return vertices.map((v) => q(v * s));
  const out: number[] = [];
  for (let i = 0; i < vertices.length;) {
    const n = vertices[i++];
    out.push(n);
    for (let k = 0; k < n; k++, i += 4) out.push(vertices[i], q(vertices[i + 1] * s), q(vertices[i + 2] * s), vertices[i + 3]);
  }
  return out;
}

/** What a property is measured in: x and y are lengths (they scale), the others are angles or ratios. */
const isLength = (prop: string) => prop === 'x' || prop === 'y';

/** Returns a copy of the exported skeleton JSON scaled by `s` (1 returns the same content). */
export function scaleSpineJson<T>(json: T, s: number): T {
  const out: J = structuredClone(json);
  if (s === 1) return out;

  const sk = out.skeleton;
  if (sk) {
    for (const key of ['x', 'y', 'width', 'height', 'referenceScale']) if (typeof sk[key] === 'number') sk[key] = q(sk[key] * s);
  }

  for (const b of out.bones ?? []) {
    for (const key of ['length', 'x', 'y']) if (typeof b[key] === 'number') b[key] = q(b[key] * s);
  }

  // constraints, and what they say about the units of their modes
  const byName = new Map<string, J>();
  for (const c of out.constraints ?? []) {
    byName.set(`${c.type}:${c.name}`, c);
    if (c.type === 'ik' && typeof c.softness === 'number') c.softness = q(c.softness * s);
    if (c.type === 'transform') {
      for (const key of ['x', 'y']) if (typeof c[key] === 'number') c[key] = q(c[key] * s);
      for (const [fromProp, from] of Object.entries<J>(c.properties ?? {})) {
        const fromScale = isLength(fromProp) ? s : 1;
        if (typeof from.offset === 'number') from.offset = q(from.offset * fromScale);
        for (const [toProp, to] of Object.entries<J>(from.to ?? {})) {
          const toScale = isLength(toProp) ? s : 1;
          if (typeof to.offset === 'number') to.offset = q(to.offset * toScale);
          // (a missing max means 1, and the loader scales that default too)
          if (toScale !== 1) to.max = q((typeof to.max === 'number' ? to.max : 1) * toScale);
          // the ratio between the target and the source changes by the factor of the target over the factor of the source
          if (toScale !== fromScale) to.scale = +((to.scale ?? 1) * (toScale / fromScale)).toPrecision(7);
        }
      }
    }
    if (c.type === 'path') {
      if (c.positionMode === 'fixed' && typeof c.position === 'number') c.position = q(c.position * s);
      if ((c.spacingMode === 'length' || c.spacingMode === 'fixed' || c.spacingMode === undefined) && typeof c.spacing === 'number')
        c.spacing = q(c.spacing * s);
    }
    // a missing limit means 5000, which the loader scales as well
    if (c.type === 'physics') c.limit = q((typeof c.limit === 'number' ? c.limit : 5000) * s);
    if (c.type === 'slider' && c.bone !== undefined) {
      const factor = isLength(c.property) ? s : 1;
      if (typeof c.from === 'number') c.from = +(c.from * factor).toPrecision(7);
      // the loader divides the slider's scale by the factor of its property
      if (factor !== 1) c.scale = +((c.scale ?? 1) / factor).toPrecision(7);
    }
  }

  // attachments of every skin
  for (const skin of out.skins ?? []) {
    for (const slot of Object.values<J>(skin.attachments ?? {})) {
      for (const att of Object.values<J>(slot)) {
        const type = att.type ?? 'region';
        if (type === 'region') {
          for (const key of ['x', 'y', 'width', 'height']) if (typeof att[key] === 'number') att[key] = q(att[key] * s);
        } else if (type === 'mesh') {
          for (const key of ['width', 'height']) if (typeof att[key] === 'number') att[key] = q(att[key] * s);
          const count = (att.uvs?.length ?? 0) / 2;
          att.vertices = scaleVertices(att.vertices ?? [], count, s);
        } else if (type === 'point') {
          for (const key of ['x', 'y']) if (typeof att[key] === 'number') att[key] = q(att[key] * s);
        } else if (type === 'path') {
          att.vertices = scaleVertices(att.vertices ?? [], att.vertexCount ?? 0, s);
          if (Array.isArray(att.lengths)) att.lengths = att.lengths.map((v: number) => q(v * s));
        } else if (type === 'boundingbox' || type === 'clipping') {
          att.vertices = scaleVertices(att.vertices ?? [], att.vertexCount ?? 0, s);
        }
      }
    }
  }

  // animations
  for (const anim of Object.values<J>(out.animations ?? {})) {
    for (const tl of Object.values<J>(anim.bones ?? {})) {
      scaleKeys(tl.translate, ['x', 'y'], s);
      scaleKeys(tl.translatex, ['value'], s);
      scaleKeys(tl.translatey, ['value'], s);
    }
    for (const keys of Object.values<J>(anim.ik ?? {})) {
      for (const k of keys as J[]) {
        if (typeof k.softness === 'number') k.softness = q(k.softness * s);
        // the curve of an ik key has two channels (mix, softness): only softness carries a length
        if (Array.isArray(k.curve))
          k.curve = k.curve.map((v: number, i: number) => (i >= 4 && (i % 4 === 1 || i % 4 === 3) ? q(v * s) : v));
      }
    }
    for (const [name, tl] of Object.entries<J>(anim.path ?? {})) {
      const c = byName.get(`path:${name}`);
      if (c?.positionMode === 'fixed') scaleKeys(tl.position, ['value'], s);
      if (c && (c.spacingMode === 'length' || c.spacingMode === 'fixed' || c.spacingMode === undefined))
        scaleKeys(tl.spacing, ['value'], s);
    }
    for (const perSkin of Object.values<J>(anim.attachments ?? {})) {
      for (const perSlot of Object.values<J>(perSkin)) {
        for (const att of Object.values<J>(perSlot)) {
          for (const k of att.deform ?? []) {
            if (Array.isArray(k.vertices)) k.vertices = k.vertices.map((v: number) => q(v * s));
          }
        }
      }
    }
  }
  return out;
}
