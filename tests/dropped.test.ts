/** A dropped folder: its files are walked (in batches, like the browser gives them) and named by their path. */
import { describe, expect, it } from 'vitest';
import { pathedFromInput, readEntries } from '@/store/dropped';
import type { FsEntry } from '@/store/dropped';

const file = (name: string): FsEntry => ({ isFile: true, isDirectory: false, name, file: (ok) => ok(new File(['x'], name)) });
/** A fake folder that hands out its children `batch` at a time. */
function dir(name: string, children: FsEntry[], batch = 2): FsEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      let at = 0;
      return {
        readEntries(ok) {
          const out = children.slice(at, at + batch);
          at += batch;
          ok(out);
        },
      };
    },
  };
}

describe('dropped folders', () => {
  it('walks nested folders and every batch of a reader, naming files by their path', async () => {
    const tree = dir('hero', [
      file('a.png'),
      file('b.png'),
      file('c.png'),
      dir('arm', [file('upper.png'), file('lower.png'), file('hand.png')]),
    ]);
    const { files, folders } = await readEntries([tree, file('loose.png')]);
    expect(folders).toBe(2);
    expect(files.map((f) => f.path)).toEqual([
      'hero/a.png',
      'hero/arm/hand.png',
      'hero/arm/lower.png',
      'hero/arm/upper.png',
      'hero/b.png',
      'hero/c.png',
      'loose.png',
    ]);
  });

  it('orders numbered files naturally (frame2 before frame10)', async () => {
    const { files } = await readEntries([dir('fx', [file('frame10.png'), file('frame2.png'), file('frame1.png')])]);
    expect(files.map((f) => f.path)).toEqual(['fx/frame1.png', 'fx/frame2.png', 'fx/frame10.png']);
  });

  it('files without entries (plain drop) and an empty folder give nothing odd', async () => {
    expect((await readEntries([dir('empty', [])])).files).toEqual([]);
    expect((await readEntries([])).files).toEqual([]);
  });

  it('a folder chosen in an input is named by the browser relative path', () => {
    const f = (path: string) => Object.assign(new File(['x'], path.split('/').pop()!), { webkitRelativePath: path });
    expect(pathedFromInput([f('hero/f10.png'), f('hero/f2.png'), new File(['x'], 'solo.png')]).map((p) => p.path)).toEqual([
      'hero/f2.png',
      'hero/f10.png',
      'solo.png',
    ]);
  });
});
