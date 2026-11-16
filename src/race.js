// 竞速模式：幽灵对手 + 名次 + 终点。
// 设计要点：所有对手（AI 或真人）都只是"一个会走路的坐标"，
// 渲染与排名走同一套接口，所以后面接联机时只需要换掉谁在驱动 z/x/y。
import * as THREE from 'three';
import { mulberry32, clamp, damp } from './utils.js';

export const RACE_LEN = 2200;

const AI_NAMES = ['霓虹', '赤风', '夜航'];
const AI_COLORS = [0x6fd6ff, 0xffb066, 0xb98cff];

// 每个幽灵（AI/真人）的稳定内部标识：网络 id 可能为 null（本地 AI），
// 名次表反查目标时不能靠 id/name 猜，统一用 uid 精确对应
let ghostSeq = 0;

function nameTag(text, color) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d');
  g.font = '600 38px system-ui, "PingFang SC", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(4,8,14,0.9)';
  g.strokeText(text, 128, 33);
  g.fillStyle = '#' + color.toString(16).padStart(6, '0');
  g.fillText(text, 128, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(2.4, 0.6, 1);
  return sp;
}

export class Race {
  constructor(stage, city) {
    this.stage = stage;
    this.city = city;
    this.len = RACE_LEN;
    this.opponents = [];
    this.place = 1;
    this.time = 0;
    this.done = false;
    this._root = new THREE.Group();
    stage.scene.add(this._root);
    this._geo = new THREE.CapsuleGeometry(0.3, 0.92, 4, 10);
    this._ringGeo = new THREE.RingGeometry(0.46, 0.62, 26);
  }

  reset(seed, opts = {}) {
    this.len = opts.len || RACE_LEN;
    this.time = 0;
    this.place = 1;
    this.done = false;
    for (const o of this.opponents) o.root.visible = false;
    this.opponents.length = 0;
    const n = opts.ai === undefined ? 2 : opts.ai;
    for (let i = 0; i < n; i++) this._addAI(i, seed);
  }

  _addAI(i, seed) {
    const color = AI_COLORS[i % AI_COLORS.length];
    const o = this._makeGhost(AI_NAMES[i % AI_NAMES.length], color);
    o.ai = true;
    o.z = -5 - i * 5; // 起跑线后错开排队
    o.x = (i - 0.5) * 3;
    o.y = 10;
    const rng = mulberry32((seed | 0) + i * 7919 + 13);
    o.pace = 0.955 + rng() * 0.065; // 相对玩家速度的系数：有强有弱
    o.wob = rng() * 6.283;
    o.t = rng() * 3;
    this.opponents.push(o);
  }

  // 联机对手：位置由网络驱动（ai=false），断线后由 net 调用 takeover() 转 AI 托管
  addHuman(id, name, color, z = -4) {
    const o = this._makeGhost(name, color);
    o.id = id;
    o.ai = false;
    o.remote = true;
    o.z = z;
    o.netZ = z;
    o.netX = 0;
    o.netY = 10;
    o.pace = 1;
    o.wob = Math.random() * 6.283;
    o.t = Math.random() * 3;
    this.opponents.push(o);
    return o;
  }

  // 网络位置：只记录目标值，渲染时做阻尼插值（否则每 100ms 一跳很抖）
  setRemote(p) {
    const id = p.id || p.from; // state 包的发送者就是对手 id
    const o = this.opponents.find((x) => x.id === id);
    if (!o) return;
    o.lastSeen = Date.now();
    // 已完赛的对手一切冻结：迟到的网络包不能再改动它的位置或状态
    if (o.finished) return;
    // 记录掉线前的真实推进速度（取净位移/时间，平滑掉插值抖动）
    if (o.obsZ !== null) {
      const dtObs = this.time - o.obsT;
      if (dtObs > 0) {
        const v = (p.z - o.obsZ) / dtObs;
        // 只接受合理的正向速度，丢弃传送/重连造成的异常跳变
        if (Number.isFinite(v) && v >= 0 && v <= 40) o.obsSpeed = o.obsSpeed === null ? v : o.obsSpeed * 0.7 + v * 0.3;
      }
    }
    o.obsZ = p.z;
    o.obsT = this.time;
    o.netZ = p.z;
    o.netX = p.x === undefined ? o.netX : p.x;
    o.netY = p.y === undefined ? o.netY : p.y;
    o.slowT = p.slow || 0;
    o.lockT = p.lock || 0;
    if (o.z < p.z - 40) o.z = p.z - 40; // 掉线很久后回归时别瞬移太远
  }

