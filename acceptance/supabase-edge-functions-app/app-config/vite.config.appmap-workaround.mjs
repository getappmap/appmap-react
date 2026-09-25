// Workaround pass (config only), used only so the rest of the pipeline can
// be evaluated if the zero-touch pass fails:
//  1. compile JSX-in-.js BEFORE the recorder's 'pre' transform, whose Babel
//     parser only enables JSX for .jsx/.tsx files;
//  2. rewrite the injected bare `virtual:` import to Vite's /@id/ URL
//     (acceptance/bulletproof-react RESULTS.md, bug 2).
import { defineConfig } from 'vite';
import { appmapVitePlugin } from './node_modules/@funwithappmap/react-recorder/src/vitePlugin.ts';
import { craBase, craIndexHtml, craJsx } from './cra-compat.mjs';

const virtualIdFix = {
  name: 'acceptance-appmap-virtual-id-fix',
  transformIndexHtml: {
    order: 'post',
    handler: (html) =>
      html.replace('import "virtual:appmap-interaction-recorder"', 'import "/@id/virtual:appmap-interaction-recorder"'),
  },
};

export default defineConfig({
  ...craBase,
  plugins: [
    craIndexHtml(),
    craJsx({ pre: true }),
    appmapVitePlugin({ include: ['src'], app: 'supabase-edge-functions-app' }),
    virtualIdFix,
  ],
});
