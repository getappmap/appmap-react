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
import { autoInstrument } from '../recorder/src/instrument';

// Per-request async context (docs/design/01, "Per-request async
// context"): every request runs in its own AsyncLocalStorage context, so
// concurrent requests each record only their own events, and an
// unrecorded request's code never sees (or stamps outbound calls with)
// another request's recording. node:async_hooks works under Deno.
installAsyncContext(new AsyncLocalStorage<RecordingContext>());

// Re-export so this file can serve as the transform's `runtimeModule`.
export { autoInstrument };

declare const Deno: {
  env: { get(key: string): string | undefined };
  version?: { deno: string; typescript: string };
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  writeTextFile(path: string, text: string): Promise<void>;
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

  return async (req: Request): Promise<Response> => {
    const match = TRACEPARENT.exec(req.headers.get('traceparent') ?? '');
    // Record only stamped requests (recording-driven semantics). Every
    // stamped request gets its own recording, however many are in flight;
    // an unstamped one runs in a context with no recording at all.
    if (!match) return runUnrecorded(() => handler(req));

    patchWaitUntil();
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
      void ship(recording, dir, collector, ++seq);
    };

    let status = 500;
    try {
      const response = await runInRecording(recording, () => handler(req), token.callId);
      status = response.status;
      // Record the real response now, at its true time — not after the
      // background work. Background call/return events (fetches, SQL) land
      // after this server-response event in the flat list; that ordering
      // is unusual but valid (parent_id linkage, doc 01).
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

async function ship(
  recording: Recording,
  dir: string,
  collector: string | undefined,
  seq: number,
): Promise<void> {
  const appmap = recording.toAppMap();
  const body = JSON.stringify(appmap, null, 2);
  try {
    if (collector) {
      await fetch(collector, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      return;
    }
    const name = String(appmap.metadata.name)
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '');
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/${name}_${appmap.metadata.parent_span_id}_${String(seq).padStart(3, '0')}.appmap.json`,
    body);
  } catch (err) {
    console.warn('appmap: failed to ship recording:', err);
  }
}
