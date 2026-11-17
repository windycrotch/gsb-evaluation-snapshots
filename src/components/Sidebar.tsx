import React, { useRef } from 'react';
import { useEditorStore } from '../store/editorStore';
import { Cuboid as Cube, Cylinder, Sun, Square, Sparkles, Camera, Plus, Cherry as Sphere, Cone, Upload, Type } from 'lucide-react';
import * as THREE from 'three';
import { toast } from 'react-hot-toast';
import { loadGLBModel, createSceneObjectFromModel } from '../services/modelLoader';
import { SceneObject } from '../types/editor';
import { readFileDataUrl } from '../services/media';
import { WebElements } from './WebElements';
import { registerAsset } from '../services/assetLibrary';
import { createSdfText, createTextGeometry } from '../services/sceneObjects';

const ComponentButton = ({ name, icon, onAdd }: { name: string; icon: React.ReactNode; onAdd: () => void }) => {
  return (
    <div className="flex flex-col items-center bg-gray-700 rounded-lg p-3 hover:bg-gray-600 transition-colors group">
      <div className="text-white mb-2 group-hover:scale-110 transition-transform">{icon}</div>
      <span className="text-sm text-white mb-2">{name}</span>
      <button
        onClick={onAdd}
        className="flex items-center gap-1 px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors text-sm group-hover:bg-blue-500"
      >
        <Plus className="w-4 h-4" />
        Add
      </button>
    </div>
  );
};

