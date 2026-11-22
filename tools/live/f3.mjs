import { connect, sleep } from './cdp.mjs';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const snip = (n) => fs.readFileSync(path.join(HERE, 'snippets', n), 'utf8');
const c = await connect();
try {
  await c.goto('http://127.0.0.1:5188/');
  for (let i=0;i<160;i++){ await sleep(500); if(await c.evaluate('!!window.__EXILIUM_READY')) break; }
  const r = await c.send('Runtime.evaluate',{expression:snip('f3.js'),returnByValue:true,awaitPromise:true},c.sessionId);
  console.log(JSON.stringify(r.result.result.value, null, 2));
} finally { c.close(); }
