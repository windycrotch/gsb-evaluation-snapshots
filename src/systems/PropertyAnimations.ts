import type { SceneObject } from '../types/editor';

export function createPropertyAnimations(objects: SceneObject[], reportError: (message: string) => void, inputTarget?: HTMLElement | Window, onSceneChange?: (id: string) => void) {
  const elapsed = new Map<string, number>();
  const abort = new AbortController();
  for (const item of objects) {
    for (const animation of item.properties.animations ?? []) {
      if (animation.trigger && animation.trigger.type !== 'none' &&
          !(animation.trigger.type === 'mouseWheel' && animation.type === 'rotation')) {
        reportError(`${item.name}: animation triggers are not supported yet; use Play on start`);
      }
      if (animation.autoPlay && (!Number.isFinite(animation.params.duration) || animation.params.duration <= 0)) {
        reportError(`${item.name}: animation duration must be positive`);
      }
    }
  }
  const rotate = (distance: number) => {
    for (const item of objects) {
      for (const animation of item.properties.animations ?? []) {
        if (animation.type !== 'rotation' || animation.trigger?.type !== 'mouseWheel' || !animation.params.rotationSpeed) continue;
        const direction = animation.trigger.mouseWheelDirection;
        if ((direction === 'up' && distance >= 0) || (direction === 'down' && distance <= 0)) continue;
        const speed = animation.params.rotationSpeed;
        item.object.rotation.x += (speed.x || 0) * distance / 100;
        item.object.rotation.y += (speed.y || 0) * distance / 100;
        item.object.rotation.z += (speed.z || 0) * distance / 100;
      }
    }
  };
  let touchY: number | null = null;
  inputTarget?.addEventListener('wheel', (event: Event) => {
    const wheel = event as WheelEvent;
    if (wheel.target instanceof Element && wheel.target.closest('input,textarea,select')) return;
    rotate(wheel.deltaY * (wheel.deltaMode === 1 ? 16 : wheel.deltaMode === 2 ? window.innerHeight : 1));
  }, { passive: true, signal: abort.signal });
  inputTarget?.addEventListener('touchstart', (event: Event) => {
    const touch = event as TouchEvent;
    touchY = touch.touches.length === 1 ? touch.touches[0].clientY : null;
  }, { passive: true, signal: abort.signal });
  inputTarget?.addEventListener('touchmove', (event: Event) => {
    const touch = event as TouchEvent;
    if (touchY === null || touch.touches.length !== 1) return;
    const next = touch.touches[0].clientY;
    rotate(touchY - next);
    touchY = next;
  }, { passive: true, signal: abort.signal });
  return {
    stop() { abort.abort(); },
    update(delta: number) {
      for (const item of objects) {
        for (const animation of item.properties.animations ?? []) {
          if (!animation.autoPlay || animation.trigger?.type === 'mouseWheel' || !Number.isFinite(animation.params.duration) || animation.params.duration <= 0) continue;
          const duration = animation.params.duration / 1000;
          const key = `${item.id}:${animation.id}`;
          const previous = elapsed.get(key) ?? 0;
          const next = previous + delta;
          elapsed.set(key, next);
          if (animation.type === 'rotation' && animation.params.rotationSpeed) {
            const step = animation.params.loop ? delta : Math.max(0, Math.min(next, duration) - Math.min(previous, duration));
            const speed = animation.params.rotationSpeed;
            item.object.rotation.x += (speed.x || 0) * step;
            item.object.rotation.y += (speed.y || 0) * step;
            item.object.rotation.z += (speed.z || 0) * step;
          }
          if (animation.type === 'movement' && animation.params.startPosition && animation.params.endPosition) {
            const start = animation.params.startPosition;
            const end = animation.params.endPosition;
            const startValues = Array.isArray(start) ? start : [start.x, start.y, start.z];
            const endValues = Array.isArray(end) ? end : [end.x, end.y, end.z];
            const progress = animation.params.loop ? (next % duration) / duration : Math.min(next / duration, 1);
            item.object.position.set(
              startValues[0] + (endValues[0] - startValues[0]) * progress,
              startValues[1] + (endValues[1] - startValues[1]) * progress,
              startValues[2] + (endValues[2] - startValues[2]) * progress
            );
          }
          if (!animation.params.loop && previous < duration && next >= duration &&
              (animation.type === 'rotation' || animation.type === 'movement') && animation.onCompleteSceneId) {
            if (onSceneChange) onSceneChange(animation.onCompleteSceneId);
            else reportError(`${item.name}: scene transition is unavailable`);
          }
        }
      }
    }
  };
}
