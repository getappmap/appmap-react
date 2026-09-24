// Zero-touch pass: the recorder's Vite plugin exactly as documented
// (include src, app name for interaction recording), added to the baseline.
// Imported by relative path into node_modules, not '@funwithappmap/react-recorder/vite':
// the package exports .ts source that Node will not load from node_modules
// (same as acceptance/bulletproof-react RESULTS.md, bug 1).
import { defineConfig } from 'vite';
import { appmapVitePlugin } from './node_modules/@funwithappmap/react-recorder/src/vitePlugin.ts';
import { craBase, craIndexHtml, craJsx } from './cra-compat.mjs';

export default defineConfig({
  ...craBase,
  plugins: [craIndexHtml(), appmapVitePlugin({ include: ['src'], app: 'supabase-edge-functions-app' }), craJsx()],
});
