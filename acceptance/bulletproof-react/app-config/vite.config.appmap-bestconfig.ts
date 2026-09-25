// DIAGNOSTIC ONLY (check B): as vite.config.appmap.ts, with the setup file
// that passes frameworks versions. Run with APPMAP_EVENT_VALUESIZE=99.
import { appmapVitePlugin } from '@funwithappmap/react-recorder/vite';
import { mergeConfig } from 'vite';

import base from './vite.config';

const apiOrigin = process.env.VITE_APP_API_URL ? new URL(process.env.VITE_APP_API_URL).origin : undefined;

export default mergeConfig(base, {
  plugins: [
    appmapVitePlugin({
      include: ['src'],
      exclude: ['src/testing'],
      app: 'bulletproof-react',
      propagateTraceHeaderOrigins: apiOrigin ? [apiOrigin] : [],
    }),
  ],
  test: { setupFiles: ['./appmap.setup.bestconfig.ts'] },
});
