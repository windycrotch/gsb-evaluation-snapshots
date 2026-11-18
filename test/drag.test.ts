/**
 * applyDrag: the TradingView-style drag rules of the core, exercised directly
 * (no pointer events, no rendering) with a hand-built `Drawing` + `Coords`
 * stub, the way the SVG renderer host calls the core.
 *
 * Covers: time landing (keepTimesOnSameBars), rectangle edge-midpoint anchors
 * 4-7, bbox corner drags (opposite corner fixed), polyline end closing,
 * Shift anchor drags, and the guard paths (out-of-range handle, short point
 * arrays, body drags that must not snap).
 *
 * Chart stub: bar i sits at x = i * SP, its time is T0 + i * DAY; a time
 * inside a bar maps to that bar (timeToBarIndex = floor), the unprojected
 * time of an x is the nearest bar's open time. Price p sits at y = H - p * 10.
 */
import { describe, expect, it } from "vitest";
import type { Time } from "lightweight-charts";
import { applyDrag, type DragState } from "../src/core/interact/drag";
import { MIN_DISTANCE_BETWEEN_POINTS } from "../src/core/interact/constants";
import { defaultStyleFor, findOverlaySpec } from "../src/core/specs";
import { bboxCorners } from "../src/core/_shared";
import type { Coords, OHLC } from "../src/core/coords";
import type { DataPoint, Drawing, DrawingKind } from "../src/core/types";
import type { Pt } from "../src/core/_shared";

const DAY = 86_400;
const SP = 10; // px per bar
const H = 500; // pane height: y = H - price * 10
/** Bar 0: Monday 5 Jan 2026, 00:00 UTC. */
const T0 = Date.UTC(2026, 0, 5) / 1000;

const bars: OHLC[] = Array.from({ length: 60 }, (_, i) => ({
  time: (T0 + i * DAY) as Time,
  open: 1,
  high: 2,
  low: 0.5,
  close: 1.5,
}));

const bar = (i: number): Time => (T0 + i * DAY) as Time;

const coords: Coords = {
  priceToY: (p) => H - p * 10,
  yToPrice: (y) => (H - y) / 10,
  isLog: () => false,
  timeToX: (t) => (((t as number) - T0) / DAY) * SP,
  // Inverse of the x axis: the open time of the bar nearest the pixel.
  xToTime: (x) => bar(Math.round(x / SP)),
  barAt: (t) => bars.find((b) => b.time === t) ?? null,
  // The bar that holds the time (a mid-bar time belongs to the bar it falls in).
  timeToBarIndex: (t) => Math.floor(((t as number) - T0) / DAY),
  barIndexToTime: (i) => bar(i),
  bars: () => bars,
  visibleTimeRange: () => ({ from: T0, to: T0 + 59 * DAY }),
  indicatorValuesAt: () => [],
  pipSize: () => 0.01,
  addPriceLine: () => {
    throw new Error("coords stub: addPriceLine is not used");
  },
  removePriceLine: () => {},
  zoomToScreenRect: () => {},
  formatTime: (t) => new Date((t as number) * 1000).toISOString().slice(0, 10),
  timeAxis: () => ({ height: 28, width: 800, fontSize: 12, fontFamily: "sans-serif" }),
  timeInfo: () => ({ timeZone: "UTC", intraday: false }),
};

const identity = (p: DataPoint): DataPoint => p;

/** A drawing stub with the kind's factory style; extra fields (`closed`, ...) ride along. */
function make(kind: DrawingKind, points: DataPoint[], extra: Record<string, unknown> = {}): Drawing {
  return { id: "d1", kind, points, style: defaultStyleFor(kind), ...extra } as unknown as Drawing;
}

/** A point at bar `i`, `price` (screen x = i * SP, y = H - price * 10). */
const pt = (i: number, price: number): DataPoint => ({ time: bar(i), price });

