/**
 * Browser API mocks for running AudioX in a node test environment.
 * Imported as a vitest setup file: installs globals before any src module
 * is evaluated. Test files import the exported classes to inspect counters
 * or swap in faulty implementations.
 */

export class MockAudioParam {
  value: number;
  constructor(value = 0) {
    this.value = value;
  }
  setTargetAtTime(value: number) {
    this.value = value;
    return this;
  }
}

export class MockAudioNode {
  connections: unknown[] = [];
  connectCount = 0;
  disconnectCount = 0;
  connect(node: unknown) {
    this.connectCount += 1;
    this.connections.push(node);
    return node;
  }
  disconnect() {
    this.disconnectCount += 1;
    this.connections = [];
  }
}

export class MockBiquadFilter extends MockAudioNode {
  type = '';
  frequency = new MockAudioParam();
  gain = new MockAudioParam();
  Q = new MockAudioParam();
}

export class MockDynamicsCompressor extends MockAudioNode {
  threshold = new MockAudioParam();
  knee = new MockAudioParam();
  ratio = new MockAudioParam();
  attack = new MockAudioParam();
  release = new MockAudioParam();
}

export class MockAudioContext {
  static instances = 0;
  static mediaElementSources = 0;

  state: 'running' | 'suspended' | 'closed' = 'running';
  currentTime = 0;
  destination = new MockAudioNode();

  constructor() {
    MockAudioContext.instances += 1;
  }

  static resetCounters() {
    MockAudioContext.instances = 0;
    MockAudioContext.mediaElementSources = 0;
  }

  resume() {
    this.state = 'running';
    return Promise.resolve();
  }

  createMediaElementSource() {
    MockAudioContext.mediaElementSources += 1;
    return new MockAudioNode();
  }

  createBiquadFilter() {
    return new MockBiquadFilter();
  }

  createDynamicsCompressor() {
    return new MockDynamicsCompressor();
  }
}

type ElementListener = (e: unknown) => void;

export class MockAudioElement {
  static instances: MockAudioElement[] = [];

  src = '';
  srcObject: unknown = null;
  paused = true;
  currentTime = 0;
  volume = 1;
  playbackRate = 1;
  muted = false;
  loop = false;
  preload = '';
  autoplay = false;
  crossOrigin: string | null = null;
  duration = 0;
  error = null;
  HAVE_ENOUGH_DATA = 4;
  playCount = 0;

  played = { length: 0, start: () => 0, end: () => 0 };
  buffered = { length: 0, start: () => 0, end: () => 0 };

  private _attrs: Record<string, string> = {};
  private _listeners: Record<string, ElementListener[]> = {};

  constructor() {
    MockAudioElement.instances.push(this);
  }

  setAttribute(name: string, value: string) {
    this._attrs[name] = value;
  }
  getAttribute(name: string) {
    return name in this._attrs ? this._attrs[name] : null;
  }
  removeAttribute(name: string) {
    delete this._attrs[name];
  }

  addEventListener(type: string, cb: ElementListener) {
    if (!this._listeners[type]) {
      this._listeners[type] = [];
    }
    this._listeners[type].push(cb);
  }
  removeEventListener(type: string, cb: ElementListener) {
    this._listeners[type] = (this._listeners[type] ?? []).filter((l) => l !== cb);
  }
  listenerCount(type: string) {
    return (this._listeners[type] ?? []).length;
  }
  totalListenerCount() {
    return Object.values(this._listeners).reduce((acc, list) => acc + list.length, 0);
  }

  play() {
    this.playCount += 1;
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {}
  canPlayType() {
    return '';
  }
}

export const installGlobalMocks = () => {
  (globalThis as any).Audio = MockAudioElement;
  (globalThis as any).AudioContext = MockAudioContext;
};

installGlobalMocks();

// keep test output readable: the library logs verbosely on every notify
console.log = () => {};
console.warn = () => {};
console.info = () => {};
