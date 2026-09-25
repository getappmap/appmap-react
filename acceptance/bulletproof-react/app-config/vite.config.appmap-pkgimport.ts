// Check A probe: the recorder's documented way to add the plugin, importing
// it by its package entry point. Expected to load; see RESULTS.md bug 1.
import { appmapVitePlugin } from '@funwithappmap/react-recorder/vite';
import { mergeConfig } from 'vite';

import base from './vite.config';

export default mergeConfig(base, {
  plugins: [appmapVitePlugin({ include: ['src'], exclude: ['src/testing'], app: 'bulletproof-react' })],
});
