import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { SceneObject, Asset, Component } from '../types/editor';
import * as THREE from 'three';
import { applyMaterialProperties, createTextGeometry, isSupportedSdfText, restoreSceneObject } from '../services/sceneObjects';
import { writeEditor, type StoredNamedScene, type StoredScene } from '../services/sceneStorage';
import { toast } from 'react-hot-toast';
import { isWebContainer, isValidWebParent } from '../types/web';
import type { SceneEdit } from '../services/sceneAgent';
import type { SceneTimeline, TimelineDevice, TimelineTrack } from '../types/timeline';
import type { SceneAIConfig } from '../systems/SceneAI';
import { Text } from 'troika-three-text';
import { recordHistory } from '../services/editorHistory';

export interface SceneOptions {
  name: string;
  backgroundColor: string;
  fogEnabled: boolean;
  fogColor: string;
  fogDensity: number;
  ambientLightIntensity: number;
  shadowsEnabled: boolean;
  gravity: number;
  enableJQuery?: boolean;
  activeCameraId?: string;
  environment?: {
    enabled: boolean;
    source: 'studio' | 'sunset' | 'night' | 'hdr';
    background: boolean;
    data?: string;
    name?: string;
  };
  timeline?: SceneTimeline;
  ai?: SceneAIConfig;
}

interface EditorState {
  sceneObjects: SceneObject[];
  selectedObject: SceneObject | null;
  assets: Asset[];
  components: Component[];
  sceneOptions: SceneOptions;
  isPlaying: boolean;
  savedState: {
    objects: { id: string; properties: SceneObject['properties'] }[];
    sceneObjects: SceneObject[];
    sceneOptions: SceneOptions;
    scenes: StoredNamedScene[];
    activeSceneId: string;
  } | null;
  currentProjectId: string | null;
  scenes: StoredNamedScene[];
  activeSceneId: string;
  timelinePreviewTime: number | null;
  timelinePreviewDevice: TimelineDevice;
  setTimelinePreviewTime: (time: number | null) => void;
  setTimelinePreviewDevice: (device: TimelineDevice) => void;
  addObject: (object: SceneObject) => void;
  removeObject: (id: string) => void;
  applySceneAgentChanges: (edits: SceneEdit[], removals: string[], additions: SceneObject[], timelineTracks: TimelineTrack[]) => void;
  moveWebObject: (id: string, targetId: string) => void;
  updateObject: (id: string, updates: Partial<SceneObject>) => void;
  updateObjectProperties: (id: string, properties: Partial<SceneObject['properties']>) => void;
  setSelectedObject: (object: SceneObject | null) => void;
  resetScene: () => void;
  loadScene: (sceneData: StoredScene) => Promise<void>;
  saveScene: () => Promise<void>;
  createScene: () => void;
  switchScene: (id: string) => Promise<void>;
  navigateScene: (id: string) => Promise<void>;
  renameScene: (id: string, name: string) => void;
  deleteScene: (id: string) => Promise<void>;
  addAsset: (asset: Asset) => void;
  removeAsset: (id: string) => void;
  setAssets: (assets: Asset[]) => void;
  updateSceneOptions: (options: Partial<EditorState['sceneOptions']>) => void;
  startPlay: () => void;
  stopPlay: () => void;
  setCurrentProjectId: (id: string | null) => void;
}

const defaultSceneOptions = {
  name: 'New Scene',
  backgroundColor: '#1a1a2e',
  fogEnabled: false,
  fogColor: '#cccccc',
  fogDensity: 0.1,
  ambientLightIntensity: 0.5,
  shadowsEnabled: true,
  gravity: -9.8,
};
export function createEmptyScene(name: string): StoredScene {
  return { objects: [], sceneOptions: { ...defaultSceneOptions, name }, activeSceneId: 'initial', assets: [] };
}
let navigationGeneration = 0;

