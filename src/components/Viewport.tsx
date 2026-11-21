import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls, TransformControls, Grid } from '@react-three/drei';
import { useEditorStore } from '../store/editorStore';
import { beginNewDraft, initializeHistory } from '../services/editorHistory';
import { ObjectContextMenu } from './ObjectContextMenu';
import * as THREE from 'three';
import { createCollisionSystem, createTriggerSystem, getPhysicsBounds, PhysicsEngine } from '../systems/PhysicsEngine';
import { InputManager } from '../systems/InputManager';
import { CharacterControllerSystem, createPlayerCamera } from '../systems/CharacterControllerSystem';
import { toast } from 'react-hot-toast';
import { createObjectScripts } from '../systems/ObjectScripts';
import { createWebLayer } from '../systems/WebLayer';
import { createModelAnimations } from '../systems/ModelAnimations';
import { createPropertyAnimations } from '../systems/PropertyAnimations';
import { createTweenAnimations } from '../systems/TweenAnimations';
import { createFloatEffects } from '../systems/FloatEffects';
import { createEnvironmentTexture } from '../systems/Environment';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import * as Tween from '@tweenjs/tween.js';
import { createTimeline } from '../systems/Timeline';
import { createTimelineMedia } from '../systems/TimelineMedia';
import { createSceneAI } from '../systems/SceneAI';
import { createPathFollowers } from '../systems/PathFollowers';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import jquerySource from 'jquery/dist/jquery.min.js?raw';
import lottie from 'lottie-web';

interface ContextMenuState {
  show: boolean;
  x: number;
  y: number;
  object: THREE.Object3D | null;
}

interface SceneProps {
  onContextMenu: (menu: { x: number; y: number; object: THREE.Object3D }) => void;
  webHost: React.RefObject<HTMLDivElement>;
  webMode: boolean;
  webWidth: string;
}

