import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, preview } from 'vite';
import { createProjectServer } from '../server/projects.mjs';

const directory = await mkdtemp(join(tmpdir(), 'game-editor-e2e-'));
const api = createProjectServer(join(directory, 'projects.jsonl'));
await new Promise((resolve, reject) => {
  api.once('error', reject);
  api.listen(14319, '127.0.0.1', resolve);
});
const config = {
  server: {
    host: '127.0.0.1',
    port: 15174,
    strictPort: true,
    proxy: { '/api/projects': 'http://127.0.0.1:14319', '/api/ai': 'http://127.0.0.1:14319', '/api/history': 'http://127.0.0.1:14319' },
  },
  preview: {
    host: '127.0.0.1',
    port: 15174,
    strictPort: true,
    proxy: { '/api/projects': 'http://127.0.0.1:14319', '/api/ai': 'http://127.0.0.1:14319', '/api/history': 'http://127.0.0.1:14319' },
  },
};
const isPreview = process.env.E2E_PREVIEW === '1';
const vite = isPreview ? await preview(config) : await createServer(config);
if (!isPreview) await vite.listen();

async function close() {
  if (isPreview) {
    await new Promise((resolve) => vite.httpServer.close(resolve));
  } else {
    await vite.close();
  }
  await new Promise((resolve) => api.close(resolve));
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
}
process.once('SIGINT', close);
process.once('SIGTERM', close);
