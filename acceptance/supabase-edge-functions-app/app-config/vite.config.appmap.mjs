// Zero-touch pass: the recorder's Vite plugin exactly as documented
// (include src, app name for interaction recording), added to the baseline.
// Imported by its documented package entry point. (Until the recorder was
// built to dist/, that import could not load and this file imported
// './node_modules/@funwithappmap/react-recorder/src/vitePlugin.ts' instead;
// acceptance/bulletproof-react RESULTS.md, bug 1.)
import { defineConfig } from 'vite';
import { appmapVitePlugin } from '@funwithappmap/react-recorder/vite';
import { craBase, craIndexHtml, craJsx } from './cra-compat.mjs';

export default defineConfig({
  ...craBase,
  plugins: [craIndexHtml(), appmapVitePlugin({ include: ['src'], app: 'supabase-edge-functions-app' }), craJsx()],
});
