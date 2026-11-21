import React, { useEffect, useRef } from 'react';
import { useEditorStore } from '../store/editorStore';
import { Copy, Eye, EyeOff, Trash2, Move, RotateCw, Maximize } from 'lucide-react';
import * as THREE from 'three';
import { SceneObject } from '../types/editor';

interface ContextMenuProps {
  position: { x: number; y: number };
  object: THREE.Object3D;
  onClose: () => void;
}

export const ObjectContextMenu: React.FC<ContextMenuProps> = ({ position, object, onClose }) => {
  const { sceneObjects, updateObject, removeObject, setSelectedObject, addObject } = useEditorStore();
  const menuRef = useRef<HTMLDivElement>(null);

  const sceneObject = sceneObjects.find(
    (obj) => obj.object && (obj.object.uuid === object.uuid || obj.object === object)
  );

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  if (!sceneObject) {
    return null;
  }

  const objId = sceneObject.id;
  const obj3d = sceneObject.object!;

  const menuItems = [
    {
      label: 'Select',
      icon: <Move className="w-4 h-4" />,
      onClick: () => {
        setSelectedObject(sceneObject);
        onClose();
      }
    },
    {
      label: obj3d.visible ? 'Hide' : 'Show',
      icon: obj3d.visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />,
      onClick: () => {
        obj3d.visible = !obj3d.visible;
        updateObject(objId, { object: obj3d });
        onClose();
      }
    },
    {
      label: 'Reset Rotation',
      icon: <RotateCw className="w-4 h-4" />,
      onClick: () => {
        obj3d.rotation.set(0, 0, 0);
        updateObject(objId, { object: obj3d });
        onClose();
      }
    },
    {
      label: 'Reset Scale',
      icon: <Maximize className="w-4 h-4" />,
      onClick: () => {
        obj3d.scale.set(1, 1, 1);
        updateObject(objId, { object: obj3d });
        onClose();
      }
    },
    {
      label: 'Duplicate',
      icon: <Copy className="w-4 h-4" />,
      onClick: () => {
        const clone = obj3d.clone();
        clone.position.x += 1;
        const newObject: SceneObject = {
          id: Math.random().toString(36).substr(2, 9),
          name: `${sceneObject.name} Copy`,
          type: sceneObject.type,
          object: clone,
          properties: {
            ...sceneObject.properties,
            position: [clone.position.x, clone.position.y, clone.position.z],
            rotation: [...(sceneObject.properties.rotation || [0, 0, 0])],
            scale: [...(sceneObject.properties.scale || [1, 1, 1])],
            animations: [],
            sounds: []
          }
        };
        addObject(newObject);
        onClose();
      }
    },
    {
      label: 'Delete',
      icon: <Trash2 className="w-4 h-4" />,
      onClick: () => {
        removeObject(objId);
        onClose();
      },
      className: 'text-red-400 hover:bg-red-600 hover:text-white'
    }
  ];

  return (
    <div
      ref={menuRef}
      className="fixed bg-gray-800 rounded-lg shadow-2xl py-1 z-50 min-w-[180px] border border-gray-600"
      style={{ left: position.x, top: position.y }}
      onClick={(e) => e.stopPropagation()}
    >
      {menuItems.map((item, index) => (
        <button
          key={index}
          className={`w-full px-4 py-2 text-left flex items-center gap-2 hover:bg-gray-700 transition-colors ${
            item.className || 'text-gray-200'
          }`}
          onClick={item.onClick}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
};
