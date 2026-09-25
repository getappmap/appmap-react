// Deno session driver: per-request AppMap recording for Deno.serve /
// Supabase edge functions — the Deno twin of the PetClinicGo middleware
// (docs/design/02). One AppMap per traceparent-carrying request, with
// the incoming trace-id and span-id copied into metadata so appmap-link
// can join it to the frontend interaction map. While the recording is
// open, the function's own outbound fetches are stamped and recorded
// too, so an edge function shows up as a middle tier in the stitch.
//
// Background work handed to EdgeRuntime.waitUntil (a handler that returns
// 202 immediately and scrapes/synthesizes in the background) is captured
// too: the recording stays open until those tasks settle, without
// delaying the response. See docs/design/11.
//
// Usage (after transforming the function source with
// recorder/bin/transform-file.ts, runtime module pointed at this file):
//
//   import { withAppMap } from './appmap.ts';
//   Deno.serve(withAppMap(handleRequest, { app: 'what2say' }));
//
// Run with: deno run -A --unstable-sloppy-imports <entry>
// (sloppy imports because the recorder core imports its siblings as
// `./x.js` — what its Node build needs — and Deno maps those to the .ts
// sources only with sloppy imports). Output: APPMAP_DIR (default tmp/appmap/requests),
// or POSTed to APPMAP_COLLECTOR if set.
//
// This file is not part of the Node/Vitest suite — it's exercised by
// deno/appmap_test.ts, run via `deno test` and wired into the `deno`
// job in .github/workflows/ci.yml.

// Import directly from the specific submodules the driver needs, not
// the './index' barrel — that barrel also re-exports
// interactionRecording.ts, which is typed against browser DOM globals
// (document, Element, HTMLInputElement) that don't exist under Deno's
// type checker. This was never actually exercised until
// deno/appmap_test.ts (added alongside CI automation) started running
// `deno check` for the first time.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Recording } from '../recorder/src/recording';
import {
  activeRecording,
  closeScopedRecording,
  installAsyncContext,
  openScopedRecording,
  runInRecording,
  runUnrecorded,
  type RecordingContext,
} from '../recorder/src/session';
import { autoInstrument, instrumentHandler } from '../recorder/src/instrument';

// Per-request async context (docs/design/01, "Per-request async
// context"): every request runs in its own AsyncLocalStorage context, so
// concurrent requests each record only their own events, and an
// unrecorded request's code never sees (or stamps outbound calls with)
// another request's recording. node:async_hooks works under Deno.
installAsyncContext(new AsyncLocalStorage<RecordingContext>());

// Re-export so this file can serve as the transform's `runtimeModule`:
// the transform imports autoInstrument, plus instrumentHandler for
// closures nested inside instrumented functions.
export { autoInstrument, instrumentHandler };

declare const Deno: {
  env: { get(key: string): string | undefined };
  version?: { deno: string; typescript: string };
  pid?: number;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  writeTextFile(path: string, text: string): Promise<void>;
  // Used for crash safety only; absent under the Node/Vitest stub.
  mkdirSync?(path: string, options?: { recursive?: boolean }): void;
  writeTextFileSync?(path: string, text: string): void;
  rename?(from: string, to: string): Promise<void>;
  renameSync?(from: string, to: string): void;
  remove?(path: string): Promise<void>;
  removeSync?(path: string): void;
  readDirSync?(path: string): Iterable<{ name: string; isFile: boolean }>;
  addSignalListener?(signal: string, handler: () => void): void;
  removeSignalListener?(signal: string, handler: () => void): void;
  kill?(pid: number, signal: string): void;
  unrefTimer?(id: number): void;
};

// Supabase Edge Runtime (and Deno Deploy) expose a global EdgeRuntime
// with waitUntil(promise), used to keep the isolate alive for background
// work after the response is sent. See patchWaitUntil / withAppMap below
// and docs/design/11.
declare const EdgeRuntime:
  | { waitUntil?: (promise: Promise<unknown>) => void }
  | undefined;

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