const Scene: React.FC<SceneProps> = ({ onContextMenu, webHost, webMode, webWidth }) => {
  const { scene, camera, gl } = useThree();
  const {
    sceneObjects: sourceObjects,
    selectedObject,
    setSelectedObject,
    sceneOptions,
    isPlaying,
    timelinePreviewTime,
    timelinePreviewDevice,
  } = useEditorStore();
  const previewing = !isPlaying && timelinePreviewTime !== null;
  const sceneObjects = useMemo(() => previewing && sceneOptions.timeline
    ? sourceObjects.map(item => ({ ...item, object: cloneSkeleton(item.object) }))
    : sourceObjects, [previewing, sourceObjects, sceneOptions.timeline]);
  const physicsEngineRef = useRef<PhysicsEngine | null>(null);
  const inputManagerRef = useRef<InputManager | null>(null);
  const characterControllerRef = useRef<CharacterControllerSystem | null>(null);
  const playerCameraRef = useRef<ReturnType<typeof createPlayerCamera>>(null);
  const pathFollowersRef = useRef<ReturnType<typeof createPathFollowers> | null>(null);
  const rotationSpeedRef = useRef<number>(0);
  const scriptsRef = useRef<ReturnType<typeof createObjectScripts> | null>(null);
  const triggerRef = useRef<ReturnType<typeof createTriggerSystem> | null>(null);
  const collisionRef = useRef<ReturnType<typeof createCollisionSystem> | null>(null);
  const modelAnimationsRef = useRef<ReturnType<typeof createModelAnimations> | null>(null);
  const propertyAnimationsRef = useRef<ReturnType<typeof createPropertyAnimations> | null>(null);
  const tweenAnimationsRef = useRef<ReturnType<typeof createTweenAnimations> | null>(null);
  const floatEffectsRef = useRef<ReturnType<typeof createFloatEffects> | null>(null);
  const timelineRef = useRef<ReturnType<typeof createTimeline> | null>(null);
  const suppressClickRef = useRef(false);
  const [transformMode] = useState<'translate' | 'rotate' | 'scale'>('translate');

  useEffect(() => {
    physicsEngineRef.current = new PhysicsEngine();
    inputManagerRef.current = new InputManager(() => useEditorStore.getState().isPlaying);
    characterControllerRef.current = new CharacterControllerSystem(inputManagerRef.current);
    return () => {
      inputManagerRef.current?.dispose();
      inputManagerRef.current = null;
      characterControllerRef.current = null;
      physicsEngineRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (physicsEngineRef.current) {
      physicsEngineRef.current.setGravity(sceneOptions.gravity);
    }
  }, [sceneOptions.gravity]);

  useEffect(() => {
    if (!isPlaying) inputManagerRef.current?.reset();
  }, [isPlaying]);

  useEffect(() => {
    if (!isPlaying) return;
    let restoreCamera: (() => void) | undefined;
    const activeCameraId = useEditorStore.getState().sceneOptions.activeCameraId;
    if (activeCameraId) {
      const source = useEditorStore.getState().sceneObjects.find(object => object.id === activeCameraId);
      if (source?.object instanceof THREE.PerspectiveCamera && camera instanceof THREE.PerspectiveCamera) {
        const position = camera.position.clone();
        const quaternion = camera.quaternion.clone();
        const { fov, near, far, zoom } = camera;
        camera.position.copy(source.object.position);
        camera.quaternion.copy(source.object.quaternion);
        camera.fov = source.object.fov;
        camera.near = source.object.near;
        camera.far = source.object.far;
        camera.zoom = source.object.zoom;
        camera.updateProjectionMatrix();
        restoreCamera = () => {
          camera.position.copy(position);
          camera.quaternion.copy(quaternion);
          Object.assign(camera, { fov, near, far, zoom });
          camera.updateProjectionMatrix();
        };
      } else {
        console.error('Selected play camera is unavailable');
        toast.error('Selected play camera is unavailable; using the default view');
      }
    }
    let jqueryScript: HTMLScriptElement | undefined;
    let jquery: { noConflict?: (deep: boolean) => void } | undefined;
    if (useEditorStore.getState().sceneOptions.enableJQuery) {
      jqueryScript = document.createElement('script');
      jqueryScript.textContent = jquerySource;
      document.head.appendChild(jqueryScript);
      jquery = Reflect.get(window, 'jQuery') as typeof jquery;
      if (!jquery?.noConflict) {
        console.error('Failed to initialize jQuery');
        toast.error('Failed to initialize jQuery');
      }
    }
    let active = true;
    const state = useEditorStore.getState();
    playerCameraRef.current = createPlayerCamera(state.sceneObjects, camera, gl.domElement, THREE, message => {
      console.error('Player camera error:', message);
      toast.error(message);
    });
    const scenes = state.scenes.map(entry => ({ id: entry.id, name: entry.id === state.activeSceneId ? state.sceneOptions.name : entry.sceneOptions.name }));
    const openScene = (id: string) => {
      if (!active) return;
      void useEditorStore.getState().navigateScene(id).catch(error => {
        if (!active) return;
        console.error('Scene transition failed:', error);
        toast.error(error instanceof Error ? error.message : 'Scene transition failed');
      });
    };
    const scripts = createObjectScripts(state.sceneObjects, scene, camera, THREE, (message) => {
      console.error('Object script error:', message);
      toast.error(`Script error: ${message}`);
    }, openScene, scenes, state.sceneOptions.ai ? createSceneAI(state.sceneOptions.ai) : null);
    scriptsRef.current = scripts;
    triggerRef.current = createTriggerSystem(state.sceneObjects, THREE, (id, method, other) => scripts.trigger(id, method, other));
    collisionRef.current = createCollisionSystem((id, method, other) => scripts.trigger(id, method, other));
    const modelAnimations = createModelAnimations(useEditorStore.getState().sceneObjects, THREE, message => {
      console.error('Model animation error:', message);
      toast.error(`Animation error: ${message}`);
    }, openScene, state.sceneOptions.timeline?.clips?.map(clip => clip.targetId));
    modelAnimationsRef.current = modelAnimations;
    propertyAnimationsRef.current = createPropertyAnimations(useEditorStore.getState().sceneObjects, message => {
      console.error('Animation error:', message);
      toast.error(`Animation error: ${message}`);
    }, webHost.current?.parentElement ?? undefined, openScene);
    scripts.start();
    tweenAnimationsRef.current = createTweenAnimations(state.sceneObjects, Tween, message => {
      console.error('Tween animation error:', message);
      toast.error(`Animation error: ${message}`);
    });
    floatEffectsRef.current = createFloatEffects(state.sceneObjects, message => {
      console.error('Float error:', message);
      toast.error(`Float error: ${message}`);
    });
    const navigationNotices = new Map<string, string>();
    pathFollowersRef.current = createPathFollowers(state.sceneObjects, state.sceneOptions.ai, state.sceneOptions.timeline,
      createSceneAI, message => {
        console.error('AI navigation error:', message);
        navigationNotices.set(message, toast.error(message));
      }, THREE, getPhysicsBounds, message => {
        const id = navigationNotices.get(message);
        if (id) toast.dismiss(id);
        navigationNotices.delete(message);
      });
    const cleanupWeb = webHost.current ? createWebLayer(webHost.current, useEditorStore.getState().sceneObjects, {
      editing: false, width: '100%', scene, camera, three: THREE, lottie,
      onPlayClip: (id, clipIndex) => modelAnimations.play(id, clipIndex),
      timelineSounds: state.sceneOptions.timeline?.sounds,
      onSceneChange: openScene, scenes,
      onError: message => { console.error('Web component error:', message); toast.error(`Web error: ${message}`); }
    }) : undefined;
    if (state.sceneOptions.timeline && webHost.current) {
      timelineRef.current = createTimeline(state.sceneOptions.timeline, state.sceneObjects, activeCameraId, camera, webHost.current, message => {
        console.error('Timeline error:', message);
        toast.error(`Timeline error: ${message}`);
      }, THREE, createTimelineMedia);
    }
    return () => { active = false; timelineRef.current?.stop(); timelineRef.current = null; cleanupWeb?.(); scripts.stop(); modelAnimations.stop(); propertyAnimationsRef.current?.stop(); tweenAnimationsRef.current?.stop(); modelAnimationsRef.current = null; propertyAnimationsRef.current = null; tweenAnimationsRef.current = null; floatEffectsRef.current = null; triggerRef.current = null; collisionRef.current = null; pathFollowersRef.current = null; scriptsRef.current = null; playerCameraRef.current?.stop(); playerCameraRef.current = null; jquery?.noConflict?.(true); jqueryScript?.remove(); restoreCamera?.(); };
  }, [isPlaying, scene, camera, gl, webHost]);

  useEffect(() => {
    if (!webHost.current || isPlaying || !webMode) return;
    const cleanup = createWebLayer(webHost.current, sceneObjects, {
      editing: true,
      width: webWidth,
      previewDevice: timelinePreviewDevice,
      selectedId: selectedObject?.id,
      scene, camera, three: THREE, lottie,
      onSelect: id => {
        const selected = useEditorStore.getState().sceneObjects.find(item => item.id === id);
        if (selected) useEditorStore.getState().setSelectedObject(selected);
      },
      onMove: (id, targetId) => useEditorStore.getState().moveWebObject(id, targetId),
      onError: message => { console.error('Web component error:', message); toast.error(`Web error: ${message}`); }
    });
    return cleanup;
  }, [webHost, webMode, webWidth, timelinePreviewDevice, isPlaying, scene, camera, sceneObjects, selectedObject]);

  useEffect(() => {
    if (!previewing || timelinePreviewTime === null || !sceneOptions.timeline || !webHost.current) return;
    const position = camera.position.clone();
    const quaternion = camera.quaternion.clone();
    const previewTimeline = webMode ? sceneOptions.timeline : {
      ...sceneOptions.timeline,
      tracks: sceneOptions.timeline.tracks.filter(track => !sceneObjects.find(item => item.id === track.targetId)?.properties.web)
    };
    const preview = createTimeline(previewTimeline, sceneObjects, sceneOptions.activeCameraId, camera, webHost.current,
      message => { console.error('Timeline preview error:', message); toast.error(`Timeline preview error: ${message}`); }, THREE, createTimelineMedia, true, timelinePreviewDevice);
    preview.seek(timelinePreviewTime);
    return () => {
      preview.stop();
      camera.position.copy(position);
      camera.quaternion.copy(quaternion);
    };
  }, [previewing, timelinePreviewTime, timelinePreviewDevice, sceneOptions.timeline, sceneOptions.activeCameraId, sceneObjects, webMode, webWidth, selectedObject, webHost, camera]);

  useEffect(() => {
    if (!isPlaying) return;
    const state = useEditorStore.getState();
    const sounds = state.sceneObjects.flatMap((object) =>
      (object.properties.sounds ?? []).filter((sound) => sound.autoPlay &&
        !state.sceneOptions.timeline?.sounds?.some(segment => segment.targetId === object.id && segment.soundId === sound.id)).map((sound) => {
        const audio = new Audio(sound.url);
        audio.volume = sound.volume;
        audio.loop = sound.loop;
        void audio.play().catch((error) => {
          console.error('Failed to play scene sound:', error);
          toast.error(`Could not play ${sound.name}`);
        });
        return audio;
      })
    );
    return () => sounds.forEach((audio) => { audio.pause(); audio.currentTime = 0; });
  }, [isPlaying]);

  useEffect(() => {
    if (sceneOptions.backgroundColor) {
      scene.background = new THREE.Color(sceneOptions.backgroundColor);
    }
    if (sceneOptions.fogEnabled) {
      scene.fog = new THREE.FogExp2(
        new THREE.Color(sceneOptions.fogColor || '#cccccc'),
        sceneOptions.fogDensity ?? 0.1
      );
    } else {
      scene.fog = null;
    }
  }, [scene, sceneOptions.backgroundColor, sceneOptions.fogEnabled, sceneOptions.fogColor, sceneOptions.fogDensity]);

  useEffect(() => {
    const config = sceneOptions.environment;
    if (!config?.enabled) return;
    let active = true;
    let texture: THREE.Texture | undefined;
    void createEnvironmentTexture(config, THREE, url => new RGBELoader().loadAsync(url)).then(result => {
      if (!active) { result.dispose(); return; }
      texture = result;
      scene.environment = result;
      if (config.background) scene.background = result;
    }).catch(error => {
      if (!active) return;
      console.error('Environment load failed:', error);
      toast.error(error instanceof Error ? error.message : 'Environment load failed');
    });
    return () => {
      active = false;
      if (scene.environment === texture) scene.environment = null;
      if (texture && scene.background === texture) scene.background = new THREE.Color(sceneOptions.backgroundColor);
      texture?.dispose();
    };
  }, [scene, sceneOptions.environment, sceneOptions.backgroundColor]);

  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (isPlaying || previewing || !selectedObject) return;
      e.preventDefault();
      rotationSpeedRef.current += e.deltaY > 0 ? 0.02 : -0.02;
      rotationSpeedRef.current = Math.max(-0.5, Math.min(0.5, rotationSpeedRef.current));
    };

    gl.domElement.addEventListener('wheel', handleWheel, { passive: false });
    return () => gl.domElement.removeEventListener('wheel', handleWheel);
  }, [isPlaying, previewing, selectedObject, gl]);

  useFrame((_, delta) => {
    if (selectedObject && selectedObject.object && !isPlaying && !previewing) {
      if (Math.abs(rotationSpeedRef.current) > 0.001) {
        selectedObject.object.rotation.y += rotationSpeedRef.current * delta * 10;
        rotationSpeedRef.current *= 0.95;
      }
    }

    if (useEditorStore.getState().isPlaying) {
      floatEffectsRef.current?.before();
      scriptsRef.current?.update(delta);
      modelAnimationsRef.current?.update(delta);
      pathFollowersRef.current?.update(delta);
      if (physicsEngineRef.current) {
        collisionRef.current?.begin();
        physicsEngineRef.current.update(sceneObjects, Math.min(delta, 0.05), (a, b) => collisionRef.current?.contact(a, b));
        collisionRef.current?.end();
      }
      triggerRef.current?.update();
      if (characterControllerRef.current) {
        characterControllerRef.current.update(sceneObjects, camera);
      }

      propertyAnimationsRef.current?.update(delta);
      tweenAnimationsRef.current?.update(delta);
      timelineRef.current?.update(delta);
      floatEffectsRef.current?.update(delta);
      playerCameraRef.current?.update();
    }
  });

  useEffect(() => {
    const objectsToRemove = scene.children.filter((child) => child.userData.isSceneObject);
    objectsToRemove.forEach((child) => scene.remove(child));

    sceneObjects.forEach((obj) => {
      obj.object.userData.isSceneObject = true;
      if (!scene.children.includes(obj.object)) scene.add(obj.object);
    });

    const handleContextMenuEvent = (event: MouseEvent) => {
      if (isPlaying || previewing) return;
      event.preventDefault();
      const rect = gl.domElement.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / gl.domElement.clientWidth) * 2 - 1;
      const y = -((event.clientY - rect.top) / gl.domElement.clientHeight) * 2 + 1;

      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
      const intersects = raycaster.intersectObjects(sceneObjects.map((obj) => obj.object), true);

      if (intersects.length > 0) {
        let clickedObject = intersects[0].object;
        while (clickedObject.parent && !clickedObject.userData.isSceneObject) {
          clickedObject = clickedObject.parent;
        }
        onContextMenu({
          x: event.clientX,
          y: event.clientY,
          object: clickedObject,
        });
      }
    };

    const handleClick = (event: MouseEvent) => {
      if (previewing) return;
      if (suppressClickRef.current) return;
      const rect = gl.domElement.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / gl.domElement.clientWidth) * 2 - 1;
      const y = -((event.clientY - rect.top) / gl.domElement.clientHeight) * 2 + 1;

      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
      const intersects = raycaster.intersectObjects(sceneObjects.map((obj) => obj.object), true);

      if (intersects.length > 0) {
        let clickedObject: THREE.Object3D = intersects[0].object;
        while (clickedObject.parent && !clickedObject.userData.isSceneObject) {
          clickedObject = clickedObject.parent;
        }
        const sceneObject = sceneObjects.find(
          (obj) => obj.object && (obj.object.uuid === clickedObject.uuid || obj.object === clickedObject)
        );
        if (isPlaying) {
          if (sceneObject) scriptsRef.current?.click(sceneObject.id);
          return;
        }
        setSelectedObject(sceneObject || null);
      } else {
        if (!isPlaying) setSelectedObject(null);
      }
    };

    gl.domElement.addEventListener('contextmenu', handleContextMenuEvent);
    gl.domElement.addEventListener('click', handleClick);

    return () => {
      gl.domElement.removeEventListener('contextmenu', handleContextMenuEvent);
      gl.domElement.removeEventListener('click', handleClick);
    };
  }, [scene, sceneObjects, camera, gl, setSelectedObject, onContextMenu, isPlaying, previewing]);

  return (
    <>
      {!isPlaying && <Grid infiniteGrid />}
      {!isPlaying && <OrbitControls makeDefault enabled={!previewing} />}

      <ambientLight intensity={sceneOptions.ambientLightIntensity ?? 0.5} />
      <directionalLight
        position={[10, 10, 5]}
        intensity={1}
        castShadow={sceneOptions.shadowsEnabled}
        userData={{ isDefault: true }}
      />

      {sceneObjects.map(
        (object) =>
          object.object && <primitive key={object.id} object={object.object} />
      )}

      {!isPlaying && !previewing && selectedObject && selectedObject.type !== 'web' && selectedObject.object && (
        <TransformControls
          object={selectedObject.object}
          mode={transformMode}
          onMouseDown={() => { suppressClickRef.current = true; }}
          onMouseUp={() => {
            const object = selectedObject.object;
            useEditorStore.getState().updateObjectProperties(selectedObject.id, {
              position: object.position.toArray() as [number, number, number],
              rotation: [
                THREE.MathUtils.radToDeg(object.rotation.x),
                THREE.MathUtils.radToDeg(object.rotation.y),
                THREE.MathUtils.radToDeg(object.rotation.z)
              ],
              scale: object.scale.toArray() as [number, number, number]
            });
            window.setTimeout(() => { suppressClickRef.current = false; }, 0);
          }}
        />
      )}
    </>
  );
};

