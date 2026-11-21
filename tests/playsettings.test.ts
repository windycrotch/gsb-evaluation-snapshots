import { beforeEach, describe, expect, it } from 'vitest';
import { cleanPlay, DEFAULT_PLAY, playOf, samePlay } from '@/core/playback';
import { emptyProject, newAnimation } from '@/core/model';
import { repairProject } from '@/core/validate';
import { exportSpineJson } from '@/core/export/spineJson';
import { createAnimation, selectAnimation, setPlay } from '@/store/actions';
import { docStore } from '@/store/doc';
import { uiStore } from '@/store/ui';
import { startPlaySync } from '@/editor/playback';

describe('play settings of an animation', () => {
  it('defaults and cleaning', () => {
    expect(playOf(undefined)).toEqual(DEFAULT_PLAY);
    expect(cleanPlay({ loop: 'yes', pingPong: 1, range: [3, 1] }, 2)).toEqual({ loop: true, pingPong: false, range: null });
    expect(cleanPlay({ loop: false, pingPong: true, range: [-1, 9] }, 2)).toEqual({ loop: false, pingPong: true, range: [0, 2] });
    expect(cleanPlay({ range: [NaN, 1] }, 2).range).toBeNull();
    expect(samePlay(DEFAULT_PLAY, cleanPlay(null, 1))).toBe(true);
  });

  it('validation repairs a damaged play field', () => {
    const p = emptyProject();
    const a = newAnimation('walk');
    a.duration = 1;
    (a as unknown as { play: unknown }).play = { loop: 3, range: [0.2, 7] };
    p.skeleton.animations.push(a);
    const notes = repairProject(p);
    expect(p.skeleton.animations[0].play).toEqual({ loop: true, pingPong: false, range: [0.2, 1] });
    expect(notes.some((n) => n.includes('playback settings'))).toBe(true);
  });

  describe('through the store', () => {
    beforeEach(() => {
      docStore.replace(emptyProject());
      uiStore.patch({ animationId: null, time: 0, playing: false });
    });

    it('each animation keeps its own loop, ping-pong and range; ui mirrors the current one; undo reverts', () => {
      const stop = startPlaySync();
      try {
        const a = createAnimation('a', 2);
        const b = createAnimation('b', 2);
        selectAnimation(a);
        setPlay({ loop: false, range: [0.5, 1.5] });
        expect(uiStore.get().loop).toBe(false);
        expect(uiStore.get().range).toEqual([0.5, 1.5]);

        selectAnimation(b);
        expect(uiStore.get().loop).toBe(true);
        expect(uiStore.get().range).toBeNull();
        setPlay({ pingPong: true });
        expect(uiStore.get().pingPong).toBe(true);

        selectAnimation(a);
        expect(uiStore.get().pingPong).toBe(false);
        expect(uiStore.get().range).toEqual([0.5, 1.5]);

        docStore.undo(); // b's ping-pong
        docStore.undo(); // a's loop and range
        expect(uiStore.get().loop).toBe(true);
        expect(uiStore.get().range).toBeNull();
      } finally {
        stop();
      }
    });

    it('is editor metadata: the Spine export does not carry it', () => {
      createAnimation('a', 1);
      setPlay({ loop: false, pingPong: true });
      expect(docStore.get().skeleton.animations[0].play).toEqual({ loop: false, pingPong: true, range: null });
      const json = JSON.stringify(exportSpineJson(docStore.get().skeleton));
      expect(json).not.toContain('pingPong');
      expect(json).not.toContain('"play"');
    });
  });
});
