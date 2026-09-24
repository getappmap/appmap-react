// AppMap acceptance config: the app's own vite.config.ts plus the recorder.
// Config only; no app source is touched.
//
// The plugin is imported by its documented package entry point. (Until the
// recorder was built to dist/, that import could not load and this file
// imported './node_modules/@funwithappmap/react-recorder/src/vitePlugin'
// instead; RESULTS.md, bug 1.)
//
// propagateTraceHeaderOrigins: the app calls its API on another origin
// (VITE_APP_API_URL: https://api.bulletproofapp.com under Vitest/MSW,
// http://localhost:8080 in the browser runs). The recorder stamps
// traceparent on cross-origin requests only for listed origins, so linking
// to this backend takes this one setting (and a backend that allows the
// header: the app's mock server reflects any requested header). Without
// it, every request is still recorded, just not stamped.
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
  test: {
    setupFiles: ['./appmap.setup.ts'],
  },
});