export const Viewport: React.FC<{ exporting: boolean }> = ({ exporting }) => {
  const { resetScene, isPlaying, sceneObjects, selectedObject, activeSceneId, timelinePreviewDevice, setTimelinePreviewDevice } = useEditorStore();
  const webHost = useRef<HTMLDivElement>(null);
  const [webMode, setWebMode] = useState(true);
  const webWidth = timelinePreviewDevice === 'mobile' ? '375px' : timelinePreviewDevice === 'tablet' ? '768px' : '100%';
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    show: false,
    x: 0,
    y: 0,
    object: null,
  });
  const selectedId = selectedObject?.id;
  const selectedType = selectedObject?.type;

  useEffect(() => {
    if (selectedId) setWebMode(selectedType === 'web');
  }, [selectedId, selectedType]);

  const handleContextMenu = useCallback(
    ({ x, y, object }: { x: number; y: number; object: THREE.Object3D }) => {
      if (!isPlaying) {
        setContextMenu({ show: true, x, y, object });
      }
    },
    [isPlaying]
  );

  return (
    <div className="relative w-full h-full bg-gray-900">
      {!isPlaying && (
        <div className="absolute top-4 left-4 z-30 flex gap-2">
          <button
            onClick={() => {
              void (async () => {
                await beginNewDraft();
                resetScene();
                await initializeHistory(null);
              })().catch(error => {
                console.error('Could not reset scene history:', error);
                toast.error(error instanceof Error ? error.message : 'Could not reset scene history');
              });
            }}
            className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition-colors text-sm"
          >
            Reset Scene
          </button>
        </div>
      )}
      {!isPlaying && (
        <div className="absolute right-4 top-4 z-30 flex gap-1 rounded bg-gray-800 p-1 text-xs">
          {sceneObjects.some(item => item.type === 'web') && <>
            <button aria-pressed={!webMode} onClick={() => setWebMode(false)} className={`rounded px-2 py-1 ${!webMode ? 'bg-blue-700' : 'hover:bg-gray-600'}`}>3D</button>
            <button aria-pressed={webMode} onClick={() => setWebMode(true)} className={`rounded px-2 py-1 ${webMode ? 'bg-blue-700' : 'hover:bg-gray-600'}`}>Web</button>
          </>}
          <select aria-label="Web preview size" className="bg-gray-700 p-1" value={webWidth} onChange={event =>
            setTimelinePreviewDevice(event.target.value === '375px' ? 'mobile' : event.target.value === '768px' ? 'tablet' : 'desktop')}>
            <option value="100%">Desktop</option><option value="768px">Tablet</option><option value="375px">Mobile</option>
          </select>
        </div>
      )}

      {isPlaying && (!sceneObjects.some(item => item.type === 'web') ||
        sceneObjects.some(item => item.properties.characterController?.enabled)) && (
        <div className="absolute top-4 left-4 z-10 bg-gray-800/90 backdrop-blur-sm px-4 py-2 rounded text-white text-sm">
          <div>WASD / Arrow Keys - Move</div>
          <div>Space - Jump</div>
        </div>
      )}

      <div aria-label="3D preview viewport" className="absolute inset-y-0 left-1/2 -translate-x-1/2 max-w-full"
        style={{ width: isPlaying ? '100%' : webWidth }}>
        <Canvas shadows frameloop={exporting ? 'never' : 'always'} camera={{ position: [0, 5, 10], fov: 50 }}>
          <Scene key={isPlaying ? activeSceneId : 'editor'} onContextMenu={handleContextMenu} webHost={webHost} webMode={webMode} webWidth={isPlaying ? '100%' : webWidth} />
        </Canvas>
        <div ref={webHost} className="pointer-events-none absolute inset-0" />
      </div>

      {contextMenu.show && contextMenu.object && !isPlaying && (
        <ObjectContextMenu
          position={{ x: contextMenu.x, y: contextMenu.y }}
          object={contextMenu.object}
          onClose={() => setContextMenu({ show: false, x: 0, y: 0, object: null })}
        />
      )}
    </div>
  );
};
