// Linking pass: the zero-touch config plus the one setting the recorder
// needs to link a cross-origin backend. The app (127.0.0.1:3300) calls its
// edge function on another origin (localhost:54321); the recorder stamps
// traceparent on cross-origin requests only for origins listed in
// propagateTraceHeaderOrigins (OpenTelemetry's propagateTraceHeaderCorsUrls
// model), because a header the backend's CORS does not allow makes the
// browser block the request. Linking also needs the backend to allow the
// header; at the pinned SHA this app's function does not (_shared/cors.ts),
// which is what pass P patches (an app change, diagnostic only).
import { defineConfig } from 'vite';
import { appmapVitePlugin } from '@funwithappmap/react-recorder/vite';
import { craBase, craIndexHtml, craJsx } from './cra-compat.mjs';

export default defineConfig({
  ...craBase,
  plugins: [
    craIndexHtml(),
    appmapVitePlugin({
      include: ['src'],
      app: 'supabase-edge-functions-app',
      propagateTraceHeaderOrigins: ['http://localhost:54321'],
    }),
    craJsx(),
  ],
});
