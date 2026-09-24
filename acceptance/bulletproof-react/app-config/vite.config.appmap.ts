// AppMap acceptance config: the app's own vite.config.ts plus the recorder.
// Config only; no app source is touched.
//
// The plugin is imported by relative path into node_modules instead of the
// package specifier '@funwithappmap/react-recorder/vite': the package's
// exports point at .ts source, which Node refuses to load from node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). A relative import makes
// Vite's config bundler compile it instead. See RESULTS.md, bug 1.
import { mergeConfig } from 'vite';

import { appmapVitePlugin } from './node_modules/@funwithappmap/react-recorder/src/vitePlugin';
import base from './vite.config';

export default mergeConfig(base, {
  plugins: [
    appmapVitePlugin({
      include: ['src'],
      exclude: ['src/testing'],
      app: 'bulletproof-react',
    }),
  ],
  test: {
    setupFiles: ['./appmap.setup.ts'],
  },
});
