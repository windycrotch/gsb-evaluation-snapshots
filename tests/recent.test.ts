/** The list of recent projects: a file moves to the front instead of repeating, and the list is capped. */
import { describe, expect, it } from 'vitest';
import { MAX_RECENT, mergeRecent } from '../src/store/recent';
import type { RecentEntry } from '../src/store/recent';

const entry = (id: string, time = 0): RecentEntry => ({ id, name: `${id}.bone2d`, time });

describe('mergeRecent', () => {
  it('puts the newest first', () => {
    expect(mergeRecent([entry('a'), entry('b')], entry('c')).map((e) => e.id)).toEqual(['c', 'a', 'b']);
  });

  it('moves a known file to the front with its new time', () => {
    const out = mergeRecent([entry('a', 1), entry('b', 2), entry('c', 3)], entry('c', 9));
    expect(out.map((e) => e.id)).toEqual(['c', 'a', 'b']);
    expect(out[0].time).toBe(9);
  });

  it('keeps at most MAX_RECENT, dropping the oldest', () => {
    let list: RecentEntry[] = [];
    for (let i = 0; i < MAX_RECENT + 5; i++) list = mergeRecent(list, entry(String(i)));
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0].id).toBe(String(MAX_RECENT + 4));
    expect(list.at(-1)!.id).toBe('5');
  });

  it('does not change the list it is given', () => {
    const list = [entry('a')];
    mergeRecent(list, entry('b'));
    expect(list).toHaveLength(1);
  });
});
