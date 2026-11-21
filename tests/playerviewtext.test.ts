/** The player page: its words in two languages, and the click that points a comment at a bone. */
import { describe, expect, it } from 'vitest';
import playerScript from 'virtual:bone2d-player';
import { PLAYER_TEXTS, playerLang, playerText } from '../src/core/export/playerText';
import type { PlayerKey } from '../src/core/export/playerText';
import { playerPageHtml } from '../src/core/export/playerPage';
import { canvasToWorld, distanceToSegment, nearestBone, viewScale, worldToCanvas } from '../src/core/export/playerView';
import { buildFixture } from './fixture';

describe('the words of the page', () => {
  it('every text exists in both languages and none is empty', () => {
    const en = Object.keys(PLAYER_TEXTS.en).sort();
    expect(Object.keys(PLAYER_TEXTS.ru).sort()).toEqual(en);
    for (const lang of ['en', 'ru'] as const)
      for (const key of en as PlayerKey[]) expect(PLAYER_TEXTS[lang][key].trim().length, `${lang}.${key}`).toBeGreaterThan(0);
  });

  it('a Russian text is not the English one, except where a word is the same in both', () => {
    const same = (Object.keys(PLAYER_TEXTS.en) as PlayerKey[]).filter((k) => PLAYER_TEXTS.en[k] === PLAYER_TEXTS.ru[k]);
    expect(same).toEqual([]);
  });

  it('the places to fill have the same names in both languages', () => {
    const slots = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    for (const key of Object.keys(PLAYER_TEXTS.en) as PlayerKey[])
      expect(slots(PLAYER_TEXTS.ru[key]), key).toBe(slots(PLAYER_TEXTS.en[key]));
  });

  it('is Russian for a Russian browser and English for the rest', () => {
    for (const l of ['ru', 'ru-RU', 'RU', 'ru_RU', ' ru-UA ']) expect(playerLang(l), l).toBe('ru');
    for (const l of ['en', 'en-US', 'de', 'uk', 'rus', 'ruby', '', null, undefined]) expect(playerLang(l as never), String(l)).toBe('en');
  });

  it('fills the places and leaves a place nobody filled as it is', () => {
    expect(playerText('en', 'send', { n: 3 })).toBe('Send comments (3)');
    expect(playerText('ru', 'send', { n: 3 })).toBe('Отправить комментарии (3)');
    expect(playerText('en', 'bone', { name: 'arm' })).toBe('Bone: arm');
    expect(playerText('en', 'bone')).toBe('Bone: {name}');
  });

  it('the page script carries the Russian words, and the shell has the places the script fills', () => {
    expect(playerScript).toContain('Отправить комментарии');
    expect(playerScript).toContain('Щёлкните кость');
    const html = playerPageHtml({ title: 'Hero', skeleton: buildFixture().project.skeleton, images: {}, smooth: true }, 'x');
    for (const id of [
      'over',
      'bonehint',
      'bonerow',
      'bone',
      'bonex',
      'note',
      'send',
      'dlg',
      'who',
      'what',
      'mine',
      'dsave',
      'dcancel',
      'dlgbox',
    ])
      expect(html, id).toContain(`id="${id}"`);
  });
});

describe('the view', () => {
  const fit = { x: 40, y: 90, w: 200, h: 300 };
  const view = { x: 12, y: -7, zoom: 1.7 };

  it('fits the box with a margin and scales with the zoom', () => {
    expect(viewScale(800, 600, fit, 1)).toBeCloseTo(Math.min(800 / (200 * 1.16), 600 / (300 * 1.16)), 9);
    expect(viewScale(800, 600, fit, 2)).toBeCloseTo(2 * viewScale(800, 600, fit, 1), 9);
  });

  it('canvasToWorld undoes worldToCanvas', () => {
    for (const [x, y] of [
      [0, 0],
      [40, 90],
      [-120, 300],
      [500, -40],
    ]) {
      const [px, py] = worldToCanvas(x, y, 800, 600, fit, view);
      const [wx, wy] = canvasToWorld(px, py, 800, 600, fit, view);
      expect(wx).toBeCloseTo(x, 9);
      expect(wy).toBeCloseTo(y, 9);
    }
  });

  it('the centre of the canvas is the centre of the box moved by the pan, and up on the screen is up in the world', () => {
    const [cx, cy] = canvasToWorld(400, 300, 800, 600, fit, view);
    expect(cx).toBeCloseTo(fit.x + view.x, 9);
    expect(cy).toBeCloseTo(fit.y + view.y, 9);
    expect(canvasToWorld(400, 100, 800, 600, fit, view)[1]).toBeGreaterThan(cy);
  });
});

describe('the bone a click points at', () => {
  const bones = [
    { name: 'root', x1: 0, y1: 0, x2: 0, y2: 0 },
    { name: 'arm', x1: 0, y1: 0, x2: 100, y2: 0 },
    { name: 'hand', x1: 100, y1: 0, x2: 130, y2: 30 },
  ];

  it('the distance to a bone is the distance to its segment, and to its point when it has no length', () => {
    expect(distanceToSegment(bones[1], 50, 7)).toBeCloseTo(7, 9);
    expect(distanceToSegment(bones[1], 130, 0)).toBeCloseTo(30, 9);
    expect(distanceToSegment(bones[0], 3, 4)).toBeCloseTo(5, 9);
  });

  it('picks the nearest bone within the tolerance, null when none is near', () => {
    expect(nearestBone(bones, 50, 4, 10)).toBe('arm');
    expect(nearestBone(bones, 125, 24, 10)).toBe('hand');
    expect(nearestBone(bones, 50, 40, 10)).toBeNull();
    expect(nearestBone([], 0, 0, 10)).toBeNull();
  });

  it('at a joint the bone nearer to the click wins, and a bone with a broken number is skipped', () => {
    expect(nearestBone(bones, 103, 2, 10)).toBe('hand');
    expect(nearestBone(bones, 97, 2, 10)).toBe('arm');
    expect(nearestBone([{ name: 'bad', x1: NaN, y1: 0, x2: 1, y2: 1 }, bones[1]], 50, 2, 10)).toBe('arm');
  });
});
