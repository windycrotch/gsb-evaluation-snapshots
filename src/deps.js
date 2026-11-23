// Which local files a page loads, so a cached part can notice a shared script, stylesheet, font, image or clip
// changing under it. The list comes from the network requests Chrome made while the page rendered (chrome.js records
// them per page), so it needs no parser and sees whatever the page really loaded: a <script src>, an @font-face, an
// <img>, a fetch in a scene, a module a transition layer imports, and the pages a transition loads in its iframes.
//
// A resource that did not load, or lies outside the served folder, is an error: a cache key built on a guess would
// quietly keep showing the old frame. The engine's own files (/__motlab/..., the private upload prefix) are not the
// project's dependencies.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, isAbsolute, relative, resolve, sep } from 'node:path';

export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const hashFile = file => sha256(readFileSync(file));
const slash = path => path.split(sep).join('/');

// The local files behind the requests, as [{ path, hash }], sorted by path. Throws with a readable message when a
// dependency failed to load, or lies outside the served folder, so a broken scene fails here instead of being cached.
// The error is marked `part` (its message already names the part) and `final`: retrying the part alone cannot make a
// missing or unloadable file load, so the render stops with this error rather than falling back to one part at a time.
export function loadedFiles({ requests, origin, base, root, where }) {
  const fail = message => { throw Object.assign(new Error(message), { final: true, part: true }); };
  const basePath = base ? (() => { try { return new URL(base).pathname; } catch { return ''; } })() : '';
  const seen = new Map();   // relative path -> { ok, bad }
  for (const r of requests) {
    let u;
    try { u = new URL(r.url); } catch { continue; }
    if (u.origin !== origin || (r.method && r.method !== 'GET')) continue;
    if ((basePath && u.pathname.startsWith(basePath)) || u.pathname.startsWith('/__motlab/') || u.pathname === '/favicon.ico') continue;
    let path;
    try { path = decodeURIComponent(u.pathname).replace(/^\/+/, ''); } catch { continue; }
    if (!path) continue;
    const entry = seen.get(path) || { ok: false, bad: null };
    if (r.status >= 200 && r.status < 400) entry.ok = true;   // footage is read in ranges; one good response is enough
    else if (r.status === 404) entry.bad = 'missing from the project folder';
    else if (r.status >= 400) entry.bad = `HTTP ${r.status}`;
    else if (r.error && !r.canceled && !/ERR_ABORTED/.test(r.error)) entry.bad = r.error;   // a seek cancels ranges on purpose
    seen.set(path, entry);
  }
  const deps = [];
  for (const [path, s] of [...seen].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!s.ok && s.bad) fail(`${where} loads ${path}, which did not load (${s.bad})`);
    if (!s.ok) continue;   // no response was seen for it (still in flight at the end): not a dependency
    const file = resolve(root, path), rel = relative(root, file);
    if (rel.startsWith('..') || isAbsolute(rel)) fail(`${where} loads ${path}, which is outside the project folder`);
    if (!existsSync(file)) fail(`${where} loads ${path}, which is missing`);
    try { deps.push({ path: slash(rel), hash: hashFile(file) }); }
    catch (e) { fail(`${where} loads ${path}, which could not be read (${e.message})`); }
  }
  return deps;
}

// A recorded dependency list re-hashed against the files as they are now: { deps, missing }. A file that is gone or
// cannot be read is not an error here, only a reason to render again: the page may not load it any more, and if it
// does, loadedFiles() fails with the readable message.
export function checkDeps({ root, deps }) {
  const now = [], missing = [];
  for (const { path } of deps) {
    const file = resolve(root, path), rel = relative(root, file);
    if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(file)) { missing.push(path); continue; }
    try { now.push({ path, hash: hashFile(file) }); } catch { missing.push(path); }
  }
  return { deps: now, missing };
}

// The paths whose contents differ between two dependency lists, for the log line.
export function changedFiles(before, now) {
  const was = new Map(before.map(d => [d.path, d.hash])), is = new Map(now.map(d => [d.path, d.hash]));
  return [...new Set([...was.keys(), ...is.keys()])].filter(p => was.get(p) !== is.get(p)).sort();
}

// What a part loaded the last time it was rendered, kept beside the parts: the cache key needs it before rendering,
// to tell whether a part made earlier is still the right one. Slots are per project cache folder and part key.
const recordFile = (cacheRoot, slot) => join(cacheRoot, 'deps', sha256(slot) + '.json');

export function loadDepRecord(cacheRoot, slot) {
  try {
    const j = JSON.parse(readFileSync(recordFile(cacheRoot, slot), 'utf8'));
    return Array.isArray(j.deps) ? j.deps.filter(d => typeof d?.path === 'string' && typeof d.hash === 'string') : null;
  } catch { return null; }
}

export function saveDepRecord(cacheRoot, slot, deps) {
  try {
    mkdirSync(join(cacheRoot, 'deps'), { recursive: true });
    writeFileSync(recordFile(cacheRoot, slot), JSON.stringify({ slot, deps }));
  } catch {}   // a cache that cannot be written still renders; it just renders again next time
}
