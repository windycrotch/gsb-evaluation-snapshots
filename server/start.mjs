import { createServer as createViteServer, preview } from 'vite';
import { createProjectServer } from './projects.mjs';

const api = createProjectServer();
api.on('error', (error) => {
  console.error('Project API could not start:', error);
  process.exitCode = 1;
});

await new Promise((resolve, reject) => {
  api.once('error', reject);
  api.listen(4318, '127.0.0.1', resolve);
});

try {
  if (process.argv[2] === 'preview') {
    const server = await preview();
    server.printUrls();
  } else {
    const server = await createViteServer();
    await server.listen();
    server.printUrls();
  }
} catch (error) {
  api.close();
  throw error;
}
