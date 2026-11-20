// One WebSocket to the room, kept alive.
//
// A dropped connection is retried after `retryMs` (2 s by default), always with the
// same per-tab `clientId`, which the server uses to recognize a reconnect of a
// connection it hasn't noticed closing yet (see worker/index.js). Anything still
// arriving from a socket this one already replaced is ignored, so a reconnect can
// never act on stale messages.
//
// Close code 4001 means the server replaced this connection on purpose (another tab
// of the same person took its place, or the IP was over the limit). Reconnecting
// would just fight the new connection, so it stops instead.
export const REPLACED_CLOSE_CODE = 4001;

export function createRoomSocket({
  url,
  clientId,
  retryMs = 2000,
  WebSocket: Socket = globalThis.WebSocket,
  setTimeout: startTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: stopTimer = (id) => globalThis.clearTimeout(id),
  onOpen,
  onMessage,
  onClose,
  onReplaced,
} = {}) {
  let socket = null;
  let generation = 0; // bumps on every socket: older sockets are ignored
  let timer = null;
  let stopped = false;
  let replaced = false;

  const target = () => {
    const u = new URL(url, globalThis.location?.href || "http://localhost/");
    if (clientId) u.searchParams.set("client", clientId);
    return u.toString();
  };

  function open() {
    timer = null;
    if (stopped || replaced) return;
    const gen = ++generation;
    let s;
    try {
      s = new Socket(target());
    } catch {
      schedule();
      return;
    }
    socket = s;
    s.onopen = () => {
      if (gen === generation) onOpen?.();
    };
    s.onmessage = (ev) => {
      if (gen === generation) onMessage?.(ev?.data);
    };
    s.onerror = () => {}; // a close always follows; the retry waits for it
    s.onclose = (ev) => {
      if (gen !== generation) return;
      socket = null;
      s.onopen = s.onmessage = s.onerror = s.onclose = null; // let the old socket go
      if (ev?.code === REPLACED_CLOSE_CODE) replaced = true;
      onClose?.(ev);
      if (replaced) {
        onReplaced?.();
        return;
      }
      schedule();
    };
  }

  function schedule() {
    if (stopped || replaced || timer !== null) return;
    timer = startTimer(open, retryMs);
  }

  return {
    connect() {
      stopped = false;
      open();
    },
    // false when the message was not sent (still connecting, or gone for good)
    send(message) {
      if (!socket || socket.readyState !== 1) return false;
      try {
        socket.send(JSON.stringify(message));
        return true;
      } catch {
        return false;
      }
    },
    close() {
      stopped = true;
      if (timer !== null) {
        stopTimer(timer);
        timer = null;
      }
      try {
        socket?.close();
      } catch {}
    },
    get connected() {
      return !!socket && socket.readyState === 1;
    },
    get clientId() {
      return clientId;
    },
    get replaced() {
      return replaced;
    },
  };
}
