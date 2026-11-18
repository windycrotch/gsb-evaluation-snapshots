import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Only the migrated pages run React in the browser. The existing server still
// owns the HTML shell, HTTP API, account queues and SSE connection.
export default defineConfig({
  plugins: [react()],
  base: "/ui/",
  build: {
    outDir: "src/ui/dist/client",
    emptyOutDir: true,
    target: "es2022",
    rolldownOptions: {
      input: fileURLToPath(
        new URL("./src/ui/client/entry.ts", import.meta.url),
      ),
      output: {
        entryFileNames: "console-client.js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
