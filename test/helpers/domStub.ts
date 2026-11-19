// Minimal browser globals needed to construct and drive AudioEngine in Node.
// Installed before the engine module is imported. No real audio hardware or
// speech service is required.

class FakeGainNode {
  gain = {
    value: 0,
    setValueAtTime: () => {},
    linearRampToValueAtTime: () => {},
    exponentialRampToValueAtTime: () => {},
    cancelScheduledValues: () => {},
  };
  connect() {}
  disconnect() {}
}

class FakeAudioParam {
  setValueAtTime() {}
  exponentialRampToValueAtTime() {}
  linearRampToValueAtTime() {}
}

class FakeScheduledNode {
  connect() {}
  start() {}
  stop() {}
  frequency = new FakeAudioParam();
  type = '';
}

class FakeFilterNode {
  connect() {}
  type = '';
  frequency = new FakeAudioParam();
  Q = { value: 0 };
}

export class FakeAudioContext {
  currentTime = 0;
  state = 'running';
  destination = {};
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  createGain() {
    return new FakeGainNode();
  }
  createOscillator() {
    return new FakeScheduledNode();
  }
  createBiquadFilter() {
    return new FakeFilterNode();
  }
  createBuffer(_channels: number, length: number) {
    return { getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    const node = new FakeScheduledNode() as unknown as {
      buffer: unknown;
      connect: () => void;
      start: () => void;
      stop: () => void;
    };
    node.buffer = null;
    return node;
  }
}

export interface FakeAudioElement {
  src: string;
  currentTime: number;
  duration: number;
  paused: boolean;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  playCalls: number;
  pauseCalls: number;
  play(): Promise<void>;
  pause(): void;
}

export function createFakeAudioElement(src: string): FakeAudioElement {
  return {
    src,
    currentTime: 0,
    duration: 10,
    paused: false,
    onended: null,
    onerror: null,
    playCalls: 0,
    pauseCalls: 0,
    play() {
      this.playCalls += 1;
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.pauseCalls += 1;
      this.paused = true;
    },
  };
}

export interface FakeUtterance {
  text: string;
  rate: number;
  pitch: number;
  voice: unknown;
  onboundary: ((e: { name: string; charIndex: number; charLength?: number }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

export interface FakeSpeechSynthesis {
  speakCalls: FakeUtterance[];
  cancelCalls: number;
  voices: Array<{ name: string; lang: string }>;
  speak(u: FakeUtterance): void;
  cancel(): void;
  getVoices(): Array<{ name: string; lang: string }>;
}

export function installDomGlobals(): {
  speech: FakeSpeechSynthesis;
  audioElements: FakeAudioElement[];
  intervals: Map<number, () => void>;
} {
  const speech: FakeSpeechSynthesis = {
    speakCalls: [],
    cancelCalls: 0,
    voices: [{ name: 'Google US English', lang: 'en-US' }],
    speak(u) {
      this.speakCalls.push(u);
    },
    cancel() {
      this.cancelCalls += 1;
    },
    getVoices() {
      return this.voices;
    },
  };

  const audioElements: FakeAudioElement[] = [];
  const intervals = new Map<number, () => void>();
  let intervalId = 1;

  const g = globalThis as unknown as Record<string, unknown>;
  g.window = {
    AudioContext: FakeAudioContext,
    webkitAudioContext: FakeAudioContext,
    speechSynthesis: speech,
    setInterval: (cb: () => void) => {
      const id = intervalId++;
      intervals.set(id, cb);
      return id;
    },
    clearInterval: (id: number) => {
      intervals.delete(id);
    },
  };
  g.AudioContext = FakeAudioContext;
  g.webkitAudioContext = FakeAudioContext;
  g.speechSynthesis = speech;
  g.SpeechSynthesisUtterance = class {
    text: string;
    rate = 1;
    pitch = 1;
    voice: unknown = null;
    onboundary: FakeUtterance['onboundary'] = null;
    onend: FakeUtterance['onend'] = null;
    onerror: FakeUtterance['onerror'] = null;
    constructor(text: string) {
      this.text = text;
    }
  };
  g.Audio = function (src: string) {
    const el = createFakeAudioElement(src);
    audioElements.push(el);
    return el;
  };
  g.setInterval = (cb: () => void) => {
    const id = intervalId++;
    intervals.set(id, cb);
    return id;
  };
  g.clearInterval = (id: number) => {
    intervals.delete(id);
  };

  return { speech, audioElements, intervals };
}
