// Live updates for the viewer. Each open viewer page keeps one event stream (server-sent events) for its project
// folder. The folder is watched while at least one page is open on it: a saved file is sent as a `change` event with
// the paths that changed, relative to the folder, and the page loads again only the scenes that use them. `motlab
// working` sets what the agent says it is working on, sent as a `work` event, so the page marks those scenes and notes.
import { watch } from 'node:fs';
import { sep } from 'node:path';

// Files the viewer writes itself (selection/), renders, backups, dependencies and editors' temporary files.
// selection.json is sent, so a note the agent marks done shows without a reload.
export const ignored = rel => /^(out|backup|node_modules|selection)(\/|$)/.test(rel) || /(^|\/)\./.test(rel) || /(~|\.tmp|\.swp|\.crdownload)$/i.test(rel);

const WAIT = 200;   // ms after the last event of a save, so one save is one change
const HOLD = 10 * 60e3;   // what the agent is working on is shown this long after its last word or the last saved file
const PING = 25e3;   // a comment line now and then, so a reverse proxy does not close a quiet stream

export function createLive() {
  const hubs = new Map();   // folder -> { pages, watcher, files, timer, work, expire }
  const send = (h, event, data) => { const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const res of h.pages) res.write(line); };
  const hub = root => {
    let h = hubs.get(root);
    if (!h) hubs.set(root, h = { pages: new Set(), watcher: null, files: new Set(), timer: 0, work: null, expire: 0 });
    return h;
  };
  const hold = h => {   // the agent's work is shown until it says it is done, or for HOLD after its last sign of life
    clearTimeout(h.expire);
    if (h.work) h.expire = setTimeout(() => { h.work = null; send(h, 'work', null); }, HOLD).unref();
  };
  function start(root, h) {
    try {
      h.watcher = watch(root, { recursive: true }, (type, name) => {
        if (!name) return;
        const rel = String(name).split(sep).join('/');
        if (ignored(rel)) return;
        h.files.add(rel); clearTimeout(h.timer);
        h.timer = setTimeout(() => { const files = [...h.files]; h.files.clear(); send(h, 'change', { files }); hold(h); }, WAIT);
      });
      h.watcher.on('error', () => { h.watcher?.close(); h.watcher = null; });   // the folder went away; the page keeps what it has
    } catch { h.watcher = null; }   // a folder that cannot be watched: the page works as before, without live updates
  }
  const ping = setInterval(() => { for (const h of hubs.values()) for (const res of h.pages) res.write(': ping\n\n'); }, PING).unref();

  return {
    // A page's event stream. It gets the agent's current work at once.
    subscribe(root, req, res) {
      const h = hub(root);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 2000\nevent: work\ndata: ${JSON.stringify(h.work)}\n\n`);
      h.pages.add(res);
      if (!h.watcher) start(root, h);
      req.on('close', () => {
        h.pages.delete(res);
        if (!h.pages.size) { h.watcher?.close(); h.watcher = null; clearTimeout(h.timer); h.files.clear(); }
      });
    },
    // What the agent is working on: { project, notes, scenes, text }, or null when it is done. Returns how many pages
    // are open on that folder, so `motlab working` can say whether anyone sees it.
    setWork(root, work) {
      const h = hub(root);
      h.work = work; send(h, 'work', work); hold(h);
      return h.pages.size;
    },
    close() { clearInterval(ping); for (const h of hubs.values()) { h.watcher?.close(); clearTimeout(h.timer); clearTimeout(h.expire); for (const res of h.pages) res.end(); } hubs.clear(); },
  };
}
