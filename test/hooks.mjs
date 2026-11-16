// Node module hooks: redirect three.js and DOM-related dependencies to local
// in-memory mocks so the verification sample runs without a browser or network.
// Registered via ./register-hooks.mjs.
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const mocksDir = fileURLToPath(new URL('./mocks', import.meta.url));

const mockMap = {
  'three': 'three.mjs',
  'three/webgpu': 'three-webgpu.mjs',
  'three/addons/controls/TrackballControls.js': 'controls-trackball.mjs',
  'three/addons/controls/ArcballControls.js': 'controls-arcball.mjs',
  'three/addons/controls/OrbitControls.js': 'controls-orbit.mjs',
  'three/addons/controls/FlyControls.js': 'controls-fly.mjs',
  'three/examples/jsm/postprocessing/EffectComposer.js': 'effect-composer.mjs',
  'three/examples/jsm/postprocessing/RenderPass.js': 'render-pass.mjs',
  'float-tooltip': 'float-tooltip.mjs'
};

export async function resolve(specifier, context, nextResolve) {
  if (mockMap[specifier]) {
    const mockPath = path.join(mocksDir, mockMap[specifier]);
    return { url: pathToFileURL(mockPath).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