type Handler = (req: Request) => Response | Promise<Response>;

export interface WithAppMapOptions {
  app?: string;
  /** Output directory; default APPMAP_DIR or tmp/appmap/requests. */
  dir?: string;
}

// Promises each open recording is waiting on before it closes — the
// background tasks its handler handed to EdgeRuntime.waitUntil
// (docs/design/11). EdgeRuntime.waitUntil is one shared global, so the
// patch looks up the recording of the *calling* async context; a
// recording is only in here while its handler is running, so the patch
// never touches waitUntil calls we aren't recording.
const pendingWaitUntil = new WeakMap<Recording, Promise<unknown>[]>();
let waitUntilPatched = false;

// Wrap EdgeRuntime.waitUntil once so that, while a recording is open,
// every background promise the handler registers is also awaited by the
// recorder before it closes and ships. Without this the recording closes
// the instant the handler returns its (often 202) response, and a
// scrape/synthesis pipeline running under waitUntil — which is the whole
// point of waitUntil — is never captured (finding E0a from a real-app
// pilot). No-ops cleanly where EdgeRuntime/waitUntil don't exist (plain
// `deno run`, the Node/Vitest tests), leaving today's handler-scoped
// behavior unchanged.
function patchWaitUntil(): void {
  if (waitUntilPatched) return;
  const er = typeof EdgeRuntime !== 'undefined' ? EdgeRuntime : undefined;
  if (!er || typeof er.waitUntil !== 'function') return;
  const original = er.waitUntil.bind(er);
  er.waitUntil = (promise: Promise<unknown>): void => {
    // Swallow rejections in our copy only (so allSettled can't be
    // skewed); the original still sees the unaltered promise.
    const recording = activeRecording();
    const pending = recording && pendingWaitUntil.get(recording);
    if (pending) pending.push(Promise.resolve(promise).catch(() => {}));
    original(promise);
  };
  waitUntilPatched = true;
}

