/**
 * Path math: positions and tangents along a composite Bezier path, ported statement by statement from the official
 * runtime's `PathConstraint.computeWorldPositions` (spine-core 4.3.13) so that bones follow a path exactly like they do in a
 * game. The functions work on plain arrays of world coordinates and know nothing about bones.
 *
 * A path has `n` nodes, each with three points in the vertex array: in-handle, anchor, out-handle (`3n` points = `6n` numbers).
 * An open path has `n - 1` curves, a closed one `n`.
 */
import type { PathPositionMode, PathSpacingMode } from './model';

const NONE = -1;
const BEFORE = -2;
const AFTER = -3;

/** Reusable arrays of one path constraint (the official runtime keeps them on the constraint as well). */
export interface PathScratch {
  /** Spacing of every bone, filled by the constraint before `computeWorldPositions`. */
  spaces: number[];
  positions: number[];
  world: number[];
  curves: number[];
  segments: number[];
}

export function newPathScratch(): PathScratch {
  return { spaces: [], positions: [], world: [], curves: [], segments: [] };
}

/** Everything `computeWorldPositions` reads about the path and the constraint. */
export interface PathInput {
  /** World coordinates of ALL points of the path (x, y pairs), as `VertexAttachment.computeWorldVertices` would produce. */
  points: ArrayLike<number>;
  /** Number of values in `points` (6 per node). */
  verticesLength: number;
  closed: boolean;
  constantSpeed: boolean;
  /** Setup pose curve lengths (end of every curve, measured from the start of the path); used when `constantSpeed` is false. */
  lengths: ArrayLike<number>;
  position: number;
  positionMode: PathPositionMode;
  spacingMode: PathSpacingMode;
}

/** `Utils.setArraySize`: the array keeps its old values, new entries are zero. */
export function setSize(array: number[], size: number): number[] {
  const old = array.length;
  if (old === size) return array;
  array.length = size;
  for (let i = old; i < size; i++) array[i] = 0;
  return array;
}

/** `VertexAttachment.computeWorldVertices(…, start, count, out, offset, 2)` for already transformed points. */
function slice(points: ArrayLike<number>, start: number, count: number, out: number[], offset: number) {
  for (let i = 0; i < count; i++) out[offset + i] = points[start + i];
}

/**
 * Position (x, y) and angle (radians) for every space of the constraint, `out[o..o+2]` per space.
 * `tangents` makes the angle available for every space (rotate mode `tangent`).
 */
