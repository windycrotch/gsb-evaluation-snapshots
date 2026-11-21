/**
 * Sprite sheets: one picture that holds the frames of an animation in a grid. The grid (by the number of columns and rows, or by the size
 * of a cell), the rectangles of the frames in reading order, which empty cells at the end to drop, and the sequence the frames make.
 */
import type { SequenceDef } from './model';
import { sequenceFrameNames } from './sequence';

export interface SheetGrid {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  /** Empty border around the whole grid, in pixels. */
  margin: number;
  /** Empty gap between two cells, in pixels. */
  spacing: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const whole = (v: number, min: number, max: number) => (Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : min);

/** A grid of `cols` x `rows` cells that fills the picture inside its margin; null when the cells would be empty. */
export function gridByCount(width: number, height: number, cols: number, rows: number, margin = 0, spacing = 0): SheetGrid | null {
  cols = whole(cols, 1, 1000);
  rows = whole(rows, 1, 1000);
  margin = whole(margin, 0, 100000);
  spacing = whole(spacing, 0, 100000);
  const cellW = Math.floor((width - 2 * margin - (cols - 1) * spacing) / cols);
  const cellH = Math.floor((height - 2 * margin - (rows - 1) * spacing) / rows);
  return cellW >= 1 && cellH >= 1 ? { cols, rows, cellW, cellH, margin, spacing } : null;
}

/** A grid of cells of a given size: as many as fit inside the margin; null when not even one fits. */
export function gridByCell(width: number, height: number, cellW: number, cellH: number, margin = 0, spacing = 0): SheetGrid | null {
  cellW = whole(cellW, 1, 100000);
  cellH = whole(cellH, 1, 100000);
  margin = whole(margin, 0, 100000);
  spacing = whole(spacing, 0, 100000);
  const cols = Math.floor((width - 2 * margin + spacing) / (cellW + spacing));
  const rows = Math.floor((height - 2 * margin + spacing) / (cellH + spacing));
  return cols >= 1 && rows >= 1 ? { cols: Math.min(cols, 1000), rows: Math.min(rows, 1000), cellW, cellH, margin, spacing } : null;
}

/** The cells in reading order: left to right then down, or (`byColumns`) top to bottom then to the right. */
export function cellRects(grid: SheetGrid, byColumns = false): Rect[] {
  const out: Rect[] = [];
  const at = (c: number, r: number): Rect => ({
    x: grid.margin + c * (grid.cellW + grid.spacing),
    y: grid.margin + r * (grid.cellH + grid.spacing),
    w: grid.cellW,
    h: grid.cellH,
  });
  if (byColumns) for (let c = 0; c < grid.cols; c++) for (let r = 0; r < grid.rows; r++) out.push(at(c, r));
  else for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) out.push(at(c, r));
  return out;
}

/** How many cells to keep: the empty ones at the end of the sheet (the unused rest of the last row) are dropped, the empty ones between frames stay (they are timing). */
export function framesToKeep(blank: readonly boolean[]): number {
  let n = blank.length;
  while (n > 0 && blank[n - 1]) n--;
  return n;
}

/** Whether RGBA pixels are all (nearly) transparent. */
export function isBlankPixels(data: ArrayLike<number>, threshold = 0): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] > threshold) return false;
  return true;
}

/** The sequence the frames make, and the names of their pictures: `base` and the frame number, padded to the width of the biggest one. */
export function sheetSequence(base: string, count: number): { sequence: SequenceDef; names: string[] } {
  const digits = Math.max(2, String(count).length);
  const sequence: SequenceDef = { count, start: 1, digits, setupIndex: 0 };
  return { sequence, names: sequenceFrameNames(base, sequence) };
}

/** The seconds a frame stays for a frame rate: the delay of a sequence key. */
export const delayForFps = (fps: number): number => (Number.isFinite(fps) && fps > 0 ? Math.round((1 / fps) * 100000) / 100000 : 0.1);
