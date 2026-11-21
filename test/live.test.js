// Live updates for the viewer (src/live.js): a saved file reaches the open page as a change event, files the viewer
// writes itself do not, and the agent's work from motlab working reaches it as a work event.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createLive, ignored } from '../src/live.js';

const dir = mkdtempSync(join(tmpdir(), 'motlab-live-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('files the viewer writes, renders, backups and temporary files are not sent', () => {
  for (const f of ['selection/3.png', 'out/a-1080p.mp4', 'backup/2/scenes/01.html', 'node_modules/x/i.js', '.git/index', 'scenes/.01.html.swp', 'scenes/01.html~', 'a.tmp'])
    assert.ok(ignored(f), f);
  for (const f of ['scenes/01.html', 'scenes/lib.js', 'project.json', 'selection.json', 'assets/kits/brand/transitions/swish/transition.js'])
    assert.ok(!ignored(f), f);
});

test('a saved file reaches the page, and the agent\'s work too', async () => {
  mkdirSync(join(dir, 'scenes')); mkdirSync(join(dir, 'selection'));
  writeFileSync(join(dir, 'scenes', '01.html'), 'one');
  const live = createLive(), server = createServer((req, res) => live.subscribe(dir, req, res));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const events = [];
  let wake = () => {};
  const req = request(`http://127.0.0.1:${server.address().port}/`, res => {
    assert.equal(res.headers['content-type'], 'text/event-stream');
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', d => {
      buf += d;
      for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
        const block = buf.slice(0, i), event = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
        if (event) { events.push({ event, data: JSON.parse(data) }); wake(); }
      }
    });
  });
  req.end();
  const next = (pred, ms = 4000) => new Promise((ok, no) => {
    const check = () => { const e = events.find(pred); if (e) { ok(e); return true; } };
    if (check()) return;
    const timer = setTimeout(() => no(new Error(`no matching event in ${ms} ms: ${JSON.stringify(events)}`)), ms);
    wake = () => { if (check()) clearTimeout(timer); };
  });
  try {
    assert.deepEqual((await next(e => e.event === 'work')).data, null);   // the current work, at once
    await new Promise(r => setTimeout(r, 300));   // the watcher is up
    writeFileSync(join(dir, 'selection', '1.png'), 'x');   // the viewer's own picture: not sent
    writeFileSync(join(dir, 'scenes', '01.html'), 'two');
    const change = await next(e => e.event === 'change');
    assert.ok(change.data.files.includes('scenes/01.html'), JSON.stringify(change.data));
    assert.ok(!change.data.files.some(f => f.startsWith('selection/')));
    assert.equal(live.setWork(dir, { project: 'project.json', notes: [3], scenes: [], text: 'judul' }), 1);   // one page sees it
    assert.deepEqual((await next(e => e.event === 'work' && e.data)).data.notes, [3]);
  } finally { req.destroy(); live.close(); server.close(); }
});
