import type JSZip from 'jszip';
import type { StoredScene } from './sceneStorage';

const extensions: Record<string, string> = {
  'model/gltf-binary': 'glb', 'image/png': 'png', 'image/jpeg': 'jpg',
  'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/bmp': 'bmp', 'image/x-icon': 'ico',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/mp4': 'm4a',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv'
};

export async function packageExportAssets(snapshot: StoredScene, zip: JSZip): Promise<StoredScene> {
  const result = structuredClone(snapshot);
  const paths = new Map<string, string>();
  const names = new Set<string>();

  async function pack(value: string, hint: string, fallbackExtension: string): Promise<string> {
    if (!value || !value.startsWith('data:')) return value;
    const existing = paths.get(value);
    if (existing) return existing;

    let response: Response;
    try {
      response = await fetch(value);
    } catch (error) {
      throw new Error(`Could not decode export asset "${hint}": ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(`Could not decode export asset "${hint}" (HTTP ${response.status}).`);
    const data = await response.arrayBuffer();
    const mime = response.headers.get('content-type')?.split(';')[0].toLowerCase() ?? '';
    let name = hint.replace(/[^\w.-]+/g, '-').replace(/^\.+/, '').replace(/-+$/g, '') || 'asset';
    if (!/\.[a-z0-9]{1,10}$/i.test(name)) name += `.${extensions[mime] ?? fallbackExtension}`;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const suffix = dot > 0 ? name.slice(dot) : '';
    let unique = name;
    for (let index = 2; names.has(unique.toLowerCase()); index++) unique = `${stem}-${index}${suffix}`;
    names.add(unique.toLowerCase());
    const path = `web3dassets/${unique}`;
    zip.file(path, data);
    paths.set(value, path);
    return path;
  }

  for (const asset of result.assets ?? []) {
    asset.url = await pack(asset.url, asset.name, asset.type === '3d' ? 'glb' : 'bin');
    if (asset.thumbnail) asset.thumbnail = await pack(asset.thumbnail, `${asset.name}-thumbnail`, 'png');
  }

  for (const scene of [result, ...(result.otherScenes ?? [])]) {
    if (scene.sceneOptions.environment?.data) {
      scene.sceneOptions.environment.data = await pack(scene.sceneOptions.environment.data,
        scene.sceneOptions.environment.name ?? 'environment.hdr', 'hdr');
    }
    for (const object of scene.objects) {
      const props = object.properties;
      if (props.modelData) props.modelData = await pack(props.modelData, `${object.name}-model`, 'glb');
      for (const key of ['texture', 'map', 'normalMap', 'roughnessMap', 'metalnessMap'] as const) {
        if (props[key]) props[key] = await pack(props[key], `${object.name}-${key}`, 'bin');
      }
      for (const sound of props.sounds ?? []) sound.url = await pack(sound.url, sound.name, 'bin');
      const web = props.web;
      if (web) {
        for (const key of ['image', 'backgroundImage', 'backgroundVideo', 'video', 'audio'] as const) {
          const value = web[key];
          if (value) web[key] = await pack(value, `${object.name}-${key}`, 'bin');
        }
      }
    }
  }
  return result;
}
