// DIAGNOSTIC ONLY (check B): as vite.config.appmap.ts, with the setup file
// that passes frameworks versions. Run with APPMAP_EVENT_VALUESIZE=99.
import { mergeConfig } from 'vite';

import { appmapVitePlugin } from './node_modules/@funwithappmap/react-recorder/src/vitePlugin';
import base from './vite.config';

export default mergeConfig(base, {
  plugins: [appmapVitePlugin({ include: ['src'], exclude: ['src/testing'], app: 'bulletproof-react' })],
  test: { setupFiles: ['./appmap.setup.bestconfig.ts'] },
});