export function computeWorldPositions(path: PathInput, scratch: PathScratch, spacesCount: number, tangents: boolean): number[] {
  const closed = path.closed;
  const points = path.points;
  let position = path.position;
  const spaces = scratch.spaces;
  const out = setSize(scratch.positions, spacesCount * 3 + 2);
  let world = scratch.world;
  let verticesLength = path.verticesLength;
  let curveCount = verticesLength / 6;
  let prevCurve = NONE;

  if (!path.constantSpeed) {
    const lengths = path.lengths;
    curveCount -= closed ? 1 : 2;
    const pathLength = lengths[curveCount];
    if (path.positionMode === 'percent') position *= pathLength;
    let multiplier: number;
    switch (path.spacingMode) {
      case 'percent':
        multiplier = pathLength;
        break;
      case 'proportional':
        multiplier = pathLength / spacesCount;
        break;
      default:
        multiplier = 1;
    }
    world = setSize(scratch.world, 8);
    for (let i = 0, o = 0, curve = 0; i < spacesCount; i++, o += 3) {
      const space = spaces[i] * multiplier;
      position += space;
      let p = position;
      if (closed) {
        p %= pathLength;
        if (p < 0) p += pathLength;
        curve = 0;
      } else if (p < 0) {
        if (prevCurve !== BEFORE) {
          prevCurve = BEFORE;
          slice(points, 2, 4, world, 0);
        }
        addBeforePosition(p, world, 0, out, o);
        continue;
      } else if (p > pathLength) {
        if (prevCurve !== AFTER) {
          prevCurve = AFTER;
          slice(points, verticesLength - 6, 4, world, 0);
        }
        addAfterPosition(p - pathLength, world, 0, out, o);
        continue;
      }
      // Determine curve containing position.
      for (; ; curve++) {
        const length = lengths[curve];
        if (p > length) continue;
        if (curve === 0) p /= length;
        else {
          const prev = lengths[curve - 1];
          p = (p - prev) / (length - prev);
        }
        break;
      }
      if (curve !== prevCurve) {
        prevCurve = curve;
        if (closed && curve === curveCount) {
          slice(points, verticesLength - 4, 4, world, 0);
          slice(points, 0, 4, world, 4);
        } else slice(points, curve * 6 + 2, 8, world, 0);
      }
      addCurvePosition(
        p,
        world[0],
        world[1],
        world[2],
        world[3],
        world[4],
        world[5],
        world[6],
        world[7],
        out,
        o,
        tangents || (i > 0 && space === 0),
      );
    }
    return out;
  }

  // World vertices.
  if (closed) {
    verticesLength += 2;
    world = setSize(scratch.world, verticesLength);
    slice(points, 2, verticesLength - 4, world, 0);
    slice(points, 0, 2, world, verticesLength - 4);
    world[verticesLength - 2] = world[0];
    world[verticesLength - 1] = world[1];
  } else {
    curveCount--;
    verticesLength -= 4;
    world = setSize(scratch.world, verticesLength);
    slice(points, 2, verticesLength, world, 0);
  }

  // Curve lengths.
  const curves = setSize(scratch.curves, curveCount);
  let pathLength = 0;
  let x1 = world[0];
  let y1 = world[1];
  let cx1 = 0;
  let cy1 = 0;
  let cx2 = 0;
  let cy2 = 0;
  let x2 = 0;
  let y2 = 0;
  let tmpx = 0;
  let tmpy = 0;
  let dddfx = 0;
  let dddfy = 0;
  let ddfx = 0;
  let ddfy = 0;
  let dfx = 0;
  let dfy = 0;
  for (let i = 0, w = 2; i < curveCount; i++, w += 6) {
    cx1 = world[w];
    cy1 = world[w + 1];
    cx2 = world[w + 2];
    cy2 = world[w + 3];
    x2 = world[w + 4];
    y2 = world[w + 5];
    tmpx = (x1 - cx1 * 2 + cx2) * 0.1875;
    tmpy = (y1 - cy1 * 2 + cy2) * 0.1875;
    dddfx = ((cx1 - cx2) * 3 - x1 + x2) * 0.09375;
    dddfy = ((cy1 - cy2) * 3 - y1 + y2) * 0.09375;
    ddfx = tmpx * 2 + dddfx;
    ddfy = tmpy * 2 + dddfy;
    dfx = (cx1 - x1) * 0.75 + tmpx + dddfx * 0.16666667;
    dfy = (cy1 - y1) * 0.75 + tmpy + dddfy * 0.16666667;
    pathLength += Math.sqrt(dfx * dfx + dfy * dfy);
    dfx += ddfx;
    dfy += ddfy;
    ddfx += dddfx;
    ddfy += dddfy;
    pathLength += Math.sqrt(dfx * dfx + dfy * dfy);
    dfx += ddfx;
    dfy += ddfy;
    pathLength += Math.sqrt(dfx * dfx + dfy * dfy);
    dfx += ddfx + dddfx;
    dfy += ddfy + dddfy;
    pathLength += Math.sqrt(dfx * dfx + dfy * dfy);
    curves[i] = pathLength;
    x1 = x2;
    y1 = y2;
  }
  if (path.positionMode === 'percent') position *= pathLength;
  let multiplier: number;
  switch (path.spacingMode) {
    case 'percent':
      multiplier = pathLength;
      break;
    case 'proportional':
      multiplier = pathLength / spacesCount;
      break;
    default:
      multiplier = 1;
  }
  const segments = scratch.segments;
  let curveLength = 0;
  for (let i = 0, o = 0, curve = 0, segment = 0; i < spacesCount; i++, o += 3) {
    const space = spaces[i] * multiplier;
    position += space;
    let p = position;
    if (closed) {
      p %= pathLength;
      if (p < 0) p += pathLength;
      curve = 0;
      segment = 0;
    } else if (p < 0) {
      addBeforePosition(p, world, 0, out, o);
      continue;
    } else if (p > pathLength) {
      addAfterPosition(p - pathLength, world, verticesLength - 4, out, o);
      continue;
    }
    // Determine curve containing position.
    for (; ; curve++) {
      const length = curves[curve];
      if (p > length) continue;
      if (curve === 0) p /= length;
      else {
        const prev = curves[curve - 1];
        p = (p - prev) / (length - prev);
      }
      break;
    }
    // Curve segment lengths.
    if (curve !== prevCurve) {
      prevCurve = curve;
      let ii = curve * 6;
      x1 = world[ii];
      y1 = world[ii + 1];
      cx1 = world[ii + 2];
      cy1 = world[ii + 3];
      cx2 = world[ii + 4];
      cy2 = world[ii + 5];
      x2 = world[ii + 6];
      y2 = world[ii + 7];
      tmpx = (x1 - cx1 * 2 + cx2) * 0.03;
      tmpy = (y1 - cy1 * 2 + cy2) * 0.03;
      dddfx = ((cx1 - cx2) * 3 - x1 + x2) * 0.006;
      dddfy = ((cy1 - cy2) * 3 - y1 + y2) * 0.006;
      ddfx = tmpx * 2 + dddfx;
      ddfy = tmpy * 2 + dddfy;
      dfx = (cx1 - x1) * 0.3 + tmpx + dddfx * 0.16666667;
      dfy = (cy1 - y1) * 0.3 + tmpy + dddfy * 0.16666667;
      curveLength = Math.sqrt(dfx * dfx + dfy * dfy);
      segments[0] = curveLength;
      for (ii = 1; ii < 8; ii++) {
        dfx += ddfx;
        dfy += ddfy;
        ddfx += dddfx;
        ddfy += dddfy;
        curveLength += Math.sqrt(dfx * dfx + dfy * dfy);
        segments[ii] = curveLength;
      }
      dfx += ddfx;
      dfy += ddfy;
      curveLength += Math.sqrt(dfx * dfx + dfy * dfy);
      segments[8] = curveLength;
      dfx += ddfx + dddfx;
      dfy += ddfy + dddfy;
      curveLength += Math.sqrt(dfx * dfx + dfy * dfy);
      segments[9] = curveLength;
      segment = 0;
    }
    // Weight by segment length.
    p *= curveLength;
    for (; ; segment++) {
      const length = segments[segment];
      if (p > length) continue;
      if (segment === 0) p /= length;
      else {
        const prev = segments[segment - 1];
        p = segment + (p - prev) / (length - prev);
      }
      break;
    }
    addCurvePosition(p * 0.1, x1, y1, cx1, cy1, cx2, cy2, x2, y2, out, o, tangents || (i > 0 && space === 0));
  }
  return out;
}

