import { Point } from "./point.js";
import { fromBytesBigEndian, getBytesBigEndian } from "./uint32.js";
import { clamp, colorStringToUint32, lerp } from "./util.js";

export class CanvasGradient {
  public stops: { color: number; t: number }[];
  constructor() {
    this.stops = [];
  }
  addColorStop(t: number, colorstring: string | number) {
    if (arguments.length < 2) throw new TypeError("addColorStop requires an offset and color");
    const color = colorStringToUint32("" + colorstring);
    this.stops.push({ t: t, color: color });
  }

  /**
   * Returns the interpolated color (as a big-endian RGBA uint32) for the
   * given gradient position. Stops may have been added in any order; they are
   * sorted by offset here. Positions outside the stop range use the nearest
   * endpoint color, and alpha is interpolated linearly just like RGB.
   */
  protected _lerpStops(t: number) {
    // render stops in ascending offset order, regardless of insertion order
    const stops = this.stops.slice().sort((a, b) => a.t - b.t);

    // a single stop colors the whole area
    if (stops.length === 1) return stops[0].color;

    // positions outside the stop range use the nearest endpoint color
    if (t <= stops[0].t) return stops[0].color;
    if (t >= stops[stops.length - 1].t) return stops[stops.length - 1].color;

    // find the pair of stops that t lies between
    let start = stops[0];
    let end = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (stops[i].t <= t && t <= stops[i + 1].t) {
        start = stops[i];
        end = stops[i + 1];
        break;
      }
    }

    // calculate relative T between those stops
    const rt = start.t === end.t ? 0 : remap(t, start.t, end.t, 0, 1);

    // convert colors to components, 0->1
    const intToRGBA = (int: number) => {
      return getBytesBigEndian(int).map((b) => b / 255);
    };
    const rgba_start = intToRGBA(start.color);
    const rgba_end = intToRGBA(end.color);

    // lerp every component, including alpha
    const final_color = rgba_start.map((c, i) => lerp(c, rgba_end[i], rt));

    // convert back to bytes, preserving the interpolated alpha
    const RGBAToInt = (rgba: number[]) => {
      const fc = rgba.map((c) => c * 255);
      return fromBytesBigEndian(fc[0], fc[1], fc[2], fc[3]);
    };
    return RGBAToInt(final_color);
  }
}

export class LinearGradient extends CanvasGradient {
  public start: Point;
  public end: Point;
  constructor(x0: number, y0: number, x1: number, y1: number) {
    super();
    this.start = new Point(x0, y0);
    this.end = new Point(x1, y1);
  }

  colorAt(x: number, y: number) {
    const pc = new Point(x, y); //convert to a point
    //calculate V
    let V = this.end.subtract(this.start); // subtract
    const d = V.magnitude(); // get magnitude
    V = V.divide(d); // normalize

    //calculate V0
    const V0 = pc.subtract(this.start);
    //project V0 onto V
    let t = V0.dotProduct(V);
    //convert to t value and clamp
    t = clamp(t / d, 0, 1);
    return this._lerpStops(t);
  }
}

export class RadialGradient extends CanvasGradient {
  public start: Point;
  constructor(x0: number, y0: number, _x1?: undefined, _y1?: undefined) {
    super();
    this.start = new Point(x0, y0);
  }

  colorAt(x: number, y: number) {
    const pc = new Point(x, y); //convert to a point
    const dist = pc.distance(this.start);
    const t = clamp(dist / 10, 0, 1);
    return this._lerpStops(t);
  }
}

function remap(
  val: number,
  smin: number,
  smax: number,
  omin: number,
  omax: number,
) {
  // map into range of 0 to 1
  let t = (val - smin) / (smax - smin);
  // map into new range
  return t * (omax - omin) + omin;
}

export class ConicalGradient extends CanvasGradient {
  private angle: number;
  private start: Point;
  constructor(angle: number, x0: number, y0: number) {
    super();
    this.angle = angle;
    this.start = new Point(x0, y0);
  }
  colorAt(x: number, y: number) {
    const pt = this.start.subtract(new Point(x, y));
    // angle measured clockwise from the gradient's start angle. atan2 ==
    // this.angle corresponds to offset t = 0; a full turn maps to t = 1.
    let ang = Math.atan2(pt.y, pt.x) - this.angle;
    ang = ((ang % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const t = ang / (2 * Math.PI);
    return this._lerpStops(t);
  }
}

export type ColorGradient = RadialGradient | LinearGradient | ConicalGradient;
