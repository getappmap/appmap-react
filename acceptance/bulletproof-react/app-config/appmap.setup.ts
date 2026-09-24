// AppMap acceptance: per-test recording hooks (the recorder's documented
// Vitest entry point). Added as an extra setupFiles entry by
// vite.config.appmap.ts; the app's own setup file is untouched.
import { registerAppMapHooks } from '@funwithappmap/react-recorder/vitest';

registerAppMapHooks({ app: 'bulletproof-react' });
