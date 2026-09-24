import { activeRecording } from './session.js';
import { randomHex } from './recording.js';

// Wraps globalThis.fetch while a recording is active, emitting
// http_client_request / http_client_response events. Composes with MSW:
// MSW intercepts inside the underlying fetch we delegate to.
//
// This is also where full-stack linking starts (docs/design/02): every
// request made during a recording is stamped with a W3C Trace Context
// traceparent header — the recording's trace-id plus a fresh span-id per
// request. The backend agent copies it into its request AppMap's
// metadata; the linker joins on span-id. Requests are only ever stamped
// while a recording is active, so production traffic is untouched.
// XMLHttpRequest (axios) gets the same treatment in xhrPatch.ts.

let originalFetch: typeof globalThis.fetch | undefined;

/** Headers worth capturing on events; everything else is noise at this stage. */
export const CAPTURED_REQUEST_HEADERS = ['content-type', 'accept', 'traceparent'];
export const CAPTURED_RESPONSE_HEADERS = ['content-type'];

export function patchFetch(): void {
  if (originalFetch) return;
  const underlying = globalThis.fetch;
  originalFetch = underlying;

  globalThis.fetch = async function recordedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const recording = activeRecording();
    if (!recording) return underlying(input, init);

    const request = new Request(input, init);
    request.headers.set('traceparent', `00-${recording.traceId}-${randomHex(8)}-01`);
    const token = recording.httpClientRequest(
      request.method,
      request.url,
      pickHeaders(request.headers, CAPTURED_REQUEST_HEADERS),
    );
    try {
      const response = await underlying(request);
      recording.httpClientResponse(
        token,
        response.status,
        pickHeaders(response.headers, CAPTURED_RESPONSE_HEADERS),
      );
      return response;
    } catch (err) {
      // Network-level failure: no response. Record status 0 so the event
      // pair stays balanced and the failure is visible in the map.
      recording.httpClientResponse(token, 0);
      throw err;
    }
  };
}

export function unpatchFetch(): void {
  if (!originalFetch) return;
  globalThis.fetch = originalFetch;
  originalFetch = undefined;
}

function pickHeaders(headers: Headers, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}
