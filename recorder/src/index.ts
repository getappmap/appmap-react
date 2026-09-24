export type * from './types.js';
export {
  Recording,
  formatValue,
  VALUE_SIZE_CAP,
  setValueSizeCap,
  type CallToken,
  type ObjectIdTracker,
} from './recording.js';
import { setValueSizeCap as __setValueSizeCap } from './recording.js';

// APPMAP_EVENT_VALUESIZE, like the .NET agent: the in-page recorder has
// no process.env of its own, so the Vite plugin injects this constant
// into the client bundle (define) when the env var is set at build/dev
// time; `typeof` is safe here even when the identifier is never defined.
declare const __APPMAP_EVENT_VALUESIZE__: number | undefined;
// eslint-disable-next-line no-undef
if (typeof __APPMAP_EVENT_VALUESIZE__ !== 'undefined') {
  __setValueSizeCap(__APPMAP_EVENT_VALUESIZE__);
}
export { startRecording, stopRecording, activeRecording } from './session.js';
export {
  instrument,
  instrumentComponent,
  instrumentHook,
  instrumentHandler,
  autoInstrument,
} from './instrument.js';
export {
  installInteractionRecorder,
  COLLECTOR_PATH,
  type InteractionRecorderOptions,
} from './interactionRecording.js';
// Test recording (node:fs) deliberately lives behind the './vitest'
// entry point: this module must stay loadable in a browser bundle.