const screenOf = (p: DataPoint): Pt => ({ x: coords.timeToX(p.time)!, y: coords.priceToY(p.price)! });

/** The pixel the runtime would report as the press point for a handle
 *  (bbox corners and rectangle edge midpoints are virtual anchors). */
function handlePixel(d: Drawing, screen: Pt[], idx: number): Pt {
  if (screen.length === 2 && findOverlaySpec(d.kind)?.isBbox && idx >= 0 && idx < 4) {
    return bboxCorners(screen[0], screen[1])[idx];
  }
  if (d.kind === "rectangle" && screen.length === 2 && idx >= 4 && idx <= 7) {
    const [tl, , br] = bboxCorners(screen[0], screen[1]);
    const mid = { x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 };
    return [
      mid, // 4 = top
      { x: br.x, y: mid.y }, // 5 = right
      { x: mid.x, y: br.y }, // 6 = bottom
      { x: tl.x, y: mid.y }, // 7 = left
    ][idx - 4];
  }
  return screen[idx] ?? { x: 0, y: 0 };
}

/** Drag state whose start screen positions are the points' projections. */
function stateOf(d: Drawing, mode: DragState["mode"]): DragState {
  const startScreen = d.points.map(screenOf);
  return {
    id: d.id,
    start: d,
    startCursor: mode.hit === "handle" ? handlePixel(d, startScreen, mode.handleIndex) : startScreen[0] ?? { x: 0, y: 0 },
    startScreen,
    mode,
    active: true,
  };
}

function handleState(d: Drawing, handleIndex: number): DragState {
  return stateOf(d, { hit: "handle", handleIndex });
}

function bodyState(d: Drawing): DragState {
  return stateOf(d, { hit: "body" });
}

function drag(d: Drawing, handleIndex: number, cursor: Pt, constrain = false, snap = identity): Drawing | null {
  return applyDrag(handleState(d, handleIndex), cursor, coords, snap, constrain);
}

describe("time landing (keepTimesOnSameBars)", () => {
  // p0 is stored 40 % into bar 4 — a time that is not a bar open. p1 on bar 20.
  const midBar4 = (T0 + 4.4 * DAY) as Time;
  const line = () => make("trend-line", [{ time: midBar4, price: 40 }, pt(20, 20)]);

  it("an anchor dragged onto its own bar keeps the stored time and only the price changes", () => {
    const got = drag(line(), 0, { x: 43, y: 60 }) as Drawing;
    expect(got.points).toEqual([
      { time: midBar4, price: 44 }, // x 43 still rounds to bar 4 -> stored time kept
      { time: bar(20), price: 20 },
    ]);
  });

  it("an anchor dragged to another bar takes that bar's open time", () => {
    const got = drag(line(), 0, { x: 64, y: 60 }) as Drawing;
    expect(got.points).toEqual([
      { time: bar(6), price: 44 },
      { time: bar(20), price: 20 },
    ]);
  });

  it("the other, unmoved point keeps its stored time and price", () => {
    const start = line();
    const got = drag(start, 0, { x: 64, y: 60 }) as Drawing;
    expect(got.points[1]).toEqual(start.points[1]);
  });

  it("dragging the second point leaves the first point untouched", () => {
    const start = line();
    const got = drag(start, 1, { x: 203, y: 300 }) as Drawing;
    expect(got.points[0]).toEqual(start.points[0]);
    expect(got.points[1]).toEqual({ time: bar(20), price: 20 }); // x 203 still on bar 20
  });

  it("without a bar index (no data) a moved point keeps its new time", () => {
    const noData: Coords = { ...coords, timeToBarIndex: () => null };
    const start = line();
    const got = applyDrag(handleState(start, 0), { x: 43, y: 60 }, noData, identity) as Drawing;
    // Same bar as far as the axis is concerned, but the index is unknown, so
    // the stored time is not restored: the unprojected time stands.
    expect(got.points).toEqual([pt(4, 44), pt(20, 20)]);
  });

  it("does not mutate the start drawing", () => {
    const start = line();
    const before = structuredClone(start);
    drag(start, 0, { x: 64, y: 60 });
    expect(start).toEqual(before);
  });
});

