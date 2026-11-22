// Minimal CDP driver using Node's built-in WebSocket + Chrome's DevToolsActivePort.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = 'C:/ud-cdp-test/run-' + Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function launch() {
  const proc = spawn(CHROME, ['--headless=new','--no-sandbox','--disable-gpu',
    '--remote-debugging-port=0','--remote-allow-origins=*','--window-size=1280,800',
    '--user-data-dir=' + PROFILE, 'about:blank'], { stdio: 'ignore' });
  return proc;
}
async function readPort() {
  const f = PROFILE + '/DevToolsActivePort';
  for (let i = 0; i < 100; i++) {
    try { const s = fs.readFileSync(f, 'utf8').split('\n'); return { port: +s[0], path: s[1] }; }
    catch { await sleep(150); }
  }
  throw new Error('no DevToolsActivePort');
}
function httpJSON(port, path) { return new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path }, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{res(JSON.parse(d));}catch(e){rej(e);} }); }).on('error', rej);
}); }

export async function connect() {
  const proc = launch();
  const { port, path } = await readPort();
  const ver = await httpJSON(port, '/json/version');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}, sessionId) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0,500));
    return r.result && r.result.result && r.result.result.value;
  };
  const goto = (url) => send('Page.navigate', { url }, sessionId);
  const close = () => { try { ws.close(); } catch {} try { proc.kill(); } catch {} };
  return { send, sessionId, evaluate, goto, close, port };
}
export { sleep };
