/* ============ watch: 一起看（MQTT 聊天 + 在线人数 + 进度同步） ============ */

var WT_URL = 'wss://broker.emqx.io:8084/mqtt';
var WT_TOPIC_PREFIX = 'tvbox-center/v1/chat/';
var WT_UID_KEY = 'tvbox_wt_uid';
var WT_NICK_KEY = 'tvbox_wt_nick';
var WT_CHAT_PREFIX = 'tvbox-center:chat:';
var WT_MSG_MAX = 200;
var WT_TEXT_MAX = 500;
var WT_ONLINE_TTL = 5 * 60 * 1000;

var WT = {
  client: null, room: '', hash: '', msgs: [], users: {}, uid: '', nick: '',
  unread: 0, open: false, topic: '', lastSync: null, pruneTimer: 0
};

function wtHash(str) {
  var h1 = 0x811c9dc5, h2 = 0x01000193;
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 16777619) >>> 0;
    h2 ^= c + 0x9e3779b9; h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
}

function wtIdentity() {
  var uid = localStorage.getItem(WT_UID_KEY);
  if (!uid) { uid = Math.random().toString(36).slice(2, 10); localStorage.setItem(WT_UID_KEY, uid); }
  var nick = localStorage.getItem(WT_NICK_KEY) || ('观众' + uid.slice(0, 4));
  WT.uid = uid; WT.nick = nick;
  return { uid: uid, nick: nick };
}

function wtRoomOf(item) {
  if (!item) return '';
  return wtHash((item._sourceKey || '') + ':' + (item.vod_id || ''));
}

function wtLoadChat(hash) {
  try {
    var o = JSON.parse(localStorage.getItem(WT_CHAT_PREFIX + hash) || '{"messages":[]}');
    return Array.isArray(o.messages) ? o.messages.slice(-WT_MSG_MAX) : [];
  } catch (e) { return []; }
}

function wtSaveChat(hash, msgs) {
  try {
    localStorage.setItem(WT_CHAT_PREFIX + hash, JSON.stringify({ messages: msgs.slice(-WT_MSG_MAX) }));
  } catch (e) {}
}

function wtConnect() {
  if (WT.client) return WT.client;
  var mqtt = G.TVBoxCenter && G.TVBoxCenter.mqtt;
  if (!mqtt) { toast('MQTT 未加载'); return null; }
  var id = wtIdentity();
  if (typeof WebSocket === 'undefined') { toast('当前环境不支持 WebSocket'); return null; }
  WT.client = mqtt.connect(WT_URL, {
    clientId: 'tvc_' + id.uid + '_' + Math.random().toString(16).slice(2, 6),
    clean: true, reconnectPeriod: 4000, connectTimeout: 10000, keepalive: 30
  });
  WT.client.on('connect', function () {
    /* 首次连接与断线重连都会走到这里：重新订阅并补发 hello，
       但绝不清空已加载的聊天记录与在线名单。 */
    if (WT.topic) WT.client.subscribe(WT.topic);
    wtPublish({ type: 'hello' });
  });
  WT.client.on('message', function (topic, payload) {
    var m;
    try { m = JSON.parse(payload.toString()); } catch (e) { return; }
    wtRecv(m);
  });
  WT.client.on('error', function () {});
  return WT.client;
}

function wtPublish(msg) {
  if (!WT.client || !WT.topic) return;
  msg.uid = WT.uid; msg.nick = WT.nick; msg.ts = msg.ts || Date.now();
  if (!msg.msgId) msg.msgId = WT.uid + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  /* 自己发言也算活跃，刷新自己的在线时间 */
  WT.users[WT.uid] = { nick: WT.nick, at: Date.now() };
  WT.client.publish(WT.topic, JSON.stringify(msg), { qos: 0 });
}

function wtRecv(m) {
  if (!m || !m.type) return;
  if (m.uid === WT.uid && m.type !== 'hello') return;

  if (m.type === 'hello' || m.type === 'chat' || m.type === 'sync') {
    WT.users[m.uid] = { nick: m.nick || '观众', at: Date.now() };
    wtPruneUsers();
  }
  if (m.type === 'bye') { delete WT.users[m.uid]; }

  if (m.type === 'chat') {
    if (WT.msgs.some(function (x) { return x.msgId === m.msgId; })) return;
    WT.msgs.push(m);
    if (WT.msgs.length > WT_MSG_MAX) WT.msgs = WT.msgs.slice(-WT_MSG_MAX);
    wtSaveChat(WT.hash, WT.msgs);
    if (!WT.open) WT.unread++;
    renderWatch();
    return;
  }
  if (m.type === 'sync') {
    WT.lastSync = m;
    if (WT.open) renderWatch();
    else toast((m.nick || '有人') + ' 已同步到 ' + (m.ep + 1) + ' 集 ' + fmtTime(m.time || 0));
  }
  if (WT.open) renderWatch();
}

function wtPruneUsers() {
  var now = Date.now();
  Object.keys(WT.users).forEach(function (k) {
    if (k === WT.uid) return; /* 自己始终计入在线名单 */
    if (now - WT.users[k].at > WT_ONLINE_TTL) delete WT.users[k];
  });
}

