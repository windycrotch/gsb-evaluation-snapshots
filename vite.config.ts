import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api/projects': 'http://127.0.0.1:4318', '/api/ai': 'http://127.0.0.1:4318', '/api/history': 'http://127.0.0.1:4318' },
  },
  preview: {
    proxy: { '/api/projects': 'http://127.0.0.1:4318', '/api/ai': 'http://127.0.0.1:4318', '/api/history': 'http://127.0.0.1:4318' },
  },
});