function removeSceneObject(objects: SceneObject[], options: SceneOptions, id: string) {
  const removed = objects.find(obj => obj.id === id);
  const sceneObjects = objects.filter(obj => obj.id !== id).map(obj => {
    const web = obj.properties.web;
    if (web?.parentId !== id) return obj;
    const removedWeb = removed?.properties.web;
    const parentId = removedWeb?.kind === 'slide'
      ? objects.find(candidate => candidate.id === removedWeb.parentId)?.properties.web?.parentId ?? null
      : removedWeb?.parentId ?? null;
    return { ...obj, properties: { ...obj.properties, web: {
      ...web, parentId, kind: removedWeb?.kind === 'slider' && web.kind === 'slide' ? 'section' : web.kind
    } } };
  });
  const timeline = options.timeline;
  const filteredTracks = timeline?.tracks.filter(track => track.targetId !== id);
  const filteredClips = timeline?.clips?.filter(clip => clip.targetId !== id);
  const filteredSounds = timeline?.sounds?.filter(sound => sound.targetId !== id);
  const sceneOptions = options.activeCameraId === id || (timeline && (
    filteredTracks?.length !== timeline.tracks.length || filteredClips?.length !== timeline.clips?.length ||
    filteredSounds?.length !== timeline.sounds?.length))
    ? { ...options,
      ...(options.activeCameraId === id ? { activeCameraId: undefined } : {}),
      ...(timeline && filteredTracks ? { timeline: { ...timeline, tracks: filteredTracks,
        ...(filteredClips ? { clips: filteredClips } : {}), ...(filteredSounds ? { sounds: filteredSounds } : {}) } } : {})
    } : options;
  return { sceneObjects, sceneOptions };
}

