import { useEditorStore } from '../store/editorStore';
import type { AssetType } from '../types/editor';

export function assetTypeForFile(file: File): AssetType | null {
  if (file.name.toLowerCase().endsWith('.glb')) return '3d';
  if (file.type.startsWith('image/')) return '2d';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('video/')) return 'video';
  return null;
}

export function registerAsset(file: File, url: string): void {
  const type = assetTypeForFile(file);
  if (!type) throw new Error(`Unsupported asset: ${file.name}`);
  const state = useEditorStore.getState();
  if (state.assets.some(asset => asset.name === file.name && asset.type === type && asset.url === url)) return;
  state.addAsset({
    id: crypto.randomUUID(), name: file.name, type, url,
    metadata: { size: file.size, format: file.type }
  });
}
