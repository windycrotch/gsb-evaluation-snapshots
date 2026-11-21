/** Review comments: the file a reviewer sends back, read strictly, and applied to the timelines as markers. */
import { describe, expect, it } from 'vitest';
import { cleanMarkers } from '../src/core/markers';
import {
  MAX_COMMENTS,
  MAX_TEXT,
  applyReview,
  makeComment,
  markerIdOf,
  parseReview,
  reviewCounts,
  serializeReview,
} from '../src/core/review';
import { buildFixture } from './fixture';

const anim = (doc: ReturnType<typeof buildFixture>['project']['skeleton']) => doc.animations.find((a) => a.name === 'walk')!;

describe('serialize and parse', () => {
  it('round-trips comments', () => {
    const c = [
      makeComment('a1', 'walk', 0.5, ' the arm is stiff ', ' Mia ', 'armUpper', 1000),
      makeComment('a2', 'walk', 1.1, 'foot slides', '', undefined, 2000),
    ];
    const back = parseReview(serializeReview('Hero', c))!;
    expect(back.title).toBe('Hero');
    expect(back.dropped).toBe(0);
    expect(back.comments).toEqual([
      { id: 'a1', animation: 'walk', time: 0.5, text: 'the arm is stiff', author: 'Mia', bone: 'armUpper', at: 1000 },
      { id: 'a2', animation: 'walk', time: 1.1, text: 'foot slides', author: '', at: 2000 },
    ]);
  });

  it('is not a review file unless it says so', () => {
    for (const t of [
      '',
      'nope',
      '[]',
      '{}',
      '{"bone2dReview":2,"comments":[]}',
      '{"bone2dReview":1}',
      '{"bone2dReview":1,"comments":{}}',
      'null',
      '5',
    ])
      expect(parseReview(t)).toBeNull();
    expect(parseReview('x'.repeat(3_000_000))).toBeNull();
  });

  it('drops bad comments one by one and keeps the good ones', () => {
    const text = JSON.stringify({
      bone2dReview: 1,
      title: 'x',
      comments: [
        { id: 'ok', animation: 'walk', time: 1, text: 'fine', author: 'A', at: 5 },
        { id: 'ok', animation: 'walk', time: 2, text: 'same id twice', author: 'A' }, // duplicate id
        { id: 'bad id!', animation: 'walk', time: 1, text: 't' },
        { id: 'n1', animation: 'walk', time: -1, text: 't' },
        { id: 'n2', animation: 'walk', time: null, text: 't' },
        { id: 'n3', animation: 'walk', time: 1, text: '   ' },
        { id: 'n4', animation: '', time: 1, text: 't' },
        { id: 'n5', animation: 'walk', time: 1, text: 42 },
        null,
        7,
        'str',
      ],
    });
    const r = parseReview(text)!;
    expect(r.comments.map((c) => c.id)).toEqual(['ok']);
    expect(r.dropped).toBe(10);
  });

  it('limits the number of comments and the length of text, and strips control characters', () => {
    const many = Array.from({ length: MAX_COMMENTS + 30 }, (_, i) => ({ id: `c${i}`, animation: 'walk', time: 0, text: 'hi' }));
    const r = parseReview(JSON.stringify({ bone2dReview: 1, comments: many }))!;
    expect(r.comments).toHaveLength(MAX_COMMENTS);
    expect(r.dropped).toBe(30);
    const long = parseReview(
      JSON.stringify({
        bone2dReview: 1,
        comments: [{ id: 'l', animation: 'walk', time: 0, text: `a\u0000b${'z'.repeat(MAX_TEXT * 2)}`, author: 'x\u0007y' }],
      }),
    )!;
    expect(long.comments[0].text.length).toBe(MAX_TEXT);
    expect(long.comments[0].text.startsWith('ab')).toBe(true);
    expect(long.comments[0].author).toBe('xy');
  });

  it('reads only its own fields (nothing from a hostile object leaks through)', () => {
    const r = parseReview(
      '{"bone2dReview":1,"__proto__":{"x":1},"comments":[{"id":"p","animation":"walk","time":0,"text":"t","__proto__":{"evil":true},"constructor":"x","extra":{"a":1}}]}',
    )!;
    expect(Object.keys(r.comments[0]).sort()).toEqual(['animation', 'at', 'author', 'id', 'text', 'time']);
    expect(({} as { evil?: boolean }).evil).toBeUndefined();
  });
});

