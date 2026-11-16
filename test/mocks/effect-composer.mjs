// Mock of three/examples/jsm/postprocessing/EffectComposer.js
export class EffectComposer {
  constructor(renderer) {
    this.renderer = renderer;
    this.passes = [];
  }
  addPass(pass) {
    this.passes.push(pass);
  }
  setSize() {}
  render() {}
  dispose() {
    this.disposed = true;
  }
}
