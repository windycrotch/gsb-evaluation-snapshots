import { setTimeout as sleep } from 'node:timers/promises';

// Coordinates wakeups and queued checkpoints. The caller still owns task
// ordering, and every job uses the existing per-account execution queue.
export function createLoopScheduler({
  client, stop = {}, schedule = work => work(),
  sleep: wait = (ms, signal) => sleep(ms, undefined, { signal }), now = Date.now,
}) {
  let disposed = false;
  let pendingWake = false;
  let waiting = null;
  const cleanups = new Set();
  const queued = new Map();
  const active = () => !disposed && !stop.aborted && client.connected !== false;

  function addCleanup(cleanup) {
    if (disposed) cleanup();
    else cleanups.add(cleanup);
    return cleanup;
  }
  function listen(emitter, event, listener) {
    if (disposed) return;
    emitter.on?.(event, listener);
    addCleanup(() => {
      const remove = emitter.off?.bind(emitter) ?? emitter.removeListener?.bind(emitter);
      remove?.(event, listener);
    });
  }
  function wake() {
    if (!active()) return;
    pendingWake = true;
    waiting?.resolve(true);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    pendingWake = false;
    queued.clear();
    waiting?.resolve(true);
    waiting?.controller.abort();
    for (const cleanup of cleanups) cleanup();
    cleanups.clear();
  }
  function run(work) {
    if (!active()) return Promise.resolve();
    return schedule(() => active() ? work() : undefined);
  }
  function runDue(key, nextAt, work) {
    if (queued.has(key)) return queued.get(key);
    if (!active() || nextAt() > now()) return Promise.resolve();
    const job = Promise.resolve().then(() => run(() => nextAt() <= now() ? work() : undefined));
    queued.set(key, job);
    const clear = () => { if (queued.get(key) === job) queued.delete(key); };
    job.then(clear, clear);
    return job;
  }
  async function waitUntil(deadline) {
    if (!active()) return true;
    if (pendingWake) { pendingWake = false; return true; }
    const ms = Math.max(0, deadline - now());
    if (ms === 0) return false;
    const controller = new AbortController();
    let resolve;
    const changed = new Promise(complete => { resolve = complete; });
    const current = { controller, resolve };
    waiting = current;
    try {
      return await Promise.race([Promise.resolve(wait(ms, controller.signal)).then(() => false), changed]);
    } finally {
      if (waiting === current) waiting = null;
      pendingWake = false;
      controller.abort();
    }
  }

  listen(client, 'close', dispose);
  listen(client, 'state', () => { if (client.connected === false) dispose(); });
  if (stop.aborted) dispose();
  else if (stop.addEventListener) {
    stop.addEventListener('abort', dispose, { once: true });
    addCleanup(() => stop.removeEventListener('abort', dispose));
  }
  return { active, wake, waitUntil, run, runDue, listen, addCleanup, dispose };
}
