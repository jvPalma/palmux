import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { precompress } from './vite-precompress';

// Dev: Vite serves the UI and proxies the backend endpoints to a running
// palmux server (PALMUX_PORT, default 44040). Prod: the server hosts the
// built bundle from dist/, so there is no proxy.
const backendPort = process.env.PALMUX_PORT || '44040';
const backend = `http://localhost:${backendPort}`;

export default defineConfig({
  plugins: [react(), precompress()],
  resolve: {
    alias: {
      '@palmux/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    host: process.env.WEB_HOST ? true : '0.0.0.0',
    proxy: {
      '/ws': { target: backend, ws: true },
      '/auth': backend,
      '/logout': backend,
      '/ping': backend,
      '/upload': backend,
      '/new': backend,
      '/download': backend,
      '/md-file': backend,
      '/md-list': backend,
      '/files': backend,
      // ANCHORED, unlike its neighbours. A bare '/file' key matches by PREFIX,
      // so it swallowed every '/file-icons/*.svg' request and answered the SPA
      // shell — the file browser rendered fallback glyphs and nothing looked
      // broken enough to point here. The route itself is `GET /file?path=`, so
      // the only shapes that may proxy are '/file' and '/file?…'.
      '^/file(\\?.*)?$': backend,
      '/config-file': backend,
      '/ports': backend,
      '/tmux-sessions': backend,
      '/pane-file': backend,
      '/artifacts': backend,
      '/fonts': backend,
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
});