export function withAppMap(handler: Handler, options: WithAppMapOptions = {}): Handler {
  const dir = options.dir ?? Deno.env.get('APPMAP_DIR') ?? 'tmp/appmap/requests';
  const collector = Deno.env.get('APPMAP_COLLECTOR');
  let seq = 0;
  // A previous process killed outright (kill -9) left its last snapshot
  // as a .part file: it is already a valid, truncated map — keep it.
  if (!collector) healPartialRecordings(dir);

  return async (req: Request): Promise<Response> => {
    const match = TRACEPARENT.exec(req.headers.get('traceparent') ?? '');
    // Record only stamped requests (recording-driven semantics). Every
    // stamped request gets its own recording, however many are in flight;
    // an unstamped one runs in a context with no recording at all.
    if (!match) return runUnrecorded(() => handler(req));

    patchWaitUntil();
    installCrashHandlers();
    const url = new URL(req.url);
    const recording = openScopedRecording(
      new Recording({
        name: `${req.method} ${url.pathname}`,
        app: options.app,
        // The spec requires language.version: the TypeScript version
        // Deno compiles with (engine: deno). Unknown only under a stub.
        language: { name: 'typescript', engine: 'deno', version: Deno.version?.typescript ?? 'unknown' },
        client: {
          name: '@funwithappmap/react-recorder',
          url: 'https://github.com/getappmap/appmap-react',
        },
        recorder: { name: 'funwithappmap-deno', type: 'requests' },
      }),
    );
    // A backend request map carries the caller's ids, not its own.
    recording.metadata.trace_id = match[1];
    recording.metadata.parent_span_id = match[2];
    const tracked = track(recording, collector ? undefined : recordingPath(recording, dir, ++seq));

    const token = recording.httpServerRequest(
      req.method,
      url.pathname,
      { traceparent: match[0] },
      undefined,
      url.searchParams,
    );
    // Collect waitUntil promises the handler registers during its (sync
    // path to the) response.
    const deferred: Promise<unknown>[] = [];
    pendingWaitUntil.set(recording, deferred);

    const finalize = (): void => {
      pendingWaitUntil.delete(recording);
      closeScopedRecording(recording);
      void ship(tracked, collector);
    };

    let status = 500;
    try {
      const response = await runInRecording(recording, () => handler(req), token.callId);
      status = response.status;
      // Record the real response now, at its true time — not after the
      // background work. In the serialized map the background calls nest
      // under the request (doc 12), so this return comes after them.
      recording.httpServerResponse(token, status);
      pendingWaitUntil.delete(recording); // handler done registering
      if (deferred.length > 0) {
        // Do NOT block the response on the background work — that is why
        // the handler used waitUntil. Keep the recording open and finalize
        // once the background settles.
        void Promise.allSettled(deferred).then(finalize);
      } else {
        finalize();
      }
      return response;
    } catch (err) {
      recording.httpServerResponse(token, status);
      finalize();
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// Shipping, and crash safety (docs/design/11, "Crashes").
//
// A recording is written once, when it closes. So that a process that
// dies first still leaves a map behind:
//
// - SIGINT / SIGTERM, an uncaught error or unhandled rejection, and a
//   normal exit with recordings still open write every open recording
//   synchronously, self-healed and marked truncated. A signal then takes
//   its default course (the process ends as it would have) unless the
//   app has its own listener for it.
// - kill -9 can't be caught, so a recording still open after
//   SNAPSHOT_FIRST_MS is snapshotted to `<file>.part` (written to a temp
//   file, then renamed, so it is always a whole, valid map) every
//   SNAPSHOT_EVERY_MS while it changes. The next withAppMap() in that
//   directory — or the appmap-deno runner, when its child dies — renames
//   a leftover .part to .appmap.json. It is at most one interval stale.
//
// Collector mode (APPMAP_COLLECTOR) posts over the network and has no
// file to fall back on; crash safety covers file output only.

const SNAPSHOT_FIRST_MS = 250;
const SNAPSHOT_EVERY_MS = 500;

interface Tracked {
  recording: Recording;
  /** Final file; undefined in collector mode. */
  path?: string;
  timer?: ReturnType<typeof setTimeout>;
  /** Event count at the last snapshot. */
  snapshotAt: number;
  hasPart: boolean;
  /** Serializes snapshot writes and the final write. */
  writing: Promise<void>;
  done: boolean;
}

const openTracked = new Set<Tracked>();

function recordingPath(recording: Recording, dir: string, seq: number): string {
  const name = String(recording.metadata.name)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${dir}/${name}_${recording.metadata.parent_span_id}_${String(seq).padStart(3, '0')}.appmap.json`;
}

function track(recording: Recording, path: string | undefined): Tracked {
  const t: Tracked = { recording, path, snapshotAt: -1, hasPart: false, writing: Promise.resolve(), done: false };
  openTracked.add(t);
  if (path && typeof Deno.rename === 'function') scheduleSnapshot(t, SNAPSHOT_FIRST_MS);
  return t;
}

function scheduleSnapshot(t: Tracked, ms: number): void {
  t.timer = setTimeout(() => {
    if (t.done) return;
    if (t.recording.events.length !== t.snapshotAt) {
      t.snapshotAt = t.recording.events.length;
      const body = JSON.stringify(t.recording.toAppMap(), null, 2);
      const part = `${t.path}.part`;
      t.writing = t.writing.then(async () => {
        if (t.done) return;
        try {
          await Deno.mkdir(dirOf(part), { recursive: true });
          await Deno.writeTextFile(`${part}.tmp`, body);
          await Deno.rename!(`${part}.tmp`, part);
          t.hasPart = true;
        } catch (err) {
          console.warn('appmap: failed to write partial recording:', err);
        }
      });
    }
    scheduleSnapshot(t, SNAPSHOT_EVERY_MS);
  }, ms);
  // Never keep the process alive just to snapshot.
  if (typeof t.timer === 'number') Deno.unrefTimer?.(t.timer);
  else (t.timer as { unref?: () => void } | undefined)?.unref?.();
}

async function ship(t: Tracked, collector: string | undefined): Promise<void> {
  clearTimeout(t.timer);
  openTracked.delete(t);
  await t.writing;
  t.done = true;
  const body = JSON.stringify(t.recording.toAppMap(), null, 2);
  try {
    if (collector) {
      await fetch(collector, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      return;
    }
    await Deno.mkdir(dirOf(t.path!), { recursive: true });
    await Deno.writeTextFile(t.path!, body);
    if (t.hasPart) await Deno.remove?.(`${t.path}.part`).catch(() => {});
  } catch (err) {
    console.warn('appmap: failed to ship recording:', err);
  }
}

/** Write every open recording now, synchronously: the process is about
 * to end. Each is self-healed and marked truncated by toAppMap(). */
function flushOpenRecordings(): void {
  if (typeof Deno.writeTextFileSync !== 'function') return;
  for (const t of openTracked) {
    if (!t.path || t.done) continue;
    t.done = true;
    clearTimeout(t.timer);
    try {
      Deno.mkdirSync?.(dirOf(t.path), { recursive: true });
      Deno.writeTextFileSync(t.path, JSON.stringify(t.recording.toAppMap(), null, 2));
      if (t.hasPart) {
        try {
          Deno.removeSync?.(`${t.path}.part`);
        } catch {
          // already gone
        }
      }
    } catch (err) {
      console.warn('appmap: failed to flush recording:', err);
    }
  }
  openTracked.clear();
}

// Signal listeners the app itself registered (Deno.addSignalListener is
// wrapped at module load, before app code runs), so a signal only takes
// its default course after the flush when nobody else handles it.
const appSignalListeners = new Map<string, number>();
const ownSignalHandlers = new Set<() => void>();
if (
  typeof Deno !== 'undefined' &&
  typeof Deno.addSignalListener === 'function' &&
  typeof Deno.removeSignalListener === 'function'
) {
  const add = Deno.addSignalListener.bind(Deno);
  const remove = Deno.removeSignalListener.bind(Deno);
  Deno.addSignalListener = (signal: string, handler: () => void) => {
    if (!ownSignalHandlers.has(handler)) appSignalListeners.set(signal, (appSignalListeners.get(signal) ?? 0) + 1);
    add(signal, handler);
  };
  Deno.removeSignalListener = (signal: string, handler: () => void) => {
    if (!ownSignalHandlers.has(handler)) appSignalListeners.set(signal, Math.max(0, (appSignalListeners.get(signal) ?? 0) - 1));
    remove(signal, handler);
  };
}
let crashHandlersInstalled = false;

function installCrashHandlers(): void {
  if (crashHandlersInstalled) return;
  crashHandlersInstalled = true;
  if (typeof Deno.addSignalListener === 'function') {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const onSignal = () => {
        flushOpenRecordings();
        Deno.removeSignalListener?.(signal, onSignal);
        // Re-raise with no listener left: the default action ends the
        // process exactly as it would have without the recorder.
        if (!appSignalListeners.get(signal) && Deno.pid !== undefined) Deno.kill?.(Deno.pid, signal);
      };
      ownSignalHandlers.add(onSignal);
      try {
        Deno.addSignalListener(signal, onSignal);
      } catch {
        // signal not supported on this platform
      }
    }
  }
  const target = globalThis as { addEventListener?: (type: string, listener: () => void) => void };
  for (const type of ['error', 'unhandledrejection', 'unload']) target.addEventListener?.(type, flushOpenRecordings);
}

function healPartialRecordings(dir: string): void {
  if (typeof Deno.readDirSync !== 'function' || typeof Deno.renameSync !== 'function') return;
  try {
    for (const entry of Deno.readDirSync(dir)) {
      if (entry.isFile && entry.name.endsWith('.appmap.json.part')) {
        Deno.renameSync(`${dir}/${entry.name}`, `${dir}/${entry.name.slice(0, -'.part'.length)}`);
      }
    }
  } catch {
    // no directory yet: nothing to heal
  }
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '.' : path.slice(0, i);
}