export const useEditorStore = create<EditorState>()(
  persist(
    (set, get) => ({
      sceneObjects: [],
      selectedObject: null,
      assets: [],
      components: [],
      sceneOptions: defaultSceneOptions,
      isPlaying: false,
      savedState: null,
      currentProjectId: null,
      scenes: [{ id: 'initial', objects: [], sceneOptions: defaultSceneOptions }],
      activeSceneId: 'initial',
      timelinePreviewTime: null,
      timelinePreviewDevice: 'desktop',
      setTimelinePreviewTime: (time) => set({ timelinePreviewTime: time }),
      setTimelinePreviewDevice: (device) => set({ timelinePreviewDevice: device }),

      addObject: (object) =>
        set((state) => {
          object.object.name = object.name;
          object.object.userData.className = object.properties.className ?? '';
          object.object.userData.tags = object.properties.tags ?? [];
          const newObjects = [...state.sceneObjects, object];
          if (!state.isPlaying) {
            queueSceneSave(newObjects, state.sceneOptions, state.assets);
          }
          return { sceneObjects: newObjects };
        }),

      removeObject: (id) =>
        set((state) => {
          const { sceneObjects: newObjects, sceneOptions } = removeSceneObject(state.sceneObjects, state.sceneOptions, id);
          if (!state.isPlaying) {
            queueSceneSave(newObjects, sceneOptions, state.assets);
          }
          return {
            sceneObjects: newObjects,
            sceneOptions,
            selectedObject: state.selectedObject?.id === id ? null :
              newObjects.find(obj => obj.id === state.selectedObject?.id) ?? null
          };
        }),

      applySceneAgentChanges: (edits, removals, additions, timelineTracks) => set(state => {
        let sceneObjects = state.sceneObjects;
        let sceneOptions = state.sceneOptions;
        for (const id of removals) {
          ({ sceneObjects, sceneOptions } = removeSceneObject(sceneObjects, sceneOptions, id));
        }
        sceneObjects = sceneObjects.map(item => {
          const edit = edits.find(change => change.objectId === item.id);
          if (!edit) return item;
          const web = item.properties.web;
          const webPatch = edit.web;
          const properties = web ? { ...item.properties, web: { ...web,
            ...(webPatch ?? {}),
            ...(webPatch?.background !== undefined && webPatch.backgroundMode === undefined
              ? { backgroundMode: webPatch.background.trim().toLowerCase() === 'transparent' ? 'transparent' as const : 'solid' as const } : {}),
            ...(webPatch && ('fontSize' in webPatch || 'padding' in webPatch || 'color' in webPatch)
              ? { styleOverrides: [...new Set([...(web.styleOverrides ?? []),
                ...(['fontSize', 'padding', 'color'] as const).filter(key => key in webPatch)])] } : {}),
            ...(edit.javascript !== undefined ? { script: edit.javascript } : {}),
            ...(edit.css !== undefined ? { customCss: edit.css } : {}) } } :
            { ...item.properties, ...(edit.javascript !== undefined ? { script: edit.javascript } : {}) };
          return { ...item, properties };
        });
        for (const item of additions) {
          item.object.name = item.name;
          item.object.userData.className = item.properties.className ?? '';
          item.object.userData.tags = item.properties.tags ?? [];
        }
        sceneObjects = [...sceneObjects, ...additions];
        if (timelineTracks.length) {
          const timeline = sceneOptions.timeline ?? { duration: 5, trigger: 'start' as const, key: '', tracks: [] };
          sceneOptions = { ...sceneOptions, timeline: { ...timeline, tracks: [...timeline.tracks, ...timelineTracks] } };
        }
        queueSceneSave(sceneObjects, sceneOptions, state.assets);
        return { sceneObjects, sceneOptions,
          selectedObject: sceneObjects.find(item => item.id === state.selectedObject?.id) ?? null };
      }),

      moveWebObject: (id, targetId) =>
        set((state) => {
          const source = state.sceneObjects.find(obj => obj.id === id);
          const target = state.sceneObjects.find(obj => obj.id === targetId);
          if (!source?.properties.web || !target?.properties.web || id === targetId) return state;
          const parentId = isWebContainer(target.properties.web.kind) ? target.id : target.properties.web.parentId;
          const parentKind = state.sceneObjects.find(obj => obj.id === parentId)?.properties.web?.kind;
          if (!isValidWebParent(source.properties.web.kind, parentKind)) {
            toast.error('Sliders contain slides; add other components inside a slide.');
            return state;
          }
          let ancestor = parentId;
          const visited = new Set<string>();
          while (ancestor) {
            if (ancestor === id || visited.has(ancestor)) {
              toast.error('A component cannot be moved inside itself.');
              return state;
            }
            visited.add(ancestor);
            ancestor = state.sceneObjects.find(obj => obj.id === ancestor)?.properties.web?.parentId ?? null;
          }
          const updated = { ...source, properties: { ...source.properties, web: { ...source.properties.web, parentId } } };
          const newObjects = state.sceneObjects.filter(obj => obj.id !== id);
          newObjects.splice(newObjects.findIndex(obj => obj.id === targetId) + 1, 0, updated);
          queueSceneSave(newObjects, state.sceneOptions, state.assets);
          return { sceneObjects: newObjects, selectedObject: updated };
        }),

      updateObject: (id, updates) =>
        set((state) => {
          const current = state.sceneObjects.find((obj) => obj.id === id);
          if (current && updates.name !== undefined) current.object.name = updates.name;
          const newObjects = state.sceneObjects.map((obj) =>
            obj.id === id ? { ...obj, ...updates } : obj
          );
          if (!state.isPlaying) {
            queueSceneSave(newObjects, state.sceneOptions, state.assets);
          }
          return {
            sceneObjects: newObjects,
            selectedObject: state.selectedObject?.id === id ?
              { ...state.selectedObject, ...updates } : state.selectedObject
          };
        }),

      updateObjectProperties: (id, properties) =>
        set((state) => {
          const objectToUpdate = state.sceneObjects.find(obj => obj.id === id);
          if (!objectToUpdate) return state;

          const updatedProperties = { ...objectToUpdate.properties, ...properties };
          if (properties.text3d && objectToUpdate.type === 'text3d' && objectToUpdate.object instanceof THREE.Mesh) {
            try {
              const geometry = createTextGeometry(properties.text3d);
              objectToUpdate.object.geometry.dispose();
              objectToUpdate.object.geometry = geometry;
            } catch (error) {
              console.error('Failed to update 3D text:', error);
              toast.error(error instanceof Error ? error.message : 'Failed to update 3D text');
              return state;
            }
          }
          if (properties.text3d && objectToUpdate.type === 'textSdf' && objectToUpdate.object instanceof Text) {
            const text = properties.text3d;
            if (typeof text.text !== 'string' || text.text.length > 200 || !isSupportedSdfText(text.text) ||
                !Number.isFinite(text.size) || text.size <= 0 || text.size > 100) {
              toast.error('SDF text supports Latin-1 and Turkish characters only');
              return state;
            }
            objectToUpdate.object.text = text.text;
            objectToUpdate.object.fontSize = text.size;
            objectToUpdate.object.sync();
          }
          if (properties.className !== undefined) objectToUpdate.object.userData.className = properties.className;
          if (properties.tags !== undefined) objectToUpdate.object.userData.tags = properties.tags;

          if (objectToUpdate.object) {
            if (properties.visible !== undefined) objectToUpdate.object.visible = properties.visible;
            if (properties.position) {
              objectToUpdate.object.position.fromArray(properties.position);
            }
            if (properties.rotation) {
              objectToUpdate.object.rotation.set(
                properties.rotation[0] * Math.PI / 180,
                properties.rotation[1] * Math.PI / 180,
                properties.rotation[2] * Math.PI / 180
              );
            }
            if (properties.scale) {
              objectToUpdate.object.scale.fromArray(properties.scale);
            }

            if (['materialType', 'color', 'opacity', 'metalness', 'roughness', 'map', 'normalMap', 'roughnessMap', 'metalnessMap'].some(key => key in properties)) {
              const materialProperties = properties.materialType ? updatedProperties : properties;
              void applyMaterialProperties(objectToUpdate.object, materialProperties).catch((error) => {
                console.error('Failed to apply material:', error);
                toast.error('Failed to apply material or texture');
              });
            }

            if (objectToUpdate.object instanceof THREE.Light) {
              if (properties.intensity !== undefined) {
                objectToUpdate.object.intensity = properties.intensity;
              }
              if (properties.color !== undefined) {
                objectToUpdate.object.color.set(properties.color);
              }
            }

            if (objectToUpdate.object instanceof THREE.PerspectiveCamera) {
              if (properties.fov !== undefined) {
                objectToUpdate.object.fov = properties.fov;
                objectToUpdate.object.updateProjectionMatrix();
              }
              if (properties.near !== undefined) {
                objectToUpdate.object.near = properties.near;
                objectToUpdate.object.updateProjectionMatrix();
              }
              if (properties.far !== undefined) {
                objectToUpdate.object.far = properties.far;
                objectToUpdate.object.updateProjectionMatrix();
              }
              if (properties.aspect !== undefined) {
                objectToUpdate.object.aspect = properties.aspect;
                objectToUpdate.object.updateProjectionMatrix();
              }
            }
          }

          const newObjects = state.sceneObjects.map(obj =>
            obj.id === id ? { ...obj, properties: updatedProperties } : obj
          );
          const timeline = state.sceneOptions.timeline;
          const soundSegments = properties.sounds && timeline?.sounds
            ? timeline.sounds.filter(segment => segment.targetId !== id ||
                properties.sounds!.some(sound => sound.id === segment.soundId))
            : undefined;
          const sceneOptions = timeline?.sounds && soundSegments && soundSegments.length !== timeline.sounds.length
            ? { ...state.sceneOptions, timeline: { ...timeline, sounds: soundSegments } }
            : state.sceneOptions;

          if (!state.isPlaying) {
            queueSceneSave(newObjects, sceneOptions, state.assets);
          }

          return {
            sceneObjects: newObjects,
            sceneOptions,
            selectedObject: state.selectedObject?.id === id ?
              { ...state.selectedObject, properties: updatedProperties } :
              state.selectedObject
          };
        }),

      setSelectedObject: (object) =>
        set({ selectedObject: object }),

      resetScene: () => {
        set({
          sceneObjects: [],
          selectedObject: null,
          sceneOptions: defaultSceneOptions,
          isPlaying: false,
          savedState: null,
          currentProjectId: null
        });
        queueSceneSave([], defaultSceneOptions, get().assets);
      },

      loadScene: async (sceneData) => {
        const previous = get();
        const activeSceneId = sceneData.activeSceneId ?? 'initial';
        const otherScenes = sceneData.otherScenes ?? [];
        if (!Array.isArray(otherScenes) || otherScenes.some(scene =>
          !scene || typeof scene.id !== 'string' || !Array.isArray(scene.objects) || !scene.sceneOptions) ||
          new Set([activeSceneId, ...otherScenes.map(scene => scene.id)]).size !== otherScenes.length + 1) {
          throw new Error('Invalid multi-scene project data');
        }
        const scenes = [{ id: activeSceneId, objects: sceneData.objects, sceneOptions: sceneData.sceneOptions }, ...otherScenes];
        if (sceneData.sceneOrder && (!Array.isArray(sceneData.sceneOrder) ||
            sceneData.sceneOrder.length !== scenes.length ||
            new Set(sceneData.sceneOrder).size !== scenes.length ||
            sceneData.sceneOrder.some(id => !scenes.some(scene => scene.id === id)))) {
          throw new Error('Invalid scene order');
        }
        if (sceneData.sceneOrder) scenes.sort((a, b) => sceneData.sceneOrder!.indexOf(a.id) - sceneData.sceneOrder!.indexOf(b.id));
        const objects = await Promise.all(sceneData.objects.map(restoreSceneObject));
        if (get().sceneObjects !== previous.sceneObjects || get().sceneOptions !== previous.sceneOptions || get().assets !== previous.assets || get().scenes !== previous.scenes) {
          throw new Error('The scene changed while loading; try again.');
        }
        set({
          sceneObjects: objects,
          selectedObject: null,
          sceneOptions: sceneData.sceneOptions || defaultSceneOptions,
          scenes,
          activeSceneId
        });
      },

      saveScene: () => {
        const { sceneObjects, sceneOptions, assets } = get();
        return saveSceneToStorage(sceneObjects, sceneOptions, assets);
      },

      createScene: () => {
        const state = get();
        if (state.isPlaying) throw new Error('Stop Play before creating a scene');
        let number = state.scenes.length + 1;
        while (state.scenes.some(scene => scene.sceneOptions.name === `Scene ${number} / Page ${number}`)) number++;
        const id = crypto.randomUUID();
        const sceneOptions = { ...defaultSceneOptions, name: `Scene ${number} / Page ${number}` };
        const scenes = state.scenes.map(scene => scene.id === state.activeSceneId
          ? { id: scene.id, ...createSceneSnapshot(state.sceneObjects, state.sceneOptions) } : scene);
        scenes.push({ id, objects: [], sceneOptions });
        set({ scenes, activeSceneId: id, sceneObjects: [], sceneOptions, selectedObject: null });
        queueSceneSave([], sceneOptions, state.assets);
      },

      switchScene: async (id) => {
        const previous = get();
        if (previous.isPlaying) throw new Error('Stop Play before switching scenes');
        if (id === previous.activeSceneId) return;
        const target = previous.scenes.find(scene => scene.id === id);
        if (!target) throw new Error('Scene not found');
        const objects = await Promise.all(target.objects.map(restoreSceneObject));
        const current = get();
        if (current.isPlaying || current.sceneObjects !== previous.sceneObjects || current.sceneOptions !== previous.sceneOptions ||
            current.assets !== previous.assets || current.scenes !== previous.scenes || current.activeSceneId !== previous.activeSceneId) {
          throw new Error('The project changed while loading the scene; try again.');
        }
        const scenes = previous.scenes.map(scene => scene.id === previous.activeSceneId
          ? { id: scene.id, ...createSceneSnapshot(previous.sceneObjects, previous.sceneOptions) } : scene);
        set({ scenes, activeSceneId: id, sceneObjects: objects, sceneOptions: target.sceneOptions, selectedObject: null });
        queueSceneSave(objects, target.sceneOptions, previous.assets, true);
      },

      navigateScene: async (id) => {
        const state = get();
        if (!state.isPlaying) throw new Error('Scene transitions are only available in Play');
        const target = state.scenes.find(scene => scene.id === id);
        if (!target) throw new Error('Target scene no longer exists');
        const generation = ++navigationGeneration;
        const objects = await Promise.all(target.objects.map(restoreSceneObject));
        if (generation !== navigationGeneration || !get().isPlaying) return;
        set({ activeSceneId: id, sceneObjects: objects, sceneOptions: target.sceneOptions, selectedObject: null });
      },

      renameScene: (id, name) => {
        const state = get();
        if (state.isPlaying) throw new Error('Stop Play before renaming a scene');
        const trimmed = name.trim();
        if (!trimmed) throw new Error('Scene name cannot be empty');
        if (!state.scenes.some(scene => scene.id === id)) throw new Error('Scene not found');
        if (id === state.activeSceneId) {
          state.updateSceneOptions({ name: trimmed });
        } else {
          set({ scenes: state.scenes.map(scene => scene.id === id ? { ...scene, sceneOptions: { ...scene.sceneOptions, name: trimmed } } : scene) });
          queueSceneSave(state.sceneObjects, state.sceneOptions, state.assets);
        }
      },

      deleteScene: async (id) => {
        const state = get();
        if (state.isPlaying) throw new Error('Stop Play before deleting a scene');
        if (state.scenes.length <= 1) throw new Error('A project must contain at least one scene');
        if (!state.scenes.some(scene => scene.id === id)) throw new Error('Scene not found');
        if (id === state.activeSceneId) await state.switchScene(state.scenes.find(scene => scene.id !== id)!.id);
        const current = get();
        set({ scenes: current.scenes.filter(scene => scene.id !== id) });
        queueSceneSave(current.sceneObjects, current.sceneOptions, current.assets);
      },

      addAsset: (asset) =>
        set((state) => {
          const assets = [...state.assets, asset];
          queueSceneSave(state.sceneObjects, state.sceneOptions, assets);
          return { assets };
        }),

      removeAsset: (id) =>
        set((state) => {
          const assets = state.assets.filter(a => a.id !== id);
          queueSceneSave(state.sceneObjects, state.sceneOptions, assets);
          return { assets };
        }),

      setAssets: (assets) => set({ assets }),

      updateSceneOptions: (options) =>
        set((state) => {
          const newOptions = { ...state.sceneOptions, ...options };
          if (!state.isPlaying) {
            queueSceneSave(state.sceneObjects, newOptions, state.assets);
          }
          return { sceneOptions: newOptions };
        }),

      startPlay: () =>
        set((state) => {
          navigationGeneration++;
          const savedState = {
            sceneObjects: state.sceneObjects,
            sceneOptions: state.sceneOptions,
            scenes: state.scenes,
            activeSceneId: state.activeSceneId,
            objects: createSceneSnapshot(state.sceneObjects, state.sceneOptions).objects.map(obj => ({
              id: obj.id,
              properties: {
                ...structuredClone(obj.properties),
                physics: obj.properties.physics ? {
                  ...obj.properties.physics,
                  velocity: [...obj.properties.physics.velocity] as [number, number, number],
                  acceleration: [...obj.properties.physics.acceleration] as [number, number, number]
                } : undefined,
                characterController: obj.properties.characterController ?
                  { ...obj.properties.characterController } : undefined
              }
            }))
          };

          return {
            isPlaying: true,
            timelinePreviewTime: null,
            savedState,
            scenes: state.scenes.map(scene => scene.id === state.activeSceneId
              ? { id: scene.id, ...createSceneSnapshot(state.sceneObjects, state.sceneOptions) } : scene),
            selectedObject: null
          };
        }),

      stopPlay: () =>
        set((state) => {
          navigationGeneration++;
          const savedState = state.savedState;
          if (savedState) {
            savedState.sceneObjects.forEach(obj => {
              const saved = savedState.objects.find(s => s.id === obj.id);
              if (saved && obj.object) {
                obj.properties = { ...saved.properties };
                obj.object.visible = obj.properties.visible !== false;

                if (obj.properties.position) {
                  obj.object.position.fromArray(obj.properties.position);
                }
                if (obj.properties.rotation) {
                  obj.object.rotation.set(
                    obj.properties.rotation[0] * Math.PI / 180,
                    obj.properties.rotation[1] * Math.PI / 180,
                    obj.properties.rotation[2] * Math.PI / 180
                  );
                }
                if (obj.properties.scale) {
                  obj.object.scale.fromArray(obj.properties.scale);
                }
              }
            });
          }

          return {
            isPlaying: false,
            savedState: null,
            ...(savedState ? { sceneObjects: savedState.sceneObjects, sceneOptions: savedState.sceneOptions,
              scenes: savedState.scenes, activeSceneId: savedState.activeSceneId, selectedObject: null } : {})
          };
        }),

      setCurrentProjectId: (id) =>
        set({ currentProjectId: id })
    }),
    {
      name: 'editor-storage',
      partialize: (state) => ({
        sceneObjects: [],
        sceneOptions: state.sceneOptions,
        currentProjectId: state.currentProjectId
      })
    }
  )
);

