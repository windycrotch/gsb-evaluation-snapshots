/** "By frames" playback: the pose is that of the start of the frame the time falls in. */
import { describe, expect, it } from 'vitest';
import { applyAnimation } from '../src/core/animate';
import { newAnimation } from '../src/core/model';
import { steppedTime } from '../src/core/playback';
import { compileSkeleton, createSkeleton } from '../src/core/skeleton';
import { getScene } from '../src/store/scene';
import { docStore } from '../src/store/doc';
import { uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';

describe('steppedTime', () => {
  it('floors to the frame, with a margin for float noise, and passes a bad rate through', () => {
    expect(steppedTime(0.37, 30)).toBeCloseTo(11 / 30, 9);
    expect(steppedTime(0.4, 30)).toBeCloseTo(12 / 30, 9);
    expect(steppedTime(12 / 30 - 1e-9, 30)).toBeCloseTo(12 / 30, 9);
    expect(steppedTime(0, 30)).toBe(0);
    expect(steppedTime(0.37, 0)).toBe(0.37);
  });
});

describe('the scene', () => {
  it('shows the pose of the frame start only while By frames is on', () => {
    const { project } = buildFixture();
    const doc = project.skeleton;
    const bone = doc.bones[1];
    const anim = newAnimation('turn', 1);
    anim.bones[bone.id] = {
      rotate: [
        { time: 0, value: [0] },
        { time: 1, value: [90] },
      ],
    };
    doc.animations.push(anim);
    doc.fps = 10;
    docStore.replace(project);
    const rotation = () => getScene().skeleton.boneById(bone.id)!.rotation - bone.rotation;
    uiStore.patch({ mode: 'animate', animationId: anim.id, time: 0.37, stepped: false });
    expect(rotation()).toBeCloseTo(33.3, 1);
    uiStore.patch({ stepped: true });
    expect(rotation()).toBeCloseTo(27, 6);
    uiStore.patch({ time: 0.3999, stepped: true });
    expect(rotation()).toBeCloseTo(27, 6);
    const sk = createSkeleton(compileSkeleton(doc));
    applyAnimation(sk, anim, 0.3);
    expect(sk.boneById(bone.id)!.rotation).toBeCloseTo(bone.rotation + 27, 6);
    uiStore.patch({ stepped: false, mode: 'setup' });
  });
});
