import type { Recording } from './recording.js';
import { patchFetch, unpatchFetch } from './fetchPatch.js';
import { patchXhr, unpatchXhr } from './xhrPatch.js';

// Session resolution — the doc 01 decision, amended (docs/design/01,
// "Per-request async context"). Two ways a recording can be "the one
// events go to":
//
// - Ambient: one module-level recording at a time (startRecording /
//   stopRecording). Test recording (one AppMap per RTL test, tests run
//   sequentially per worker) and browser interaction windows use it. The
//   browser has no async context, so this is all it can have.
//
// - Scoped: where an AsyncLocalStorage exists (Deno, Node), a driver
//   installs it with installAsyncContext() and runs each recorded unit of
//   work inside runInRecording(). activeRecording() then answers from the
//   *current async context*, so concurrent requests each see only their
//   own recording, and code running for an unrecorded request
//   (runUnrecorded) sees none at all — it is never recorded or stamped,
//   even while other recordings are open.
//
// The same context also carries the innermost instrumented call, so a
// call made from an async continuation (after an await, in a timer, in
// background work) is attributed to the call that started it — see
// currentCallId / runInCall.

/** What the async context holds. */
export interface RecordingContext {
  /** True inside runInRecording / runUnrecorded: the context alone
   * decides which recording (if any) is active; the ambient one is not
   * consulted. */
  scoped: boolean;
  recording?: Recording;
  /** Innermost instrumented call open in this async context… */
  callId?: number;
  /** …and the recording that call belongs to. */
  callRecording?: Recording;
}

/** The subset of node:async_hooks' AsyncLocalStorage the recorder uses.
 * Kept structural so this module never imports node:async_hooks itself
 * and stays loadable in a browser bundle. */
export interface AsyncContextStorage {
  getStore(): RecordingContext | undefined;
  run<R>(store: RecordingContext, fn: () => R): R;
}

let current: Recording | undefined;
let storage: AsyncContextStorage | undefined;
// Recordings currently open, ambient or scoped. The outbound-request
// patches stay installed while any is open.
let openCount = 0;
const closed = new WeakSet<Recording>();

function retainPatches(): void {
  if (openCount++ === 0) {
    patchFetch();
    patchXhr();
  }
}

function releasePatches(): void {
  if (openCount > 0 && --openCount === 0) {
    unpatchFetch();
    unpatchXhr();
  }
}

/** Install the async-context store (an AsyncLocalStorage). Idempotent:
 * the first store installed wins, so every driver shares one. */
export function installAsyncContext(store: AsyncContextStorage): void {
  if (!storage) storage = store;
}

export function hasAsyncContext(): boolean {
  return storage !== undefined;
}

export function startRecording(recording: Recording): Recording {
  if (current) {
    throw new Error(
      `a recording ("${current.metadata.name}") is already active; stop it before starting "${recording.metadata.name}"`,
    );
  }
  current = recording;
  retainPatches();
  return recording;
}

export function stopRecording(): Recording {
  if (!current) throw new Error('no active recording');
  const finished = current;
  current = undefined;
  releasePatches();
  return finished;
}

/** Open a scoped recording. Events reach it only from code run inside
 * runInRecording(recording, …). Requires installAsyncContext(). */
export function openScopedRecording(recording: Recording): Recording {
  if (!storage) throw new Error('openScopedRecording needs installAsyncContext() first');
  retainPatches();
  return recording;
}

/** Close a scoped recording. Work still running in its context (e.g.
 * un-awaited background promises) is from now on neither recorded nor
 * stamped. Idempotent. */
export function closeScopedRecording(recording: Recording): void {
  if (closed.has(recording)) return;
  closed.add(recording);
  releasePatches();
}

/** Run fn (and every async continuation it spawns) with `recording` as
 * the active recording; `callId` makes the calls fn makes children of
 * that call (e.g. the http_server_request of a recorded request). */
export function runInRecording<R>(recording: Recording, fn: () => R, callId?: number): R {
  if (!storage) throw new Error('runInRecording needs installAsyncContext() first');
  return storage.run({ scoped: true, recording, callId, callRecording: recording }, fn);
}

/** Run fn with no active recording, whatever else is open. */
export function runUnrecorded<R>(fn: () => R): R {
  return storage ? storage.run({ scoped: true }, fn) : fn();
}

export function activeRecording(): Recording | undefined {
  const ctx = storage?.getStore();
  if (ctx?.scoped) return ctx.recording && !closed.has(ctx.recording) ? ctx.recording : undefined;
  return current;
}

/** The innermost instrumented call of `recording` open in the current
 * async context, if the runtime has async context. */
export function currentCallId(recording: Recording): number | undefined {
  const ctx = storage?.getStore();
  return ctx?.callRecording === recording ? ctx.callId : undefined;
}

/** Run fn as the body of call `callId`, so calls made from it —
 * synchronously or from its async continuations — nest under it. */
export function runInCall<R>(recording: Recording, callId: number, fn: () => R): R {
  if (!storage) return fn();
  const ctx = storage.getStore();
  return storage.run(
    { scoped: ctx?.scoped ?? false, recording: ctx?.recording, callId, callRecording: recording },
    fn,
  );
}