describe("rectangle edge-midpoint anchors 4-7", () => {
  // top-left (100, 100) to bottom-right (300, 300): bar 10 / price 40, bar 30 / price 20.
  const rect = () => make("rectangle", [pt(10, 40), pt(30, 20)]);

  it.each([
    { idx: 4, edge: "top", cursor: { x: 200, y: 50 }, want: [pt(10, 45), pt(30, 20)] },
    { idx: 5, edge: "right", cursor: { x: 250, y: 200 }, want: [pt(10, 40), pt(25, 20)] },
    { idx: 6, edge: "bottom", cursor: { x: 200, y: 350 }, want: [pt(10, 40), pt(30, 15)] },
    { idx: 7, edge: "left", cursor: { x: 50, y: 200 }, want: [pt(5, 40), pt(30, 20)] },
  ])("$edge ($idx) moves only that edge; the opposite and cross-axis edges stay", ({ idx, cursor, want }) => {
    const got = drag(rect(), idx, cursor) as Drawing;
    expect(got.points).toEqual(want);
  });

  it("a dragged edge keeps a stored mid-bar time when it stays on the same bar", () => {
    const midBar10 = (T0 + 10.4 * DAY) as Time;
    const d = make("rectangle", [{ time: midBar10, price: 40 }, pt(30, 20)]);
    // The top edge moves (y 100 -> 60); its x stays over bar 10.
    const got = drag(d, 4, { x: 200, y: 60 }) as Drawing;
    expect(got.points).toEqual([
      { time: midBar10, price: 44 }, // same bar -> the stored time wins over the bar open
      { time: bar(30), price: 20 },
    ]);
  });

  it("Shift on a right edge-midpoint widens the box and grows the height symmetrically", () => {
    // TV _correctRightLeftMiddlePoint: the right edge follows the pointer and
    // the height changes by the same pixels, split between top and bottom.
    // right 300 -> 250, top 100 -> 125, bottom 300 -> 275.
    const got = drag(rect(), 5, { x: 250, y: 200 }, true) as Drawing;
    expect(got.points).toEqual([pt(10, 37.5), pt(25, 22.5)]);
  });

  it("Shift on a top edge-midpoint moves both side edges by whole bars", () => {
    // _correctTopBottomMiddlePoint: grow 20 px / 10 px bar spacing = 2 bars on
    // each side (left 100 -> 80, right 300 -> 320); the top edge drops by the
    // pixel width of those 2 bars (100 -> 80).
    const got = drag(rect(), 4, { x: 200, y: 80 }, true) as Drawing;
    expect(got.points).toEqual([pt(8, 42), pt(32, 20)]);
  });
});

