/** Package Project: the project file and its pictures in one ZIP. */
import { describe, expect, it } from 'vitest';
import { packageEntries, safeZipPath } from '../src/core/export/packageProject';
import { createZip } from '../src/core/export/zip';

const png = (n: number) => new Uint8Array([137, 80, 78, 71, n]);

describe('safeZipPath', () => {
  it('drops parts that climb out of the folder and characters files refuse', () => {
    expect(safeZipPath('../../etc/passwd')).toBe('etc/passwd');
    expect(safeZipPath('/abs\\path/./x')).toBe('abs/path/x');
    expect(safeZipPath('a:b*c?')).toBe('a_b_c_');
    expect(safeZipPath('..')).toBe('image');
    expect(safeZipPath('')).toBe('image');
  });
});

describe('packageEntries', () => {
  it('has the project file first and the pictures in an images folder', () => {
    const e = packageEntries('my hero', '{"bone2d":1}', [
      { name: 'body', type: 'image/png', bytes: png(1) },
      { name: 'parts/arm', type: 'image/webp', bytes: png(2) },
      { name: 'head.png', type: 'image/png', bytes: png(3) },
    ]);
    expect(e.map((x) => x.name)).toEqual(['my hero.bone2d', 'images/body.png', 'images/parts/arm.webp', 'images/head.png']);
    expect(new TextDecoder().decode(e[0].data)).toBe('{"bone2d":1}');
    expect(Array.from(e[1].data)).toEqual(Array.from(png(1)));
  });

  it('keeps every path unique, even when names differ only in case or by the extension', () => {
    const e = packageEntries('p', '{}', [
      { name: 'a', type: 'image/png', bytes: png(1) },
      { name: 'A', type: 'image/png', bytes: png(2) },
      { name: 'a.png', type: 'image/png', bytes: png(3) },
    ]);
    const names = e.map((x) => x.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(e).toHaveLength(4);
  });

  it('a project name that is a path cannot place the file elsewhere', () => {
    expect(packageEntries('../x/y', '{}', [])[0].name).toBe('x_y.bone2d');
  });

  it('makes a ZIP that lists every entry', () => {
    const entries = packageEntries('p', '{"a":1}', [{ name: 'b', type: 'image/png', bytes: png(1) }]);
    const zip = createZip(entries);
    expect(Array.from(zip.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    // the end-of-central-directory record carries the entry count
    const eocd = zip.length - 22;
    expect(Array.from(zip.slice(eocd, eocd + 4))).toEqual([0x50, 0x4b, 0x05, 0x06]);
    expect(zip[eocd + 10] | (zip[eocd + 11] << 8)).toBe(2);
  });
});
