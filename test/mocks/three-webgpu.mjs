// Mock of three/webgpu
export class WebGPURenderer {
  constructor(config) {
    this.config = config;
    this.domElement = document.createElement('canvas');
  }
  setPixelRatio() {}
  setSize() {}
  setClearColor() {}
  render() {}
  dispose() {}
}
