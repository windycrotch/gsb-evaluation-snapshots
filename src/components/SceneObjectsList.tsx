import React, { useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { Camera, Sun, Box, Trash2, Eye, EyeOff, Layers } from 'lucide-react';
import * as THREE from 'three';
import { TimelineEditor } from './TimelineEditor';

export const SceneObjectsList: React.FC = () => {
  const { sceneObjects, removeObject, setSelectedObject, updateObjectProperties } = useEditorStore();
  const [tab, setTab] = useState<'scene' | 'timeline'>('scene');

  const getIcon = (object: THREE.Object3D | undefined) => {
    if (!object) return <Layers className="w-4 h-4" />;

    if (object instanceof THREE.Camera) return <Camera className="w-4 h-4" />;
    if (object instanceof THREE.Light) return <Sun className="w-4 h-4" />;
    if (object instanceof THREE.Mesh) return <Box className="w-4 h-4" />;

    return <Layers className="w-4 h-4" />;
  };

  const handleToggleVisibility = (id: string, object: THREE.Object3D) => {
    updateObjectProperties(id, { visible: !object.visible });
  };

  return (
    <div className="absolute bottom-0 left-0 right-0 z-30 bg-gray-800/95 backdrop-blur-sm p-3 border-t border-gray-700">
      <div className="mb-2 flex gap-3 text-xs font-semibold uppercase tracking-wide">
        <button aria-pressed={tab === 'scene'} onClick={() => setTab('scene')} className={tab === 'scene' ? 'text-sky-300' : 'text-gray-400'}>In Scene</button>
        <button aria-pressed={tab === 'timeline'} onClick={() => setTab('timeline')} className={tab === 'timeline' ? 'text-sky-300' : 'text-gray-400'}>Timeline</button>
      </div>
      {tab === 'timeline' ? <TimelineEditor /> : (
      <div className="editor-scrollbar flex gap-2 overflow-x-auto pb-2">
        {sceneObjects.length === 0 && (
          <div className="text-gray-500 text-sm py-2 px-3">No objects in scene yet. Add one from the sidebar.</div>
        )}
        {sceneObjects.map((obj) => (
          <div
            key={obj.id}
            className="flex items-center gap-2 bg-gray-700 p-2 rounded-lg min-w-[200px] hover:bg-gray-600 transition-colors group"
          >
            <div className="text-gray-300">{getIcon(obj.object)}</div>
            <div className="flex-1 min-w-0">
              <div className="text-white text-sm truncate">{obj.name}</div>
              <div className="text-gray-400 text-xs capitalize">{obj.type}</div>
            </div>
            <div className="flex gap-1 shrink-0">
              <button
                onClick={() => setSelectedObject(obj)}
                className="p-1 text-gray-400 hover:text-white transition-colors"
                title="Select"
              >
                {obj.object?.visible ? (
                  <Eye className="w-4 h-4" />
                ) : (
                  <EyeOff className="w-4 h-4" />
                )}
              </button>
              <button
                onClick={() => obj.object && handleToggleVisibility(obj.id, obj.object)}
                className="p-1 text-gray-400 hover:text-blue-400 transition-colors"
                title={obj.object?.visible ? 'Hide' : 'Show'}
              >
                {obj.object?.visible ? (
                  <Eye className="w-4 h-4" />
                ) : (
                  <EyeOff className="w-4 h-4" />
                )}
              </button>
              <button
                onClick={() => removeObject(obj.id)}
                className="p-1 text-gray-400 hover:text-red-500 transition-colors"
                title="Delete"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
      )}
    </div>
  );
};
