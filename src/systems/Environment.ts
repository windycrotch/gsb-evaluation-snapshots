import type * as Three from 'three';
import type { SceneOptions } from '../store/editorStore';

export async function createEnvironmentTexture(
  config: NonNullable<SceneOptions['environment']>,
  three: typeof Three,
  loadHdr: (url: string) => Promise<Three.Texture>
) {
  let texture: Three.Texture;
  if (config.source === 'hdr') {
    if (!config.data) throw new Error('Choose an HDR environment file');
    texture = await loadHdr(config.data);
  } else {
    const presets = {
      studio: ['#c5d0df', '#f4f4f4', '#52575f'],
      sunset: ['#d47d52', '#fac891', '#373b60'],
      night: ['#1a2e57', '#416497', '#060b18']
    };
    const colors = presets[config.source];
    if (!colors) throw new Error('Unknown environment preset');
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create environment texture');
    const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, colors[0]);
    gradient.addColorStop(0.5, colors[1]);
    gradient.addColorStop(1, colors[2]);
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const light = context.createRadialGradient(690, 185, 0, 690, 185, 120);
    light.addColorStop(0, 'rgba(255,255,255,0.9)');
    light.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = light;
    context.fillRect(0, 0, canvas.width, canvas.height);
    texture = new three.CanvasTexture(canvas);
    if ('colorSpace' in texture) texture.colorSpace = three.SRGBColorSpace;
    else Object.assign(texture, { encoding: Reflect.get(three, 'sRGBEncoding') });
  }
  texture.mapping = three.EquirectangularReflectionMapping;
  texture.needsUpdate = true;
  return texture;
}
