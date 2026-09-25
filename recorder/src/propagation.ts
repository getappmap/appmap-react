// Which outgoing requests get a `traceparent` header (docs/design/02,
// amendment "Cross-origin requests").
//
// A recorder must never break the app. In a browser, adding a header that
// is not CORS-safelisted to a cross-origin request makes the browser send
// a preflight, and if the server's Access-Control-Allow-Headers does not
// list `traceparent` (Supabase functions' default CORS, most APIs written
// before trace propagation was considered) the browser blocks the request
// and the app's feature stops working. So this follows OpenTelemetry's
// browser model (`propagateTraceHeaderCorsUrls`):
//
// - same-origin requests are always stamped;
// - cross-origin requests are stamped only when their origin is listed in
//   `propagateTraceHeaderOrigins` (an origin string such as
//   'https://api.example.com', a RegExp tested against the full URL, or
//   '*' for every origin);
// - where there is no page origin at all (Node, Deno: server-side code,
//   no CORS) every outgoing request is stamped, as OpenTelemetry's
//   server-side instrumentations do.
//
// Linking a frontend map to a cross-origin backend therefore needs two
// things: the backend's origin in this list, and the backend's CORS
// allowing the `traceparent` request header.
//
// Configuration, in increasing precedence:
//   1. APPMAP_PROPAGATE_TRACE_HEADER_ORIGINS (comma-separated; `/re/flags`
//      entries are regular expressions), read where `process.env` exists —
//      the Vite plugin sets it from its option so Vitest workers see it;
//   2. setPropagateTraceHeaderOrigins(), which installInteractionRecorder
//      calls with its `propagateTraceHeaderOrigins` option (the Vite
//      plugin passes its option there for zero-touch browser recording).

export type OriginPattern = string | RegExp;

export const PROPAGATE_ENV = 'APPMAP_PROPAGATE_TRACE_HEADER_ORIGINS';

let patterns: OriginPattern[] = readEnv();

/** Replace the list of cross-origin targets that get `traceparent`. */
export function setPropagateTraceHeaderOrigins(list: readonly OriginPattern[] | undefined): void {
  patterns = [...(list ?? [])];
}

export function propagateTraceHeaderOrigins(): readonly OriginPattern[] {
  return patterns;
}

/** Should a request to `url` carry the recording's traceparent? */
export function shouldPropagateTraceHeader(url: string): boolean {
  const page = pageOrigin();
  if (page === undefined) return true;
  let target: URL;
  try {
    target = new URL(url, page);
  } catch {
    return false;
  }
  if (target.origin === page) return true;
  return patterns.some((p) =>
    typeof p === 'string' ? p === '*' || normalizeOrigin(p) === target.origin : p.test(target.href),
  );
}

/** Serialize patterns for an env var / define (RegExp as `/source/flags`). */
export function serializeOriginPatterns(list: readonly OriginPattern[]): string {
  return list.map((p) => (typeof p === 'string' ? p : `/${p.source}/${p.flags}`)).join(',');
}

export function parseOriginPatterns(raw: string | undefined): OriginPattern[] {
  if (!raw) return [];
  const out: OriginPattern[] = [];
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const re = /^\/(.+)\/([a-z]*)$/.exec(entry);
    if (re) {
      try {
        out.push(new RegExp(re[1], re[2]));
        continue;
      } catch {
        // not a valid regex: treat as a literal origin below
      }
    }
    out.push(entry);
  }
  return out;
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

/** The page's origin in a browser (or jsdom); undefined server-side.
 * Deno throws on `location` unless run with --location, hence the try. */
function pageOrigin(): string | undefined {
  try {
    const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
    return origin && origin !== 'null' ? origin : undefined;
  } catch {
    return undefined;
  }
}

function readEnv(): OriginPattern[] {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    return parseOriginPatterns(env?.[PROPAGATE_ENV]);
  } catch {
    return [];
  }
}