describe('applyReview', () => {
  it('puts the comments on the markers of their animations, in time order', () => {
    const doc = buildFixture().project.skeleton;
    const a = anim(doc);
    const before = a.markers?.length ?? 0;
    const r = applyReview(doc, [makeComment('b', 'walk', 0.8, 'second', 'Mia'), makeComment('a', 'walk', 0.2, 'first', 'Mia', 'armUpper')]);
    expect(r).toEqual({ added: 2, updated: 0, skipped: 0 });
    expect(a.markers).toHaveLength(before + 2);
    const m = a.markers!.find((x) => x.id === markerIdOf({ id: 'a' }))!;
    expect(m).toMatchObject({ time: 0.2, text: 'first', author: 'Mia', bone: 'armUpper', review: true, resolved: false, name: 'Mia' });
    const times = a.markers!.map((x) => x.time);
    expect(times).toEqual([...times].sort((x, y) => x - y));
  });

  it('skips a comment about an animation that is not there and keeps a time inside the animation', () => {
    const doc = buildFixture().project.skeleton;
    const a = anim(doc);
    const r = applyReview(doc, [
      makeComment('x', 'no such animation', 1, 'lost', 'A'),
      makeComment('y', 'walk', a.duration + 50, 'late', 'A'),
    ]);
    expect(r).toEqual({ added: 1, updated: 0, skipped: 1 });
    expect(a.markers!.find((m) => m.id === markerIdOf({ id: 'y' }))!.time).toBe(a.duration);
  });

  it('importing the same file again changes nothing, and keeps what the animator marked resolved', () => {
    const doc = buildFixture().project.skeleton;
    const a = anim(doc);
    const file = [makeComment('r1', 'walk', 0.3, 'v1', 'Mia')];
    applyReview(doc, file);
    a.markers!.find((m) => m.id === markerIdOf({ id: 'r1' }))!.resolved = true;
    const count = a.markers!.length;
    const again = applyReview(doc, [makeComment('r1', 'walk', 0.35, 'v2 (edited)', 'Mia')]);
    expect(again).toEqual({ added: 0, updated: 1, skipped: 0 });
    expect(a.markers).toHaveLength(count);
    const m = a.markers!.find((x) => x.id === markerIdOf({ id: 'r1' }))!;
    expect(m.resolved).toBe(true);
    expect(m.text).toBe('v2 (edited)');
    expect(m.time).toBe(0.35);
  });

  it('counts open and resolved comments, and ignores markers that are not review ones', () => {
    const doc = buildFixture().project.skeleton;
    const a = anim(doc);
    (a.markers ??= []).push({ id: 'plain', time: 0.1, name: 'beat', color: 0, text: '' });
    applyReview(doc, [makeComment('c1', 'walk', 0.1, 'a', 'A'), makeComment('c2', 'walk', 0.2, 'b', 'A')]);
    a.markers.find((m) => m.id === markerIdOf({ id: 'c1' }))!.resolved = true;
    expect(reviewCounts(doc)).toEqual({ open: 1, resolved: 1 });
  });
});

describe('markers keep the review fields', () => {
  it('cleanMarkers keeps author, bone and the resolved mark of a review marker and nothing extra on a plain one', () => {
    const out = cleanMarkers(
      [
        { id: 'r', time: 1, name: 'Mia', color: 3, text: 't', review: true, author: 'Mia', bone: 'arm', resolved: true },
        { id: 'p', time: 2, name: 'beat', color: 0, text: '', author: 'ignored', resolved: true },
      ],
      5,
    );
    expect(out[0]).toMatchObject({ review: true, author: 'Mia', bone: 'arm', resolved: true });
    expect(out[1]).toEqual({ id: 'p', time: 2, name: 'beat', color: 0, text: '' });
  });
});

describe('the player page', () => {
  it('has the comment controls and a script that writes the review file', async () => {
    const { default: playerScript } = await import('virtual:bone2d-player');
    const { playerPageHtml } = await import('../src/core/export/playerPage');
    const { project } = buildFixture();
    const html = playerPageHtml({ title: 'Hero', skeleton: project.skeleton, images: {}, smooth: true }, playerScript);
    for (const id of ['note', 'send', 'dlg', 'who', 'what', 'dsave', 'dcancel', 'mine']) expect(html).toContain(`id="${id}"`);
    // the script is the one that makes the file: the format signature and the file name are in it, and it still has no network
    expect(playerScript).toContain('bone2dReview');
    expect(playerScript).toContain('.b2dreview.json');
    expect(playerScript).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket/);
  });
});
