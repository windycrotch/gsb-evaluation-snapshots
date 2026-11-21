/** Selection history: PgUp / PgDn go back and forward over the selections, skipping what is gone. */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SelectionHistory,
  entryExists,
  selectionBack,
  selectionForward,
  selectionHistory,
  startSelectionHistory,
} from '../src/store/selHistory';
import { docStore } from '../src/store/doc';
import { setSelection } from '../src/store/actions';
import { uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';

const e = (bones: string[], slot: string | null = null) => ({ bones, slot, attachment: null, constraint: null });
const always = () => true;

describe('SelectionHistory', () => {
  it('remembers selections in order, not empty ones, not the same twice', () => {
    const h = new SelectionHistory();
    h.push(e([]));
    h.push(e(['a']));
    h.push(e(['a']));
    h.push(e(['b']));
    expect(h.list.map((x) => x.bones)).toEqual([['a'], ['b']]);
    expect(h.at).toBe(1);
  });
  it('goes back and forward, and says when there is no more', () => {
    const h = new SelectionHistory();
    for (const id of ['a', 'b', 'c']) h.push(e([id]));
    expect(h.move(-1, always)?.bones).toEqual(['b']);
    expect(h.move(-1, always)?.bones).toEqual(['a']);
    expect(h.move(-1, always)).toBeNull();
    expect(h.at).toBe(0);
    expect(h.move(1, always)?.bones).toEqual(['b']);
  });
  it('a new selection after going back drops what was forward', () => {
    const h = new SelectionHistory();
    for (const id of ['a', 'b', 'c']) h.push(e([id]));
    h.move(-1, always);
    h.move(-1, always);
    h.push(e(['d']));
    expect(h.list.map((x) => x.bones[0])).toEqual(['a', 'd']);
    expect(h.move(1, always)).toBeNull();
  });
  it('skips the entries that are refused, and keeps at most `max`', () => {
    const h = new SelectionHistory(3);
    for (const id of ['a', 'b', 'c', 'd']) h.push(e([id]));
    expect(h.list.map((x) => x.bones[0])).toEqual(['b', 'c', 'd']);
    expect(h.move(-1, (x) => x.bones[0] !== 'c')?.bones).toEqual(['b']);
    expect(h.move(1, (x) => x.bones[0] !== 'c' && x.bones[0] !== 'd')).toBeNull();
    expect(h.at).toBe(0);
  });
});

describe('through the editor', () => {
  let ids: string[];
  beforeEach(() => {
    const { project } = buildFixture();
    docStore.replace(project);
    selectionHistory.clear();
    ids = project.skeleton.bones.map((b) => b.id);
    setSelection({ bones: [], slot: null });
  });

  it('follows the selection as it changes, and PgUp / PgDn move it without recording itself', () => {
    const stop = startSelectionHistory();
    setSelection({ bones: [ids[0]] });
    setSelection({ bones: [ids[1]] });
    setSelection({ bones: [ids[2]] });
    expect(selectionBack()).toBe(true);
    expect(uiStore.get().selection.bones).toEqual([ids[1]]);
    expect(selectionBack()).toBe(true);
    expect(uiStore.get().selection.bones).toEqual([ids[0]]);
    expect(selectionBack()).toBe(false);
    expect(selectionForward()).toBe(true);
    expect(uiStore.get().selection.bones).toEqual([ids[1]]);
    expect(selectionHistory.list).toHaveLength(3);
    stop();
  });

  it('skips a bone that was deleted', () => {
    const stop = startSelectionHistory();
    setSelection({ bones: [ids[1]] });
    setSelection({ bones: [ids[2]] });
    const doc = docStore.get().skeleton;
    expect(entryExists(doc, e([ids[1]]))).toBe(true);
    expect(entryExists(doc, e(['gone']))).toBe(false);
    expect(entryExists(doc, e([], 'no-slot'))).toBe(false);
    docStore.update('x', (d) => {
      d.skeleton.bones = d.skeleton.bones.filter((b) => b.id !== ids[1] && b.parent !== ids[1]);
    });
    stop();
  });
});
