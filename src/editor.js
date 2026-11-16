// Viewer for projects: serves the editor page and the projects' files, saves the last click to selection.json, and
// renders a project when the page's Export button asks for it.
// One server holds many projects, each under /p/<slug>/: the one it was started with, the project folders in the
// folder it was started from (the workspace), and the projects opened before (~/.motlab/recent.json). A second
// `motlab edit` adds its project to a viewer that is already running instead of starting another one.
// A project is a folder with project.json, or a project file in it (video/storyboard.json), so a storyboard and the
// finished video can share one folder and its assets.
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { projectPaths, renderProject } from './project.js';
import { pageLib, sendFile } from './server.js';

const RECENT = join(homedir(), '.motlab', 'recent.json');
const SKIP = new Set(['node_modules', 'out', 'backup']);
const readRecent = () => { try { return JSON.parse(readFileSync(RECENT, 'utf8')).filter(f => typeof f === 'string'); } catch { return []; } };
function remember(file) {   // newest first; a missing or unwritable file only means the list is not remembered
  try { mkdirSync(dirname(RECENT), { recursive: true }); writeFileSync(RECENT, JSON.stringify([file, ...readRecent().filter(f => f !== file)].slice(0, 30), null, 2)); } catch {}
}
// project.json files under `dir`, a few levels down. A project's own folders are not searched, and the walk stops after
// a few thousand folders, so starting it in a home folder stays quick.
function scan(dir, depth = 4, found = [], budget = { n: 3000 }) {
  let list; try { list = readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  if (list.some(e => e.isFile() && e.name === 'project.json')) { found.push(join(dir, 'project.json')); return found; }
  if (depth) for (const e of list) if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name) && budget.n-- > 0) scan(join(dir, e.name), depth - 1, found, budget);
  return found;
}
// The versions of a project: the .json files in its folder with a list of scenes. project.json is "Utama", and
// project-tiktok.json is "tiktok".
const label = file => file === 'project.json' ? 'Utama' : file.replace(/\.json$/i, '').replace(/^project-/, '');
function versions(root) {
  const out = [];
  for (const f of readdirSync(root)) {
    if (!/\.json$/i.test(f) || f === 'selection.json') continue;
    try { if (Array.isArray(JSON.parse(readFileSync(join(root, f), 'utf8')).scenes)) out.push({ file: f, label: label(f) }); } catch {}
  }
  return out.sort((a, b) => (b.file === 'project.json') - (a.file === 'project.json') || a.label.localeCompare(b.label));
}
// One page's save of version v's notes, merged into the notes in selection.json (`old`). A page sends the notes it holds
// and names the ones it deleted, so a note it has not seen (made in another tab of the viewer) is kept rather than
// dropped. A note is known by its `id` (notes from before ids, by `n`). A new note whose number another tab took meanwhile
// gets the next free one: `renumbered` lists [id, old n, new n]. `done` is the file's unless the page changed it
// (`toggled`), because the agent marks notes done in the file while the page is open.
export function mergeNotes(old, { marks = [], toggled = [], deleted = [] }, v) {
  const key = m => m.id || `#${m.n}`, sent = new Set(marks.map(key)), gone = new Set(deleted);
  const was = new Map(old.filter(m => m.project === v).map(m => [key(m), m]));
  const kept = old.filter(m => m.project !== v || (!sent.has(key(m)) && !gone.has(key(m))));
  const taken = new Set(kept.map(m => m.n)), renumbered = [];
  let next = Math.max(0, ...old.map(m => m.n), ...marks.map(m => m.n)) + 1;
  const mine = marks.map(({ done, ...m }) => {
    const d = toggled.includes(m.n) || !was.has(key(m)) ? done : was.get(key(m)).done;
    if (taken.has(m.n)) { renumbered.push([m.id, m.n, next]); m = { ...m, n: next, ...(m.image ? { image: `selection/${next}.png` } : {}) }; next++; }
    taken.add(m.n);
    return { ...m, ...(d ? { done: true } : {}), project: v };
  });
  return { all: [...kept, ...mine].sort((a, b) => a.n - b.n), renumbered };
}

const json = (res, data, code = 200) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
const readBody = req => new Promise((ok, no) => { let body = ''; req.on('data', d => body += d).on('end', () => ok(body)).on('error', no); });