export function createSceneSnapshot(objects: SceneObject[], sceneOptions: SceneOptions) {
  return {
    objects: objects.map(obj => ({
      id: obj.id,
      name: obj.name,
      type: obj.type,
      properties: {
        ...structuredClone(obj.properties),
        visible: obj.object ? obj.object.visible : obj.properties.visible,
        position: obj.object ? [obj.object.position.x, obj.object.position.y, obj.object.position.z] as [number, number, number] : obj.properties.position,
        rotation: obj.object ? [
          THREE.MathUtils.radToDeg(obj.object.rotation.x),
          THREE.MathUtils.radToDeg(obj.object.rotation.y),
          THREE.MathUtils.radToDeg(obj.object.rotation.z)
        ] as [number, number, number] : obj.properties.rotation,
        scale: obj.object ? [obj.object.scale.x, obj.object.scale.y, obj.object.scale.z] as [number, number, number] : obj.properties.scale
      }
    })),
    sceneOptions
  };
}

function saveSceneToStorage(objects: SceneObject[], sceneOptions: SceneOptions, assets: Asset[]) {
  return writeEditor({
    currentScene: createProjectSnapshot(objects, sceneOptions),
    assets
  });
}

export function createProjectSnapshot(objects: SceneObject[], sceneOptions: SceneOptions): StoredScene {
  const { scenes, activeSceneId } = useEditorStore.getState();
  return {
    ...createSceneSnapshot(objects, sceneOptions),
    activeSceneId,
    otherScenes: structuredClone(scenes.filter(scene => scene.id !== activeSceneId)),
    sceneOrder: scenes.map(scene => scene.id)
  };
}

function queueSceneSave(objects: SceneObject[], sceneOptions: SceneOptions, assets: Asset[], replaceHistory = false) {
  void saveSceneToStorage(objects, sceneOptions, assets).catch((error) => {
    console.error('Failed to save scene:', error);
    toast.error('Failed to save scene locally');
  });
  queueMicrotask(() => recordHistory(replaceHistory));
}
