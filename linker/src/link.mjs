// The join (docs/design/02):
//
//   frontend map · http_client_request · traceparent span-id
//     == backend map · metadata.parent_span_id
//
// One interaction fans out to N fetches → 1 frontend map linked to N
// backend request maps. Maps are matched by ids, never by timestamps:
// clock skew between client and server makes causality (span ids) the
// only safe ordering.

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** @returns {{traceId: string, spanId: string, flags: string} | undefined} */
export function parseTraceparent(value) {
  const m = typeof value === 'string' ? value.match(TRACEPARENT) : null;
  return m ? { traceId: m[1], spanId: m[2], flags: m[3] } : undefined;
}

/** A frontend (interaction or test) map records outgoing requests. */
export function isFrontendMap(appmap) {
  return appmap.events?.some((e) => e.http_client_request) ?? false;
}

/** A backend request map records one incoming request. */
export function isBackendMap(appmap) {
  return appmap.events?.some((e) => e.http_server_request) ?? false;
}

/** The outgoing requests of a frontend map, with their trace ids parsed
 * from the captured traceparent header and responses paired by parent_id. */
export function outgoingRequests(appmap) {
  const requests = [];
  for (const event of appmap.events ?? []) {
    if (event.http_client_request) {
      const ctx = parseTraceparent(event.http_client_request.headers?.traceparent);
      requests.push({
        eventId: event.id,
        method: event.http_client_request.request_method,
        url: event.http_client_request.url,
        traceId: ctx?.traceId,
        spanId: ctx?.spanId,
        status: undefined,
      });
    } else if (event.http_client_response) {
      const req = requests.find((r) => r.eventId === event.parent_id);
      if (req) req.status = event.http_client_response.status_code;
    }
  }
  return requests;
}

/**
 * Join frontend maps to backend maps.
 *
 * @param {{path: string, appmap: object}[]} frontends
 * @param {{path: string, appmap: object}[]} backends
 * @returns {{links: object[], orphanBackends: string[]}}
 */
export function linkMaps(frontends, backends) {
  const bySpanId = new Map();
  for (const b of backends) {
    const spanId = b.appmap.metadata?.parent_span_id;
    if (spanId) bySpanId.set(spanId, b);
  }

  const matched = new Set();
  const links = frontends.map((f) => ({
    interaction: {
      path: f.path,
      name: f.appmap.metadata?.name,
      trace_id: f.appmap.metadata?.trace_id,
    },
    requests: outgoingRequests(f.appmap).map((req) => {
      const backend = req.spanId ? bySpanId.get(req.spanId) : undefined;
      if (backend) matched.add(backend.path);
      return {
        span_id: req.spanId ?? null,
        request: { method: req.method, url: req.url, status: req.status ?? null },
        backend: backend
          ? { path: backend.path, name: backend.appmap.metadata?.name }
          : null,
      };
    }),
  }));

  return {
    links,
    orphanBackends: backends.map((b) => b.path).filter((p) => !matched.has(p)),
  };
}