export const Sidebar: React.FC = () => {
  const { addObject } = useEditorStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAddComponent = (type: string, name: string) => {
    let object;
    const position = new THREE.Vector3(0, 0, 0);

    try {
      switch (type) {
        case 'ground':
          object = new THREE.Mesh(
            new THREE.PlaneGeometry(10, 10),
            new THREE.MeshStandardMaterial({ 
              color: 0x808080,
              side: THREE.DoubleSide 
            })
          );
          object.rotation.x = -Math.PI / 2;
          object.receiveShadow = true;
          break;
        case 'box':
          object = new THREE.Mesh(
            new THREE.BoxGeometry(),
            new THREE.MeshStandardMaterial({ color: 0x808080 })
          );
          break;
        case 'text3d':
          object = new THREE.Mesh(createTextGeometry({ text: '3D Text', size: 1, depth: 0.15 }),
            new THREE.MeshStandardMaterial({ color: 0x808080 }));
          break;
        case 'textSdf':
          object = createSdfText({ text: 'SDF Text', size: 1, depth: 0 });
          break;
        case 'sphere':
          object = new THREE.Mesh(
            new THREE.SphereGeometry(0.5, 32, 32),
            new THREE.MeshStandardMaterial({ color: 0x808080 })
          );
          break;
        case 'cylinder':
          object = new THREE.Mesh(
            new THREE.CylinderGeometry(0.5, 0.5, 1, 32),
            new THREE.MeshStandardMaterial({ color: 0x808080 })
          );
          break;
        case 'cone':
          object = new THREE.Mesh(
            new THREE.ConeGeometry(0.5, 1, 32),
            new THREE.MeshStandardMaterial({ color: 0x808080 })
          );
          break;
        case 'pointLight':
          object = new THREE.PointLight(0xffffff, 1);
          position.set(2, 2, 2);
          break;
        case 'spotLight':
          object = new THREE.SpotLight(0xffffff, 1);
          position.set(2, 5, 2);
          break;
        case 'camera':
          object = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
          position.set(0, 2, 5);
          break;
        default:
          return;
      }

      object.position.copy(position);
      object.castShadow = true;

      const newObject: SceneObject = {
        id: Math.random().toString(36).substr(2, 9),
        name,
        type,
        object,
        properties: {
          position: [position.x, position.y, position.z],
          rotation: [
            THREE.MathUtils.radToDeg(object.rotation.x),
            THREE.MathUtils.radToDeg(object.rotation.y),
            THREE.MathUtils.radToDeg(object.rotation.z)
          ],
          scale: [1, 1, 1],
          color: type.includes('Light') ? '#ffffff' : '#808080',
          ...(type === 'text3d' ? { text3d: { text: '3D Text', size: 1, depth: 0.15 } } : {}),
          ...(type === 'textSdf' ? { text3d: { text: 'SDF Text', size: 1, depth: 0 } } : {}),
          intensity: type.includes('Light') ? 1 : undefined,
          angle: type === 'spotLight' ? 45 : undefined,
          fov: type === 'camera' ? 75 : undefined,
          near: type === 'camera' ? 0.1 : undefined,
          far: type === 'camera' ? 1000 : undefined,
          receiveShadow: type === 'ground',
          animations: [],
          sounds: []
        }
      };

      addObject(newObject);
      toast.success(`Added ${name} to scene`);
    } catch (error) {
      toast.error(`Failed to add ${name}`);
      console.error('Add component error:', error);
    }
  };

  const components = [
    { id: 'ground', name: 'Ground', icon: <Square className="w-6 h-6" /> },
    { id: 'box', name: 'Box', icon: <Cube className="w-6 h-6" /> },
    { id: 'text3d', name: '3D Text', icon: <Type className="w-6 h-6" /> },
    { id: 'textSdf', name: 'SDF Text', icon: <Type className="w-6 h-6" /> },
    { id: 'sphere', name: 'Sphere', icon: <Sphere className="w-6 h-6" /> },
    { id: 'cylinder', name: 'Cylinder', icon: <Cylinder className="w-6 h-6" /> },
    { id: 'cone', name: 'Cone', icon: <Cone className="w-6 h-6" /> },
    { id: 'pointLight', name: 'Point Light', icon: <Sun className="w-6 h-6" /> },
    { id: 'spotLight', name: 'Spot Light', icon: <Sparkles className="w-6 h-6" /> },
    { id: 'camera', name: 'Camera', icon: <Camera className="w-6 h-6" /> }
  ];

  const handleLoadModel = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.glb')) {
      toast.error('Please select a .glb file');
      return;
    }

    const toastId = toast.loading('Loading model...');
    try {
      const data = await readFileDataUrl(file);
      const model = await loadGLBModel(data);
      const fileName = file.name.replace(/\.glb$/i, '');
      const sceneObject = createSceneObjectFromModel(model, fileName, data);
      registerAsset(file, data);
      addObject(sceneObject);
      toast.success(`Loaded ${fileName}`, { id: toastId });
    } catch (error) {
      toast.error('Failed to load model', { id: toastId });
      console.error('Model loading error:', error);
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleMedia = async (event: React.ChangeEvent<HTMLInputElement>, type: 'imagePlane' | 'imageSprite' | 'audioSource') => {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const data = await readFileDataUrl(file);
      let object: THREE.Object3D;
      if (type === 'audioSource') {
        await new Promise<void>((resolve, reject) => {
          const audio = new Audio();
          audio.onloadedmetadata = () => resolve();
          audio.onerror = () => reject(new Error('Invalid audio file'));
          audio.src = data;
        });
        object = new THREE.Object3D();
      } else {
        const texture = await new THREE.TextureLoader().loadAsync(data);
        texture.colorSpace = THREE.SRGBColorSpace;
        object = type === 'imageSprite'
          ? new THREE.Sprite(new THREE.SpriteMaterial({ map: texture }))
          : new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, transparent: true, depthWrite: false }));
        if (type === 'imagePlane') object.userData.preserveTextureAlpha = true;
      }
      addObject({
        id: crypto.randomUUID(), name: file.name, type, object,
        properties: {
          position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
          ...(type === 'audioSource'
            ? { sounds: [{ id: crypto.randomUUID(), name: file.name, url: data, volume: 1, loop: false, autoPlay: true }] }
            : { map: data })
        }
      });
      registerAsset(file, data);
      toast.success(`Added ${file.name}`);
    } catch (error) {
      console.error('Media import failed:', error);
      toast.error(`Could not import ${file.name}`);
    } finally {
      input.value = '';
    }
  };

  return (
    <div className="w-full bg-gray-800 p-4">
      <h2 className="text-white text-lg font-bold mb-4">Components</h2>

      <div className="mb-6">
        <label
          htmlFor="model-upload"
          className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 transition-colors cursor-pointer w-full justify-center mb-4"
        >
          <Upload className="w-4 h-4" />
          Load GLB Model
        </label>
        <input
          ref={fileInputRef}
          id="model-upload"
          type="file"
          accept=".glb"
          onChange={handleLoadModel}
          className="hidden"
        />
        {([
          ['imagePlane', 'Add image plane', 'image/*'],
          ['imageSprite', 'Add image sprite', 'image/*'],
          ['audioSource', 'Add audio source', 'audio/*']
        ] as const).map(([type, label, accept]) => (
          <label key={type} className="flex items-center justify-center px-4 py-2 mb-2 bg-blue-700 text-white rounded hover:bg-blue-600 cursor-pointer">
            {label}
            <input aria-label={label} type="file" accept={accept} className="hidden" onChange={(event) => void handleMedia(event, type)} />
          </label>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        {components.map((component) => (
          <ComponentButton
            key={component.id}
            name={component.name}
            icon={component.icon}
            onAdd={() => handleAddComponent(component.id, component.name)}
          />
        ))}
      </div>
      <WebElements />
    </div>
  );
};