/* Share-link parsing and the transactional restore controller.

   Opening a share link must restore the whole three-layer mix — songs, gains, mutes,
   key and tempo — as ONE observable, rollback-able transaction:

   - the link is validated up front (unknown song codes, out-of-range volumes, bad
     tempo/key are rejected before anything in the engine changes);
   - while a restore runs, every layer mutation (picks, random mix, clear, mute,
     volume) is queued behind it instead of racing the restore on the same layer;
   - any failure — validation, a layer stretch, or the limiter/graph rebuild — rolls
     the three layers back to the snapshot taken before the transaction and reports
     one error; no half-loaded layer is left behind;
   - only success unblocks the queue and fires one change/render;
   - pasting two links in a row only ever honours the last one;
   - the same link re-submitted while its restore is in flight (e.g. a background /
     foreground round trip) is coalesced, never run twice.

   Nothing here touches the DOM: main.js owns the UI and adapts engine calls into the
   `port` the controller drives, which keeps the whole thing unit-testable in Node. */

export const SLOT_LETTERS = { g: 'groove', l: 'lead', t: 'texture' };
const LAYER_IDS = Object.values(SLOT_LETTERS);

export class RestoreError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'RestoreError';
    // 'unknown-song' | 'volume' | 'tempo' | 'key' | 'empty' | 'stretch' | 'limiter' | 'superseded'
    this.code = code;
  }
}

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------- pure parsing / validation ----------
// Turns the raw hash ('g=H1&l=D4&vg=50&mg=1&bpm=120&...') into the desired mix, or
// throws RestoreError without touching any state. `manifest` is the engine's song
// manifest (song -> { code, key, ... }); NOTE maps key spellings to pitch classes and
// BPM_MIN/MAX bound the tempo.
export function parseShareHash(raw, { manifest, NOTE, BPM_MIN, BPM_MAX }) {
  const p = new URLSearchParams(raw);
  // A Map on purpose: a '#g=constructor' style code must find nothing, not touch props.
  const codeToSong = new Map(Object.entries(manifest).map(([song, info]) => [info.code, song]));

  const layers = {};
  for (const id of LAYER_IDS) {
    layers[id] = { song: null, volume: null, muted: false, hasVolume: false, hasMute: false };
  }

  // Volumes and mutes first, so a link that only carries levels still validates them.
  for (const [letter, id] of Object.entries(SLOT_LETTERS)) {
    const volKey = 'v' + letter;
    if (p.has(volKey)) {
      const vol = Number(p.get(volKey)); // gain in percent, whole or decimal numbers
      if (!isFiniteNum(vol) || vol < 0 || vol > 100) {
        throw new RestoreError(`Shared link has an out-of-range volume (${p.get(volKey)}%) for the ${id} layer`, { code: 'volume' });
      }
      layers[id].hasVolume = true;
      layers[id].volume = vol / 100;
    }
    if (p.has('m' + letter)) {
      layers[id].hasMute = true;
      if (p.get('m' + letter) === '1') layers[id].muted = true;
    }
  }

  // Selection order matters: the first slot is the auto-key anchor.
  const order = [...new Set(
    (p.get('a') || 'glt').split('').map((ch) => SLOT_LETTERS[ch]).filter(Boolean).concat(LAYER_IDS),
  )];

  for (const id of order) {
    const letter = id[0];
    if (!p.has(letter)) continue;
    const code = p.get(letter);
    const song = codeToSong.get(code);
    if (!song) {
      throw new RestoreError(`Shared link names a song this build doesn't have (code "${code}")`, { code: 'unknown-song' });
    }
    layers[id].song = song;
  }

  const out = { layers, order: order.filter((id) => layers[id].song) };

  if (p.has('bpm')) {
    const bpm = Number(p.get('bpm'));
    if (!isFiniteNum(bpm) || bpm < BPM_MIN || bpm > BPM_MAX) {
      throw new RestoreError(`Shared link has an out-of-range tempo (${p.get('bpm')} BPM)`, { code: 'tempo' });
    }
    out.bpm = Math.round(bpm);
  }

  if (p.has('lock')) out.keyLock = p.get('lock') !== '0';
  if (p.has('key')) {
    const key = p.get('key');
    if (!Object.hasOwn(NOTE, key)) {
      throw new RestoreError(`Shared link has an unknown key ("${key}")`, { code: 'key' });
    }
    out.masterKey = key; // NOTE_NAMES spelling is the caller's job (it owns NOTE_NAMES)
  }

  if (!out.order.length) throw new RestoreError('Shared link names no songs', { code: 'empty' });
  return out;
}

