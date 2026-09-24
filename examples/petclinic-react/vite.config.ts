/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { appmapVitePlugin } from '../../recorder/src/vitePlugin';

// The recorder workspace ships TypeScript source (it's a spike, no build
// step); alias straight to it so Vite/Vitest transpile it like app code.
const recorderSrc = (file: string) =>
  fileURLToPath(new URL(`../../recorder/src/${file}`, import.meta.url));

export default defineConfig({
  // appmap.yml equivalent: instrument everything under src/. The plugin
  // is dev/test-only; production builds get untouched code. `app` also
  // injects interaction recording without application code changes.
  plugins: [appmapVitePlugin({ include: ['src'], app: 'petclinic-react' }), react()],
  resolve: {
    alias: [
      { find: '@funwithappmap/react-recorder/vitest', replacement: recorderSrc('vitest.ts') },
      { find: '@funwithappmap/react-recorder', replacement: recorderSrc('index.ts') },
    ],
  },
  server: {
    proxy: {
      // PetClinicGo backend (examples/PetClinicGo in the sibling repo).
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
  },
});
