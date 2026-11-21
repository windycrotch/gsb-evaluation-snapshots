import type * as Three from 'three';
import type { SceneObject } from '../types/editor';
import type { createSceneAI } from './SceneAI';

type ScriptHandlers = {
  start?: () => void;
  update?: (delta: number) => void;
  click?: () => void;
  stop?: () => void;
  triggerEnter?: (other: Three.Object3D) => void;
  triggerExit?: (other: Three.Object3D) => void;
  collisionEnter?: (other: Three.Object3D) => void;
  collisionExit?: (other: Three.Object3D) => void;
};

export function createObjectScripts(
  objects: SceneObject[],
  scene: Three.Scene,
  camera: Three.Camera,
  three: typeof Three,
  reportError: (message: string) => void,
  openScene: (id: string) => void,
  scenes: { id: string; name: string }[],
  ai: ReturnType<typeof createSceneAI> | null = null
) {
  const scripts: { id: string; name: string; handlers: ScriptHandlers; failed: boolean }[] = [];
  for (const item of objects) {
    if (!item.properties.script?.trim()) continue;
    try {
      const create = new Function('object', 'scene', 'camera', 'THREE', 'state', 'openScene', 'scenes', item.properties.script);
      const handlers: unknown = create(item.object, scene, camera, three, ai ? { ai } : {}, openScene, scenes);
      if (!handlers || typeof handlers !== 'object') throw new Error('Script must return an object');
      scripts.push({ id: item.id, name: item.name, handlers: handlers as ScriptHandlers, failed: false });
    } catch (error) {
      reportError(`${item.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  function run(script: typeof scripts[number], method: 'start' | 'update' | 'click' | 'stop', delta?: number) {
    if (script.failed) return;
    try {
      const handler = script.handlers[method];
      if (handler !== undefined && typeof handler !== 'function') throw new Error(`${method} must be a function`);
      if (handler) handler.call(script.handlers, delta as number);
    } catch (error) {
      script.failed = true;
      reportError(`${script.name} (${method}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    start: () => scripts.forEach(script => run(script, 'start')),
    update: (delta: number) => scripts.forEach(script => run(script, 'update', delta)),
    click: (id: string) => scripts.filter(script => script.id === id).forEach(script => run(script, 'click')),
    trigger(id: string, method: 'triggerEnter' | 'triggerExit' | 'collisionEnter' | 'collisionExit', other: Three.Object3D) {
      for (const script of scripts) {
        if (script.id !== id || script.failed) continue;
        try {
          const handler = script.handlers[method];
          if (handler !== undefined && typeof handler !== 'function') throw new Error(`${method} must be a function`);
          handler?.call(script.handlers, other);
        } catch (error) {
          script.failed = true;
          reportError(`${script.name} (${method}): ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
    stop: () => scripts.forEach(script => run(script, 'stop'))
  };
}
