import test from 'node:test';
import assert from 'node:assert/strict';
import { AVEngine } from '../av-engine.js';
import { idleState } from '../shared.js';

test('stopping A/V during acquisition releases a late stream without starting an encoder', async () => {
  const originalChannel = globalThis.BroadcastChannel, originalRecorder = globalThis.MediaRecorder;
  globalThis.BroadcastChannel = class {
    postMessage(message) { if (message.type === 'STOP') queueMicrotask(() => this.onmessage({ data: { type: 'RELEASED' } })); }
    close() {}
  };
  globalThis.MediaRecorder = class { static isTypeSupported() { return true; } constructor() { throw new Error('Must not encode canceled acquisition'); } };
  try {
    let resolveStream, stopped = 0;
    const engine = new AVEngine({ mediaDevices: { getUserMedia: () => new Promise(resolve => { resolveStream = resolve; }) } });
    const pending = engine.start({ streamId: 'fresh', tabId: 8, tabTitle: 'test', sessionId: 'one', delay: 30, viewerTabId: 9, region: 'tab' });
    await engine.stop();
    resolveStream({ getTracks: () => [{ stop() { stopped++; } }] });
    await pending;
    assert.equal(stopped, 1);
    assert.equal(engine.snapshot().active, false);
    assert.equal(engine.session, null);
  } finally { globalThis.BroadcastChannel = originalChannel; globalThis.MediaRecorder = originalRecorder; }
});

test('Stop waits for cleanup already started by an error or viewer closure', async () => {
  const oldChannel = globalThis.BroadcastChannel, oldRecorder = globalThis.MediaRecorder;
  let channel;
  globalThis.BroadcastChannel = class { constructor() { channel = this; } postMessage() {} close() {} };
  globalThis.MediaRecorder = class { static isTypeSupported() { return true; } };
  try {
    const engine = new AVEngine({ mediaDevices: { getUserMedia: async () => { throw new DOMException('denied', 'NotAllowedError'); } } });
    const starting = engine.start({ streamId: 'fresh', sessionId: 'one', delay: 30, region: 'tab' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(engine.session, null);
    let finished = false;
    const stopping = engine.stop().then(() => { finished = true; });
    await Promise.resolve();
    assert.equal(finished, false);
    channel.onmessage({ data: { type: 'RELEASED' } });
    await starting; await stopping;
    assert.equal(finished, true);
    assert.equal(engine.snapshot().phase, 'idle');
  } finally { globalThis.BroadcastChannel = oldChannel; globalThis.MediaRecorder = oldRecorder; }
});

test('crop geometry updates only its session; losing the player releases capture instead of showing the page', async () => {
  let received, stopped = 0, closed = 0;
  const engine = new AVEngine({ mediaDevices: {} });
  const session = { listeners: [], stream: { getTracks: () => [{ stop() { stopped++; } }] },
    cropper: { setGeometry(value) { received = value; }, async close() { closed++; } },
    channel: { postMessage() { queueMicrotask(() => session.released?.()); }, close() {} } };
  engine.session = session;
  engine.state = { ...idleState(), active: true, mode: 'av', sessionId: 'current' };
  const geometry = { rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, sourceWidth: 1920, sourceHeight: 1080 };
  await engine.setRegion({ sessionId: 'old', geometry });
  assert.equal(received, undefined);
  await engine.setRegion({ sessionId: 'current', geometry });
  assert.equal(received, geometry); assert.equal(engine.state.sourceWidth, 1920);
  await engine.setRegion({ sessionId: 'current', error: '播放器未完整显示' });
  assert.equal(engine.state.phase, 'interrupted'); assert.equal(engine.state.active, false);
  assert.equal(stopped, 1); assert.equal(closed, 1);
});
