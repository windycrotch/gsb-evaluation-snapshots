// Real envelope/codec/client behavior with declared protobuf fixtures and fake
// sockets. No game connection, account files or installed protocol required.
import assert from 'node:assert/strict';
import { GameClient } from '../src/client.mjs';
import { createCodec } from '../src/codec.mjs';

const textMessage = {
  encode(body, writer) { return writer.uint32(10).string(body.value ?? ''); },
  decode(reader) { reader.uint32(); return { value: reader.string() }; },
};
const harvestRequest = {
  encode(body, writer) {
    for (const id of body.buildingId ?? []) writer.uint32(10).string(id);
    return writer;
  },
  decode(reader) {
    const buildingId = [];
    while (reader.pos < reader.len) { reader.uint32(); buildingId.push(reader.string()); }
    return { buildingId };
  },
};
const protocol = Object.fromEntries(['LoginRequest', 'LoginResponse', 'FarmHarvestResponse',
  'ReadRequest', 'ReadResponse', 'NoReplyRequest', 'PingRequest', 'PingResponse', 'Ack', 'Nack']
  .map(name => [name, textMessage]));
protocol.FarmHarvestRequest = harvestRequest;
const codec = createCodec(protocol);
const serverCodec = createCodec({ ...protocol, SCFutureHarvestUpdate: textMessage });
let passed = 0;
const test = async (name, run) => { await run(); passed++; console.log('通过：' + name); };

function fixture() {
  const client = new GameClient({ protocol, url: 'ws://invalid.invalid' });
  const sent = [], diagnostics = [], closes = [];
  client.socket = { readyState: 1, send(frame) { sent.push(frame); }, close(...args) { closes.push(args); } };
  client.on('diagnostic', event => diagnostics.push(event));
  return { client, sent, diagnostics, closes };
}

await test('未知推送在清空收获请求前留下原始帧与上下文，断线行为不变', async () => {
  const f = fixture();
  let stateAtDiagnostic;
  f.client.on('diagnostic', () => { stateAtDiagnostic = { connected: f.client.connected, pending: f.client.pending.length }; });
  const harvest = f.client.request('FarmHarvestRequest', { buildingId: ['1农田'] }, 'FarmHarvestResponse');
  const failed = assert.rejects(harvest, /Unknown message type: SCFutureHarvestUpdate/);
  const watcher = f.client.sendWatch('NoReplyRequest', { value: 'private-request-body' });
  const watcherFailed = assert.rejects(watcher, /Unknown message type: SCFutureHarvestUpdate/);
  const frame = serverCodec.encode('SCFutureHarvestUpdate', 81, { value: 'wheat-reward-payload' });
  // A view into a larger Buffer must retain only the actual frame bytes.
  const padded = Buffer.concat([Buffer.alloc(7, 123), frame, Buffer.alloc(9, 124)]);
  const input = padded.subarray(7, 7 + frame.length);
  f.client.onMessage(input);
  await Promise.all([failed, watcherFailed]);
  assert.deepEqual(codec.decode(f.sent[0]).body, { buildingId: ['1农田'] });
  assert.deepEqual(stateAtDiagnostic, { connected: true, pending: 1 });
  assert.equal(f.diagnostics.length, 1);
  const event = f.diagnostics[0];
  assert.equal(event.event, 'protocol-decode-error');
  assert.equal(event.phase, 'message');
  assert.equal(event.frameBytes, frame.byteLength);
  assert.deepEqual(event.frame, Uint8Array.from(frame));
  assert.deepEqual(event.pending, [{ name: 'FarmHarvestRequest', responseName: 'FarmHarvestResponse' }]);
  assert.deepEqual(event.watchers, [{ name: 'NoReplyRequest' }]);
  assert.equal(event.header.name, 'SCFutureHarvestUpdate');
  assert.equal(event.header.seq, 81);
  assert.deepEqual(event.recentFrames.map(({ direction, name }) => [direction, name]), [
    ['out', 'FarmHarvestRequest'], ['out', 'NoReplyRequest'], ['in', 'SCFutureHarvestUpdate'],
  ]);
  assert.doesNotMatch(JSON.stringify(event.recentFrames), /private-request-body|wheat-reward-payload/);
  input.fill(0);
  assert.equal(serverCodec.decode(event.frame).body.value, 'wheat-reward-payload', 'capture must own its bytes');
  assert.equal(f.client.connected, false);
  assert.equal(f.client.closeReason, 'protocol');
  assert.equal(f.client.pending.length, 0);
  assert.equal(f.client.watchers.length, 0);
  assert.equal(f.closes.length, 1);
});

