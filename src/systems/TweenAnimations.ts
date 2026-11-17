import type { SceneObject } from '../types/editor';
import type * as Tween from '@tweenjs/tween.js';
import type { Material, Mesh, Sprite } from 'three';

export function createTweenAnimations(objects: SceneObject[], engine: typeof Tween, reportError: (message: string) => void) {
  const group = new engine.Group();
  const savedMaterials: { material: Material; opacity: number; transparent: boolean }[] = [];
  let time = 0;
  for (const item of objects) {
    const config = item.properties.tween;
    if (!config?.enabled) continue;
    if (!Number.isFinite(config.duration) || config.duration <= 0 ||
        !['position', 'rotation', 'scale', 'opacity'].includes(config.property) ||
        !['linear', 'smooth', 'out'].includes(config.easing) ||
        !Array.isArray(config.target) || config.target.length !== 3 ||
        config.target.some(value => !Number.isFinite(value)) ||
        !Number.isFinite(config.opacity) || config.opacity < 0 || config.opacity > 1) {
      reportError(`${item.name}: invalid tween animation settings`);
      continue;
    }
    const easing = config.easing === 'smooth' ? engine.Easing.Quadratic.InOut :
      config.easing === 'out' ? engine.Easing.Quadratic.Out : engine.Easing.Linear.None;
    if (config.property === 'opacity') {
      const materials: Material[] = [];
      item.object.traverse(child => {
        if (!('isMesh' in child) && !('isSprite' in child)) return;
        const material = (child as Mesh | Sprite).material;
        for (const part of Array.isArray(material) ? material : [material]) {
          if (materials.includes(part)) continue;
          materials.push(part);
          savedMaterials.push({ material: part, opacity: part.opacity, transparent: part.transparent });
          part.transparent = true;
          part.needsUpdate = true;
          new engine.Tween(part, group).to({ opacity: config.opacity }, config.duration * 1000)
            .easing(easing).repeat(config.repeat ? Infinity : 0).yoyo(config.yoyo).start(0);
        }
      });
      if (!materials.length) reportError(`${item.name}: opacity animation requires a material`);
    } else {
      const factor = config.property === 'rotation' ? Math.PI / 180 : 1;
      new engine.Tween(item.object[config.property], group)
        .to({ x: config.target[0] * factor, y: config.target[1] * factor, z: config.target[2] * factor }, config.duration * 1000)
        .easing(easing).repeat(config.repeat ? Infinity : 0).yoyo(config.yoyo).start(0);
    }
  }
  return {
    update(delta: number) { time += delta * 1000; group.update(time); },
    stop() {
      group.removeAll();
      for (const { material, opacity, transparent } of savedMaterials) {
        material.opacity = opacity;
        material.transparent = transparent;
        material.needsUpdate = true;
      }
    }
  };
}