function addBeforePosition(p: number, temp: number[], i: number, out: number[], o: number) {
  const x1 = temp[i];
  const y1 = temp[i + 1];
  const dx = temp[i + 2] - x1;
  const dy = temp[i + 3] - y1;
  const r = Math.atan2(dy, dx);
  out[o] = x1 + p * Math.cos(r);
  out[o + 1] = y1 + p * Math.sin(r);
  out[o + 2] = r;
}

function addAfterPosition(p: number, temp: number[], i: number, out: number[], o: number) {
  const x1 = temp[i + 2];
  const y1 = temp[i + 3];
  const dx = x1 - temp[i];
  const dy = y1 - temp[i + 1];
  const r = Math.atan2(dy, dx);
  out[o] = x1 + p * Math.cos(r);
  out[o + 1] = y1 + p * Math.sin(r);
  out[o + 2] = r;
}

function addCurvePosition(
  p: number,
  x1: number,
  y1: number,
  cx1: number,
  cy1: number,
  cx2: number,
  cy2: number,
  x2: number,
  y2: number,
  out: number[],
  o: number,
  tangents: boolean,
) {
  if (p === 0 || Number.isNaN(p)) {
    out[o] = x1;
    out[o + 1] = y1;
    out[o + 2] = Math.atan2(cy1 - y1, cx1 - x1);
    return;
  }
  const tt = p * p;
  const ttt = tt * p;
  const u = 1 - p;
  const uu = u * u;
  const uuu = uu * u;
  const ut = u * p;
  const ut3 = ut * 3;
  const uut3 = u * ut3;
  const utt3 = ut3 * p;
  const x = x1 * uuu + cx1 * uut3 + cx2 * utt3 + x2 * ttt;
  const y = y1 * uuu + cy1 * uut3 + cy2 * utt3 + y2 * ttt;
  out[o] = x;
  out[o + 1] = y;
  if (tangents) {
    if (p < 0.001) out[o + 2] = Math.atan2(cy1 - y1, cx1 - x1);
    else out[o + 2] = Math.atan2(y - (y1 * uu + cy1 * ut * 2 + cy2 * tt), x - (x1 * uu + cx1 * ut * 2 + cx2 * tt));
  }
}

