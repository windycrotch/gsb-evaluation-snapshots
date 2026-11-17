import React, { useCallback, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { Asset, AssetType } from '../types/editor';
import { Upload, Trash2, Image as ImageIcon, Music, Box, Plus, Video, Pencil } from 'lucide-react';
import { loadGLBModel, createSceneObjectFromModel } from '../services/modelLoader';
import { readFileDataUrl } from '../services/media';
import { assetTypeForFile, registerAsset } from '../services/assetLibrary';
import { toast } from 'react-hot-toast';
import * as THREE from 'three';
import { isValidWebParent, isWebContainer, newWebElement } from '../types/web';

const AssetItem: React.FC<{ asset: Asset }> = ({ asset }) => {
  const { removeAsset } = useEditorStore();
  const [loading, setLoading] = useState(false);

  const handleAddToScene = async (webImage = false) => {
    setLoading(true);
    try {
      const before = useEditorStore.getState();
      if (asset.type === '3d') {
        const model = await loadGLBModel(asset.url);
        const current = useEditorStore.getState();
        if (current.sceneObjects !== before.sceneObjects || current.sceneOptions !== before.sceneOptions) throw new Error('The scene changed while loading the model; try again.');
        const object = createSceneObjectFromModel(model, asset.name, asset.url);
        current.addObject(object);
        current.setSelectedObject(object);
      } else if (asset.type === '2d' && !webImage) {
        const texture = await new THREE.TextureLoader().loadAsync(asset.url);
        const current = useEditorStore.getState();
        if (current.sceneObjects !== before.sceneObjects || current.sceneOptions !== before.sceneOptions) {
          texture.dispose();
          throw new Error('The scene changed while loading the image; try again.');
        }
        texture.colorSpace = THREE.SRGBColorSpace;
        const object = {
          id: crypto.randomUUID(), name: asset.name, type: 'imagePlane',
          object: new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, transparent: true, depthWrite: false })),
          properties: { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number], map: asset.url }
        };
        object.object.userData.preserveTextureAlpha = true;
        current.addObject(object);
        current.setSelectedObject(object);
      } else {
        const kind = asset.type === '2d' ? 'image' : asset.type === 'audio' ? 'audio' : 'video';
        const selected = before.selectedObject?.properties.web;
        const parentId = selected && isWebContainer(selected.kind) ? before.selectedObject!.id : selected?.parentId ?? null;
        const parentKind = before.sceneObjects.find(object => object.id === parentId)?.properties.web?.kind;
        if (!isValidWebParent(kind, parentKind)) throw new Error('Select a slide to add media inside a slider.');
        const web = newWebElement(kind, parentId);
        if (kind === 'image') web.image = asset.url;
        else if (kind === 'audio') web.audio = asset.url;
        else web.video = asset.url;
        web.text = asset.name;
        const object = {
          id: crypto.randomUUID(), name: asset.name, type: 'web', object: new THREE.Object3D(),
          properties: { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number], web }
        };
        before.addObject(object);
        before.setSelectedObject(object);
      }
      toast.success(`Added ${asset.name}`);
    } catch (error) {
      console.error('Failed to add asset:', error);
      toast.error(error instanceof Error ? error.message : `Failed to add ${asset.name}`);
    } finally {
      setLoading(false);
    }
  };

  const getIcon = (type: AssetType) => {
    switch (type) {
      case '2d':
        return <ImageIcon className="w-6 h-6" />;
      case 'audio':
        return <Music className="w-6 h-6" />;
      case '3d':
        return <Box className="w-6 h-6" />;
      case 'video':
        return <Video className="w-6 h-6" />;
      default:
        return null;
    }
  };

  return (
    <div className="flex items-center justify-between p-2 bg-gray-700 rounded-lg hover:bg-gray-600 transition-colors group">
      <div className="flex items-center gap-2">
        {getIcon(asset.type)}
        <span className="text-white text-sm">{asset.name}</span>
      </div>
      <div className="flex items-center gap-2">
          <button
            onClick={() => void handleAddToScene()}
            disabled={loading}
            aria-label={`Add ${asset.name} to scene`}
            className="text-blue-400 hover:text-blue-300 transition-colors"
          >
            <Plus className="w-4 h-4" />
          </button>
        {asset.type === '2d' && <button onClick={() => void handleAddToScene(true)} disabled={loading}
          aria-label={`Add ${asset.name} to web`} className="text-xs text-blue-300 hover:text-blue-200">Web</button>}
        <button
          onClick={() => removeAsset(asset.id)}
          aria-label={`Remove ${asset.name}`}
          className="text-gray-400 hover:text-red-500 transition-colors"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

export const AssetPanel: React.FC = () => {
  const { assets, scenes, activeSceneId, sceneOptions, createScene, switchScene, renameScene, deleteScene } = useEditorStore();
  const [switchingScene, setSwitchingScene] = useState(false);

  const runSceneAction = async (action: () => void | Promise<void>) => {
    if (switchingScene) return;
    setSwitchingScene(true);
    try {
      await action();
    } catch (error) {
      console.error('Scene operation failed:', error);
      toast.error(error instanceof Error ? error.message : 'Scene operation failed');
    } finally {
      setSwitchingScene(false);
    }
  };

  const handleFileUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const files = input.files;
    if (!files) return;

    for (const file of Array.from(files)) {
      const type = assetTypeForFile(file);

      if (!type) {
        toast.error(`Unsupported file: ${file.name}`);
        continue;
      }

      try {
        registerAsset(file, await readFileDataUrl(file));
      } catch (error) {
        console.error('Failed to import asset:', error);
        toast.error(`Failed to import ${file.name}`);
      }
    }
    input.value = '';
  }, []);

  return (
    <div className="w-full bg-gray-800 p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-white text-lg font-bold">Assets</h2>
        <label className="cursor-pointer bg-blue-600 hover:bg-blue-700 text-white p-2 rounded-lg transition-colors">
          <Upload className="w-5 h-5" />
          <input
            type="file"
            className="hidden"
            aria-label="Upload assets"
            multiple
            accept="image/*,audio/*,video/mp4,video/webm,.glb"
            onChange={handleFileUpload}
          />
        </label>
      </div>

      <div className="flex flex-col gap-2 overflow-y-auto max-h-[300px]">
        {assets.map((asset) => (
          <AssetItem key={asset.id} asset={asset} />
        ))}
        {assets.length === 0 && (
          <p className="text-gray-400 text-sm text-center py-4">
            No assets uploaded yet
          </p>
        )}
      </div>
      <div className="border-t border-gray-600 pt-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold text-white">Scenes / Pages</h3>
          <button type="button" disabled={switchingScene} onClick={() => void runSceneAction(createScene)}
            className="rounded bg-blue-700 px-2 py-1 text-xs text-white" aria-label="Create scene">+ Scene</button>
        </div>
        <div className="space-y-1">
          {scenes.map(scene => {
            const name = scene.id === activeSceneId ? sceneOptions.name : scene.sceneOptions.name;
            return <div key={scene.id} className="flex items-center gap-1 rounded bg-gray-700 p-1">
              <button type="button" disabled={switchingScene} aria-label={`Open scene ${name}`}
                aria-current={scene.id === activeSceneId ? 'page' : undefined}
                onClick={() => void runSceneAction(() => switchScene(scene.id))}
                className={`min-w-0 flex-1 truncate px-1 text-left text-sm ${scene.id === activeSceneId ? 'text-sky-300' : 'text-white'}`}>
                {name}
              </button>
              <button type="button" disabled={switchingScene} aria-label={`Rename scene ${name}`} className="p-1 text-gray-300"
                onClick={() => {
                  const next = window.prompt('Scene name', name);
                  if (next !== null) void runSceneAction(() => renameScene(scene.id, next));
                }}><Pencil size={14} /></button>
              <button type="button" disabled={switchingScene || scenes.length === 1} aria-label={`Delete scene ${name}`} className="p-1 text-gray-300 disabled:opacity-40"
                onClick={() => {
                  if (window.confirm(`Delete scene "${name}"?`)) void runSceneAction(() => deleteScene(scene.id));
                }}><Trash2 size={14} /></button>
            </div>;
          })}
        </div>
      </div>
    </div>
  );
};