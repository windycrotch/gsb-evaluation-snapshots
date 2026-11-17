import basicSsl from '@vitejs/plugin-basic-ssl';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Vite minifies JS and CSS but not HTML. Our index.html is simple and under our control,
 * so a few replacements are enough: drop comments and indentation, put JSON-LD on one line.
 */
function minifyHtml(): Plugin {
  return {
    name: 'minify-html',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) =>
        html
          .replace(/<!--[\s\S]*?-->/g, '')
          .replace(
            /(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/g,
            (_, open: string, json: string, close: string) => open + JSON.stringify(JSON.parse(json)) + close,
          )
          .replace(/>\s*\n\s*</g, '><')
          .replace(/\s{2,}/g, ' ')
          .trim(),
    },
  };
}

// HTTPS=1 npm run dev — self-signed certificate to open the site from a phone over LAN.
// WebCodecs and Web Share only work in a secure context (https or localhost).
export default defineConfig({
  plugins: [minifyHtml(), ...(process.env.HTTPS ? [basicSsl()] : [])],
  build: {
    target: 'es2022',
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
