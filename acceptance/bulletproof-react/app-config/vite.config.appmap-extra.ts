// Runs only the acceptance's own extra test files (appmap-extra/), with the
// same recorder config and the app's own setup file (MSW server etc.).
// These files are copies/new files outside the app's src tree; no app test
// is edited.
import { mergeConfig } from 'vite';

import appmapConfig from './vite.config.appmap';

export default mergeConfig(appmapConfig, {
  test: {
    include: ['appmap-extra/**/*.test.{ts,tsx}'],
  },
});
