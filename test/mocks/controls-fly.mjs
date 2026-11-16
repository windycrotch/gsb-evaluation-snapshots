import { EventDispatcher } from './three.mjs';

class MockControls extends EventDispatcher {
  constructor(camera, domElement) {
    super();
    this.camera = camera;
    this.domElement = domElement;
    this.enabled = true;
    this.movementSpeed = 0;
    this.rollSpeed = 0;
    this.dragToLook = false;
  }
  update() {}
  dispose() {
    this.disposed = true;
  }
}

export class FlyControls extends MockControls {}
