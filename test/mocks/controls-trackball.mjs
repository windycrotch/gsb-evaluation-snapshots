// Generic mock shared by the controls addons
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
    this.movementSpeed = 0;
    this.rollSpeed = 0;
    this.dragToLook = false;
  }
  update() {}
  dispose() {
    this.disposed = true;
  }
}

export class TrackballControls extends MockControls {}