  // 心跳：证明这个对手还活着（应用层判定，不依赖 TCP 断开）
  touch(id) {
    const o = this.opponents.find((x) => x.id === id);
    if (o) o.lastSeen = Date.now();
  }

  // 断线 → 就地转 AI 托管，沿用掉线前一刻的推进节奏继续跑，
  // 别让比赛变成一个人的独角戏，也不能把对手节奏重置成固定系数
  takeover(id) {
    const o = this.opponents.find((x) => x.id === id);
    if (!o) return null;
    // 已完赛的对手无需托管，名次与终点状态保持冻结
    if (o.finished) return o;
    if (o.obsSpeed !== null) {
      // AI 推进速度 = 当前赛道基础速度 × pace，反推出与掉线前节奏一致的 pace
      const base = Math.min(34, 12 + o.z * 0.018);
      o.pace = clamp(o.obsSpeed / Math.max(1, base), 0.85, 1.15);
    }
    // 没有有效采样（开局即掉线等）时保留 addHuman 时的 pace=1，同样不写死成 0.9~1.02
    o.ai = true;
    o.remote = false;
    return o;
  }

  removeHuman(id) {
    const i = this.opponents.findIndex((x) => x.id === id);
    if (i < 0) return;
    const o = this.opponents[i];
    o.root.visible = false;
    this.opponents.splice(i, 1);
  }

  // 技能命中：AI 直接生效；真人对手由上层通过 net 通知对方本地结算。
  // 返回 true 表示技能生效；对手已完赛时返回 false，上层不得消耗技能槽
  applySkill(o, kind) {
    if (!o) return false;
    if (o.finished) return false; // 已冲线：状态冻结，逆风/断电/锁跳一律无效
    if (kind === 'headwind') o.slowT = 4;
    else if (kind === 'blackout') {
      o.slowT = 2;
      o.darkT = 5;
    } else if (kind === 'lockjump') o.lockT = 4;
    else return false;
    return true;
  }

