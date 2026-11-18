// 完全本地的 WebSocket 帧健壮性测试：自造 TLS 上游 + 手拼 RFC 6455 帧，
// 不依赖真实游戏账号、外网或本机游戏协议包（代理使用 rawLogin 模式）。
// 覆盖：分片登录帧重组、16 MiB 超限消息拒绝且不写凭证、扩展位/非法 opcode 失败后可停止、
// 首凭证不被后续登录覆盖、未拦截端口 CONNECT 透明隧道。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { runOpenSsl } from './mitm-ca.mjs';
import { MAX_MESSAGE_BYTES } from './mitm-proxy.mjs';

const HOST = '127.0.0.1';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const TIMEOUT_MS = 15000;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mitm-frames-'));
const credentialsPath = path.join(tempDir, 'credentials.json');
const sockets = new Set();
const servers = [];
const proxies = [];
const logs = [];

function track(socket) {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
  socket.on('error', () => {});
  return socket;
}

// 手拼 RFC 6455 帧；默认带掩码（客户端到服务端方向必须掩码）。
function wsFrame(payload, { opcode = 2, fin = true, mask = true, rsv = 0 } = {}) {
  const length = payload.length;
  const maskBit = mask ? 0x80 : 0;
  let head;
  if (length < 126) {
    head = Buffer.from([(fin ? 0x80 : 0) | (rsv & 0x70) | (opcode & 0x0f), maskBit | length]);
  } else if (length < 65536) {
    head = Buffer.alloc(4);
    head[0] = (fin ? 0x80 : 0) | (rsv & 0x70) | (opcode & 0x0f);
    head[1] = maskBit | 126;
    head.writeUInt16BE(length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = (fin ? 0x80 : 0) | (rsv & 0x70) | (opcode & 0x0f);
    head[1] = maskBit | 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  if (!mask) return Buffer.concat([head, payload]);
  const key = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= key[i % 4];
  return Buffer.concat([head, key, masked]);
}

// 游戏协议信封（与 frame-header.mjs 的 inspectGameFrame 规则一致），不需要 protobuf 协议包。
function gameEnvelope(name, seq, payload = Buffer.alloc(64, 0x5a)) {
  const header = Buffer.alloc(11 + Buffer.byteLength(name));
  header.writeInt32BE(header.length + payload.length - 4, 0);
  header.writeUInt8(2, 4);
  header.writeInt32BE(seq, 5);
  header.writeUInt8(Buffer.byteLength(name), 9);
  header.write(name, 10, 'ascii');
  header.writeUInt8(0, 10 + name.length);
  return Buffer.concat([header, payload]);
}

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

async function listen(server) {
  servers.push(server);
  server.on('connection', track);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server.address().port;
}

// 透传/回显上游：升级后把收到的字节原样写回，方便核对代理没有篡改线路数据。
function createEchoUpstream(cert, keyPem) {
  const server = https.createServer({ cert, key: keyPem });
  server.on('upgrade', (req, socket, head) => {
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${wsAccept(req.headers['sec-websocket-key'])}`,
      '',
      '',
    ].join('\r\n'));
    if (head.length) socket.write(head);
    socket.on('data', (chunk) => socket.write(chunk));
  });
  return server;
}

async function startProxy(interceptPorts, onLogin) {
  const { createProxy } = await import('./mitm-proxy.mjs');
  const proxy = createProxy({
    port: 0,
    rawLogin: true,
    interceptHosts: [HOST],
    interceptPorts,
    upstreamCa: cert,
    certificateFor: () => ({ cert, keyPem }),
    caIsInstalled: () => true,
    log: (kind, message) => logs.push({ kind, message }),
    onLogin,
  });
  proxies.push(proxy);
  await proxy.listen();
  return proxy;
}

// 经 CONNECT + TLS + WebSocket 握手建立一条到自造上游的连接。
async function connectWebSocket(proxyPort, upstreamPort) {
  const raw = track(net.connect({ port: proxyPort, host: HOST }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket 握手超时')), TIMEOUT_MS);
    const fail = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    raw.once('error', fail);
    raw.once('data', (chunk) => {
      try {
        assert.match(chunk.toString(), /^HTTP\/1\.1 200 /);
      } catch (error) {
        fail(error);
        return;
      }
      const secure = track(tls.connect({
        socket: raw,
        servername: HOST,
        ca: cert,
        rejectUnauthorized: true,
      }));
      secure.on('error', fail);
      const key = crypto.randomBytes(16).toString('base64');
      secure.write([
        'GET /ws HTTP/1.1',
        `Host: ${HOST}:${upstreamPort}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'));
      const onData = (data) => {
        if (data.toString('latin1').includes('101 Switching Protocols')) {
          clearTimeout(timer);
          secure.off('data', onData);
          resolve(secure);
        }
      };
      secure.on('data', onData);
    });
    raw.write(`CONNECT ${HOST}:${upstreamPort} HTTP/1.1\r\nHost: ${HOST}:${upstreamPort}\r\n\r\n`);
  });
}

