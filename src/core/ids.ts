const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Short random id. Unique enough for a single document; not cryptographically meaningful. */
export function uid(): string {
  const bytes = new Uint8Array(9);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

/** "bone" -> "bone2" -> "bone3" ... avoiding every name in `taken`. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = taken instanceof Set ? (taken as Set<string>) : new Set(taken);
  if (!set.has(base)) return base;
  const m = /^(.*?)(\d+)$/.exec(base);
  const stem = m ? m[1] : base;
  let n = m ? parseInt(m[2], 10) + 1 : 2;
  while (set.has(stem + n)) n++;
  return stem + n;
}