// ---------- controller ----------
// `port` provides the engine operations a transaction needs:
//   parse(raw)                 -> validated desired mix (parseShareHash bound to engine data)
//   snapshot()                 -> serializable mix state to roll back to
//   restoreSnapshot(snap)      -> put a snapshot back (songs, gains, mutes, tempo, key), async
//   rebuildGraph({ strict })   -> rebuild the master mix graph + limiter worklet;
//                                 strict mode rejects instead of falling back silently
//   selectStem(layer, song, o) -> promise; rejects when the stretch/load fails
//   setVolume / setMuted       -> level operations applied before the picks
//   applyMixSettings(desired)  -> bpm / keyLock / masterKey
//   afterCommit(desired)       -> one render / hash / album alignment, only on success
export function createRestoreController(port) {
  // One work item at a time. A restore request arriving while another is queued (not
  // yet started) replaces it, so two pastes in a row run only the last. User mutations
  // queue behind whichever restore is in flight/queued, in call order.
  const queue = [];           // { kind: 'restore'|'op', ... }
  let draining = false;
  let active = null;          // the running restore item, or null
  const subscribers = new Set();
  const notify = (phase) => subscribers.forEach((fn) => { try { fn(phase); } catch (err) { console.error(err); } });

  const isRestoring = () => !!active || queue.some((it) => it.kind === 'restore');

  function drain() {
    if (draining) return;
    draining = true;
    (async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item.kind === 'op') {
          try { item.resolve(await item.fn()); } catch (err) { item.reject(err); }
          continue;
        }
        active = item;
        notify('start');
        const result = await runTransaction(item.raw);
        active = null;
        notify(result.ok ? 'end' : 'error');
        item.resolve(result);
      }
      draining = false;
    })();
  }

  async function runTransaction(raw) {
    let desired;
    const snapshot = port.snapshot(); // capture before validation too: nothing mutated yet either way
    try {
      desired = port.parse(raw); // validation only; throws RestoreError
      await port.rebuildGraph({ strict: true });
      port.applyMixSettings(desired);
      // Levels and mutes before the first pick: the first pick builds layer nodes from them.
      // Only touch what the link actually carries, so a link that says nothing about one
      // layer's gain or mute leaves that layer's setting alone.
      for (const id of LAYER_IDS) {
        const d = desired.layers[id];
        if (d.hasVolume) port.setVolume(id, d.volume);
        if (d.hasMute) port.setMuted(id, d.muted);
      }
      // Every requested layer, in anchor order. force: re-stretch even if the same song
      // was already picked, so a restore is always a full rebuild of the shared mix.
      await Promise.all(desired.order.map((id) =>
        port.selectStem(id, desired.layers[id].song, { force: true, noAutoplay: true, keepTempo: true })));
      port.afterCommit(desired); // one render / hash / album alignment
      return { ok: true };
    } catch (err) {
      try { await port.restoreSnapshot(snapshot); } catch (rollbackErr) { console.error('rollback failed', rollbackErr); }
      const KNOWN = ['unknown-song', 'volume', 'tempo', 'key', 'empty', 'stretch', 'limiter'];
      const error = err instanceof RestoreError ? err
        : new RestoreError(err && err.message ? err.message : 'Shared mix could not be restored',
          { code: KNOWN.includes(err && err.code) ? err.code : undefined });
      return { ok: false, error };
    }
  }

  // Submit a share link. Resolves { ok, error? }.
  // - same raw as a queued/running restore: the same promise (coalesced, never twice);
  // - a new raw while another restore is queued but not started: the queued one is
  //   dropped and reported as superseded, only the newest link can take effect;
  // - a new raw while a restore is running: it queues and runs next (the running
  //   transaction itself rolls back on failure, so no half state ever leaks).
  function requestRestore(raw) {
    // Coalesce: the same raw hash already running or queued returns its promise, so a
    // background/foreground round trip or a double click never submits it twice.
    if (active && active.raw === raw) return active.promise;
    const queuedSame = queue.find((it) => it.kind === 'restore' && it.raw === raw);
    if (queuedSame) return queuedSame.promise;

    // Drop a queued (not yet started) restore — last paste wins. A restore already
    // running cannot be interrupted safely (it owns the snapshot/rollback), so the new
    // one queues behind it and runs once the transaction has settled.
    for (let i = queue.length - 1; i >= 0; i--) {
      const it = queue[i];
      if (it.kind === 'restore') {
        queue.splice(i, 1);
        it.resolve({ ok: false, superseded: true, error: new RestoreError('A newer share link was pasted', { code: 'superseded' }) });
      }
    }
    const item = { kind: 'restore', raw, resolve: null, promise: null };
    item.promise = new Promise((resolve) => { item.resolve = resolve; });
    queue.push(item);
    drain();
    return item.promise;
  }

  // Queue a user mutation for after the in-flight/queued restore. While idle it runs
  // immediately. Mutations replay in call order once the transaction ends, whatever its
  // outcome (on failure the snapshot was restored first).
  function mutate(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ kind: 'op', fn, resolve, reject });
      drain();
    });
  }

  const onPhase = (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); };

  return { requestRestore, mutate, isRestoring, onPhase, SLOT_LETTERS };
}
