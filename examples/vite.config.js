import fs from 'node:fs';
import path from 'node:path';

// dev-only helper: the demo's bench and capture hooks POST results and frames here; they land in <repo>/out/
const save = () => ({
  name: 'three-nanite-save',
  configureServer(server) {
    server.middlewares.use('/__save', (req, res) => {
      const url = new URL(req.url, 'http://x');
      const name = (url.searchParams.get('name') || 'x').replace(/[^\w.\-/]/g, '_').replace(/\.\./g, '_');
      const file = path.join(import.meta.dirname, '..', 'out', name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { fs.writeFileSync(file, Buffer.concat(chunks)); res.end('ok'); });
    });
  },
});

export default {
  plugins: [save()],
  // the examples import the library by its package name, exactly as a consumer would
  resolve: { alias: { 'three-nanite': path.join(import.meta.dirname, '..', 'src', 'index.js') } },
  server: { port: 5291 },
  build: { target: 'esnext', rollupOptions: { input: { main: path.join(import.meta.dirname, 'index.html'), webgpu: path.join(import.meta.dirname, 'webgpu.html'), minimal: path.join(import.meta.dirname, 'minimal.html') } } },
};
