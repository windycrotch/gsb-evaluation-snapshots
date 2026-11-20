// Who else is in the room, keyed by the server's player id.
//
// The state must be touched by this module alone: when a connection is replaced and
// a new `state` snapshot arrives, entries for players that are no longer there are
// dropped, so a reconnect can neither duplicate a character nor keep a ghost around.
export function createRoomView({ onAdd, onRemove, onUpdate = () => {} } = {}) {
  const players = new Map();

  function add(p) {
    if (!p || typeof p.id !== "string") return null;
    const existing = players.get(p.id);
    if (existing) {
      update(p);
      return existing;
    }
    const entry = { ...p };
    players.set(p.id, entry);
    onAdd(entry);
    return entry;
  }

  function update(p) {
    const entry = players.get(p.id);
    if (!entry) return null;
    Object.assign(entry, p);
    onUpdate(entry);
    return entry;
  }

  function remove(id) {
    if (!players.delete(id)) return;
    onRemove(id);
  }

  // a full snapshot: add or refresh everyone in it, drop everyone else
  function sync(list) {
    const seen = new Set();
    for (const p of Array.isArray(list) ? list : []) {
      if (!p || typeof p.id !== "string") continue;
      seen.add(p.id);
      add(p);
    }
    for (const id of [...players.keys()]) if (!seen.has(id)) remove(id);
  }

  function clear() {
    for (const id of [...players.keys()]) remove(id);
  }

  return { players, add, update, remove, sync, clear };
}