// 把一个大帧拆成多次写入，模拟真实 TCP 分片，控制内存占用。
async function writeLargeFrame(socket, length, { opcode = 2, fin = true } = {}) {
  const header = Buffer.alloc(10);
  header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  const mask = crypto.randomBytes(4);
  socket.write(Buffer.concat([header, mask]));
  const chunkSize = 1024 * 1024;
  let remaining = length;
  let offset = 0;
  while (remaining > 0) {
    const size = Math.min(chunkSize, remaining);
    const chunk = Buffer.alloc(size, 0x7b);
    for (let i = 0; i < size; i += 1) chunk[i] ^= mask[(offset + i) % 4];
    const ok = socket.write(chunk);
    if (!ok) await new Promise((resolve) => socket.once('drain', resolve));
    remaining -= size;
    offset += size;
  }
}

function waitFor(predicate, description) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${description} 等待超时`)), TIMEOUT_MS);
    const tick = () => {
      try {
        if (predicate()) {
          clearTimeout(timer);
          resolve();
        } else {
          setImmediate(tick);
        }
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    };
    tick();
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 生成本地自签名 TLS 证书（与 selftest-raw-capture 相同的离线方式）。
const keyPath = path.join(tempDir, 'test.key');
const certPath = path.join(tempDir, 'test.crt');
runOpenSsl([
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
  '-keyout', keyPath, '-out', certPath, '-subj', `/CN=${HOST}`,
  '-addext', 'subjectAltName=IP:127.0.0.1',
]);
const cert = fs.readFileSync(certPath);
const keyPem = fs.readFileSync(keyPath);

try {
  const upstream = createEchoUpstream(cert, keyPem);
  const upstreamPort = await listen(upstream);
  const echoPort = await listen(net.createServer((connection) => connection.pipe(connection)));

  // 先完成一次合法捕获并真实落盘 credentials.json，后续所有失败场景都必须保住这份凭证。
  const initialLogins = [];
  const initialProxy = await startProxy([upstreamPort], (record) => {
    initialLogins.push(record);
    fs.writeFileSync(credentialsPath, JSON.stringify({
      url: record.url,
      login: record.body,
      loginFrameHex: record.rawFrameHex,
      source: 'mitm',
      capturedAt: '2026-11-19T00:00:00.000Z',
    }, null, 2));
  });
  const initialSocket = await connectWebSocket(initialProxy.port, upstreamPort);
  const goodLogin = gameEnvelope('LoginRequest', 1);
  initialSocket.write(wsFrame(goodLogin, { opcode: 2 }));
  await waitFor(() => initialLogins.length === 1, '初始合法登录捕获');
  assert.equal(fs.existsSync(credentialsPath), true, '合法登录应写出 credentials.json');
  const initialCredential = fs.readFileSync(credentialsPath, 'utf8');
  assert.equal(JSON.parse(initialCredential).loginFrameHex, goodLogin.toString('hex'));
  initialSocket.destroy();
  await initialProxy.stop();
  proxies.splice(proxies.indexOf(initialProxy), 1);

  // ---------- 一、分片登录帧重组，loginFrameHex 与原始帧完全一致 ----------
  const fragmentLogins = [];
  const fragmentProxy = await startProxy([upstreamPort], (record) => fragmentLogins.push(record));
  const fragmentSocket = await connectWebSocket(fragmentProxy.port, upstreamPort);

  const loginFrame = gameEnvelope('LoginRequest', 7);
  const part1 = loginFrame.subarray(0, 20);
  const part2 = loginFrame.subarray(20, loginFrame.length - 7);
  const part3 = loginFrame.subarray(loginFrame.length - 7);
  // 首帧 FIN=0，中间穿插一个 Ping 控制帧，续帧再被拆成多个 TCP 包写入。
  fragmentSocket.write(wsFrame(part1, { opcode: 2, fin: false }));
  fragmentSocket.write(wsFrame(Buffer.from('ping-data'), { opcode: 9 }));
  fragmentSocket.write(wsFrame(part2, { opcode: 0, fin: false }));
  const tailFrame = wsFrame(part3, { opcode: 0, fin: true });
  fragmentSocket.write(tailFrame.subarray(0, 1));
  fragmentSocket.write(tailFrame.subarray(1, 5));
  fragmentSocket.write(tailFrame.subarray(5));

  await waitFor(() => fragmentLogins.length === 1, '分片登录帧重组');
  assert.equal(fragmentLogins[0].name, 'LoginRequest');
  assert.equal(fragmentLogins[0].url, `wss://${HOST}:${upstreamPort}/ws`);
  assert.equal(fragmentLogins[0].rawFrameHex, loginFrame.toString('hex'),
    '重组后的 loginFrameHex 必须与原始完整帧逐字节一致');
  assert.equal(fragmentLogins[0].body, null, 'rawLogin 模式不伪造解码 body');

  // 同一次运行内后续登录帧不得覆盖首个凭证。
  const secondLogin = gameEnvelope('LoginRequest', 8);
  fragmentSocket.write(wsFrame(secondLogin, { opcode: 2 }));
  await delay(200);
  assert.equal(fragmentLogins.length, 1, '同一代理运行只触发一次 onLogin');
  assert.equal(fragmentLogins[0].rawFrameHex, loginFrame.toString('hex'), '首个凭证不被后续登录覆盖');
  fragmentSocket.destroy();

  // ---------- 二、单帧超过 16 MiB：拒绝消息、记录日志、不写凭证、连接仍可继续 ----------
  const oversizeLogins = [];
  const oversizeProxy = await startProxy([upstreamPort], (record) => oversizeLogins.push(record));
  const oversizeSocket = await connectWebSocket(oversizeProxy.port, upstreamPort);

  const MAX = MAX_MESSAGE_BYTES;
  assert.equal(MAX, 16 * 1024 * 1024);
  const oversizedLength = MAX + 1;
  const beforeLogs = logs.length;
  await writeLargeFrame(oversizeSocket, oversizedLength, { opcode: 2, fin: true });
  await waitFor(() => logs.slice(beforeLogs).some((entry) => entry.kind === 'ws'
    && entry.message.includes('超过') && entry.message.includes(String(MAX))), '超限日志');
  const oversizeLog = logs.slice(beforeLogs).find((entry) => entry.message.includes('超过'));
  assert.match(oversizeLog.message, /放弃该消息/);
  assert.match(oversizeLog.message, /不写入任何凭证/);
  await delay(200);
  assert.equal(oversizeLogins.length, 0, '超限消息不得触发登录回调');
  assert.equal(fs.readFileSync(credentialsPath, 'utf8'), initialCredential, '超限消息不得改写已有 credentials.json');
  assert.equal(oversizeProxy.captured, false);

  // 超限帧排空后，同一连接上的合法登录帧仍能被捕获。
  const recoveredLogin = gameEnvelope('LoginRequest', 9);
  oversizeSocket.write(wsFrame(recoveredLogin, { opcode: 2 }));
  await waitFor(() => oversizeLogins.length === 1, '超限后同连接恢复解析');
  assert.equal(oversizeLogins[0].rawFrameHex, recoveredLogin.toString('hex'), '恢复后捕获的是新消息而非半截内容');
  assert.equal(fs.readFileSync(credentialsPath, 'utf8'), initialCredential,
    '恢复后的回调未配置写盘，已有凭证保持不变');
  oversizeSocket.destroy();

  // ---------- 二b、分片累计超过 16 MiB：累计超限同样放弃整条消息 ----------
  const fragmentOversizeLogins = [];
  const fragmentOversizeProxy = await startProxy([upstreamPort], (record) => fragmentOversizeLogins.push(record));
  const fragmentOversizeSocket = await connectWebSocket(fragmentOversizeProxy.port, upstreamPort);
  const fragmentBefore = logs.length;
  // 首帧本身不超限，但两个分片累计超过上限。
  fragmentOversizeSocket.write(wsFrame(Buffer.alloc(MAX - 100, 0x11), { opcode: 2, fin: false }));
  await writeLargeFrame(fragmentOversizeSocket, 200, { opcode: 0, fin: true });
  await waitFor(() => logs.slice(fragmentBefore).some((entry) => entry.message.includes('超过')), '分片累计超限日志');
  await delay(200);
  assert.equal(fragmentOversizeLogins.length, 0, '累计超限的分片消息不得触发登录回调');
  assert.equal(fs.readFileSync(credentialsPath, 'utf8'), initialCredential, '累计超限不得改写已有凭证');

  // 丢弃完成后来一条合法登录，证明读取器没有卡死、内存状态已复位。
  const afterDropLogin = gameEnvelope('LoginRequest', 10);
  fragmentOversizeSocket.write(wsFrame(afterDropLogin, { opcode: 2 }));
  await waitFor(() => fragmentOversizeLogins.length === 1, '累计超限丢弃后恢复解析');
  assert.equal(fragmentOversizeLogins[0].rawFrameHex, afterDropLogin.toString('hex'));
  fragmentOversizeSocket.destroy();

  // ---------- 三、扩展位与非法 opcode：判定失败、停止解析该连接、原因入日志 ----------
  const malformedLogins = [];
  const malformedProxy = await startProxy([upstreamPort], (record) => malformedLogins.push(record));
  const malformedSocket = await connectWebSocket(malformedProxy.port, upstreamPort);

  // 3a RSV1 置位（模拟 permessage-deflate 压缩帧）。
  const rsvBefore = logs.length;
  malformedSocket.write(wsFrame(gameEnvelope('LoginRequest', 11), { opcode: 2, rsv: 0x40 }));
  await waitFor(() => logs.slice(rsvBefore).some((entry) => entry.message.includes('扩展位')), 'RSV 扩展位日志');
  const rsvLog = logs.slice(rsvBefore).find((entry) => entry.message.includes('扩展位'));
  assert.match(rsvLog.message, /permessage-deflate/);
  assert.match(rsvLog.message, /停止解析该连接/);
  await delay(100);
  assert.equal(malformedLogins.length, 0, '带扩展位的帧不得被当作登录帧');

  // 失败后该连接上的后续帧一律被忽略。
  malformedSocket.write(wsFrame(gameEnvelope('LoginRequest', 12), { opcode: 2 }));
  await delay(200);
  assert.equal(malformedLogins.length, 0, '连接解析失败后不再处理任何帧');
  assert.equal(fs.readFileSync(credentialsPath, 'utf8'), initialCredential, '扩展位畸形帧不得影响已有凭证');
  malformedSocket.destroy();

  // 3b 非法 opcode 序列：没有进行中的分片消息却收到续帧。
  const badSequenceProxy = await startProxy([upstreamPort], (record) => malformedLogins.push(record));
  const badSequenceSocket = await connectWebSocket(badSequenceProxy.port, upstreamPort);
  const seqBefore = logs.length;
  badSequenceSocket.write(wsFrame(Buffer.from('orphan-continuation'), { opcode: 0, fin: true }));
  await waitFor(() => logs.slice(seqBefore).some((entry) => entry.message.includes('续帧')), '非法续帧日志');
  assert.match(logs.slice(seqBefore).find((entry) => entry.message.includes('续帧')).message, /停止解析该连接/);
  badSequenceSocket.write(wsFrame(gameEnvelope('LoginRequest', 13), { opcode: 2 }));
  await delay(200);
  assert.equal(malformedLogins.length, 0, '非法 opcode 序列后该连接不再产出凭证');
  badSequenceSocket.destroy();

  // 3c 保留 opcode（0x3）同样判失败。
  const reservedProxy = await startProxy([upstreamPort], (record) => malformedLogins.push(record));
  const reservedSocket = await connectWebSocket(reservedProxy.port, upstreamPort);
  const reservedBefore = logs.length;
  reservedSocket.write(wsFrame(Buffer.from('reserved'), { opcode: 0x3, fin: true }));
  await waitFor(() => logs.slice(reservedBefore).some((entry) => entry.message.includes('非法')), '保留 opcode 日志');
  reservedSocket.destroy();

  // ---------- 四、畸形帧之后代理仍能正常停止 ----------
  // 上面的 malformed/badSequence/reserved 三个代理都处理过畸形连接，统一 stop 必须干净完成。
  await Promise.all([
    fragmentProxy.stop(),
    oversizeProxy.stop(),
    fragmentOversizeProxy.stop(),
    malformedProxy.stop(),
    badSequenceProxy.stop(),
    reservedProxy.stop(),
  ]);
  for (const proxy of [fragmentProxy, oversizeProxy, fragmentOversizeProxy,
    malformedProxy, badSequenceProxy, reservedProxy]) {
    proxies.splice(proxies.indexOf(proxy), 1);
  }

  // ---------- 五、未拦截端口的 CONNECT 仍是透明隧道 ----------
  const tunnelProxy = await startProxy([upstreamPort], () => {});
  const tunnelRaw = track(net.connect({ port: tunnelProxy.port, host: HOST }));
  const tunneled = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('隧道超时')), TIMEOUT_MS);
    tunnelRaw.once('data', (chunk) => {
      assert.match(chunk.toString(), /^HTTP\/1\.1 200 /);
      const payload = Buffer.from('raw-bytes-not-tls\x00\xff', 'latin1');
      tunnelRaw.write(payload);
      tunnelRaw.once('data', (echoed) => {
        clearTimeout(timer);
        resolve(echoed);
      });
    });
    tunnelRaw.on('error', reject);
    tunnelRaw.write(`CONNECT ${HOST}:${echoPort} HTTP/1.1\r\nHost: ${HOST}:${echoPort}\r\n\r\n`);
  });
  assert.deepEqual(tunneled, Buffer.from('raw-bytes-not-tls\x00\xff', 'latin1'), '未拦截端口字节原样透传');
  tunnelRaw.destroy();
  await tunnelProxy.stop();
  proxies.splice(proxies.indexOf(tunnelProxy), 1);

  // 经历超限、扩展位、非法 opcode 等全部失败场景后，最初的有效凭证仍原封不动。
  assert.equal(fs.readFileSync(credentialsPath, 'utf8'), initialCredential,
    '畸形帧与超限消息均不得影响此前已保存的有效凭证');

  console.log('mitm frames selftest ok: 分片重组+hex一致, 首凭证不覆盖, 单帧/累计超限拒绝且不写凭证并可恢复, 扩展位/非法opcode失败且可停止, 透明隧道不受影响, 既有凭证不受影响');
} finally {
  for (const socket of sockets) socket.destroy();
  for (const proxy of proxies) await proxy.stop();
  for (const server of servers) {
    await new Promise((resolve) => server.close(resolve));
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
}