/**
 * Lengths of the curves of a path in the setup pose, as the file format stores them: entry `i` is the distance from the start
 * of the path to the end of curve `i`. `points` are world coordinates of all `3 * nodeCount` points. Each Bezier is measured
 * by a fine polyline, so the numbers are far more accurate than the runtime's own per-frame estimate.
 */
export function pathCurveLengths(points: ArrayLike<number>, nodeCount: number, closed: boolean): number[] {
  const curves = closed ? nodeCount : nodeCount - 1;
  const out: number[] = [];
  let total = 0;
  const STEPS = 64;
  for (let i = 0; i < curves; i++) {
    const j = i + 1 === nodeCount ? 0 : i + 1;
    const x1 = points[(i * 3 + 1) * 2];
    const y1 = points[(i * 3 + 1) * 2 + 1];
    const cx1 = points[(i * 3 + 2) * 2];
    const cy1 = points[(i * 3 + 2) * 2 + 1];
    const cx2 = points[j * 3 * 2];
    const cy2 = points[j * 3 * 2 + 1];
    const x2 = points[(j * 3 + 1) * 2];
    const y2 = points[(j * 3 + 1) * 2 + 1];
    let px = x1;
    let py = y1;
    for (let s = 1; s <= STEPS; s++) {
      const t = s / STEPS;
      const u = 1 - t;
      const a = u * u * u;
      const b = 3 * u * u * t;
      const c = 3 * u * t * t;
      const d = t * t * t;
      const x = a * x1 + b * cx1 + c * cx2 + d * x2;
      const y = a * y1 + b * cy1 + c * cy2 + d * y2;
      total += Math.hypot(x - px, y - py);
      px = x;
      py = y;
    }
    out.push(total);
  }
  return out;
}

/**
 * Points along the curves of a path for drawing and hit testing: `steps` samples per curve, x,y pairs, one polyline from the
 * first anchor to the last (a closed path ends where it started). `points` are the `3 * nodeCount` points (any space).
 */
export function samplePath(points: ArrayLike<number>, nodeCount: number, closed: boolean, steps = 16): number[] {
  const curves = closed ? nodeCount : nodeCount - 1;
  const out: number[] = [];
  for (let i = 0; i < curves; i++) {
    const j = i + 1 === nodeCount ? 0 : i + 1;
    const x0 = points[(i * 3 + 1) * 2];
    const y0 = points[(i * 3 + 1) * 2 + 1];
    const x1 = points[(i * 3 + 2) * 2];
    const y1 = points[(i * 3 + 2) * 2 + 1];
    const x2 = points[j * 3 * 2];
    const y2 = points[j * 3 * 2 + 1];
    const x3 = points[(j * 3 + 1) * 2];
    const y3 = points[(j * 3 + 1) * 2 + 1];
    for (let s = i === 0 ? 0 : 1; s <= steps; s++) {
      const t = s / steps;
      const u = 1 - t;
      out.push(
        u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
      );
    }
  }
  return out;
}

/** Size of the path that Reset makes. */
const DEFAULT_PATH_SIZE = 100;

/**
 * Reset (Spine's button on a path): the vertices of a plain open path of two nodes along the x axis of its bone, centred on the origin;
 * the handles sit a third of the way (three points per node: in-handle, anchor, out-handle).
 */
export function defaultPathVertices(size = DEFAULT_PATH_SIZE): number[] {
  const h = size / 2;
  const t = size / 3;
  return [-h - t, 0, -h, 0, -h + t, 0, h - t, 0, h, 0, h + t, 0];
}