function wtEnter(item) {
  var hash = wtRoomOf(item);
  if (!hash) { toast('先打开一个作品'); return; }
  wtIdentity();

  /* 已经在这个房间：只是重新展开侧栏，不清状态、不重复进房 */
  if (WT.hash === hash && WT.topic) {
    WT.open = true;
    WT.unread = 0;
    renderWatch();
    return;
  }

  WT.hash = hash;
  WT.topic = WT_TOPIC_PREFIX + hash;
  WT.msgs = wtLoadChat(hash);
  WT.users = {};
  WT.users[WT.uid] = { nick: WT.nick, at: Date.now() };
  WT.unread = 0;
  WT.open = true;
  WT.lastSync = null;

  var c = wtConnect();
  if (c && c.connected) {
    /* 已连接（换房间）：直接订阅并发 hello；
       未连接（首次）：由 connect 回调统一订阅 + hello，避免重复 */
    c.subscribe(WT.topic);
    wtPublish({ type: 'hello' });
  }

  if (!WT.pruneTimer) {
    WT.pruneTimer = setInterval(function () {
      wtPruneUsers();
      if (WT.open) renderWatch();
    }, 30000);
  }
  renderWatch();
}

/* 关闭侧栏：只收起界面，MQTT 连接与订阅保持，未读角标继续累加 */
function wtClose() {
  WT.open = false;
  renderWatch();
}

/* 主动退出房间：这才断开订阅与连接 */
function wtLeave() {
  wtPublish({ type: 'bye' });
  if (WT.client && WT.topic) WT.client.unsubscribe(WT.topic);
  if (WT.client) { try { WT.client.end(true); } catch (e) {} WT.client = null; }
  if (WT.pruneTimer) { clearInterval(WT.pruneTimer); WT.pruneTimer = 0; }
  WT.open = false;
  WT.topic = '';
  WT.hash = '';
  WT.msgs = [];
  WT.users = {};
  WT.lastSync = null;
  var p = S.root && S.root.querySelector('#wtPanel');
  if (p) p.classList.remove('open');
}

function wtSend(text) {
  text = (text || '').trim();
  if (!text) return;
  if (!WT.topic) { toast('先打开一个作品'); return; }
  if (text.length > WT_TEXT_MAX) { toast('消息最多 ' + WT_TEXT_MAX + ' 字，请缩短后再发'); return; }
  var m = { type: 'chat', text: text };
  wtPublish(m); /* wtPublish 会补上 uid/nick/ts/msgId，本地回显复用同一 msgId 以便去重 */
  WT.msgs.push(m);
  if (WT.msgs.length > WT_MSG_MAX) WT.msgs = WT.msgs.slice(-WT_MSG_MAX);
  wtSaveChat(WT.hash, WT.msgs);
  renderWatch();
}

function wtSync() {
  var P = S.player;
  if (!P.item) return;
  var v = S.root.querySelector('#video');
  wtPublish({ type: 'sync', from: P.from, ep: P.ep, time: v ? v.currentTime : 0 });
  toast('已同步当前进度');
}

function wtFollow() {
  var m = WT.lastSync;
  if (!m || !S.player.item) return;
  var lineOk = !!(m.from && S.player.groups[m.from]);
  if (lineOk) {
    S.player.from = m.from;
    renderLines();
  }
  var eps = S.player.groups[S.player.from] || [];
  var ep = m.ep || 0;
  if (ep < 0 || ep >= eps.length) ep = 0;
  S.player.ep = ep;
  playEpisode(true, m.time || 0);
  if (lineOk) toast('已跟随 ' + (m.nick || '对方'));
  else toast('对方线路在当前作品中不存在，已按当前线路跟随到第 ' + (ep + 1) + ' 集');
}

function renderWatch() {
  if (!S.root) return;
  /* 未读角标在播放器顶栏，侧栏收起时也要持续更新 */
  var badge = S.root.querySelector('#wtBadge');
  if (badge) badge.textContent = WT.unread > 0 ? String(WT.unread) : '';

  var box = S.root.querySelector('#wtPanel');
  if (!box) return;
  box.classList.toggle('open', WT.open);
  if (!WT.open) return;

  wtPruneUsers();
  S.root.querySelector('#wtRoom').textContent = WT.hash.slice(0, 8);
  var n = Object.keys(WT.users).length;
  S.root.querySelector('#wtOnline').textContent = n + ' 人在看';

  var list = S.root.querySelector('#wtList');
  if (!WT.msgs.length) {
    list.innerHTML = '<div class="wt-empty">还没有人说话，打个招呼</div>';
  } else {
    list.innerHTML = WT.msgs.map(function (m) {
      var mine = m.uid === WT.uid;
      return '<div class="wt-msg' + (mine ? ' mine' : '') + '">' +
        '<div class="wt-nick">' + esc(m.nick || '观众') + '</div>' +
        '<div class="wt-text">' + esc(m.text) + '</div></div>';
    }).join('');
    list.scrollTop = list.scrollHeight;
  }

  var sync = S.root.querySelector('#wtSyncBar');
  if (WT.lastSync) {
    sync.style.display = '';
    sync.innerHTML = '<span>' + esc(WT.lastSync.nick || '有人') + ' 在第 ' + ((WT.lastSync.ep || 0) + 1) + ' 集 ' + fmtTime(WT.lastSync.time || 0) + '</span>' +
      '<button class="btn primary" data-act="wt-follow">跟随</button>';
  } else {
    sync.style.display = 'none';
  }
}

/* ---------- 分享 ---------- */

function wtShare() {
  if (!S.player.item) return;
  var item = S.player.item;
  var url = location.href.split('#')[0] + '#watch=' + wtRoomOf(item) + '&vod=' + encodeURIComponent(item._sourceKey + ':' + item.vod_id);
  var text = '一起看《' + (item.vod_name || '') + '》 ' + url;
  if (navigator.share) {
    navigator.share({ title: item.vod_name || 'TVBox', text: text, url: url }).catch(function () {});
    return;
  }
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(function () { toast('分享链接已复制'); }).catch(function () { toast('复制失败'); });
  } else {
    toast('当前浏览器不支持分享');
  }
}
