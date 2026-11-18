/**
 * 牛来格斗 - LAN 服务器
 * 职责：静态文件服务 + WebSocket 房间配对 + 消息中继
 * 启动：node server.js  （默认端口 3000，可用 PORT=xx 覆盖）
 *
 * 房间生命周期规则（客户端依赖这些保证两端一致）：
 * - 一个连接同一时刻最多属于一个房间；重复 join 只回发当前角色，不会新建/切换房间。
 * - 一方断开时，留下的一方会收到 peer-left，随后房间被删除，后续 join 可以重新配对。
 * - cmd 会广播给房间内双方（带 from），发起方也能收到回声，从而让两端执行同一动作。
 * - cmd=menu 表示双方都返回标题：广播后直接解散房间，避免留下“标题界面的幽灵房间”。
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

/** 静态文件服务（含仅本地验证用的 /__shot 截图回传） */
function createHttpHandler(root) {
  return (req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    let urlPath = decodeURIComponent(u.pathname);

    if (req.method === 'POST' && urlPath === '/__shot') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const dir = path.join(root, 'shots');
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
    const filePath = path.join(root, path.normalize(urlPath));
    if (!filePath.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  };
}

/**
 * 创建游戏服务器（不自动监听，便于测试）。
 * @param {{ root?: string, port?: number }} [options]
 */
export function createGameServer({ root = ROOT, port = PORT } = {}) {
  const server = http.createServer(createHttpHandler(root));
  const wss = new WebSocketServer({ server });
  /** room = { id, host: ws, guest: ws|null, matchId } */
  const rooms = new Map();
  let roomSeq = 0;

  const send = (ws, msg) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  };
  const broadcast = (room, msg) => { send(room.host, msg); send(room.guest, msg); };

  /** 找一个仍在等待对手、且不是自己的房间 */
  function findWaitingRoom(ws) {
    for (const [id, r] of rooms) {
      // 顺带清理双方都已断开的僵尸房间（close 事件尚未处理到的极端情况）
      if ((!r.host || r.host.readyState !== 1) && (!r.guest || r.guest.readyState !== 1)) {
        rooms.delete(id);
        continue;
      }
      if (r.guest) continue;
      if (r.host === ws) continue;
      if (!r.host || r.host.readyState !== 1) continue;
      return r;
    }
    return null;
  }

  /** join 幂等：已在本房间内就只回发角色，绝不产生第二个房间 */
  function handleJoin(ws) {
    const existing = ws.__room;
    if (existing && rooms.get(existing.id) === existing) {
      send(ws, { type: 'role', role: existing.host === ws ? 'host' : 'guest', room: existing.id });
      return;
    }
    ws.__room = null;

    const target = findWaitingRoom(ws);
    if (!target) {
      const id = `R${++roomSeq}`;
      const room = { id, host: ws, guest: null, matchId: 0 };
      rooms.set(id, room);
      ws.__room = room;
      send(ws, { type: 'role', role: 'host', room: id });
      return;
    }

    target.guest = ws;
    ws.__room = target;
    send(ws, { type: 'role', role: 'guest', room: target.id });
    send(target.host, { type: 'matched', room: target.id });
    send(ws, { type: 'matched', room: target.id });
  }

  /** 一方离开：明确通知留下的一方，并删除房间使后续 join 能重新配对 */
  function handleLeave(ws) {
    const room = ws.__room;
    if (!room) return;
    ws.__room = null;
    if (rooms.get(room.id) !== room) return;   // 房间已被 menu 等流程解散

    const peer = room.host === ws ? room.guest : room.host;
    if (peer) {
      if (peer.__room === room) peer.__room = null;
      send(peer, { type: 'peer-left', room: room.id });
    }
    rooms.delete(room.id);
  }

  function handleMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const room = ws.__room && rooms.get(ws.__room.id) === ws.__room ? ws.__room : null;

    switch (msg.type) {
      case 'join':
        handleJoin(ws);
        break;
      case 'pick':   // 光标移动 {char}
        if (room) broadcast(room, { type: 'pick', from: ws === room.host ? 'host' : 'guest', char: msg.char });
        break;
      case 'ready':  // 确认出场
        if (room) broadcast(room, { type: 'ready', from: ws === room.host ? 'host' : 'guest', char: msg.char });
        break;
      case 'input':  // 客户端 → 主机：输入状态
        if (room && ws === room.guest) send(room.host, { type: 'input', keys: msg.keys });
        break;
      case 'state':  // 主机 → 客户端：权威状态快照
        if (room && ws === room.host) send(room.guest, { type: 'state', ...msg.data });
        break;
      case 'cmd': {  // 双向命令（开始/重赛/返回菜单）—— 透传全部字段，并广播给双方
        if (!room) break;
        const peer = ws === room.host ? room.guest : room.host;
        if (!peer || peer.readyState !== 1) {
          // 对手连接已断但 close 事件尚未处理：明确告知本端，并清理房间，
          // 避免发起方一直停留在“等待对手”状态。
          handleLeave(ws);
          send(ws, { type: 'peer-left', room: room.id });
          break;
        }
        const from = ws === room.host ? 'host' : 'guest';
        const { type: _t, ...rest } = msg;
        const out = { type: 'cmd', ...rest, from };
        // start / rematch 由服务器分配递增的对局代号 mid：
        // 两端收到的回声携带同一 mid，客机据此丢弃重赛前残留的迟到快照。
        if (msg.cmd === 'start' || msg.cmd === 'rematch') {
          room.matchId = (room.matchId || 0) + 1;
          out.mid = room.matchId;
        }
        broadcast(room, out);
        // 返回菜单意味着双方都离开对局：解散房间，后续 join 可重新配对，
        // 且双方主动关闭连接时不会再收到多余的 peer-left 提示。
        if (msg.cmd === 'menu') {
          if (room.host && room.host.__room === room) room.host.__room = null;
          if (room.guest && room.guest.__room === room) room.guest.__room = null;
          rooms.delete(room.id);
        }
        break;
      }
      case 'ping': send(ws, { type: 'pong' }); break;
    }
  }

  wss.on('connection', (ws) => {
    ws.__room = null;
    ws.on('message', (raw) => handleMessage(ws, raw));
    ws.on('close', () => handleLeave(ws));
  });

  return {
    server,
    wss,
    rooms,
    get roomCount() { return rooms.size; },
    /** 开始监听；port=0 时返回系统分配的实际端口 */
    listen(p = port) {
      return new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          const addr = server.address();
          resolve(addr && typeof addr === 'object' ? addr.port : p);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(p);
      });
    },
    async close() {
      for (const client of wss.clients) {
        try { client.terminate(); } catch { /* ignore */ }
      }
      await new Promise((resolve) => wss.close(() => resolve()));
      if (server.listening) {
        await new Promise((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        });
      }
    },
  };
}

// ---------- 直接运行 server.js 时自动启动 ----------
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch {
    return false;
  }
})();

if (isMain) {
  const app = createGameServer();
  app.listen().then((actualPort) => {
    const nets = os.networkInterfaces();
    const ips = [];
    for (const list of Object.values(nets)) for (const ni of list) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
    console.log('==========================================');
    console.log('  牛来格斗 · 服务器已启动');
    console.log(`  本机游玩:   http://localhost:${actualPort}`);
    for (const ip of ips) console.log(`  局域网对战: http://${ip}:${actualPort}`);
    console.log('==========================================');
  }).catch((err) => {
    console.error('服务器启动失败：', err.message);
    process.exitCode = 1;
  });
}
