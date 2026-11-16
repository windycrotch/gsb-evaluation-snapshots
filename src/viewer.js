// The viewer as a background server. `motlab start` runs it on 4173 (the next free port when something else has
// 4173), `motlab edit <project>` opens a project in it and starts it first when none is running, `motlab stop` ends
// it and `motlab restart` starts it again from the same folder. The server is `motlab start --foreground` in a
// detached process, writing to ~/.motlab/viewer.log. A running viewer is found by asking each port for
// /__motlab/editor, so there is no pid file to go stale.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { projectPaths } from './project.js';

export const FIRST_PORT = 4173, LAST_PORT = 4190;
const BIN = fileURLToPath(new URL('../bin/motlab.js', import.meta.url));
export const LOG = join(homedir(), '.motlab', 'viewer.log');

// The motlab viewer on this machine: { port, url, pid, workspace }, or null. pid and workspace are missing for a
// viewer from before motlab start existed.
export async function findViewer() {
  for (let port = FIRST_PORT; port <= LAST_PORT; port++) {
    const r = await fetch(`http://127.0.0.1:${port}/__motlab/editor`, { signal: AbortSignal.timeout(800) }).then(r => r.json()).catch(() => null);
    if (r?.motlab === 'editor') return { port, url: `http://127.0.0.1:${port}`, pid: r.pid, workspace: r.workspace };
  }
  return null;
}

const logTail = () => { try { return readFileSync(LOG, 'utf8').trim().split('\n').slice(-15).join('\n'); } catch { return ''; } };

// Starts the server in the background in `cwd` (the folder whose projects the menu lists) and waits until it answers.
export async function startViewer({ cwd = process.cwd(), say = true } = {}) {
  const running = await findViewer();
  if (running) { if (say) console.log(`Viewer: ${running.url}  (already running)`); return running; }
  mkdirSync(join(homedir(), '.motlab'), { recursive: true });
  const log = openSync(LOG, 'w');
  const child = spawn(process.execPath, [BIN, 'start', '--foreground'], { cwd, detached: true, stdio: ['ignore', log, log], windowsHide: true });
  closeSync(log);
  let exited = null;
  child.once('exit', code => { exited = code; });
  child.unref();
  for (const until = Date.now() + 20000; Date.now() < until;) {
    const v = await findViewer();
    if (v) { if (say) console.log(`Viewer: ${v.url}  (in the background; log in ${LOG})`); return v; }
    if (exited !== null) break;
    await sleep(250);
  }
  throw new Error(`the viewer did not start${exited !== null ? ` (it exited with code ${exited})` : ' within 20 s'}. ${LOG}:\n${logTail()}`);
}

export async function stopViewer({ say = true } = {}) {
  const v = await findViewer();
  if (!v) { if (say) console.log('No viewer is running.'); return null; }
  if (!v.pid) throw new Error(`the viewer on ${v.url} is from an older motlab and cannot be stopped from here. Stop it with Ctrl+C where it runs`);
  // Asked first, so a running export closes its Chrome; killed if it does not go.
  await fetch(`${v.url}/__motlab/stop`, { method: 'POST', signal: AbortSignal.timeout(3000) }).catch(() => {});
  for (const until = Date.now() + 10000; Date.now() < until; await sleep(200)) {
    const still = await findViewer();
    if (!still || still.pid !== v.pid) { if (say) console.log(`Stopped the viewer on ${v.url}.`); return v; }
    if (Date.now() > until - 5000) try { process.kill(v.pid); } catch {}
  }
  throw new Error(`the viewer on ${v.url} (process ${v.pid}) did not stop within 10 s`);
}

export async function restartViewer() {
  const old = await stopViewer({ say: false });
  if (old) console.log(`Stopped the viewer on ${old.url}.`);
  return startViewer({ cwd: old?.workspace || process.cwd() });
}

// motlab edit [project]: the project in the running viewer, after starting one if needed. Ends once the address is printed.
export async function openInViewer(target) {
  const file = target ? projectPaths(target).file : null;   // fails here, before starting anything, if it is not a project
  const v = await findViewer() || await startViewer({ say: false });
  if (!file) { console.log(`Viewer: ${v.url}`); return; }
  const r = await fetch(`${v.url}/open`, { method: 'POST', body: JSON.stringify({ file }) });
  if (!r.ok) throw new Error(await r.text());
  console.log(`Viewer: ${v.url}${(await r.json()).url}  (${file})`);
}
