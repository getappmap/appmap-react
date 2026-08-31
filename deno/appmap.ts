// Deno session driver: per-request AppMap recording for Deno.serve /
// Supabase edge functions — the Deno twin of the PetClinicGo middleware
// (docs/design/02). One AppMap per traceparent-carrying request, with
// the incoming trace-id and span-id copied into metadata so appmap-link
// can join it to the frontend interaction map. While the recording is
// open, the function's own outbound fetches are stamped and recorded
// too, so an edge function shows up as a middle tier in the stitch.
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
// This file is not part of the Node/Vitest suite; it is exercised by
// the Deno validation procedure in docs (this repo has no Deno in CI yet).

import {
  Recording,
  startRecording,
  stopRecording,
  activeRecording,
  autoInstrument,
} from '../recorder/src/index';

// Re-export so this file can serve as the transform's `runtimeModule`.
export { autoInstrument };

declare const Deno: {
  env: { get(key: string): string | undefined };
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  writeTextFile(path: string, text: string): Promise<void>;
};

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

type Handler = (req: Request) => Response | Promise<Response>;

export interface WithAppMapOptions {
  app?: string;
  /** Output directory; default APPMAP_DIR or tmp/appmap/requests. */
  dir?: string;
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
    if (!match || activeRecording()) return handler(req);

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
    let status = 500;
    try {
      const response = await handler(req);
      status = response.status;
      return response;
    } finally {
      recording.httpServerResponse(token, status);
      stopRecording();
      void ship(recording, dir, collector, ++seq);
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
