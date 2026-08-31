export type * from './types';
export { Recording, formatValue, VALUE_SIZE_CAP, type CallToken } from './recording';
export { startRecording, stopRecording, activeRecording } from './session';
export {
  instrument,
  instrumentComponent,
  instrumentHook,
  instrumentHandler,
  autoInstrument,
} from './instrument';
export {
  installInteractionRecorder,
  COLLECTOR_PATH,
  type InteractionRecorderOptions,
} from './interactionRecording';
// Test recording (node:fs) deliberately lives behind the './vitest'
// entry point: this module must stay loadable in a browser bundle.