describe("bbox corner drags (opposite corner fixed)", () => {
  // Same rectangle as above: corners tl (100,100), tr (300,100), br (300,300), bl (100,300).
  const rect = () => make("rectangle", [pt(10, 40), pt(30, 20)]);

  it("corner 0 (top-left): bottom-right stays put", () => {
    const got = drag(rect(), 0, { x: 50, y: 50 }) as Drawing;
    expect(got.points).toEqual([pt(5, 45), pt(30, 20)]);
  });

  it("corner 2 (bottom-right): top-left stays put", () => {
    const got = drag(rect(), 2, { x: 350, y: 350 }) as Drawing;
    expect(got.points).toEqual([pt(35, 15), pt(10, 40)]);
  });

  it("corner 1 (top-right) of a gann box: bottom-left stays put", () => {
    const box = make("gann-box", [pt(10, 40), pt(30, 20)]);
    const got = drag(box, 1, { x: 250, y: 50 }) as Drawing;
    expect(got.points).toEqual([pt(25, 45), pt(10, 20)]);
  });

  it("an out-of-range corner index on a bbox kind returns null instead of throwing", () => {
    // Gann box has no edge-midpoint anchors: index 5 is past the 4 corners and
    // the generic point path finds no such point.
    const box = make("gann-box", [pt(10, 40), pt(30, 20)]);
    expect(() => drag(box, 5, { x: 50, y: 50 })).not.toThrow();
    expect(drag(box, 5, { x: 50, y: 50 })).toBeNull();
  });

  it("a rectangle edge index past 7 matches no edge, so nothing moves", () => {
    // The rectangle edge branch owns every index >= 4; an index it doesn't
    // know (8, 9, ...) leaves left / top / right / bottom untouched.
    expect(drag(rect(), 8, { x: 50, y: 50 })).toEqual(rect());
  });

  it("with Shift a bbox corner snaps to a square around the fixed opposite corner", () => {
    const got = drag(rect(), 0, { x: 50, y: 50 }, true) as Drawing;
    // snapPointSquare: equal |dx| / |dy| (both 50 px) -> the drag lands exactly
    // on the square's corner; the opposite corner (300,300) stays put.
    expect(got.points).toEqual([pt(5, 45), pt(30, 20)]);
  });
});

describe("polyline end closing", () => {
  // (100,100) - (200,150) - (300,200)
  const poly = () => make("polyline", [pt(10, 40), pt(20, 35), pt(30, 30)]);

  it("the last point dropped within MIN_DISTANCE_BETWEEN_POINTS of the first closes the line at the drop point", () => {
    const got = drag(poly(), 2, { x: 102, y: 101 }) as Drawing; // ~2.2 px from (100,100)
    expect(got.closed).toBe(true);
    expect(got.points).toEqual([
      pt(10, 40),
      pt(20, 35),
      { time: bar(10), price: 39.9 },
    ]);
  });

  it("the first point dropped within the distance of the last end also closes it", () => {
    const got = drag(poly(), 0, { x: 302, y: 201 }) as Drawing; // ~2.2 px from (300,200)
    expect(got.closed).toBe(true);
    expect(got.points).toEqual([
      { time: bar(30), price: 29.9 },
      pt(20, 35),
      pt(30, 30),
    ]);
  });

  it("beyond the distance the endpoint just moves: no close", () => {
    const got = drag(poly(), 2, { x: 110, y: 100 }) as Drawing; // 10 px from the first point
    expect(got.closed).toBeUndefined();
    expect(got.points).toEqual([pt(10, 40), pt(20, 35), { time: bar(11), price: 40 }]);
  });

  it("exactly MIN_DISTANCE_BETWEEN_POINTS away still does not close (strict <)", () => {
    const got = drag(poly(), 2, { x: 100 + MIN_DISTANCE_BETWEEN_POINTS, y: 100 }) as Drawing;
    expect(got.closed).toBeUndefined();
  });

  it("a two-point polyline has no far end to close onto; the endpoint moves", () => {
    const d = make("polyline", [pt(10, 40), pt(30, 20)]);
    const got = drag(d, 1, { x: 102, y: 101 }) as Drawing;
    expect(got.closed).toBeUndefined();
    expect(got.points).toEqual([pt(10, 40), { time: bar(10), price: 39.9 }]);
  });
});

