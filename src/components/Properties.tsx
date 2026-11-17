import React, { useState, useRef, useEffect } from 'react';
import { useEditorStore } from '../store/editorStore';
import { HexColorPicker } from 'react-colorful';
import { Play, Pause, Plus, Trash2 } from 'lucide-react';
import { Animation, AnimationType, Sound, TriggerType } from '../types/animations';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from './ui/Accordion';
import * as THREE from 'three';
import { toast } from 'react-hot-toast';
import { readFileDataUrl } from '../services/media';
import { WebProperties } from './WebProperties';
import { registerAsset } from '../services/assetLibrary';

function positionArray(position?: number[] | THREE.Vector3): [number, number, number] {
  if (!position) return [0, 0, 0];
  if (Array.isArray(position)) return [position[0] ?? 0, position[1] ?? 0, position[2] ?? 0];
  return [position.x, position.y, position.z];
}

const CompletionScene: React.FC<{ value?: string; label: string; onChange: (id: string) => void }> = ({ value, label, onChange }) => {
  const { scenes, activeSceneId } = useEditorStore();
  return <label className="block text-xs text-white">When animation finishes
    <select aria-label={label} className="w-full rounded bg-gray-600 p-1" value={value ?? ''} onChange={event => onChange(event.target.value)}>
      <option value="">Do nothing</option>
      {value && !scenes.some(scene => scene.id === value) && <option value={value}>Missing scene</option>}
      {scenes.filter(scene => scene.id !== activeSceneId).map(scene => <option key={scene.id} value={scene.id}>{scene.sceneOptions.name}</option>)}
    </select>
    <span className="text-gray-300">Runs only when a non-looping animation finishes.</span>
  </label>;
};

const TriggerSettings: React.FC<{
  trigger?: Animation['trigger'];
  animationType: AnimationType;
  onChange: (trigger: Animation['trigger']) => void;
}> = ({ trigger, animationType, onChange }) => {
  const handleTriggerTypeChange = (type: TriggerType) => {
    onChange({
      type,
      key: type === 'key' ? 'Space' : undefined,
      mouseButton: type === 'mouse' ? 0 : undefined,
      mouseWheelDirection: type === 'mouseWheel' ? 'both' : undefined,
      distance: type === 'proximity' ? 5 : undefined,
    });
  };

  return (
    <div className="space-y-2">
      <label className="text-white text-xs block">Trigger Type</label>
      <select
        aria-label="Animation trigger"
        value={trigger?.type || 'none'}
        onChange={(e) => handleTriggerTypeChange(e.target.value as TriggerType)}
        className="w-full bg-gray-600 text-white p-1 rounded"
      >
        <option value="none">None</option>
        <option value="key" disabled>Keyboard Key</option>
        <option value="mouse" disabled>Mouse Button</option>
        <option value="mouseWheel" disabled={animationType !== 'rotation'}>Scroll / Mouse Wheel</option>
        <option value="collision" disabled>Collision</option>
        <option value="proximity" disabled>Proximity</option>
      </select>

      {trigger?.type === 'key' && (
        <div>
          <label className="text-white text-xs block">Key</label>
          <input
            type="text"
            value={trigger.key}
            onChange={(e) => onChange({ ...trigger, key: e.target.value })}
            onKeyDown={(e) => {
              e.preventDefault();
              onChange({ ...trigger, key: e.key });
            }}
            className="w-full bg-gray-600 text-white p-1 rounded"
            placeholder="Press any key"
          />
        </div>
      )}

      {trigger?.type === 'mouse' && (
        <div>
          <label className="text-white text-xs block">Mouse Button</label>
          <select
            value={trigger.mouseButton}
            onChange={(e) => onChange({ ...trigger, mouseButton: Number(e.target.value) })}
            className="w-full bg-gray-600 text-white p-1 rounded"
          >
            <option value="0">Left Click</option>
            <option value="1">Middle Click</option>
            <option value="2">Right Click</option>
          </select>
        </div>
      )}

      {trigger?.type === 'mouseWheel' && (
        <div>
          <label className="text-white text-xs block">Wheel Direction</label>
          <select
            value={trigger.mouseWheelDirection}
            aria-label="Scroll direction"
            onChange={(e) => onChange({ ...trigger, mouseWheelDirection: e.target.value as 'up' | 'down' | 'both' })}
            className="w-full bg-gray-600 text-white p-1 rounded"
          >
            <option value="both">Both directions</option>
            <option value="up">Scroll Up</option>
            <option value="down">Scroll Down</option>
          </select>
          <p className="text-gray-300 text-xs">Rotation values are radians per 100 pixels of scrolling.</p>
        </div>
      )}

      {trigger?.type === 'proximity' && (
        <div>
          <label className="text-white text-xs block">Distance</label>
          <input
            type="number"
            value={trigger.distance}
            onChange={(e) => onChange({ ...trigger, distance: Number(e.target.value) })}
            className="w-full bg-gray-600 text-white p-1 rounded"
            min="0"
            step="0.1"
          />
        </div>
      )}
    </div>
  );
};

