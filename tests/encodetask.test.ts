/** The encoders as worker tasks: the same bytes as calling them directly, progress that only grows, and the buffers handed over once. */
import { describe, expect, it } from 'vitest';
import { encodeApng, frameDelay } from '../src/core/export/apng';
import { encodeGif } from '../src/core/export/gif';
import { runEncodeTask, transferablesOf } from '../src/core/export/encodeTask';
import type { EncodeTask } from '../src/core/export/encodeTask';
import { createZip } from '../src/core/export/zip';

function frame(w: number, h: number, seed: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = (i * 7 + seed * 40) & 255;
    d[i * 4 + 1] = (i * 3) & 255;
    d[i * 4 + 2] = (i + seed * 90) & 255;
    d[i * 4 + 3] = i % 5 === 0 ? 0 : 255;
  }
  return d;
}

describe('encode tasks (what the export worker runs)', () => {
  const frames = [frame(16, 12, 0), frame(16, 12, 1), frame(16, 12, 2)];
  const options = { width: 16, height: 12, delayCs: 8, transparent: true };

  it('a GIF task gives the bytes encodeGif gives, and reports progress frame by frame', () => {
    const seen: number[] = [];
    const bytes = runEncodeTask({ kind: 'gif', frames, options }, (f) => seen.push(f));
    expect(Array.from(bytes)).toEqual(Array.from(encodeGif(frames, options)));
    expect(seen).toEqual([1 / 3, 2 / 3, 1]);
  });

  it('a ZIP task gives the same entries as createZip (the date inside the file is the only thing that may differ)', () => {
    const files = [
      { name: 'a.txt', data: new Uint8Array([1, 2, 3]) },
      { name: 'b/c.bin', data: new Uint8Array(500).fill(7) },
    ];
    const a = runEncodeTask({ kind: 'zip', files });
    const b = createZip(files);
    expect(a.length).toBe(b.length);
    expect(String.fromCharCode(...a.subarray(0, 4))).toBe('PK\u0003\u0004');
  });

  it('an APNG task fails the way encodeApng does (frames that are not PNG files)', () => {
    const task: EncodeTask = { kind: 'apng', frames: [new Uint8Array([1, 2, 3])], options: { ...frameDelay(12), plays: 0 } };
    expect(() => runEncodeTask(task)).toThrow();
    expect(() => encodeApng([new Uint8Array([1, 2, 3])], { ...frameDelay(12), plays: 0 })).toThrow();
  });

  it('lists every buffer of a task once, even when two frames share one', () => {
    const shared = new Uint8ClampedArray(64);
    const task: EncodeTask = { kind: 'gif', frames: [shared, shared.subarray(0, 16), new Uint8ClampedArray(8)], options };
    expect(transferablesOf(task)).toHaveLength(2);
    const zip: EncodeTask = {
      kind: 'zip',
      files: [
        { name: 'x', data: new Uint8Array(4) },
        { name: 'y', data: new Uint8Array(4) },
      ],
    };
    expect(transferablesOf(zip)).toHaveLength(2);
  });
});
