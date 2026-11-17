import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectServer } from './projects.mjs';
import { generateCode, listModels } from './ai.mjs';
import { createStaticHandler } from '../desktop/static.mjs';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'game-editor-projects-'));
  const file = join(dir, 'projects.jsonl');
  const server = createProjectServer(file);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { file, url: `http://127.0.0.1:${server.address().port}/api/projects` };
}

const sceneData = { objects: [], sceneOptions: { name: 'Scene' } };
const json = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('desktop serves built files and project API without exposing files outside the build', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'game-editor-desktop-'));
  const build = join(dir, 'dist');
  await mkdir(build);
  await writeFile(join(build, 'index.html'), '<h1>Editor</h1>');
  await writeFile(join(dir, 'private.txt'), 'private');
  const server = createProjectServer(join(dir, 'projects.jsonl'), { staticHandler: createStaticHandler(build) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(await page.text(), '<h1>Editor</h1>');
  assert.equal((await fetch(`${base}/..%5cprivate.txt`)).status, 404);
  assert.equal((await fetch(`${base}/missing.js`)).status, 404);
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
  const created = await fetch(`${base}/api/projects`, json('POST', { name: 'Desktop', sceneData }));
  assert.equal(created.status, 201);
  assert.equal((await (await fetch(`${base}/api/projects`)).json())[0].name, 'Desktop');
});

