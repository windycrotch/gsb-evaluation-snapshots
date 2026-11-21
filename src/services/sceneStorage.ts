import type { Asset, SceneObject } from '../types/editor';
import type { SceneOptions } from '../store/editorStore';

export interface StoredScene {
  objects: Omit<SceneObject, 'object'>[];
  sceneOptions: SceneOptions;
  activeSceneId?: string;
  otherScenes?: StoredNamedScene[];
  sceneOrder?: string[];
  assets?: Asset[];
}

export interface StoredNamedScene {
  id: string;
  objects: Omit<SceneObject, 'object'>[];
  sceneOptions: SceneOptions;
}

interface StoredEditor {
  currentScene: StoredScene;
  assets: Asset[];
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('game-engine-editor', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('editor');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Editor storage is blocked by another tab'));
  });
}

export async function readEditor(): Promise<StoredEditor | null> {
  const db = await openDatabase();
  try {
    const stored = await new Promise<StoredEditor | undefined>((resolve, reject) => {
      const request = db.transaction('editor', 'readonly').objectStore('editor').get('current');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (stored) return stored;
    const legacy = localStorage.getItem('scene-data');
    return legacy ? { currentScene: JSON.parse(legacy).currentScene, assets: [] } : null;
  } finally {
    db.close();
  }
}

let pending: Promise<void> = Promise.resolve();

export function writeEditor(value: StoredEditor): Promise<void> {
  const operation = pending.catch(() => undefined).then(async () => {
    const db = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('editor', 'readwrite');
        transaction.objectStore('editor').put(value, 'current');
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('Editor save aborted'));
      });
    } finally {
      db.close();
    }
  });
  pending = operation;
  return operation;
}
