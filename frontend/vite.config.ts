import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  base: '/ui/',
  build: {
    outDir: '../internal/server/web',
    emptyOutDir: true,
    target: 'es2022',
    rolldownOptions: {
      input: {
        client: fileURLToPath(new URL('./client/index.html', import.meta.url)),
        admin: fileURLToPath(new URL('./admin/index.html', import.meta.url)),
      },
    },
  },
  server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
});