await test('畸形帧仍能报告错误，诊断观察器抛错不会妨碍请求退出', async () => {
  const f = fixture();
  f.client.on('diagnostic', () => { throw new Error('broken diagnostic observer'); });
  const pending = assert.rejects(f.client.request('FarmHarvestRequest', { buildingId: ['2农田'] }), /服务器消息解码失败/);
  assert.doesNotThrow(() => f.client.onMessage(Uint8Array.of(1).buffer));
  await pending;
  assert.equal(f.diagnostics[0].header, null);
  assert.deepEqual(f.diagnostics[0].frame, Uint8Array.of(1));
  assert.equal(f.client.connected, false);
  assert.equal(f.client.pending.length, 0);
});

await test('正常回包不报告异常，近期帧有界且过滤心跳', async () => {
  const f = fixture();
  for (let i = 0; i < 26; i++) {
    f.client.send('ReadRequest', { value: 'private-body-' + i });
    f.client.onMessage(codec.encode('ReadResponse', 0, { value: 'response-' + i }));
  }
  f.client.sendNoSeq('PingRequest', {});
  f.client.sendNoSeq('Ack', {});
  f.client.sendNoSeq('Nack', {});
  f.client.onMessage(codec.encode('PingResponse', 0, {}));
  assert.equal(f.client.recentFrames.length, 20);
  assert(f.client.recentFrames.every(row => ['ReadRequest', 'ReadResponse'].includes(row.name)));
  assert.doesNotMatch(JSON.stringify(f.client.recentFrames), /private-body|response-/);
  const harvest = f.client.request('FarmHarvestRequest', { buildingId: ['3农田'] });
  f.client.onMessage(codec.encode('FarmHarvestResponse', 0, { value: 'harvest-ok' }));
  assert.deepEqual(await harvest, { value: 'harvest-ok' });
  assert.equal(f.diagnostics.length, 0);
  assert.equal(f.client.connected, true);
  f.client.stop();
});

await test('登录解码失败只记录安全头部，不复制登录原始报文或凭据', async () => {
  const original = globalThis.WebSocket;
  let socket;
  globalThis.WebSocket = class {
    constructor() { socket = this; this.readyState = 0; }
    send() {}
    close() { this.readyState = 3; }
  };
  const client = new GameClient({ protocol, url: 'ws://invalid.invalid' });
  const diagnostics = [];
  client.on('diagnostic', event => diagnostics.push(event));
  try {
    const login = client.connect({ value: 'private-login-token' });
    const failed = assert.rejects(login, /Unknown message type: SCFutureHarvestUpdate/);
    socket.readyState = 1;
    socket.onopen();
    const frame = serverCodec.encode('SCFutureHarvestUpdate', 1, { value: 'private-server-login-payload' });
    socket.onmessage({ data: frame });
    await failed;
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].phase, 'login');
    assert.equal(diagnostics[0].frameBytes, frame.byteLength);
    assert.equal('frame' in diagnostics[0], false);
    assert.equal(diagnostics[0].header.name, 'SCFutureHarvestUpdate');
    assert.equal(diagnostics[0].recentFrames[0].name, 'LoginRequest');
    assert.doesNotMatch(JSON.stringify(diagnostics), /private-login-token|private-server-login-payload/);
    assert.equal(client.closeReason, 'protocol');
    assert.equal(client.connected, false);
  } finally { client.stop(); globalThis.WebSocket = original; }
});

console.log(`protocol diagnostics selftest ${passed}/${passed} passed`);
