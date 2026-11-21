import type * as Three from 'three';
import type { SceneObject } from '../types/editor';

export function createModelAnimations(
  objects: SceneObject[],
  three: typeof Three,
  reportError: (message: string) => void,
  onSceneChange?: (id: string) => void,
  timelineTargets: string[] = []
) {
  const mixers = new Map<string, Three.AnimationMixer>();
  const play = (id: string, clipIndex: number, loop = false, speed = 1) => {
    if (timelineTargets.includes(id)) {
      reportError('This model is controlled by the timeline.');
      return;
    }
    const item = objects.find(candidate => candidate.id === id && candidate.type === 'model');
    if (!item) {
      reportError('Model animation target was not found');
      return;
    }
    const clip = item.object.animations[clipIndex];
    if (!clip) {
      reportError(`${item.name}: animation clip ${clipIndex} was not found`);
      return;
    }
    if (!Number.isFinite(speed) || speed <= 0) {
      reportError(`${item.name}: animation speed must be positive`);
      return;
    }
    let mixer = mixers.get(id);
    if (!mixer) {
      mixer = new three.AnimationMixer(item.object);
      mixer.addEventListener('finished', event => {
        const config = item.properties.modelAnimation;
        if (config?.onCompleteSceneId && item.object.animations[config.clipIndex] === event.action.getClip()) {
          if (onSceneChange) onSceneChange(config.onCompleteSceneId);
          else reportError(`${item.name}: scene transition is unavailable`);
        }
      });
      mixers.set(id, mixer);
    }
    mixer.stopAllAction();
    const action = mixer.clipAction(clip);
    action.reset();
    action.setLoop(loop ? three.LoopRepeat : three.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
    action.setEffectiveTimeScale(speed);
    action.play();
  };
  for (const item of objects) {
    const config = item.properties.modelAnimation;
    if (item.type === 'model' && config?.autoPlay && !timelineTargets.includes(item.id)) play(item.id, config.clipIndex, config.loop, config.speed);
  }
  return {
    play,
    update: (delta: number) => mixers.forEach(mixer => mixer.update(delta)),
    stop: () => mixers.forEach(mixer => {
      mixer.stopAllAction();
      mixer.uncacheRoot(mixer.getRoot());
    })
  };
}
