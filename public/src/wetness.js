// Wetness marks are stored in the posed, local space of each stocking mesh.
// A fixed-size ring buffer keeps the shader uniform array in sync: once it is
// full, a new mark overwrites the oldest slot instead of being dropped.

export const MAX_STAINS = 24;
// The shader clamps merged marks to this radius; keep the same ceiling here so
// a debounced tap cannot grow a mark past what the share link can carry.
export const MAX_STAIN_RADIUS = .089;
// Marks closer than this are treated as the same splash and simply grow.
const STAIN_MERGE_DISTANCE = .021;
const MAX_SHARE_RADIUS = MAX_STAIN_RADIUS * 1.5;
const MAX_SHARE_COORDINATE = 4;

export function createStains(count = MAX_STAINS) {
  return Array.from({ length: count }, () => ({ x: 0, y: 0, z: 0, w: 0 }));
}

// Clearing must wipe the position as well as the weight: the shader skips
// marks whose weight is zero, but leaving stale coordinates around makes the
// uniform array (and anything that snapshots it) look like it still holds the
// old splashes.
export function clearStains(marks) {
  for (const mark of marks) {
    mark.x = 0;
    mark.y = 0;
    mark.z = 0;
    mark.w = 0;
  }
}

export function isActiveStain(mark) {
  return Boolean(mark) && Number.isFinite(mark.w) && mark.w > 0;
}

// Adds a mark at `point` ({x, y, z} in the mesh's rested local space) and
// returns the next ring-buffer cursor together with the affected mark. When the
// buffer is full the cursor wraps, so the new splash replaces the oldest mark.
export function addStain(marks, cursor, point, radius) {
  const count = marks.length;
  const amount = Number(radius);
  if (!count || !Number.isFinite(amount) || amount <= 0) return { cursor, mark: null };
  const size = Math.min(MAX_STAIN_RADIUS, amount);
  const close = marks.find(mark => isActiveStain(mark) &&
    Math.hypot(mark.x - point.x, mark.y - point.y, mark.z - point.z) < STAIN_MERGE_DISTANCE);
  if (close) {
    close.w = Math.min(MAX_STAIN_RADIUS, Math.max(close.w, size) * 1.13);
    return { cursor, mark: close };
  }
  const slot = ((cursor % count) + count) % count;
  const mark = marks[slot];
  mark.x = Number(point.x) || 0;
  mark.y = Number(point.y) || 0;
  mark.z = Number(point.z) || 0;
  mark.w = size;
  return { cursor: (slot + 1) % count, mark };
}

function sanitize(entry) {
  if (!entry) return null;
  const values = Array.isArray(entry)
    ? entry
    : [entry.x, entry.y, entry.z, entry.r ?? entry.radius ?? entry.w];
  if (values.length < 4) return null;
  const [x, y, z, r] = values.map(Number);
  if (![x, y, z, r].every(Number.isFinite)) return null;
  if (r <= 0 || r > MAX_SHARE_RADIUS) return null;
  if (Math.abs(x) > MAX_SHARE_COORDINATE || Math.abs(y) > MAX_SHARE_COORDINATE ||
      Math.abs(z) > MAX_SHARE_COORDINATE) return null;
  return { x, y, z, r };
}

// Replaces every slot with the supplied marks (oldest first) and returns the
// cursor the next splash should use. Malformed entries are skipped; when a link
// carries more marks than the uniform array can hold, the newest ones win.
export function restoreStains(marks, entries) {
  clearStains(marks);
  if (!Array.isArray(entries) || !marks.length) return 0;
  const valid = [];
  for (const entry of entries) {
    const stain = sanitize(entry);
    if (stain) valid.push(stain);
  }
  const keep = valid.slice(-marks.length);
  keep.forEach((stain, index) => {
    const mark = marks[index];
    mark.x = stain.x;
    mark.y = stain.y;
    mark.z = stain.z;
    mark.w = stain.r;
  });
  return keep.length % marks.length;
}

// Ring slots are written in cursor order, so rotating from the cursor yields
// the marks oldest-first. Sharing and restoring both rely on that order.
export function orderedStains(marks, cursor = 0) {
  const count = marks.length;
  if (!count) return [];
  const start = ((Math.trunc(cursor) || 0) % count + count) % count;
  const ordered = [];
  for (let step = 0; step < count; step++) {
    const mark = marks[(start + step) % count];
    if (isActiveStain(mark)) ordered.push(mark);
  }
  return ordered;
}

export function wetnessSnapshot(marks, cursor = 0) {
  return orderedStains(marks, cursor).map(mark => ({ x: mark.x, y: mark.y, z: mark.z, r: mark.w }));
}

function round(value) {
  // toFixed keeps the payload free of exponent notation ("1e-7"), which the
  // comma-separated parser could not read back.
  const fixed = Number(value.toFixed(6));
  return String(Object.is(fixed, -0) ? 0 : fixed);
}

// "x,y,z,r;x,y,z,r" (oldest first). An empty string means "no wetness".
// Accepts mark snapshots ({x, y, z, r}) or live uniform marks ({x, y, z, w}).
export function encodeWetness(entries) {
  if (!Array.isArray(entries)) return '';
  const active = entries.map(sanitize).filter(Boolean);
  if (!active.length) return '';
  return active.map(mark => [mark.x, mark.y, mark.z, mark.r].map(round).join(',')).join(';');
}

// Returns a list of marks for a valid payload, [] for an explicitly empty one,
// and null for anything malformed so callers can fall back to a dry look
// without throwing. Coordinates and radii must be finite and in range.
export function decodeWetness(text) {
  if (text === undefined || text === null || text === '' || text === '-') return [];
  if (typeof text !== 'string') return null;
  const marks = [];
  for (const chunk of text.split(';')) {
    const values = chunk.split(',');
    if (values.length !== 4) return null;
    const stain = sanitize(values);
    if (!stain) return null;
    marks.push(stain);
  }
  return marks.slice(-MAX_STAINS);
}