export function startEditor(target, port = 4173) {
  const workspace = process.cwd(), projects = new Map();   // slug -> { root, file }
  const show = dir => {   // a folder as the menu shows it: inside the workspace relative to it, else from ~
    const r = relative(workspace, dir), h = relative(homedir(), dir), slash = p => p.split(sep).join('/');
    return r && !r.startsWith('..') && !isAbsolute(r) ? slash(r) : h && !h.startsWith('..') && !isAbsolute(h) ? '~/' + slash(h) : slash(dir);
  };
  function register(target) {   // the slug of a project, added if it is new; throws if there is no project file
    const { root, file } = projectPaths(target);
    for (const [slug, p] of projects) if (p.root.toLowerCase() === root.toLowerCase()) return slug;
    const base = basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'project';
    let slug = base; for (let i = 2; projects.has(slug); i++) slug = `${base}-${i}`;
    projects.set(slug, { root, file });
    return slug;
  }
  function list() {   // looked up again on every request, so a project made while the viewer runs shows up
    for (const f of [...scan(workspace), ...readRecent()]) try { register(f); } catch {}
    return [...projects].filter(([, p]) => existsSync(p.file)).map(([slug, p]) => ({ slug, name: basename(p.root), path: show(p.root) }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  }
  const opened = target ? register(target) : null;
  if (opened) remember(projects.get(opened).file);

  let exporting = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), path = decodeURIComponent(url.pathname);
    // Only the viewer's own page may write: another site open in the browser (or a DNS-rebound name) gets a 403,
    // so it cannot write selection.json, add a project or start an export. `motlab edit` sends no Origin.
    if (req.method === 'POST') {
      const host = req.headers.host || '', origin = req.headers.origin;
      const local = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host);
      if (!local || (origin && origin !== `http://${host}`)) return res.writeHead(403).end('forbidden');
    }
    if (path === '/__motlab/editor') return json(res, { motlab: 'editor', pid: process.pid, workspace });   // how motlab edit/stop find this viewer
    if (req.method === 'POST' && path === '/__motlab/stop') {   // motlab stop: end a running export (its Chrome closes), then exit
      res.writeHead(204).end();
      if (exporting) exporting.abort();
      setTimeout(() => process.exit(0), exporting ? 1500 : 100);
      return;
    }
    if (path === '/') {
      const first = opened || list()[0]?.slug;
      if (first) return res.writeHead(302, { Location: `/p/${first}/` }).end();
      return res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`No motlab project in ${workspace} yet. Run motlab edit <project folder>.`);
    }
    if (path === '/projects') return json(res, { workspace: show(workspace), projects: list() });
    if (req.method === 'POST' && path === '/open') {   // body: { file }, from a second `motlab edit`
      try { const { file } = JSON.parse(await readBody(req)), slug = register(file); remember(projects.get(slug).file); return json(res, { url: `/p/${slug}/` }); }
      catch (e) { return res.writeHead(400).end(e.message); }
    }
    if (req.method === 'POST' && path === '/export/cancel') {   // stops the running export; its /export response then ends with CANCELLED
      if (exporting) exporting.abort();
      return res.writeHead(204).end();
    }
    const lib = pageLib(path);
    if (lib) return sendFile(req, res, lib);
    const m = /^\/p\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) return res.writeHead(404).end();
    if (!projects.has(m[1])) list();   // the viewer was restarted and the page reloaded
    const p = projects.get(m[1]);
    if (!p) return res.writeHead(404).end();
    if (!m[2]) return res.writeHead(301, { Location: `/p/${m[1]}/` }).end();   // the page loads everything relative to this
    // The version comes as ?v= for the page and as `project` in the body of a write; anything that is not one of the
    // project's versions falls back to the file the project was opened with.
    const { root } = p, sub = m[2], all = versions(root);
    const version = f => all.some(v => v.file === f) ? f : basename(p.file);

    if (sub === '/versions' && req.method === 'GET') return json(res, all);
    if (sub === '/versions' && req.method === 'POST') {   // body: { from, name }; a copy of `from` as project-<name>.json
      try {
        const { from, name } = JSON.parse(await readBody(req)), slug = String(name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        if (!slug) return res.writeHead(400).end('A version name needs letters or numbers.');
        const to = `project-${slug}.json`;
        if (existsSync(join(root, to))) return res.writeHead(409).end(`${to} already exists.`);
        copyFileSync(join(root, version(from)), join(root, to));
        return json(res, { file: to, label: label(to) });
      } catch (e) { return res.writeHead(400).end(e.message); }
    }
    if (req.method === 'POST' && sub === '/selection') {   // the last click, the range and this version's notes
      try {
        // `images` holds a PNG (data URL) per new note with a box or point: that frame with the note drawn on it, saved
        // as selection/<n>.png. Pictures of deleted notes are removed. The notes are merged by mergeNotes, and the reply
        // gives the page the file's notes, so it picks up notes from other tabs and done marks from the agent.
        const { images = {}, project, marks = [], toggled = [], deleted = [], png, ...sel } = JSON.parse(await readBody(req)), v = version(project), file = join(root, 'selection.json');
        let old = []; try { old = JSON.parse(readFileSync(file, 'utf8')).marks || []; } catch {}
        const { all, renumbered } = mergeNotes(old, { marks, toggled, deleted }, v), moved = new Set(renumbered.map(([, from]) => String(from)));
        writeFileSync(file, JSON.stringify({ project: v, ...sel, marks: all }, null, 2));
        const dir = join(root, 'selection'), keep = new Set(all.filter(m => m.image).map(m => `${m.n}.png`));
        for (const [n, data] of Object.entries(images)) {
          if (!keep.has(`${n}.png`) || moved.has(n)) continue;   // a renumbered note's picture shows its old number; the page sends a new one
          mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${n}.png`), Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'));
        }
        if (existsSync(dir)) for (const f of readdirSync(dir)) if (/^\d+\.png$/.test(f) && !keep.has(f)) rmSync(join(dir, f), { force: true });
        rmSync(join(root, 'selection.png'), { force: true });   // the single picture from before notes
        return json(res, { renumbered: renumbered.map(([id, , n]) => [id, n]), marks: all.filter(m => m.project === v), others: all.filter(m => m.project !== v) });
      } catch (e) { return res.writeHead(400).end(e.message); }
    }
    if (req.method === 'POST' && sub === '/export') {   // body: { project, scale, tag }; the render log is streamed back, last line DONE, CANCELLED or ERROR
      if (exporting) return res.writeHead(409).end('another export is still running');
      exporting = new AbortController();
      const started = Date.now(), { signal } = exporting, body = await readBody(req);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      try {
        const { project, scale, tag } = JSON.parse(body), file = join(root, version(project));
        const rel = `out/${projectPaths(file).name}-${String(tag).replace(/\W/g, '')}.mp4`;   // out/example-tiktok-1080p.mp4
        await renderProject({ dir: file, out: join(root, rel), scale: Number(scale) || 2, signal, log: line => { console.log(line); res.write(line + '\n'); } });
        res.end(`DONE ${rel} ${Math.round((Date.now() - started) / 1000)}\n`);
      } catch (e) {
        if (signal.aborted) { console.log('\nExport cancelled'); res.end('CANCELLED\n'); }
        else { console.error(e); res.end(`ERROR ${e.message.split('\n')[0]}\n`); }
      }
      exporting = false;
      return;
    }
    if (sub === '/') {   // read on every request, so a reload picks up edits to the editor itself
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      const file = version(url.searchParams.get('v'));
      const fill = { name: basename(root), project: file, version: label(file), slug: m[1] };
      return res.end(readFileSync(new URL('./editor.html', import.meta.url), 'utf8').replace(/\{\{(\w+)\}\}/g, (all, k) => fill[k] ?? all));
    }
    const asset = join(root, sub);
    if (!asset.startsWith(root + sep) || !existsSync(asset) || statSync(asset).isDirectory()) return res.writeHead(404).end();
    sendFile(req, res, asset);
  });

  // A viewer already on the port takes this project and the command ends; something else on the port, or an older
  // viewer, means the next free port.
  const handOver = async at => {
    const r = await fetch(`http://127.0.0.1:${at}/__motlab/editor`, { signal: AbortSignal.timeout(1500) }).then(r => r.json()).catch(() => null);
    if (r?.motlab !== 'editor') return null;
    if (!opened) return `http://127.0.0.1:${at}`;
    const o = await fetch(`http://127.0.0.1:${at}/open`, { method: 'POST', body: JSON.stringify({ file: projects.get(opened).file }) });
    if (!o.ok) throw new Error(await o.text());
    return `http://127.0.0.1:${at}${(await o.json()).url}`;
  };
  return new Promise((ok, no) => {
    server.on('error', async e => {
      if (e.code !== 'EADDRINUSE' || port > 4190) return no(e);
      try {
        const there = await handOver(port);
        if (there) { console.log(`Editor: ${there}  (in the viewer that is already running)`); return ok('joined'); }
      } catch (err) { return no(err); }
      server.listen(++port, '127.0.0.1');
    });
    server.on('listening', () => {
      const n = list().length;
      console.log(`Editor: http://127.0.0.1:${port}${opened ? `/p/${opened}/  (${projects.get(opened).file})` : ''}`);
      console.log(`  ${n} project${n === 1 ? '' : 's'} in the menu: ${workspace}, and the ones opened before`);
    });
    server.listen(port, '127.0.0.1');
  });
}
