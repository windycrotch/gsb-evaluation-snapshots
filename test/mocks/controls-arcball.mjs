import { EventDispatcher } from './three.mjs';

class MockControls extends EventDispatcher {
  constructor(camera, domElement) {
    super();
    this.camera = camera;
    this.domElement = domElement;
    this.enabled = true;
    this.target = { x: 0, y: 0, z: 0 };
    this.minDistance = 0;
    this.maxDistance = Infinity;
  }
  update() {}
  dispose() {
    this.disposed = true;
  }
}

export class ArcballControls extends MockControls {}
