// DIAGNOSTIC ONLY (check B): the recorder's own options set as well as they
// can be — frameworks with a version (TestRecordingOptions.frameworks), used
// with APPMAP_EVENT_VALUESIZE=99 — to see which spec version the output can
// reach through configuration alone. Not used for any other check.
import { registerAppMapHooks } from '@funwithappmap/react-recorder/vitest';

registerAppMapHooks({
  app: 'bulletproof-react',
  frameworks: [{ name: 'vitest', version: '2.1.4' }, { name: 'react', version: '18.3.1' }],
});