test('creates, updates, lists and deletes projects in JSONL', async (t) => {
  const { file, url } = await setup(t);
  const createdResponse = await fetch(url, json('POST', { name: 'Scene', sceneData }));
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const update = await fetch(`${url}/${created.id}`, json('PUT', { name: 'Edited', sceneData }));
  assert.equal(update.status, 200);
  const updated = await update.json();
  assert.equal(updated.name, 'Edited');
  assert.equal(updated.createdAt, created.createdAt);
  assert.deepEqual(await (await fetch(url)).json(), [updated]);
  assert.deepEqual(await (await fetch(`${url}/${created.id}`)).json(), updated);
  assert.equal((await fetch(`${url}/${created.id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(await (await fetch(url)).json(), []);
  assert.equal((await fetch(`${url}/${created.id}`)).status, 404);
  const records = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map((record) => record.action), ['save', 'save', 'delete']);
});

test('serializes concurrent writes and recovers persisted projects after restart', async (t) => {
  const { file, url } = await setup(t);
  const responses = await Promise.all(
    Array.from({ length: 10 }, (_, index) => fetch(url, json('POST', { name: `Scene ${index}`, sceneData })))
  );
  assert.ok(responses.every((response) => response.status === 201));
  const restarted = createProjectServer(file);
  await new Promise((resolve) => restarted.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => restarted.close(resolve)));
  const result = await fetch(`http://127.0.0.1:${restarted.address().port}/api/projects`);
  assert.equal((await result.json()).length, 10);
});

test('rejects invalid input and non-local origins without writing', async (t) => {
  const { url } = await setup(t);
  assert.equal((await fetch(url, json('POST', { name: '', sceneData }))).status, 400);
  assert.equal((await fetch(url, { method: 'POST', body: 'x' })).status, 415);
  assert.equal((await fetch(url, { ...json('POST', { name: 'Scene', sceneData }), headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' } })).status, 403);
  assert.deepEqual(await (await fetch(url)).json(), []);
});

test('reports malformed JSONL instead of silently discarding data', async (t) => {
  const { file, url } = await setup(t);
  await writeFile(file, '{invalid}\n');
  assert.equal((await fetch(url)).status, 500);
  assert.equal((await fetch(url, json('POST', { name: 'Scene', sceneData }))).status, 500);
  assert.equal(await readFile(file, 'utf8'), '{invalid}\n');
});

test('accepts media-sized projects and reports requests over the limit', async (t) => {
  const { url } = await setup(t);
  const medium = { ...sceneData, objects: [{ type: 'model', properties: { modelData: 'x'.repeat(6 * 1024 * 1024) } }] };
  const accepted = await fetch(url, json('POST', { name: 'Media', sceneData: medium }));
  assert.equal(accepted.status, 201);
  assert.equal((await accepted.json()).sceneData.objects[0].properties.modelData.length, 6 * 1024 * 1024);
  const oversized = { ...sceneData, objects: [{ type: 'model', properties: { modelData: 'x'.repeat(50 * 1024 * 1024) } }] };
  const rejected = await fetch(url, json('POST', { name: 'Too large', sceneData: oversized }));
  assert.equal(rejected.status, 413);
  assert.match((await rejected.json()).error, /50 MB/);
});

test('history persists bounded snapshots with deduplicated media and rejects stale writes', async (t) => {
  const { file, url } = await setup(t);
  const id = randomUUID();
  const historyUrl = `${url.replace('/projects', '/history')}/${id}`;
  const asset = 'data:image/svg+xml;base64,PHN2Zy8+';
  const hash = createHash('sha256').update(asset).digest('hex');
  assert.equal((await fetch(`${historyUrl}/blobs/${hash}`, json('PUT', asset))).status, 200);
  const snapshot = { scene: { ...sceneData, objects: [{ properties: { map: { $historyBlob: hash } } }] }, assets: [] };
  assert.equal((await fetch(historyUrl, json('PUT', { expectedVersion: 0, history: { index: 0, snapshots: [snapshot] } }))).status, 200);
  assert.equal((await fetch(historyUrl, json('PUT', { expectedVersion: 0, history: { index: 0, snapshots: [snapshot] } }))).status, 409);
  assert.equal((await fetch(historyUrl, json('PUT', { expectedVersion: 1, history: { index: 21, snapshots: Array(22).fill(snapshot) } }))).status, 400);
  assert.equal((await (await fetch(historyUrl)).json()).version, 1);
  assert.equal(await (await fetch(`${historyUrl}/blobs/${hash}`)).json(), asset);
  const disk = await readFile(join(file, '..', 'history', `${id}.json`), 'utf8');
  assert.ok(disk.includes(hash));
  assert.ok(!disk.includes(asset));
  assert.equal((await fetch(`${historyUrl}/blobs/${hash}`, json('PUT', 'data:image/png;base64,wrong'))).status, 400);
});

test('AI providers format requests and return generated code without real network access', async () => {
  const replies = {
    openai: { choices: [{ message: { content: '```js\nreturn {};\n```' } }] },
    claude: { content: [{ type: 'text', text: 'return {};' }] },
    gemini: { candidates: [{ content: { parts: [{ text: 'return {};' }] } }] },
    ollama: { message: { content: 'return {};' } }
  };
  const env = { OPENAI_API_KEY: 'test', ANTHROPIC_API_KEY: 'test', GEMINI_API_KEY: 'test' };
  for (const provider of Object.keys(replies)) {
    let request;
    const fetcher = async (url, options) => {
      request = { url: String(url), options };
      return { ok: true, json: async () => replies[provider] };
    };
    assert.equal(await generateCode({ provider, model: 'test-model', prompt: 'rotate' }, fetcher, env), 'return {};');
    assert.ok(request.options.body.includes('rotate'));
    assert.equal(request.url.startsWith(provider === 'ollama' ? 'http://127.0.0.1:11434/' : 'https://'), true);
  }
  await assert.rejects(() => generateCode({ provider: 'openai', model: 'test', prompt: 'test' }, fetch, {}), /OPENAI_API_KEY/);
  await assert.rejects(() => generateCode({ provider: 'ollama', model: 'test', prompt: 'test' }, fetch, { OLLAMA_BASE_URL: 'http://example.com' }), /local HTTP/);
  let actualRequest;
  const fetcher = async (_url, options) => {
    actualRequest = JSON.parse(options.body);
    return { ok: true, json: async () => ({ message: { content: 'return {};' } }) };
  };
  const name = 'hf.co/mradermacher/Qwen3.5-4B-GLB-3D-Coder-GGUF:Q8_0';
  assert.equal(await generateCode({ provider: 'ollama', model: name, prompt: 'test', thinking: false, temperature: 0 }, fetcher, {}), 'return {};');
  assert.equal(actualRequest.model, name);
  assert.equal(actualRequest.think, false);
  assert.equal(actualRequest.options.temperature, 0);
  await generateCode({ provider: 'ollama', model: name, prompt: 'test' }, fetcher, {});
  assert.equal('think' in actualRequest, false);
  assert.equal('options' in actualRequest, false);
  assert.match(actualRequest.messages[0].content, /Three\.js scene object/);
  await generateCode({ provider: 'ollama', model: name, prompt: 'test', targetKind: 'web' }, fetcher, {});
  assert.match(actualRequest.messages[0].content, /web component/);
  assert.match(actualRequest.messages[0].content, /element, scene, camera/);
  assert.match(actualRequest.messages[0].content, /keydown\(event\)/);
  await assert.rejects(() => generateCode({ provider: 'ollama', model: name, prompt: 'test', targetKind: 'invalid' }, fetcher, {}), /target kind/);
  await assert.rejects(() => generateCode({ provider: 'ollama', model: name, prompt: 'test', mode: 'scene-agent', context: {}, targetKind: 'web' }, fetcher, {}), /target kind/);
  await assert.rejects(() => generateCode({ provider: 'ollama', model: name, prompt: 'test', temperature: 2.1 }, fetcher, {}), /Temperature/);
  await assert.rejects(
    () => generateCode({ provider: 'ollama', model: name, prompt: 'test' }, async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); }, {}),
    error => error.status === 504 && /timed out/.test(error.message)
  );
  await assert.rejects(() => generateCode({ provider: 'gemini', model: 'foo/bar', prompt: 'test' }, fetch, env), /valid provider/);
  await generateCode({ provider: 'ollama', model: 'test', prompt: 'x'.repeat(20000) }, fetcher, {});
  assert.equal(actualRequest.messages[1].content.length, 20000);
  await assert.rejects(() => generateCode({ provider: 'ollama', model: 'test', prompt: 'x'.repeat(100001) }, fetcher, {}), /100000/);
});

test('AI endpoint rejects invalid requests', async (t) => {
  const { url } = await setup(t);
  const response = await fetch(url.replace('/api/projects', '/api/ai/generate'), json('POST', { provider: 'invalid', model: 'test', prompt: 'test' }));
  assert.equal(response.status, 400);
  const listing = await fetch(url.replace('/api/projects', '/api/ai/models'), json('POST', { provider: 'invalid' }));
  assert.equal(listing.status, 400);
  assert.match((await listing.json()).error, /Invalid AI provider/);
});

test('model discovery normalizes provider listings and reports failures', async () => {
  const env = { ANYTHINGLLM_API_KEY: 'test', ANTHROPIC_API_KEY: 'test', GEMINI_API_KEY: 'test',
    OPENAI_API_KEY: 'test', OPENROUTER_API_KEY: 'test' };
  for (const [provider, payload, expected] of [
    ['ollama', { models: [{ name: 'local:latest' }] }, 'local:latest'],
    ['lmstudio', { data: [{ id: 'vendor/model' }] }, 'vendor/model'],
    ['anythingllm', { workspaces: [{ slug: 'workspace' }] }, 'workspace'],
    ['openai', { data: [{ id: 'gpt-test' }] }, 'gpt-test'],
    ['openrouter', { data: [{ id: 'vendor/model' }] }, 'vendor/model'],
    ['claude', { data: [{ id: 'claude-test' }], has_more: false }, 'claude-test'],
    ['gemini', { models: [{ name: 'models/gemini-test', supportedGenerationMethods: ['generateContent'] }] }, 'gemini-test']
  ]) {
    let options;
    const result = await listModels(provider, async (_url, init) => {
      options = init;
      return { ok: true, json: async () => payload };
    }, env);
    assert.deepEqual(result, [expected]);
    assert.equal(options.redirect, 'error');
  }
  let calls = 0;
  assert.deepEqual(await listModels('claude', async () => ({
    ok: true, json: async () => ++calls === 1 ? { data: [{ id: 'one' }], has_more: true, last_id: 'one' } :
      { data: [{ id: 'two' }], has_more: false }
  }), env), ['one', 'two']);
  await assert.rejects(() => listModels('ollama', fetch, { OLLAMA_BASE_URL: 'http://example.com' }), /local HTTP/);
  await assert.rejects(() => listModels('openai', fetch, {}), /OPENAI_API_KEY/);
  await assert.rejects(() => listModels('ollama', async () => ({ ok: false, status: 503 }), {}), /HTTP 503/);
  await assert.rejects(() => listModels('ollama', async () => ({ ok: true, json: async () => ({}) }), {}), /invalid model list/);
});

test('OpenRouter, LM Studio and AnythingLLM use their respective chat contracts', async () => {
  const screenshot = 'data:image/jpeg;base64,YWJj';
  const context = { objects: [{ id: 'item-1' }] };
  const env = { OPENROUTER_API_KEY: 'test-router', LM_STUDIO_API_KEY: 'test-studio', ANYTHINGLLM_API_KEY: 'test-anything' };
  for (const [provider, model, expectedUrl] of [
    ['openrouter', 'openai/gpt-4o-mini', 'https://openrouter.ai/api/v1/chat/completions'],
    ['lmstudio', 'vendor/model', 'http://127.0.0.1:1234/v1/chat/completions'],
    ['anythingllm', 'test-workspace', 'http://127.0.0.1:3001/api/v1/workspace/test-workspace/chat']
  ]) {
    let request;
    const fetcher = async (url, options) => {
      request = { url: String(url), headers: options.headers, body: JSON.parse(options.body), redirect: options.redirect };
      return { ok: true, json: async () => provider === 'anythingllm'
        ? { textResponse: '{"summary":"ok"}', error: null }
        : { choices: [{ message: { content: '{"summary":"ok"}' } }] } };
    };
    assert.equal(JSON.parse(await generateCode({ provider, model, prompt: 'Edit', mode: 'scene-agent', context, screenshot }, fetcher, env)).summary, 'ok');
    assert.equal(request.url, expectedUrl);
    assert.equal(request.redirect, 'error');
    assert.match(JSON.stringify(request.body), /item-1/);
    if (provider === 'anythingllm') {
      assert.equal(request.headers.authorization, 'Bearer test-anything');
      assert.equal(request.body.mode, 'chat');
      assert.equal(request.body.attachments[0].contentString, screenshot);
      assert.ok(request.body.sessionId);
    } else {
      assert.equal(request.headers.authorization, provider === 'openrouter' ? 'Bearer test-router' : 'Bearer test-studio');
      assert.equal(request.body.model, model);
      assert.equal(request.body.messages[1].content[1].image_url.url, screenshot);
    }
  }
  await assert.rejects(() => generateCode({ provider: 'openrouter', model: 'a/b', prompt: 'x' }, fetch, {}), /OPENROUTER_API_KEY/);
  await assert.rejects(() => generateCode({ provider: 'anythingllm', model: 'workspace', prompt: 'x' }, fetch, {}), /ANYTHINGLLM_API_KEY/);
  await assert.rejects(() => generateCode({ provider: 'lmstudio', model: 'model', prompt: 'x' }, fetch, { LM_STUDIO_BASE_URL: 'http://example.com' }), /local HTTP/);
  await assert.rejects(() => generateCode({ provider: 'anythingllm', model: 'workspace', prompt: 'x' },
    async () => ({ ok: true, json: async () => ({ error: 'internal failure' }) }), env), /returned an error/);
});

test('scene agent sends context and image in each provider format without real network access', async () => {
  const replies = {
    openai: { choices: [{ message: { content: '```json\n{"summary":"ok","edits":[]}\n```' } }] },
    claude: { content: [{ type: 'text', text: '{"summary":"ok","edits":[]}' }] },
    gemini: { candidates: [{ content: { parts: [{ text: '{"summary":"ok","edits":[]}' }] } }] },
    ollama: { message: { content: '{"summary":"ok","edits":[]}' } }
  };
  const env = { OPENAI_API_KEY: 'test', ANTHROPIC_API_KEY: 'test', GEMINI_API_KEY: 'test' };
  for (const provider of Object.keys(replies)) {
    let body;
    const fetcher = async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, json: async () => replies[provider] };
    };
    const result = await generateCode({
      provider, model: 'test', prompt: 'Style the heading', mode: 'scene-agent',
      context: { objects: [{ id: 'item-1' }], assets: [{ name: 'image.png' }] },
      screenshot: 'data:image/jpeg;base64,YWJj'
    }, fetcher, env);
    assert.equal(JSON.parse(result).summary, 'ok');
    assert.match(JSON.stringify(body), /item-1/);
    assert.match(JSON.stringify(body), /image.png/);
    assert.match(JSON.stringify(body), /gameengine_type/);
    assert.match(JSON.stringify(body), /addscenebutton/);
    if (provider === 'ollama') assert.deepEqual(body.messages[1].images, ['YWJj']);
    if (provider === 'openai') assert.equal(body.messages[1].content[1].image_url.url, 'data:image/jpeg;base64,YWJj');
    if (provider === 'claude') assert.equal(body.messages[0].content[1].source.data, 'YWJj');
    if (provider === 'gemini') assert.equal(body.contents[0].parts[1].inlineData.data, 'YWJj');
  }
  await assert.rejects(() => generateCode({ provider: 'ollama', model: 'test', prompt: 'test', mode: 'scene-agent', context: {}, screenshot: 'not-an-image' }), /Invalid or oversized screenshot/);
  await assert.rejects(() => generateCode({ provider: 'ollama', model: 'test', prompt: 'test', mode: 'scene-agent', context: { text: 'a'.repeat(250001) } }), /exceeds 250 KB/);
});
