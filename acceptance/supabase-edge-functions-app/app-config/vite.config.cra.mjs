// Baseline: the app under Vite with NO recorder (for J, overhead, and to
// show the app itself works in this harness).
import { defineConfig } from 'vite';
import { craBase, craIndexHtml, craJsx } from './cra-compat.mjs';

export default defineConfig({ ...craBase, plugins: [craIndexHtml(), craJsx()] });