  _makeGhost(name, color) {
    const root = new THREE.Group();
    const body = new THREE.Mesh(
      this._geo,
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.9,
        roughness: 0.45,
        metalness: 0.25,
        transparent: true,
        opacity: 0.92,
      })
    );
    body.position.y = 0.86;
    body.castShadow = false;
    root.add(body);
    const ring = new THREE.Mesh(
      this._ringGeo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    root.add(ring);
    const tag = nameTag(name, color);
    tag.position.y = 2.15;
    root.add(tag);
    this._root.add(root);
    return {
      uid: ++ghostSeq,
      ai: true,
      remote: false,
      id: null,
      name,
      color,
      root,
      body,
      ring,
      z: -5,
      x: 0,
      y: 10,
      netZ: -5,
      netX: 0,
      netY: 10,
      pace: 1,
      wob: 0,
      t: 0,
      finished: false,
      finishT: 0,
      // 掉线托管前的节奏采样：对真人对手实测其推进速度（米/秒），
      // 托管时换算成 pace，沿用掉线前一刻的节奏而不是重置成固定系数
      obsZ: null,
      obsT: 0,
      obsSpeed: null,
      slowT: 0,
      lockT: 0,
      darkT: 0,
      lastSeen: Date.now(),
    };
  }

  // 生成要跑到所有对手前面，否则领先的幽灵会掉进"还没生成的地图"
  maxZ() {
    let m = 0;
    for (const o of this.opponents) if (o.z > m) m = o.z;
    return m;
  }

  update(dt, playerZ) {
    this.time += dt;
    for (const o of this.opponents) {
      o.t += dt;
      // 已完赛：位置、用时、技能状态全部冻结，之后任何推进/技能都不再影响它
      if (o.finished) {
        o.root.position.set(o.x, o.y, o.z);
        continue;
      }
      if (o.slowT > 0) o.slowT -= dt;
      if (o.lockT > 0) o.lockT -= dt;
      if (o.darkT > 0) o.darkT -= dt;
      if (o.ai) {
        // AI（含断线托管）：沿关卡曲线加速 + 一点正弦起伏，技能会改变它的速度
        const base = Math.min(34, 12 + o.z * 0.018) * o.pace;
        let mul = 1;
        if (o.slowT > 0) mul *= 0.72;
        if (o.lockT > 0) mul *= 0.86;
        o.z += base * mul * (1 + Math.sin(o.t * 1.7) * 0.035) * dt;
        const seg = this.city.platformAt(o.x, o.z);
        if (seg) {
          o.y = seg.y;
          const target = seg.cx + Math.sin(o.z * 0.11 + o.wob) * (seg.w * 0.18);
          o.x = damp(o.x, clamp(target, seg.cx - seg.w / 2 + 0.7, seg.cx + seg.w / 2 - 0.7), 4, dt);
        }
      } else {
        // 真人：位置来自网络，做阻尼插值（每秒 10 帧的状态直贴会抖）
        o.z = damp(o.z, o.netZ, 12, dt);
        o.x = damp(o.x, o.netX, 9, dt);
        o.y = damp(o.y, o.netY, 9, dt);
      }
      // 中招视觉：被减速 / 断电时压暗
      if (o.body) o.body.material.emissiveIntensity = o.darkT > 0 ? 0.3 : o.slowT > 0 ? 0.55 : 0.9;
      o.root.position.set(o.x, o.y, o.z);
      // 冲过终点线：当场固定完赛时刻与位置，之后不再参与推进
      if (o.z >= this.len) {
        o.z = this.len;
        o.finished = true;
        o.finishT = this.time;
        o.root.position.set(o.x, o.y, o.z);
      }
    }
    // 名次：已完赛者永远排在玩家前面；未完赛者按赛道进度比较。
    // 玩家自己冲线时，已完赛对手数 + 1 即玩家名次（finishRace 在同帧读取）
    let ahead = 0;
    for (const o of this.opponents) {
      if (o.finished) ahead++;
      else if (playerZ < this.len && o.z > playerZ) ahead++;
    }
    this.place = ahead + 1;
  }

  // 名次表：完赛者按完赛时刻排前（gap 显示"完赛"），未完赛者按赛道进度降序，
  // 相差的米数直接给玩家看
  rows(playerZ) {
    const meDone = playerZ >= this.len;
    const list = [
      // 玩家完赛时没有单独的冲线时刻，名次应排在所有已记录完赛时刻的对手之后，
      // 故用 Infinity 参与"先冲线者靠前"的排序（与 race.place 口径一致）
      { uid: 0, name: '你', z: Math.min(playerZ, this.len), me: true, color: '#6fd6ff', done: meDone, id: null, finishT: meDone ? Infinity : -1 },
      ...this.opponents.map((o) => ({
        uid: o.uid,
        name: o.name,
        id: o.id,
        z: Math.min(o.z, this.len),
        me: false,
        color: '#' + o.color.toString(16).padStart(6, '0'),
        done: o.finished,
        finishT: o.finished ? o.finishT : Infinity,
      })),
    ];
    list.sort((a, b) => {
      if (a.done !== b.done) return a.done ? -1 : 1; // 完赛者恒在前
      if (a.done) return a.finishT - b.finishT; // 都完赛：先冲线者靠前
      return b.z - a.z; // 都未完赛：进度高者靠前
    });
    return list.map((r, i) => ({
      place: i + 1,
      uid: r.uid,
      name: r.name,
      id: r.id,
      me: r.me,
      done: r.done,
      color: r.color,
      gap: r.done ? '完赛' : r.me ? '—' : `${r.z > playerZ ? '+' : ''}${Math.round(r.z - playerZ)}m`,
    }));
  }

  setVisible(on) {
    this._root.visible = on;
  }
}
