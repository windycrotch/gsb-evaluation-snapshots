import { connect, sleep } from './cdp.mjs';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const snip = (n) => fs.readFileSync(path.join(HERE, 'snippets', n), 'utf8');
const c = await connect();
try {
  await c.goto('http://127.0.0.1:5188/');
  let ready=false; for (let i=0;i<160;i++){ await sleep(500);
    const st=await c.evaluate('({r:!!window.__EXILIUM_READY,e:window.__EXILIUM_ERROR||null})');
    if(st.e) throw new Error(st.e); if(st.r){ready=true;break;} }
  if(!ready) throw new Error('not ready');
  const r = await c.evaluate(snip('stress.js'));
  console.log(JSON.stringify(r, null, 2));
} finally { c.close(); }