describe("guards: out-of-range handleIndex and short point arrays return null", () => {
  const line = () => make("trend-line", [pt(10, 40), pt(20, 20)]);

  it("handleIndex === points.length does not throw and returns null", () => {
    expect(() => drag(line(), 2, { x: 100, y: 100 })).not.toThrow();
    expect(drag(line(), 2, { x: 100, y: 100 })).toBeNull();
  });

  it("a negative handleIndex returns null", () => {
    expect(drag(line(), -1, { x: 100, y: 100 })).toBeNull();
  });

  it("a one-point polyline with handleIndex 1 returns null", () => {
    const d = make("polyline", [pt(10, 40)]);
    expect(drag(d, 1, { x: 100, y: 100 })).toBeNull();
  });

  it("a drawing with no points returns null", () => {
    const d = make("polyline", []);
    expect(() => drag(d, 0, { x: 100, y: 100 })).not.toThrow();
    expect(drag(d, 0, { x: 100, y: 100 })).toBeNull();
  });

  it("Shift with an out-of-range handle still returns null", () => {
    expect(drag(line(), 2, { x: 100, y: 100 }, true)).toBeNull();
  });

  it("a cursor that cannot be unprojected returns null", () => {
    const blind: Coords = { ...coords, xToTime: () => null };
    expect(applyDrag(handleState(line(), 0), { x: 100, y: 100 }, blind, identity)).toBeNull();
  });
});

describe("body drag", () => {
  const line = () => make("trend-line", [pt(10, 40), pt(20, 20)]);

  it("translates every point by the pointer delta and never snaps a point", () => {
    let snaps = 0;
    const snap = (p: DataPoint): DataPoint => {
      snaps++;
      return { time: p.time, price: p.price + 1000 };
    };
    const st = bodyState(line());
    const got = applyDrag(st, { x: st.startCursor.x + 2, y: st.startCursor.y - 20 }, coords, snap) as Drawing;
    expect(snaps).toBe(0); // per-point snapping would tear the shape apart
    // Same bars -> the stored times stay; both prices shift by +2.
    expect(got.points).toEqual([pt(10, 42), pt(20, 22)]);
  });

  it("a small body move keeps a stored mid-bar time (the prices only)", () => {
    const midBar10 = (T0 + 10.4 * DAY) as Time;
    const d = make("trend-line", [{ time: midBar10, price: 40 }, pt(20, 20)]);
    const st = bodyState(d);
    // The point projects to x = 104; -2 px still rounds to bar 10, so the stored
    // mid-bar time must come back instead of bar 10's open time.
    const got = applyDrag(st, { x: st.startCursor.x - 2, y: st.startCursor.y - 20 }, coords, identity) as Drawing;
    expect(got.points).toEqual([
      { time: midBar10, price: 42 },
      pt(20, 22),
    ]);
  });

  it("moved to other bars, the points take their new bars' open times", () => {
    const st = bodyState(line());
    const got = applyDrag(st, { x: st.startCursor.x + SP, y: st.startCursor.y - 20 }, coords, identity) as Drawing;
    expect(got.points).toEqual([pt(11, 42), pt(21, 22)]);
  });
});

describe("Shift anchor drag (shiftAnchorDrag branch)", () => {
  // p0 (100,100) = bar 10 / price 40, p1 (200,300) = bar 20 / price 20.
  const line = () => make("trend-line", [pt(10, 40), pt(20, 20)]);

  it("without Shift the dragged end lands under the cursor (bar 16, price 28)", () => {
    const got = drag(line(), 0, { x: 160, y: 220 }) as Drawing;
    expect(got.points).toEqual([pt(16, 28), pt(20, 20)]);
  });

  it("with Shift the dragged end snaps to the 45° rule around the other end", () => {
    const got = drag(line(), 0, { x: 160, y: 220 }, true) as Drawing;
    // snapPoint45: the direction from p1 (200,300) to (160,220) is diagonal, so
    // the leg is rounded to whole bars and the price taken from the real pixel
    // width of that bar distance -> bar 14 / price 26 (not the free bar 16 / 28).
    expect(got.points).toEqual([pt(14, 26), pt(20, 20)]);
  });

  it("with Shift a near-vertical drag takes the other end's bar (price kept)", () => {
    const got = drag(line(), 0, { x: 250, y: 110 }, true) as Drawing;
    expect(got.points).toEqual([pt(20, 39), pt(20, 20)]);
  });
});
