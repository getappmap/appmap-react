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
// (sloppy imports because the recorder core uses extensionless
// relative imports). Output: APPMAP_DIR (default tmp/appmap/requests),
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
import { Recording } from '../recorder/src/recording';
import { startRecording, stopRecording, activeRecording } from '../recorder/src/session';
import { autoInstrument } from '../recorder/src/instrument';

// Re-export so this file can serve as the transform's `runtimeModule`.
export { autoInstrument };

declare const Deno: {
  env: { get(key: string): string | undefined };
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

// Promises the current recording is waiting on before it closes — the
// background tasks the handler handed to EdgeRuntime.waitUntil (docs/design/11).
// Module-level because EdgeRuntime.waitUntil is a shared global and the
// one-at-a-time recording invariant (doc 01) guarantees only one
// recording is collecting at a time. `undefined` outside a recording, so
// the patch never touches waitUntil calls we aren't recording.
let pendingWaitUntil: Promise<unknown>[] | undefined;
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
    if (pendingWaitUntil) pendingWaitUntil.push(Promise.resolve(promise).catch(() => {}));
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
    // Record only stamped requests (recording-driven semantics), and only
    // one at a time — the ambient-session invariant from doc 01. A
    // request arriving while another is being recorded runs unrecorded.
    // (With waitUntil capture, "being recorded" now extends through the
    // background window; a request arriving during it is skipped, doc 11.)
    if (!match || activeRecording()) return handler(req);

    patchWaitUntil();
    const url = new URL(req.url);
    const recording = startRecording(
      new Recording({
        name: `${req.method} ${url.pathname}`,
        app: options.app,
        language: { name: 'typescript', engine: 'deno' },
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

    const token = recording.httpServerRequest(req.method, url.pathname, {
      traceparent: match[0],
    });
    // Collect waitUntil promises the handler registers during its (sync
    // path to the) response.
    const deferred: Promise<unknown>[] = [];
    pendingWaitUntil = deferred;

    const finalize = (): void => {
      pendingWaitUntil = undefined;
      stopRecording();
      void ship(recording, dir, collector, ++seq);
    };

    let status = 500;
    try {
      const response = await handler(req);
      status = response.status;
      // Record the real response now, at its true time — not after the
      // background work. Background call/return events (fetches, SQL) land
      // after this server-response event in the flat list; that ordering
      // is unusual but valid (parent_id linkage, doc 01).
      recording.httpServerResponse(token, status);
      pendingWaitUntil = undefined; // handler done registering
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
