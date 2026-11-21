import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { generateCode, listModels } from './ai.mjs';

const MAX_BODY_BYTES = 50 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;

export function createProjectServer(filePath = resolve('data', 'projects.jsonl'), { staticHandler } = {}) {
  let queue = Promise.resolve();

  async function readProjects() {
    let content;
    try {
      content = await readFile(filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return new Map();
      throw error;
    }

    const projects = new Map();
    for (const [index, line] of content.split('\n').entries()) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error(`Invalid JSONL record at line ${index + 1}`);
      }
      if (!record || !UUID.test(record.id) || !['save', 'delete'].includes(record.action)) {
        throw new Error(`Invalid project record at line ${index + 1}`);
      }
      if (record.action === 'delete') {
        projects.delete(record.id);
      } else {
        if (!record.project || record.project.id !== record.id) {
          throw new Error(`Invalid project data at line ${index + 1}`);
        }
        projects.set(record.id, record.project);
      }
    }
    return projects;
  }

  async function writeRecord(record) {
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  function respond(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  async function readBody(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      throw Object.assign(new Error('Content-Type must be application/json'), { status: 415 });
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
      } else {
        chunks.push(chunk);
      }
    }
    if (tooLarge) throw Object.assign(new Error('Project exceeds the 50 MB limit'), { status: 413 });
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
    }
  }

  const historyDirectory = join(dirname(filePath), 'history');
  async function atomicWrite(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, value, 'utf8');
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async function readHistory(id) {
    let text;
    try {
      text = await readFile(join(historyDirectory, `${id}.json`), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const value = JSON.parse(text);
    if (!value || !Number.isSafeInteger(value.version) || value.version < 1 ||
        !Array.isArray(value.snapshots) || value.snapshots.length < 1 || value.snapshots.length > 21 ||
        !Number.isInteger(value.index) || value.index < 0 || value.index >= value.snapshots.length ||
        value.snapshots.some(snapshot => !snapshot || !snapshot.scene || !Array.isArray(snapshot.scene.objects) ||
          !snapshot.scene.sceneOptions || !Array.isArray(snapshot.assets))) {
      throw new Error('Invalid project history');
    }
    return value;
  }

  async function handle(req, res) {
    const origin = req.headers.origin;
    if (origin) {
      let hostname;
      try {
        hostname = new URL(origin).hostname;
      } catch {
        return respond(res, 403, { error: 'Invalid origin' });
      }
      if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
        return respond(res, 403, { error: 'Only local origins are allowed' });
      }
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/ai/generate') {
      if (req.method !== 'POST') return respond(res, 405, { error: 'Method not allowed' });
      const data = await readBody(req);
      return respond(res, 200, { code: await generateCode(data) });
    }
    if (url.pathname === '/api/ai/models') {
      if (req.method !== 'POST') return respond(res, 405, { error: 'Method not allowed' });
      const data = await readBody(req);
      return respond(res, 200, { models: await listModels(data?.provider) });
    }
    const historyMatch = /^\/api\/history\/([^/]+)(?:\/blobs\/([^/]+))?$/.exec(url.pathname);
    if (historyMatch) {
      const [, id, hash] = historyMatch;
      if (!UUID.test(id) || (hash && !HASH.test(hash))) return respond(res, 404, { error: 'Not found' });
      if (hash) {
        const path = join(historyDirectory, 'blobs', `${hash}.json`);
        if (req.method === 'GET') {
          try { return respond(res, 200, JSON.parse(await readFile(path, 'utf8'))); }
          catch (error) { if (error.code === 'ENOENT') return respond(res, 404, { error: 'History asset not found' }); throw error; }
        }
        if (req.method === 'PUT') {
          const value = await readBody(req);
          if (typeof value !== 'string' || !value.startsWith('data:') ||
              createHash('sha256').update(value, 'utf8').digest('hex') !== hash) {
            return respond(res, 400, { error: 'Invalid history asset' });
          }
          await atomicWrite(path, JSON.stringify(value));
          return respond(res, 200, { saved: true });
        }
      } else {
        if (req.method === 'GET') return respond(res, 200, await readHistory(id));
        if (req.method === 'PUT') {
          const data = await readBody(req);
          const previous = await readHistory(id);
          if (!Number.isInteger(data?.expectedVersion) || data.expectedVersion !== (previous?.version ?? 0)) {
            return respond(res, 409, { error: 'History changed in another editor; reload before editing again' });
          }
          const next = { ...data.history, version: data.expectedVersion + 1 };
          if (!Array.isArray(next.snapshots) || next.snapshots.length < 1 || next.snapshots.length > 21 ||
              !Number.isInteger(next.index) || next.index < 0 || next.index >= next.snapshots.length ||
              next.snapshots.some(snapshot => !snapshot || !snapshot.scene || !Array.isArray(snapshot.scene.objects) ||
                !snapshot.scene.sceneOptions || !Array.isArray(snapshot.assets))) {
            return respond(res, 400, { error: 'Invalid project history' });
          }
          await atomicWrite(join(historyDirectory, `${id}.json`), JSON.stringify(next));
          return respond(res, 200, { version: next.version });
        }
      }
      return respond(res, 405, { error: 'Method not allowed' });
    }
    const match = /^\/api\/projects(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match || (match[1] && !UUID.test(match[1]))) {
      return respond(res, 404, { error: 'Not found' });
    }
    const id = match[1];
    if (req.method === 'GET') {
      const projects = await readProjects();
      if (!id) {
        return respond(res, 200, [...projects.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      }
      const project = projects.get(id);
      return project ? respond(res, 200, project) : respond(res, 404, { error: 'Project not found' });
    }
    if ((req.method === 'POST' && !id) || (req.method === 'PUT' && id)) {
      const data = await readBody(req);
      if (!data || typeof data.name !== 'string' || !data.name.trim() ||
          !data.sceneData || !Array.isArray(data.sceneData.objects) ||
          !data.sceneData.sceneOptions || typeof data.sceneData.sceneOptions !== 'object') {
        return respond(res, 400, { error: 'A project name and valid scene data are required' });
      }
      const projects = await readProjects();
      const existing = id ? projects.get(id) : undefined;
      if (id && !existing) return respond(res, 404, { error: 'Project not found' });
      const now = new Date().toISOString();
      const project = {
        id: id || randomUUID(),
        name: data.name.trim(),
        description: typeof data.description === 'string' ? data.description : '',
        sceneData: data.sceneData,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      await writeRecord({ action: 'save', id: project.id, project });
      return respond(res, existing ? 200 : 201, project);
    }
    if (req.method === 'DELETE' && id) {
      const projects = await readProjects();
      if (!projects.has(id)) return respond(res, 404, { error: 'Project not found' });
      await writeRecord({ action: 'delete', id });
      return respond(res, 200, { deleted: true });
    }
    return respond(res, 405, { error: 'Method not allowed' });
  }

  return createServer((req, res) => {
    const reportError = (error) => {
      console.error('Project API error:', error);
      if (!res.headersSent) respond(res, error.status || 500, { error: error.status ? error.message : 'Project storage failed' });
      else res.end();
    };
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (staticHandler && !pathname.startsWith('/api/')) {
      void staticHandler(req, res).catch(reportError);
    } else if (pathname.startsWith('/api/ai/')) {
      void handle(req, res).catch(reportError);
    } else {
      const operation = queue.then(() => handle(req, res));
      queue = operation.catch(reportError);
    }
  });
}