export const Properties: React.FC = () => {
  const { selectedObject, updateObject, updateObjectProperties } = useEditorStore();
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [tagsDraft, setTagsDraft] = useState<{ id: string; value: string } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const colorPickerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showColorPicker) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setShowColorPicker(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showColorPicker]);

  if (!selectedObject || !selectedObject.properties) {
    return (
      <div className="w-full bg-gray-800 p-4">
        <p className="text-gray-400 text-center">No object selected</p>
      </div>
    );
  }

  if (selectedObject.type === 'web' && selectedObject.properties.web) {
    return <WebProperties item={selectedObject} />;
  }

  const { properties } = selectedObject;
  const tween = properties.tween ?? {
    enabled: false, property: 'position' as const, target: [...properties.position] as [number, number, number],
    opacity: 1, duration: 1, easing: 'smooth' as const, repeat: false, yoyo: false
  };
  const updateTween = (patch: Partial<NonNullable<typeof properties.tween>>) =>
    updateObjectProperties(selectedObject.id, { tween: { ...tween, ...patch } });
  const floating = properties.float ?? { enabled: false, speed: 1, height: 0.1, rotation: 0.1 };
  const updateFloat = (patch: Partial<NonNullable<typeof properties.float>>) =>
    updateObjectProperties(selectedObject.id, { float: { ...floating, ...patch } });

  const handleTextureUpload = async (event: React.ChangeEvent<HTMLInputElement>, type: 'map' | 'normalMap' | 'roughnessMap' | 'metalnessMap') => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const data = await readFileDataUrl(file);
      const texture = await new THREE.TextureLoader().loadAsync(data);
      texture.dispose();
      registerAsset(file, data);
      updateObjectProperties(selectedObject.id, { [type]: data });
    } catch (error) {
      console.error('Failed to load texture:', error);
      toast.error('Failed to load texture');
    } finally {
      event.target.value = '';
    }
  };

  const handleSoundUpload = async (event: React.ChangeEvent<HTMLInputElement>, soundId?: string) => {
    const file = event.target.files?.[0];
    if (!file) return;
    let url: string;
    try {
      url = await readFileDataUrl(file);
      await new Promise<void>((resolve, reject) => {
        const audio = new Audio();
        audio.onloadedmetadata = () => resolve();
        audio.onerror = () => reject(new Error('Unsupported or invalid audio file'));
        audio.src = url;
      });
    } catch (error) {
      console.error('Failed to load sound:', error);
      toast.error('Failed to load sound');
      return;
    } finally {
      event.target.value = '';
    }
    const newSound: Sound = {
      id: soundId || Math.random().toString(36).substr(2, 9),
      name: file.name,
      url,
      autoPlay: false,
      volume: 1,
      loop: false
    };
    registerAsset(file, url);

    const currentSounds = properties.sounds || [];
    const updatedSounds = soundId 
      ? currentSounds.map(s => s.id === soundId ? newSound : s)
      : [...currentSounds, newSound];

    updateObjectProperties(selectedObject.id, { sounds: updatedSounds });
  };

  const handleAnimationAdd = (type: AnimationType) => {
    const newAnimation: Animation = {
      id: Math.random().toString(36).substr(2, 9),
      type,
      targetId: selectedObject.id,
      autoPlay: false,
      trigger: {
        type: 'none'
      },
      params: {
        duration: 1000,
        loop: true,
        rotationSpeed: { x: 0, y: 1, z: 0 },
        movementSpeed: { x: 0, y: 0, z: 0 },
        startPosition: selectedObject.object ? [
          selectedObject.object.position.x,
          selectedObject.object.position.y,
          selectedObject.object.position.z
        ] : [0, 0, 0],
        endPosition: selectedObject.object ? [
          selectedObject.object.position.x + 1,
          selectedObject.object.position.y,
          selectedObject.object.position.z
        ] : [1, 0, 0]
      }
    };

    const currentAnimations = properties.animations || [];
    updateObjectProperties(selectedObject.id, { 
      animations: [...currentAnimations, newAnimation] 
    });
  };

  const toggleSound = (sound: Sound) => {
    if (!audioRef.current) return;

    if (audioRef.current.paused) {
      audioRef.current.src = sound.url;
      audioRef.current.volume = sound.volume;
      audioRef.current.loop = sound.loop;
      void audioRef.current.play().catch((error) => {
        console.error('Failed to play sound:', error);
        toast.error('Failed to play sound');
      });
    } else {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  };

  return (
    <div className="w-full bg-gray-800 p-4 overflow-y-auto">
      <h2 className="text-white text-lg font-bold mb-4">Properties</h2>
      <audio ref={audioRef} className="hidden" />
      
      <Accordion type="single" collapsible className="space-y-2">
        <AccordionItem value="identity">
          <AccordionTrigger className="text-white">Identity</AccordionTrigger>
          <AccordionContent>
            <div className="space-y-2">
              <label className="block text-white text-sm">Name
                <input aria-label="Object name" value={selectedObject.name} onChange={(e) => updateObject(selectedObject.id, { name: e.target.value })} className="w-full bg-gray-700 text-white p-2 rounded" />
              </label>
              <label className="block text-white text-sm">Class
                <input aria-label="Object class" value={properties.className ?? ''} onChange={(e) => updateObjectProperties(selectedObject.id, { className: e.target.value })} className="w-full bg-gray-700 text-white p-2 rounded" />
              </label>
              <label className="block text-white text-sm">Tags (comma separated)
                <input aria-label="Object tags" value={tagsDraft?.id === selectedObject.id ? tagsDraft.value : (properties.tags ?? []).join(', ')} onChange={(e) => { setTagsDraft({ id: selectedObject.id, value: e.target.value }); updateObjectProperties(selectedObject.id, { tags: e.target.value.split(',').map(tag => tag.trim()).filter(Boolean) }); }} className="w-full bg-gray-700 text-white p-2 rounded" />
              </label>
            </div>
          </AccordionContent>
        </AccordionItem>
        {(selectedObject.type === 'text3d' || selectedObject.type === 'textSdf') && properties.text3d && <AccordionItem value="text3d">
          <AccordionTrigger className="text-white">{selectedObject.type === 'textSdf' ? 'SDF Text' : '3D Text'}</AccordionTrigger>
          <AccordionContent>
            <div className="space-y-2 text-sm text-white">
              <label className="block">Text
                <input aria-label="3D text" maxLength={200} value={properties.text3d.text}
                  onChange={event => updateObjectProperties(selectedObject.id, { text3d: { ...properties.text3d!, text: event.target.value } })}
                  className="block w-full rounded bg-gray-700 p-1" />
              </label>
              <label className="block">Size
                <input aria-label="3D text size" type="number" min="0.01" max="100" step="0.1" value={properties.text3d.size}
                  onChange={event => updateObjectProperties(selectedObject.id, { text3d: { ...properties.text3d!, size: Math.max(0.01, Math.min(100, Number(event.target.value))) } })}
                  className="block w-full rounded bg-gray-700 p-1" />
              </label>
              {selectedObject.type === 'text3d' && <label className="block">Depth
                <input aria-label="3D text depth" type="number" min="0" max="50" step="0.05" value={properties.text3d.depth}
                  onChange={event => updateObjectProperties(selectedObject.id, { text3d: { ...properties.text3d!, depth: Math.max(0, Math.min(50, Number(event.target.value))) } })}
                  className="block w-full rounded bg-gray-700 p-1" />
              </label>}
              <p className="text-xs text-gray-300">{selectedObject.type === 'textSdf'
                ? 'SDF text uses bundled Noto Sans fonts and supports Latin-1 and Turkish characters.'
                : 'Built-in Droid Sans font. Depth 0 creates flat geometry; this is not SDF text.'}</p>
            </div>
          </AccordionContent>
        </AccordionItem>}
        <AccordionItem value="float">
          <AccordionTrigger className="text-white">Float</AccordionTrigger>
          <AccordionContent>
            <div className="space-y-2 text-sm text-white">
              <label className="flex items-center gap-2">
                <input aria-label="Enable float" type="checkbox" checked={floating.enabled} onChange={event => {
                  if (event.target.checked && (properties.physics?.enabled || properties.characterController?.enabled || properties.pathFollower?.enabled)) {
                    toast.error('Disable physics, character control and AI navigation before enabling float');
                    return;
                  }
                  updateFloat({ enabled: event.target.checked });
                }} />Play on start
              </label>
              {(['speed', 'height', 'rotation'] as const).map(key =>
                <label key={key} className="block">Float {key}
                  <input aria-label={`Float ${key}`} type="number" min="0" step="0.1" value={floating[key]}
                    onChange={event => updateFloat({ [key]: Math.max(0, Number(event.target.value)) })}
                    className="block w-full rounded bg-gray-700 p-1" />
                </label>)}
              <p className="text-xs text-gray-300">Visual offset applied after the timeline; physics and navigation must be disabled.</p>
            </div>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="tween">
          <AccordionTrigger className="text-white">Tween Animation</AccordionTrigger>
          <AccordionContent>
            <div className="space-y-2 text-sm text-white">
              <label className="flex items-center gap-2">
                <input aria-label="Enable tween animation" type="checkbox" checked={tween.enabled}
                  onChange={event => updateTween({ enabled: event.target.checked })} />Play on start
              </label>
              <label className="block">Property
                <select aria-label="Tween property" value={tween.property}
                  onChange={event => {
                    const property = event.target.value as typeof tween.property;
                    const target = property === 'position' || property === 'rotation' || property === 'scale'
                      ? [...properties[property]] as [number, number, number] : tween.target;
                    updateTween({ property, target });
                  }} className="block w-full rounded bg-gray-700 p-1">
                  <option value="position">Position</option><option value="rotation">Rotation (degrees)</option>
                  <option value="scale">Scale</option><option value="opacity">Opacity</option>
                </select>
              </label>
              {tween.property === 'opacity'
                ? <label className="block">Target opacity
                  <input aria-label="Tween opacity" type="number" min="0" max="1" step="0.05" value={tween.opacity}
                    onChange={event => updateTween({ opacity: Math.max(0, Math.min(1, Number(event.target.value))) })}
                    className="block w-full rounded bg-gray-700 p-1" />
                </label>
                : <div>Target {tween.property}
                  <div className="grid grid-cols-3 gap-2">{(['X', 'Y', 'Z'] as const).map((axis, index) =>
                    <input key={axis} aria-label={`Tween target ${axis}`} type="number" step="0.1" value={tween.target[index]}
                      onChange={event => {
                        const target: [number, number, number] = [...tween.target];
                        target[index] = Number(event.target.value);
                        updateTween({ target });
                      }} className="rounded bg-gray-700 p-1" />)}</div>
                </div>}
              <label className="block">Duration (seconds)
                <input aria-label="Tween duration" type="number" min="0.01" step="0.1" value={tween.duration}
                  onChange={event => updateTween({ duration: Math.max(0.01, Number(event.target.value)) })}
                  className="block w-full rounded bg-gray-700 p-1" />
              </label>
              <label className="block">Easing
                <select aria-label="Tween easing" value={tween.easing}
                  onChange={event => updateTween({ easing: event.target.value as typeof tween.easing })}
                  className="block w-full rounded bg-gray-700 p-1">
                  <option value="linear">Linear</option><option value="smooth">Smooth</option><option value="out">Ease out</option>
                </select>
              </label>
              <label className="flex items-center gap-2">
                <input aria-label="Tween repeat" type="checkbox" checked={tween.repeat}
                  onChange={event => updateTween({ repeat: event.target.checked })} />Repeat
              </label>
              <label className="flex items-center gap-2">
                <input aria-label="Tween yoyo" type="checkbox" checked={tween.yoyo} disabled={!tween.repeat}
                  onChange={event => updateTween({ yoyo: event.target.checked })} />Reverse on repeat
              </label>
              <p className="text-xs text-gray-300">Timeline channels override the same properties. Opacity requires a mesh or sprite.</p>
            </div>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="script">
          <AccordionTrigger className="text-white">JavaScript</AccordionTrigger>
          <AccordionContent>
            <p className="text-gray-300 text-xs mb-2">Return an object with start(), update(delta), click(), and stop() methods. Available: object, scene, camera, THREE, state, openScene(id), scenes (id and name).</p>
            <p className="text-gray-300 text-xs mb-2">Example: openScene(scenes.find(s =&gt; s.name === 'Scene 2 / Page 2').id)</p>
            <label className="block text-white text-sm">Object script
              <textarea aria-label="Object script" value={properties.script ?? ''} onChange={(e) => updateObjectProperties(selectedObject.id, { script: e.target.value })} spellCheck={false} rows={10} className="w-full bg-gray-900 text-white p-2 rounded font-mono text-xs" placeholder={'return {\n  update(delta) {\n    object.rotation.y += delta;\n  }\n};'} />
            </label>
            <p className="text-amber-300 text-xs mt-2">Scripts have full browser access. Run only trusted projects.</p>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="transform">
          <AccordionTrigger className="text-white">Transform</AccordionTrigger>
          <AccordionContent>
            <div className="space-y-4">
              <div>
                <label className="text-white text-sm">Position</label>
                <div className="grid grid-cols-3 gap-2">
                  {['x', 'y', 'z'].map((axis, i) => (
                    <input
                      key={axis}
                      type="number"
                      step="0.1"
                      value={properties.position[i]}
                      onChange={(e) => {
                        const newPosition: [number, number, number] = [...properties.position];
                        newPosition[i] = parseFloat(e.target.value) || 0;
                        updateObjectProperties(selectedObject.id, { position: newPosition });
                      }}
                      className="bg-gray-700 text-white p-1 rounded"
                    />
                  ))}
                </div>
              </div>

              <div>
                <label className="text-white text-sm">Rotation</label>
                <div className="grid grid-cols-3 gap-2">
                  {['x', 'y', 'z'].map((axis, i) => (
                    <input
                      key={axis}
                      type="number"
                      step="1"
                      value={properties.rotation[i]}
                      onChange={(e) => {
                        const newRotation: [number, number, number] = [...properties.rotation];
                        newRotation[i] = parseFloat(e.target.value) || 0;
                        updateObjectProperties(selectedObject.id, { rotation: newRotation });
                      }}
                      className="bg-gray-700 text-white p-1 rounded"
                    />
                  ))}
                </div>
              </div>

              <div>
                <label className="text-white text-sm">Scale</label>
                <div className="grid grid-cols-3 gap-2">
                  {['x', 'y', 'z'].map((axis, i) => (
                    <input
                      key={axis}
                      type="number"
                      step="0.1"
                      value={properties.scale[i]}
                      onChange={(e) => {
                        const newScale: [number, number, number] = [...properties.scale];
                        newScale[i] = Number(e.target.value);
                        updateObjectProperties(selectedObject.id, { scale: newScale });
                      }}
                      className="bg-gray-700 text-white p-1 rounded"
                    />
                  ))}
                </div>
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>

        {!properties.web && (selectedObject.object instanceof THREE.Mesh || selectedObject.type === 'model') && (
          <AccordionItem value="ai-navigation">
            <AccordionTrigger className="text-white">AI Navigation</AccordionTrigger>
            <AccordionContent>
              <div className="space-y-3 text-white text-sm">
                <label className="flex items-center gap-2">
                  <input aria-label="Enable AI navigation" type="checkbox" checked={properties.pathFollower?.enabled ?? false}
                    onChange={event => {
                      if (event.target.checked) {
                        const state = useEditorStore.getState();
                        if (!state.sceneOptions.ai) { toast.error('Save the scene AI grid settings first'); return; }
                        if ((properties.physics?.enabled && !properties.physics.isKinematic) || properties.characterController?.enabled) {
                          toast.error('Use kinematic physics and disable the character controller first'); return;
                        }
                        if (state.sceneOptions.timeline?.tracks.some(track => track.targetId === selectedObject.id &&
                            ['position.x', 'position.z'].includes(track.property))) {
                          toast.error('Remove this object\'s X/Z timeline channels first'); return;
                        }
                      }
                      updateObjectProperties(selectedObject.id, { pathFollower: {
                        algorithm: properties.pathFollower?.algorithm ?? 'astar',
                        speed: properties.pathFollower?.speed ?? 1,
                        cellSize: properties.pathFollower?.cellSize ?? 1,
                        faceDirection: properties.pathFollower?.faceDirection ?? false,
                        avoidObstacles: properties.pathFollower?.avoidObstacles ?? true,
                        enabled: event.target.checked
                      } });
                    }} />
                  Follow scene AI path
                </label>
                {properties.pathFollower?.enabled && <>
                  <label className="block">Algorithm
                    <select aria-label="NPC path algorithm" value={properties.pathFollower.algorithm}
                      className="block w-full rounded bg-gray-700 p-2"
                      onChange={event => {
                        if (properties.pathFollower) updateObjectProperties(selectedObject.id, {
                          pathFollower: { ...properties.pathFollower, algorithm: event.target.value as 'astar' | 'dijkstra' | 'q' }
                        });
                      }}>
                      <option value="astar">A*</option><option value="dijkstra">Dijkstra</option><option value="q">Q-learning</option>
                    </select>
                  </label>
                  {([
                    ['speed', 'NPC speed', 100],
                    ['cellSize', 'NPC cell size', 1000]
                  ] as const).map(([field, label, max]) => <label key={field} className="block">{label}
                    <input aria-label={label} type="number" min="0.1" max={max} step="0.1"
                      className="block w-full rounded bg-gray-700 p-2" value={properties.pathFollower![field]}
                      onChange={event => {
                        const value = event.target.valueAsNumber;
                        if (properties.pathFollower && Number.isFinite(value) && value >= 0.1 && value <= max) {
                          updateObjectProperties(selectedObject.id, { pathFollower: { ...properties.pathFollower, [field]: value } });
                        }
                      }} />
                  </label>)}
                  <label className="flex items-center gap-2">
                    <input aria-label="NPC face path" type="checkbox" checked={properties.pathFollower.faceDirection}
                      onChange={event => {
                        if (properties.pathFollower) updateObjectProperties(selectedObject.id,
                          { pathFollower: { ...properties.pathFollower, faceDirection: event.target.checked } });
                      }} />
                    Face movement direction (+Z forward)
                  </label>
                  <label className="flex items-center gap-2">
                    <input aria-label="Avoid scene obstacles" type="checkbox" checked={properties.pathFollower.avoidObstacles ?? false}
                      onChange={event => {
                        if (properties.pathFollower) updateObjectProperties(selectedObject.id,
                          { pathFollower: { ...properties.pathFollower, avoidObstacles: event.target.checked } });
                      }} />
                    Avoid scene colliders and replan
                  </label>
                  <p className="text-gray-400 text-xs">Solid physics colliders block the path; triggers do not. Enable kinematic physics on the NPC for collision and trigger events.</p>
                </>}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}
        {(selectedObject.object instanceof THREE.Mesh || selectedObject.type === 'model') && (
          <AccordionItem value="material">
            <AccordionTrigger className="text-white">Material</AccordionTrigger>
            <AccordionContent>
              <div className="space-y-4">
                <div>
                  <label className="text-white text-sm block mb-2">Material Type</label>
                  <select
                    aria-label="Material Type"
                    value={properties.materialType || 'standard'}
                    onChange={(e) => updateObjectProperties(selectedObject.id, { materialType: e.target.value as 'standard' | 'basic' | 'phong' | 'lambert' })}
                    className="w-full bg-gray-700 text-white p-2 rounded"
                  >
                    <option value="standard">Standard</option>
                    <option value="basic">Basic</option>
                    <option value="phong">Phong</option>
                    <option value="lambert">Lambert</option>
                  </select>
                </div>

                <div>
                  <label className="text-white text-sm block mb-2">Color</label>
                  <div className="relative" ref={colorPickerRef}>
                  <button
                    aria-label="Choose material color"
                    className="w-full h-8 rounded border border-gray-600"
                    style={{ backgroundColor: properties.color }}
                    onClick={() => setShowColorPicker(!showColorPicker)}
                  />
                  {showColorPicker && (
                    <div className="absolute z-20 mt-1">
                      <HexColorPicker
                        color={properties.color ?? '#808080'}
                        onChange={(color) => updateObjectProperties(selectedObject.id, { color })}
                      />
                    </div>
                  )}
                  </div>
                </div>

                <div>
                  <label className="text-white text-sm block mb-2">Metalness</label>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={properties.metalness || 0}
                    onChange={(e) => updateObjectProperties(selectedObject.id, { metalness: parseFloat(e.target.value) })}
                    className="w-full"
                  />
                </div>

                <div>
                  <label className="text-white text-sm block mb-2">Roughness</label>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={properties.roughness ?? 0.5}
                    onChange={(e) => updateObjectProperties(selectedObject.id, { roughness: parseFloat(e.target.value) })}
                    className="w-full"
                  />
                </div>

                <div>
                  <label className="text-white text-sm block mb-2">Opacity</label>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={properties.opacity ?? 1}
                    onChange={(e) => updateObjectProperties(selectedObject.id, { opacity: parseFloat(e.target.value) })}
                    className="w-full"
                  />
                </div>

                <div>
                  <label className="text-white text-sm block mb-2">Texture Maps</label>
                  <div className="space-y-2">
                    <div>
                      <label className="text-white text-xs block">Diffuse Map</label>
                      <input
                        type="file"
                        accept="image/*"
                        aria-label="Diffuse Map"
                        onChange={(e) => handleTextureUpload(e, 'map')}
                        className="w-full bg-gray-700 text-white p-1 rounded text-sm"
                      />
                    </div>
                    <div>
                      <label className="text-white text-xs block">Normal Map</label>
                      <input
                        type="file"
                        accept="image/*"
                        aria-label="Normal Map"
                        onChange={(e) => handleTextureUpload(e, 'normalMap')}
                        className="w-full bg-gray-700 text-white p-1 rounded text-sm"
                      />
                    </div>
                    <div>
                      <label className="text-white text-xs block">Roughness Map</label>
                      <input
                        type="file"
                        accept="image/*"
                        aria-label="Roughness Map"
                        onChange={(e) => handleTextureUpload(e, 'roughnessMap')}
                        className="w-full bg-gray-700 text-white p-1 rounded text-sm"
                      />
                    </div>
                    <div>
                      <label className="text-white text-xs block">Metalness Map</label>
                      <input
                        type="file"
                        accept="image/*"
                        aria-label="Metalness Map"
                        onChange={(e) => handleTextureUpload(e, 'metalnessMap')}
                        className="w-full bg-gray-700 text-white p-1 rounded text-sm"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
        )}

        {selectedObject.object instanceof THREE.Camera && (
          <AccordionItem value="camera">
            <AccordionTrigger className="text-white">Camera Settings</AccordionTrigger>
            <AccordionContent>
              <div className="space-y-4">
                <div>
                  <label className="text-white text-sm block mb-2">Field of View (FOV)</label>
                  <input
                    type="range"
                    min="1"
                    max="180"
                    value={properties.fov || 75}
                    onChange={(e) => updateObjectProperties(selectedObject.id, { fov: parseFloat(e.target.value) })}
                    className="w-full"
                  />
                  <span className="text-white text-xs">{properties.fov || 75}°</span>
                </div>

                <div>
                  <label className="text-white text-sm block mb-2">Near Plane</label>
                  <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={properties.near || 0.1}
                    onChange={(e) => updateObjectProperties(selectedObject.id, { near: parseFloat(e.target.value) })}
                    className="w-full bg-gray-700 text-white p-2 rounded"
                  />
                </div>

                <div>
                  <label className="text-white text-sm block mb-2">Far Plane</label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={properties.far || 1000}
                    onChange={(e) => updateObjectProperties(selectedObject.id, { far: parseFloat(e.target.value) })}
                    className="w-full bg-gray-700 text-white p-2 rounded"
                  />
                </div>

                <div>
                  <label className="text-white text-sm block mb-2">Aspect Ratio</label>
                  <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={properties.aspect || 1.5}
                    onChange={(e) => updateObjectProperties(selectedObject.id, { aspect: parseFloat(e.target.value) })}
                    className="w-full bg-gray-700 text-white p-2 rounded"
                  />
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
        )}

        {selectedObject.type === 'model' && (
          <AccordionItem value="model-animations">
            <AccordionTrigger className="text-white">GLB Animation Clips</AccordionTrigger>
            <AccordionContent>
              {selectedObject.object.animations.length === 0 ? (
                <p className="text-sm text-gray-300">This model has no animation clips.</p>
              ) : (
                <div className="space-y-3">
                  <label className="block text-sm text-white">Animation clip
                    <select aria-label="GLB animation clip" className="w-full rounded bg-gray-700 p-2"
                      value={properties.modelAnimation?.clipIndex ?? ''}
                      onChange={event => updateObjectProperties(selectedObject.id, {
                        modelAnimation: event.target.value === '' ? undefined : {
                          clipIndex: Number(event.target.value),
                          autoPlay: properties.modelAnimation?.autoPlay ?? false,
                          loop: properties.modelAnimation?.loop ?? true,
                          speed: properties.modelAnimation?.speed ?? 1,
                          onCompleteSceneId: properties.modelAnimation?.onCompleteSceneId
                        }
                      })}>
                      <option value="">Select a clip</option>
                      {selectedObject.object.animations.map((clip, index) =>
                        <option key={`${clip.name}-${index}`} value={index}>{clip.name || `Clip ${index + 1}`}</option>)}
                    </select>
                  </label>
                  <label className="flex items-center gap-2 text-sm text-white">
                    <input type="checkbox" aria-label="Play GLB animation"
                      checked={properties.modelAnimation?.autoPlay ?? false}
                      disabled={!properties.modelAnimation}
                      onChange={event => {
                        if (properties.modelAnimation) updateObjectProperties(selectedObject.id, {
                          modelAnimation: { ...properties.modelAnimation, autoPlay: event.target.checked }
                        });
                      }} />
                    Play on start
                  </label>
                  <label className="flex items-center gap-2 text-sm text-white">
                    <input type="checkbox" aria-label="Loop GLB animation"
                      checked={properties.modelAnimation?.loop ?? true}
                      disabled={!properties.modelAnimation}
                      onChange={event => {
                        if (properties.modelAnimation) updateObjectProperties(selectedObject.id, {
                          modelAnimation: { ...properties.modelAnimation, loop: event.target.checked }
                        });
                      }} />
                    Loop
                  </label>
                  <label className="block text-sm text-white">Playback speed
                    <input aria-label="GLB animation speed" type="number" min="0.1" max="4" step="0.1"
                      className="w-full rounded bg-gray-700 p-2" value={properties.modelAnimation?.speed ?? 1}
                      disabled={!properties.modelAnimation}
                      onChange={event => {
                        const speed = event.target.valueAsNumber;
                        if (properties.modelAnimation && Number.isFinite(speed) && speed >= 0.1 && speed <= 4) {
                          updateObjectProperties(selectedObject.id, {
                            modelAnimation: { ...properties.modelAnimation, speed }
                          });
                        }
                      }} />
                  </label>
                  {properties.modelAnimation && <CompletionScene label="GLB completion scene" value={properties.modelAnimation.onCompleteSceneId}
                    onChange={id => {
                      if (properties.modelAnimation) updateObjectProperties(selectedObject.id, {
                        modelAnimation: { ...properties.modelAnimation, onCompleteSceneId: id || undefined }
                      });
                    }} />}
                </div>
              )}
            </AccordionContent>
          </AccordionItem>
        )}

        <AccordionItem value="animations">
          <AccordionTrigger className="text-white">Animations</AccordionTrigger>
          <AccordionContent>
            <div className="space-y-4">
              <p className="text-xs text-gray-300">Animations run in Play and exports. Rotation also supports scroll input; other triggers are not yet available.</p>
              <div className="flex gap-2">
                <button
                  onClick={() => handleAnimationAdd('rotation')}
                  className="flex items-center gap-2 px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700"
                >
                  <Plus className="w-4 h-4" /> Rotation
                </button>
                <button
                  onClick={() => handleAnimationAdd('movement')}
                  className="flex items-center gap-2 px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700"
                >
                  <Plus className="w-4 h-4" /> Movement
                </button>
              </div>

              <div className="space-y-2">
                {properties.animations?.map((animation: Animation) => (
                  <div key={animation.id} className="bg-gray-700 p-2 rounded">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-white text-sm">{animation.type}</span>
                      <div className="flex gap-1">
                        <button
                          aria-label={`${animation.autoPlay ? 'Disable' : 'Enable'} ${animation.type} play on start`}
                          aria-pressed={animation.autoPlay}
                          disabled={animation.trigger?.type === 'mouseWheel'}
                          onClick={() => {
                            const updatedAnimation = { ...animation, autoPlay: !animation.autoPlay };
                            const updatedAnimations = properties.animations?.map(a => 
                              a.id === animation.id ? updatedAnimation : a
                            );
                            updateObjectProperties(selectedObject.id, { animations: updatedAnimations });
                          }}
                          className="flex items-center gap-1 text-xs text-gray-300 hover:text-white"
                        >
                          {animation.autoPlay ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                          {animation.autoPlay ? 'On' : 'Off'}
                        </button>
                        <button
                          aria-label={`Remove ${animation.type} animation`}
                          onClick={() => {
                            updateObjectProperties(selectedObject.id, { animations:
                              properties.animations?.filter(a => a.id !== animation.id)
                            });
                          }}
                          className="text-gray-400 hover:text-red-500"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <TriggerSettings
                        trigger={animation.trigger}
                        animationType={animation.type}
                        onChange={(trigger) => {
                          const updatedAnimation = { ...animation, trigger, autoPlay: trigger?.type === 'mouseWheel' ? false : animation.autoPlay };
                          const updatedAnimations = properties.animations?.map(a => 
                            a.id === animation.id ? updatedAnimation : a
                          );
                          updateObjectProperties(selectedObject.id, { animations: updatedAnimations });
                        }}
                      />
                      {animation.trigger?.type !== 'mouseWheel' && <CompletionScene label={`${animation.type} completion scene`} value={animation.onCompleteSceneId}
                        onChange={id => updateObjectProperties(selectedObject.id, { animations: properties.animations?.map(a =>
                          a.id === animation.id ? { ...a, onCompleteSceneId: id || undefined } : a) })} />}

                      {animation.trigger?.type !== 'mouseWheel' && <div>
                        <label className="text-white text-xs">Duration (ms)</label>
                        <input
                          type="number"
                          value={animation.params.duration}
                          onChange={(e) => {
                            const updatedAnimation = {
                              ...animation,
                              params: { ...animation.params, duration: parseInt(e.target.value) }
                            };
                            const updatedAnimations = properties.animations?.map(a => 
                              a.id === animation.id ? updatedAnimation : a
                            );
                            updateObjectProperties(selectedObject.id, { animations: updatedAnimations });
                          }}
                          className="w-full bg-gray-600 text-white p-1 rounded"
                        />
                      </div>}

                      {animation.type === 'rotation' && (
                        <div>
                          <label className="text-white text-xs">Rotation Speed</label>
                          <div className="grid grid-cols-3 gap-1">
                            {(['x', 'y', 'z'] as const).map((axis) => (
                              <input
                                key={axis}
                                type="number"
                                aria-label={`Rotation speed ${axis}`}
                                step="0.1"
                                value={animation.params.rotationSpeed?.[axis] || 0}
                                onChange={(e) => {
                                  const newSpeed = { x: 0, y: 0, z: 0, ...animation.params.rotationSpeed };
                                  newSpeed[axis] = parseFloat(e.target.value) || 0;
                                  const updatedAnimation = {
                                    ...animation,
                                    params: { ...animation.params, rotationSpeed: newSpeed }
                                  };
                                  const updatedAnimations = properties.animations?.map(a => 
                                    a.id === animation.id ? updatedAnimation : a
                                  );
                                  updateObjectProperties(selectedObject.id, { animations: updatedAnimations });
                                }}
                                className="bg-gray-600 text-white p-1 rounded"
                              />
                            ))}
                          </div>
                        </div>
                      )}

                      {animation.type === 'movement' && (
                        <>
                          <div>
                            <label className="text-white text-xs">Start Position</label>
                            <div className="grid grid-cols-3 gap-1">
                              {['x', 'y', 'z'].map((axis, i) => (
                                <input
                                  key={axis}
                                  type="number"
                                  step="0.1"
                                  value={positionArray(animation.params.startPosition)[i]}
                                  onChange={(e) => {
                                    const newPos = positionArray(animation.params.startPosition);
                                    newPos[i] = parseFloat(e.target.value) || 0;
                                    const updatedAnimation = {
                                      ...animation,
                                      params: { ...animation.params, startPosition: newPos }
                                    };
                                    const updatedAnimations = properties.animations?.map(a => 
                                      a.id === animation.id ? updatedAnimation : a
                                    );
                                    updateObjectProperties(selectedObject.id, { animations: updatedAnimations });
                                  }}
                                  className="bg-gray-600 text-white p-1 rounded"
                                />
                              ))}
                            </div>
                          </div>

                          <div>
                            <label className="text-white text-xs">End Position</label>
                            <div className="grid grid-cols-3 gap-1">
                              {['x', 'y', 'z'].map((axis, i) => (
                                <input
                                  key={axis}
                                  type="number"
                                  step="0.1"
                                  value={positionArray(animation.params.endPosition)[i]}
                                  onChange={(e) => {
                                    const newPos = positionArray(animation.params.endPosition);
                                    newPos[i] = parseFloat(e.target.value) || 0;
                                    const updatedAnimation = {
                                      ...animation,
                                      params: { ...animation.params, endPosition: newPos }
                                    };
                                    const updatedAnimations = properties.animations?.map(a => 
                                      a.id === animation.id ? updatedAnimation : a
                                    );
                                    updateObjectProperties(selectedObject.id, { animations: updatedAnimations });
                                  }}
                                  className="bg-gray-600 text-white p-1 rounded"
                                />
                              ))}
                            </div>
                          </div>
                        </>
                      )}

                      {animation.trigger?.type !== 'mouseWheel' && <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={animation.params.loop}
                          onChange={(e) => {
                            const updatedAnimation = {
                              ...animation,
                              params: { ...animation.params, loop: e.target.checked }
                            };
                            const updatedAnimations = properties.animations?.map(a => 
                              a.id === animation.id ? updatedAnimation : a
                            );
                            updateObjectProperties(selectedObject.id, { animations: updatedAnimations });
                          }}
                          className="bg-gray-600"
                        />
                        <label className="text-white text-xs">Loop</label>
                      </div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="sounds">
          <AccordionTrigger className="text-white">Sounds</AccordionTrigger>
          <AccordionContent>
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <input
                  type="file"
                  accept="audio/*"
                  onChange={(e) => handleSoundUpload(e)}
                  className="hidden"
                  id="sound-upload"
                />
                <label
                  htmlFor="sound-upload"
                  className="flex items-center gap-2 px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 cursor-pointer"
                >
                  <Plus className="w-4 h-4" /> Add Sound
                </label>
              </div>

              <div className="space-y-2">
                {properties.sounds?.map((sound: Sound) => (
                  <div key={sound.id} className="bg-gray-700 p-2 rounded">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-white text-sm">{sound.name}</span>
                      <div className="flex gap-1">
                        <button
                          onClick={() => toggleSound(sound)}
                            aria-label={`Play or pause ${sound.name}`}
                          className="text-gray-400 hover:text-white"
                        >
                          <Play className="w-4 h-4" />
                        </button>
                        <button
                          aria-label={`Remove ${sound.name}`}
                          onClick={() => {
                            if (useEditorStore.getState().sceneOptions.timeline?.sounds?.some(segment =>
                              segment.targetId === selectedObject.id && segment.soundId === sound.id) &&
                              !window.confirm('Removing this sound also removes its timeline segments. Continue?')) return;
                            updateObjectProperties(selectedObject.id, { sounds:
                              properties.sounds?.filter(s => s.id !== sound.id)
                            });
                          }}
                          className="text-gray-400 hover:text-red-500"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="flex items-center gap-2 text-white text-xs">
                        <input
                          type="checkbox"
                          checked={sound.autoPlay}
                          onChange={(e) => {
                            const updatedSounds = properties.sounds?.map(s =>
                              s.id === sound.id ? { ...s, autoPlay: e.target.checked } : s
                            );
                            updateObjectProperties(selectedObject.id, { sounds: updatedSounds });
                          }}
                        />
                        Play automatically
                      </label>
                      <div>
                        <label className="text-white text-xs">Volume</label>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.1"
                          value={sound.volume}
                          onChange={(e) => {
                            const updatedSound = {
                              ...sound,
                              volume: parseFloat(e.target.value)
                            };
                            const updatedSounds = properties.sounds?.map(s =>
                              s.id === sound.id ? updatedSound : s
                            );
                            updateObjectProperties(selectedObject.id, { sounds: updatedSounds });
                            if (audioRef.current) {
                              audioRef.current.volume = updatedSound.volume;
                            }
                          }}
                          className="w-full bg-gray-600"
                        />
                      </div>

                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={sound.loop}
                          onChange={(e) => {
                            const updatedSound = {
                              ...sound,
                              loop: e.target.checked
                            };
                            const updatedSounds = properties.sounds?.map(s =>
                              s.id === sound.id ? updatedSound : s
                            );
                            updateObjectProperties(selectedObject.id, { sounds: updatedSounds });
                            if (audioRef.current) {
                              audioRef.current.loop = updatedSound.loop;
                            }
                          }}
                          className="bg-gray-600"
                        />
                        <label className="text-white text-xs">Loop</label>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>

        {(selectedObject.object instanceof THREE.Mesh || selectedObject.type === 'model') && (
          <AccordionItem value="physics">
            <AccordionTrigger className="text-white">Physics</AccordionTrigger>
            <AccordionContent>
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={properties.physics?.enabled || false}
                    onChange={(e) => updateObjectProperties(selectedObject.id, {
                      physics: {
                        ...(properties.physics || {}),
                        enabled: e.target.checked,
                        mass: properties.physics?.mass || 1,
                        velocity: properties.physics?.velocity || [0, 0, 0],
                        acceleration: properties.physics?.acceleration || [0, 0, 0],
                        useGravity: properties.physics?.useGravity !== undefined ? properties.physics.useGravity : true,
                        isKinematic: properties.physics?.isKinematic || false
                      }
                    })}
                    className="bg-gray-700"
                  />
                  <label className="text-white text-sm">Enable Physics</label>
                </div>

                {properties.physics?.enabled && (
                  <>
                    <div>
                      <label className="text-white text-sm block mb-2">Mass</label>
                      <input
                        type="number"
                        min="0.1"
                        step="0.1"
                        value={properties.physics?.mass || 1}
                        onChange={(e) => {
                          if (properties.physics) updateObjectProperties(selectedObject.id, {
                            physics: { ...properties.physics, mass: parseFloat(e.target.value) }
                          });
                        }}
                        className="w-full bg-gray-700 text-white p-2 rounded"
                      />
                    </div>

                    <label className="text-white text-sm block">
                      Linear damping
                      <input
                        aria-label="Linear damping"
                        type="number"
                        min="0"
                        max="10"
                        step="0.1"
                        value={properties.physics.linearDamping ?? 0}
                        onChange={(event) => {
                          const value = event.target.valueAsNumber;
                          if (properties.physics && Number.isFinite(value) && value >= 0 && value <= 10) {
                            updateObjectProperties(selectedObject.id, { physics: { ...properties.physics, linearDamping: value } });
                          }
                        }}
                        className="w-full bg-gray-700 text-white p-2 rounded"
                      />
                      <span className="text-xs text-gray-400">Reduces velocity over time; 0 preserves existing behavior.</span>
                    </label>

                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={properties.physics?.useGravity !== undefined ? properties.physics.useGravity : true}
                        onChange={(e) => {
                          if (properties.physics) updateObjectProperties(selectedObject.id, {
                            physics: { ...properties.physics, useGravity: e.target.checked }
                          });
                        }}
                        className="bg-gray-700"
                      />
                      <label className="text-white text-sm">Use Gravity</label>
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={properties.physics?.isKinematic || false}
                        onChange={(e) => {
                          if (properties.physics) updateObjectProperties(selectedObject.id, {
                            physics: { ...properties.physics, isKinematic: e.target.checked }
                          });
                        }}
                        className="bg-gray-700"
                      />
                      <label className="text-white text-sm">Is Kinematic</label>
                    </div>
                    <label className="block text-white text-sm">
                      Collider
                      <select aria-label="Collider" className="block w-full bg-gray-700 p-2 rounded"
                        value={properties.physics.collider?.type === 'box' ? 'box' : 'auto'}
                        onChange={event => {
                          if (!properties.physics) return;
                          updateObjectProperties(selectedObject.id, { physics: { ...properties.physics,
                            collider: event.target.value === 'box' ? { type: 'box', size: [1, 1, 1] } : undefined } });
                        }}>
                        <option value="auto">Automatic object bounds</option>
                        <option value="box">Custom box</option>
                      </select>
                    </label>
                    {properties.physics.collider?.type === 'box' && <div className="grid grid-cols-3 gap-2">
                      {(['X', 'Y', 'Z'] as const).map((axis, index) => <label key={axis} className="text-white text-sm">
                        {axis}
                        <input aria-label={`Collider size ${axis}`} type="number" min="0.01" step="0.1"
                          className="w-full bg-gray-700 p-2 rounded" value={properties.physics!.collider!.size[index]}
                          onChange={event => {
                            const value = event.target.valueAsNumber;
                            const physics = properties.physics;
                            if (!physics?.collider || !Number.isFinite(value) || value <= 0) return;
                            const size: [number, number, number] = [...physics.collider.size];
                            size[index] = value;
                            updateObjectProperties(selectedObject.id, { physics: { ...physics, collider: { ...physics.collider, size } } });
                          }} />
                      </label>)}
                    </div>}
                    <label className="flex items-center gap-2 text-white text-sm">
                      <input type="checkbox" aria-label="Trigger" checked={properties.physics.isTrigger ?? false}
                        onChange={event => {
                          if (properties.physics) updateObjectProperties(selectedObject.id,
                            { physics: { ...properties.physics, isTrigger: event.target.checked } });
                        }} />
                      Trigger (no collision response)
                    </label>
                    <p className="text-xs text-gray-400">Scripts receive triggerEnter/triggerExit or collisionEnter/collisionExit with the other object.</p>
                  </>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}

        {(selectedObject.object instanceof THREE.Mesh || selectedObject.type === 'model') && (
          <AccordionItem value="character-controller">
            <AccordionTrigger className="text-white">Character Controller</AccordionTrigger>
            <AccordionContent>
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={properties.characterController?.enabled || false}
                    onChange={(e) => {
                      const mode = properties.characterController?.mode;
                      const other = useEditorStore.getState().sceneObjects.find(item => item.id !== selectedObject.id &&
                        item.properties.characterController?.enabled &&
                        ['fps', 'rpg'].includes(item.properties.characterController.mode ?? 'legacy'));
                      if (e.target.checked && (mode === 'fps' || mode === 'rpg') && other) {
                        toast.error(`Camera is already controlled by ${other.name}`);
                        return;
                      }
                      updateObjectProperties(selectedObject.id, {
                      characterController: {
                        ...properties.characterController,
                        enabled: e.target.checked,
                        speed: properties.characterController?.speed || 5,
                        jumpForce: properties.characterController?.jumpForce || 5,
                        isGrounded: false,
                        canJump: properties.characterController?.canJump ?? true
                      },
                      physics: properties.physics?.enabled ? properties.physics : {
                        enabled: true,
                        mass: 1,
                        velocity: [0, 0, 0],
                        acceleration: [0, 0, 0],
                        useGravity: true,
                        isKinematic: false
                      }
                    });
                    }}
                    className="bg-gray-700"
                  />
                  <label className="text-white text-sm">Enable Character Controller</label>
                </div>

                {properties.characterController?.enabled && (
                  <>
                    <label className="block text-white text-sm">
                      Camera mode
                      <select aria-label="Player camera mode" className="block w-full bg-gray-700 p-2 rounded"
                        value={properties.characterController.mode ?? 'legacy'}
                        onChange={event => {
                          const mode = event.target.value as 'legacy' | 'fps' | 'rpg';
                          const other = useEditorStore.getState().sceneObjects.find(item => item.id !== selectedObject.id &&
                            item.properties.characterController?.enabled &&
                            ['fps', 'rpg'].includes(item.properties.characterController.mode ?? 'legacy'));
                          if (mode !== 'legacy' && other) {
                            toast.error(`Camera is already controlled by ${other.name}`);
                            return;
                          }
                          if (properties.characterController) updateObjectProperties(selectedObject.id,
                            { characterController: { ...properties.characterController, mode } });
                        }}>
                        <option value="legacy">Existing camera</option>
                        <option value="fps">First person (FPS)</option>
                        <option value="rpg">Third person (RPG)</option>
                      </select>
                    </label>
                    {(properties.characterController.mode === 'fps' || properties.characterController.mode === 'rpg') && <>
                      {([
                        ['cameraHeight', 'Camera height', 1.5, 0],
                        ['cameraDistance', 'Camera distance', 4, 0.1],
                        ['lookSensitivity', 'Mouse sensitivity', 0.002, 0.0001]
                      ] as const).filter(([field]) => field !== 'cameraDistance' || properties.characterController?.mode === 'rpg')
                        .map(([field, label, fallback, min]) => <label key={field} className="block text-white text-sm">
                          {label}
                          <input aria-label={label} type="number" min={min} step={field === 'lookSensitivity' ? '0.001' : '0.1'}
                            className="block w-full bg-gray-700 p-2 rounded"
                            value={properties.characterController?.[field] ?? fallback}
                            onChange={event => {
                              const value = event.target.valueAsNumber;
                              if (properties.characterController && Number.isFinite(value) && value >= min) {
                                updateObjectProperties(selectedObject.id,
                                  { characterController: { ...properties.characterController, [field]: value } });
                              }
                            }} />
                        </label>)}
                      <p className="text-gray-400 text-xs">Click the viewport to capture the mouse; Escape releases it.</p>
                    </>}
                    <div>
                      <label className="text-white text-sm block mb-2">Movement Speed</label>
                      <input
                        type="number"
                        min="0.1"
                        step="0.1"
                        value={properties.characterController?.speed || 5}
                        onChange={(e) => {
                          if (properties.characterController) updateObjectProperties(selectedObject.id, {
                            characterController: { ...properties.characterController, speed: parseFloat(e.target.value) }
                          });
                        }}
                        className="w-full bg-gray-700 text-white p-2 rounded"
                      />
                    </div>

                    <div>
                      <label className="text-white text-sm block mb-2">Jump Force</label>
                      <input
                        type="number"
                        min="0.1"
                        step="0.1"
                        value={properties.characterController?.jumpForce || 5}
                        onChange={(e) => {
                          if (properties.characterController) updateObjectProperties(selectedObject.id, {
                            characterController: { ...properties.characterController, jumpForce: parseFloat(e.target.value) }
                          });
                        }}
                        className="w-full bg-gray-700 text-white p-2 rounded"
                      />
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={properties.characterController?.canJump !== false}
                        onChange={(e) => {
                          if (properties.characterController) updateObjectProperties(selectedObject.id, {
                            characterController: { ...properties.characterController, canJump: e.target.checked }
                          });
                        }}
                        className="bg-gray-700"
                      />
                      <label className="text-white text-sm">Can Jump</label>
                    </div>

                    <div className="bg-blue-900 bg-opacity-30 p-2 rounded border border-blue-700">
                      <p className="text-blue-200 text-xs">
                        Controls: WASD or Arrow Keys to move, Space to jump
                      </p>
                    </div>
                  </>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}
      </Accordion>
    </div>
  );
};