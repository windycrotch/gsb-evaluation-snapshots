import type { SceneObject } from '../types/editor';

export function createFloatEffects(objects: SceneObject[], reportError: (message: string) => void) {
  const entries = objects.flatMap(item => {
    const config = item.properties.float;
    if (!config?.enabled) return [];
    if (![config.speed, config.height, config.rotation].every(value => Number.isFinite(value) && value >= 0)) {
      reportError(`${item.name}: invalid float settings`);
      return [];
    }
    if (item.properties.physics?.enabled || item.properties.characterController?.enabled || item.properties.pathFollower?.enabled) {
      reportError(`${item.name}: float is visual only; disable physics, character control and AI navigation`);
      return [];
    }
    return [{ object: item.object, config, elapsed: 0, y: 0, rx: 0, ry: 0, rz: 0 }];
  });
  return {
    before() {
      for (const entry of entries) {
        entry.object.position.y -= entry.y;
        entry.object.rotation.x -= entry.rx;
        entry.object.rotation.y -= entry.ry;
        entry.object.rotation.z -= entry.rz;
      }
    },
    update(delta: number) {
      for (const entry of entries) {
        entry.elapsed += delta * entry.config.speed;
        entry.y = Math.sin(entry.elapsed) * entry.config.height;
        entry.rx = Math.cos(entry.elapsed) * entry.config.rotation;
        entry.ry = Math.sin(entry.elapsed) * entry.config.rotation;
        entry.rz = Math.sin(entry.elapsed) * entry.config.rotation * 0.4;
        entry.object.position.y += entry.y;
        entry.object.rotation.x += entry.rx;
        entry.object.rotation.y += entry.ry;
        entry.object.rotation.z += entry.rz;
      }
    }
  };
}
