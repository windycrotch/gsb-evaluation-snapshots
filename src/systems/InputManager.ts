export class InputManager {
  private keys: Set<string> = new Set();
  private mouseButtons: Set<number> = new Set();
  private mousePosition: { x: number; y: number } = { x: 0, y: 0 };
  private mouseDelta: { x: number; y: number } = { x: 0, y: 0 };
  private keydownHandler: (e: KeyboardEvent) => void;
  private keyupHandler: (e: KeyboardEvent) => void;
  private mousedownHandler: (e: MouseEvent) => void;
  private mouseupHandler: (e: MouseEvent) => void;
  private mousemoveHandler: (e: MouseEvent) => void;
  private blurHandler: () => void;

  constructor(private isEnabled: () => boolean = () => true) {
    this.keydownHandler = (e: KeyboardEvent) => {
      if (!this.isEnabled()) return;
      if (e.target instanceof Element && e.target.closest('.engine-web-root button, .engine-web-root input, .engine-web-root textarea, .engine-web-root select, .engine-web-root a')) return;
      if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(e.key.toLowerCase())) {
        e.preventDefault();
      }
      this.keys.add(e.key.toLowerCase());
    };
    this.keyupHandler = (e: KeyboardEvent) => {
      this.keys.delete(e.key.toLowerCase());
    };
    this.mousedownHandler = (e: MouseEvent) => {
      this.mouseButtons.add(e.button);
    };
    this.mouseupHandler = (e: MouseEvent) => {
      this.mouseButtons.delete(e.button);
    };
    this.mousemoveHandler = (e: MouseEvent) => {
      this.mouseDelta.x = e.movementX;
      this.mouseDelta.y = e.movementY;
      this.mousePosition.x = e.clientX;
      this.mousePosition.y = e.clientY;
    };
    this.blurHandler = () => this.reset();

    window.addEventListener('keydown', this.keydownHandler);
    window.addEventListener('keyup', this.keyupHandler);
    window.addEventListener('mousedown', this.mousedownHandler);
    window.addEventListener('mouseup', this.mouseupHandler);
    window.addEventListener('mousemove', this.mousemoveHandler);
    window.addEventListener('blur', this.blurHandler);
  }

  isKeyPressed(key: string): boolean {
    return this.keys.has(key.toLowerCase());
  }

  isMouseButtonPressed(button: number): boolean {
    return this.mouseButtons.has(button);
  }

  getMousePosition(): { x: number; y: number } {
    return { ...this.mousePosition };
  }

  getMouseDelta(): { x: number; y: number } {
    const delta = { ...this.mouseDelta };
    this.mouseDelta = { x: 0, y: 0 };
    return delta;
  }

  reset() {
    this.keys.clear();
    this.mouseButtons.clear();
    this.mouseDelta = { x: 0, y: 0 };
  }

  dispose() {
    window.removeEventListener('keydown', this.keydownHandler);
    window.removeEventListener('keyup', this.keyupHandler);
    window.removeEventListener('mousedown', this.mousedownHandler);
    window.removeEventListener('mouseup', this.mouseupHandler);
    window.removeEventListener('mousemove', this.mousemoveHandler);
    window.removeEventListener('blur', this.blurHandler);
    this.reset();
  }
}
