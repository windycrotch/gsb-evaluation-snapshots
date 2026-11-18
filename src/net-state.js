/**
 * 联机对局的“回合状态”纯逻辑（浏览器与 Node 测试共用）
 *
 * 设计目标：两端只依据服务器回传的同一串 cmd 事件与主机快照做决定，
 * 不各自猜测对局是否已开始/重赛。
 * - 服务器为每条 start / rematch 命令分配递增的 mid（对局代号）。
 * - host 与 guest 收到同一条 cmd 回声 → 得到同一个 mid 与同样的角色选择。
 * - 快照携带 mid；客机只接受与当前对局代号一致的快照，旧对局的迟到快照被丢弃。
 */
export class NetMatchState {
  constructor() {
    this.mid = 0;
    this.started = false;
  }

  /**
   * 处理一条 cmd 消息，返回两端应当执行的动作（或 null 表示忽略）。
   * @param {{type?:string, cmd?:string, mid?:number, c1?:number, c2?:number, stage?:string}} msg
   * @returns {{action:'start'|'menu', mid?:number, c1?:number|null, c2?:number|null, stage?:string|null}|null}
   */
  onCmd(msg) {
    if (!msg || msg.type !== 'cmd') return null;

    if (msg.cmd === 'start' || msg.cmd === 'rematch') {
      const mid = Number.isFinite(msg.mid) ? msg.mid : this.mid + 1;
      if (this.started && mid <= this.mid) return null;   // 旧命令/重复命令
      this.mid = mid;
      this.started = true;
      return {
        action: 'start',
        mid,
        c1: Number.isInteger(msg.c1) ? msg.c1 : null,
        c2: Number.isInteger(msg.c2) ? msg.c2 : null,
        stage: typeof msg.stage === 'string' ? msg.stage : null,
      };
    }

    if (msg.cmd === 'menu') {
      this.started = false;
      return { action: 'menu' };
    }

    return null;
  }

  /** 客机：判断快照是否属于当前对局，过滤重赛前残留的迟到快照 */
  acceptSnapshot(snap) {
    if (!snap) return false;
    if (!Number.isFinite(snap.mid)) return true;   // 兼容未携带 mid 的旧主机
    if (!this.started) return true;
    if (snap.mid < this.mid) return false;         // 旧对局的迟到快照
    if (snap.mid > this.mid) {                     // 主机已经进入更新的对局：跟上它而不是永久停摆
      this.mid = snap.mid;
      this.started = true;
    }
    return true;
  }

  reset() {
    this.mid = 0;
    this.started = false;
  }
}
