/**
 * 牛来格斗 - LAN 服务器
 * 职责：静态文件服务 + WebSocket 房间配对 + 消息中继
 * 启动：node server.js  （默认端口 3000，可用 PORT=xx 覆盖）
 *
 * 房间生命周期（断线与并发安全）：
 *  - 每个连接最多绑定一个房间；同一连接重复 join 幂等（返回既有角色，不新建房间）
 *  - 任一方断开/主动离开 → 房间立即删除，存活方收到 peer-left
 *  - 房间删除后到达的迟到消息一律拒绝（回复 error/room-closed），绝不再被当作有效对局转发
 *  - 已离开的连接发来的 input/state/cmd 等均无效
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.glb': 'model/gltf-binary',
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  let urlPath = decodeURIComponent(u.pathname);

  // 开发辅助：接收页面渲染帧截图（仅本地验证用）
  if (req.method === 'POST' && urlPath === '/__shot') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const dir = path.join(ROOT, 'shots');
      fs.mkdirSync(dir, { recursive: true });
      const name = (u.searchParams.get('name') || 'shot').replace(/[^\w.-]/g, '_') + '.png';
      const data = Buffer.concat(chunks).toString();
      const b64 = data.includes(',') ? data.split(',')[1] : data;
      fs.writeFile(path.join(dir, name), Buffer.from(b64, 'base64'), () => {
        res.writeHead(200); res.end('ok');
      });
    });
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, path.normalize(urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

// ---------- 房间配对与中继 ----------
const wss = new WebSocketServer({ server });
/** room = { id, host: ws, guest: ws|null, closed: boolean } */
const rooms = new Map();
let roomSeq = 0;

function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg) { send(room.host, msg); send(room.guest, msg); }

/** 把连接从其房间解绑；若它是房间成员则关闭整个房间并通知存活方。幂等。 */
function detachSocket(ws) {
  const room = ws.__room;
  if (!room || room.closed) { ws.__room = null; return; }
  room.closed = true;
  rooms.delete(room.id);
  const peer = ws === room.host ? room.guest : room.host;
  send(peer, { type: 'peer-left' });
  if (room.host) room.host.__room = null;
  if (room.guest) room.guest.__room = null;
}

wss.on('connection', (ws) => {
  ws.__room = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const room = ws.__room;

    switch (msg.type) {
      case 'join': {
        // 幂等：同一连接重复加入 → 直接返回既有角色，绝不创建第二个房间
        if (room && rooms.get(room.id) === room && !room.closed) {
          const role = ws === room.host ? 'host' : 'guest';
          send(ws, { type: 'role', role, room: room.id });
          if (room.guest) send(ws, { type: 'matched', room: room.id });
          break;
        }
        // 加入等待中的房间（房主必须是另一条连接），否则新建
        let target = null;
        for (const r of rooms.values()) {
          if (!r.closed && !r.guest && r.host && r.host !== ws) { target = r; break; }
        }
        if (!target) {
          const id = `R${++roomSeq}`;
          target = { id, host: ws, guest: null, closed: false };
          rooms.set(id, target);
          ws.__room = target;
          send(ws, { type: 'role', role: 'host', room: id });
        } else {
          target.guest = ws;
          ws.__room = target;
          send(ws, { type: 'role', role: 'guest', room: target.id });
          send(target.host, { type: 'matched', room: target.id });
          send(ws, { type: 'matched', room: target.id });
        }
        break;
      }
      case 'leave':
        detachSocket(ws);
        break;
      case 'pick':   // 光标移动 {char}
        if (room && rooms.get(room.id) === room && !room.closed) {
          broadcast(room, { type: 'pick', from: ws === room.host ? 'host' : 'guest', char: msg.char });
        } else send(ws, { type: 'error', reason: 'room-closed' });
        break;
      case 'ready':  // 确认出场
        if (room && rooms.get(room.id) === room && !room.closed) {
          broadcast(room, { type: 'ready', from: ws === room.host ? 'host' : 'guest', char: msg.char });
        } else send(ws, { type: 'error', reason: 'room-closed' });
        break;
      case 'input':  // 客户端 → 主机：输入状态（仅客机有效，且对手仍在）
        if (room && rooms.get(room.id) === room && !room.closed && ws === room.guest && room.host) {
          send(room.host, { type: 'input', keys: msg.keys });
        } else if (ws.__room === null) {
          send(ws, { type: 'error', reason: 'room-closed' });
        }
        break;
      case 'state': {  // 主机 → 客户端：权威状态快照（仅主机有效，且客机仍在）
        if (room && rooms.get(room.id) === room && !room.closed && ws === room.host && room.guest) {
          // 客户端实际发送的是扁平结构 {type:'state', ...快照}；兼容旧版 {type:'state', data:{...}}
          const snap = msg.data ?? (() => { const { type: _t, ...rest } = msg; return rest; })();
          send(room.guest, { type: 'state', ...snap });
        } else if (ws.__room === null) {
          send(ws, { type: 'error', reason: 'room-closed' });
        }
        break;
      }
      case 'cmd':    // 双向命令（开始/重赛/回菜单等）—— 透传全部字段
        if (room && rooms.get(room.id) === room && !room.closed) {
          const to = ws === room.host ? room.guest : room.host;
          if (to) {
            const { type: _t, ...rest } = msg;
            send(to, { type: 'cmd', ...rest });
          }
        } else send(ws, { type: 'error', reason: 'room-closed' });
        break;
      case 'ping': send(ws, { type: 'pong' }); break;
    }
  });

  ws.on('close', () => detachSocket(ws));
  ws.on('error', () => detachSocket(ws));
});

server.listen(PORT, () => {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const list of Object.values(nets)) for (const ni of list) {
    if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
  }
  console.log('==========================================');
  console.log('  牛来格斗 · 服务器已启动');
  console.log(`  本机游玩:   http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  局域网对战: http://${ip}:${PORT}`);
  console.log('==========================================');
});
