/**
 * 局域网联机客户端 —— 主机权威架构
 * 主机：运行完整模拟，30Hz 广播状态快照；接收客机输入
 * 客机：本地输入 30Hz 上行；接收快照驱动木偶（插值平滑渲染）
 *
 * 会话安全：
 *  - 每个 NetSession 有唯一 id，游戏侧据此忽略旧会话的迟到回调（快速取消/重连不会串台）
 *  - alive 在主动关闭或连接断开时置 false，上行/下行定时器立即停发
 *  - 离开房间先发 leave（服务端删除房间并通知对手），再关连接
 */
let _sessionSeq = 0;

export class NetSession {
  constructor(handlers) {
    this.id = ++_sessionSeq;
    this.ws = null;
    this.role = null;         // 'host' | 'guest'
    this.handlers = handlers; // { onRole, onMatched, onPick, onReady, onStart, onCmd, onState, onInput, onClose, onError }
    this._inputTimer = null;
    this._stateTimer = null;
    this.alive = false;       // 会话是否仍有效（连接打开且未被销毁）
    this.closed = false;      // 是否已销毁（防止重复 destroy / 重复回调）
  }

  connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = this.ws = new WebSocket(`${proto}://${location.host}`);
      const timeout = setTimeout(() => reject(new Error('连接超时')), 5000);
      ws.onopen = () => { clearTimeout(timeout); this.alive = true; resolve(); };
      ws.onerror = () => { clearTimeout(timeout); reject(new Error('无法连接服务器')); };
      ws.onclose = () => {
        clearTimeout(timeout);
        const wasAlive = this.alive;
        this.alive = false;
        this._stopTimers();
        // 主动 destroy/leave 触发的关闭不再回调，避免重复走退出流程
        if (!this.closed && wasAlive) this.handlers.onClose?.();
      };
      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (!this.alive || this.closed) return;   // 关闭过程中的迟到消息一律丢弃
        this.rxCount = (this.rxCount || 0) + 1;
        this.lastRx = msg.type;
        this._route(msg);
      };
    });
  }

  _route(msg) {
    const h = this.handlers;
    switch (msg.type) {
      case 'role': this.role = msg.role; h.onRole?.(msg.role); break;
      case 'matched': h.onMatched?.(); break;
      case 'pick': h.onPick?.(msg.from, msg.char); break;
      case 'ready': h.onReady?.(msg.from, msg.char); break;
      case 'cmd': h.onStart?.(msg); break;
      case 'state': if (this.role === 'guest') h.onState?.(msg); break;
      case 'input': if (this.role === 'host') h.onInput?.(msg.keys); break;
      case 'peer-left': h.onClose?.(true); break;
      case 'error': h.onError?.(msg.reason); break;
    }
  }

  send(obj) {
    if (this.alive && this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
      this.txCount = (this.txCount || 0) + 1;
      if (obj.type === 'state') this.stateTx = (this.stateTx || 0) + 1;
    }
  }

  /** 主动离开房间：服务端删除房间并通知对手，然后关闭连接（幂等） */
  leave() {
    if (this.closed) return;
    try { this.send({ type: 'leave' }); } catch { /* ignore */ }
    this.destroy();
  }

  /** 客机：上行输入 */
  startInputLoop(getInput) {
    this._stopTimer('_inputTimer');
    this._getInput = getInput;
    this._inputTimer = setInterval(() => {
      if (!this.alive || this.role !== 'guest') return;
      this.send({ type: 'input', keys: this._getInput() });
    }, 33);
  }

  /** 主机：下行状态快照 */
  startStateLoop(getState) {
    this._stopTimer('_stateTimer');
    this._getState = getState;
    this._stateTimer = setInterval(() => {
      if (!this.alive || this.role !== 'host') return;
      const data = this._getState();
      if (data) this.send({ type: 'state', ...data });
    }, 33);
  }

  _stopTimer(key) { if (this[key]) { clearInterval(this[key]); this[key] = null; } }
  _stopTimers() { this._stopTimer('_inputTimer'); this._stopTimer('_stateTimer'); }

  /** 停止数据循环（保留连接） */
  stopLoops() { this._stopTimers(); }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.alive = false;
    this._stopTimers();
    if (this.ws) {
      try {
        this.ws.onclose = null;   // 主动关闭不再触发 onClose 回调
        this.ws.close();
      } catch { /* ignore */ }
      this.ws = null;
    }
  }
}
