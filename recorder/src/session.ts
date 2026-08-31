import { Recording } from './recording';
import { patchFetch, unpatchFetch } from './fetchPatch';

// Session resolution — the doc 01 decision. One ambient session at a time:
// a module-level global, not AsyncLocalStorage / Zone.js. Test recording
// (one AppMap per RTL test, tests run sequentially per worker) and browser
// interaction windows (single-threaded, one window open at a time) both
// satisfy the invariant. See docs/design/01-recording-sessions-and-
// interaction-windows.md for why the async gap is deferred, not solved here.

let current: Recording | undefined;

export function startRecording(recording: Recording): Recording {
  if (current) {
    throw new Error(
      `a recording ("${current.metadata.name}") is already active; stop it before starting "${recording.metadata.name}"`,
    );
  }
  current = recording;
  patchFetch();
  return recording;
}

export function stopRecording(): Recording {
  if (!current) throw new Error('no active recording');
  const finished = current;
  current = undefined;
  unpatchFetch();
  return finished;
}

export function activeRecording(): Recording | undefined {
  return current;
}
