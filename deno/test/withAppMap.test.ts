import { describe, it, expect, beforeEach, vi } from 'vitest';
import { withAppMap } from '../appmap.ts';

// withAppMap (deno/appmap.ts) has real logic beyond the Recording
// primitive already covered in examples/petclinic-react/test/
// serverRecording.test.ts: traceparent-gated routing, the one-
// recording-at-a-time invariant, and the file-vs-collector ship path.
// None of that had test coverage — this file closes that gap by
// stubbing the three Deno.* calls the driver makes, so it runs under
// plain Node/Vitest with no Deno binary required.

const TRACE = 'a'.repeat(32);

function stampedRequest(spanId: string, url = 'http://localhost/hello?x=1') {
  return new Request(url, { headers: { traceparent: `00-${TRACE}-${spanId}-01` } });
}

function plainRequest(url = 'http://localhost/hello') {
  return new Request(url);
}

describe('withAppMap', () => {
  let writeTextFile: ReturnType<typeof vi.fn>;
  let mkdir: ReturnType<typeof vi.fn>;
  let envVars: Record<string, string>;

  beforeEach(() => {
    writeTextFile = vi.fn().mockResolvedValue(undefined);
    mkdir = vi.fn().mockResolvedValue(undefined);
    envVars = {};
    (globalThis as unknown as { Deno: unknown }).Deno = {
      env: { get: (key: string) => envVars[key] },
      mkdir,
      writeTextFile,
    };
  });

  it('bypasses recording entirely for a request with no traceparent', async () => {
    const handler = vi.fn(async () => new Response('ok'));
    const wrapped = withAppMap(handler, { app: 'test' });

    const res = await wrapped(plainRequest());

    expect(await res.text()).toBe('ok');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('records a stamped request and ships one file carrying the caller\'s trace/span ids', async () => {
    const handler = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const wrapped = withAppMap(handler, { app: 'test' });
    const span = '1'.repeat(16);

    const res = await wrapped(stampedRequest(span));
    expect(res.status).toBe(200);

    // ship() is fire-and-forget (`void ship(...)` in the finally block) —
    // flush the microtask queue before asserting on it.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mkdir).toHaveBeenCalledTimes(1);
    expect(writeTextFile).toHaveBeenCalledTimes(1);
    const [path, body] = writeTextFile.mock.calls[0];
    expect(path).toMatch(new RegExp(`^tmp/appmap/requests/GET.*_${span}_001\\.appmap\\.json$`));

    const appmap = JSON.parse(body);
    expect(appmap.metadata.trace_id).toBe(TRACE);
    expect(appmap.metadata.parent_span_id).toBe(span);
    expect(appmap.metadata.recorder).toEqual({ name: 'funwithappmap-deno', type: 'requests' });
    expect(appmap.events[0]).toMatchObject({
      event: 'call',
      http_server_request: { request_method: 'GET', path_info: '/hello' },
    });
    expect(appmap.events.at(-1)).toMatchObject({
      event: 'return',
      http_server_response: { status_code: 200 },
    });
  });

  it('ships to APPMAP_COLLECTOR via fetch instead of the filesystem when set', async () => {
    envVars.APPMAP_COLLECTOR = 'https://collector.example/ingest';
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const handler = vi.fn(async () => new Response('ok'));
    const wrapped = withAppMap(handler, { app: 'test' });
    await wrapped(stampedRequest('2'.repeat(16)));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mkdir).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://collector.example/ingest',
      expect.objectContaining({ method: 'POST' }),
    );

    vi.unstubAllGlobals();
  });

  it('records a second stamped request in its own recording while the first is still in flight', async () => {
    // Per-request async context (docs/design/01): overlapping stamped
    // requests each get their own recording — the old one-at-a-time rule
    // dropped the second one and let its events leak into the first.
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const slowHandler = vi.fn(async () => {
      await gate;
      return new Response('first');
    });
    const fastHandler = vi.fn(async () => new Response('second'));

    const firstPromise = withAppMap(slowHandler, { app: 'test' })(stampedRequest('3'.repeat(16), 'http://localhost/first'));
    const secondResponse = await withAppMap(fastHandler, { app: 'test' })(stampedRequest('4'.repeat(16), 'http://localhost/second'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await secondResponse.text()).toBe('second');
    expect(fastHandler).toHaveBeenCalledTimes(1);
    // The second request shipped on its own while the first is still open.
    expect(writeTextFile).toHaveBeenCalledTimes(1);
    expect(writeTextFile.mock.calls[0][0]).toContain('_4444444444444444_');

    releaseFirst();
    await firstPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writeTextFile).toHaveBeenCalledTimes(2);
    expect(writeTextFile.mock.calls[1][0]).toContain('_3333333333333333_');
    for (const [, body] of writeTextFile.mock.calls) {
      const servers = JSON.parse(body).events.filter((e: { http_server_request?: unknown }) => e.http_server_request);
      expect(servers).toHaveLength(1);
    }
  });

  it('increments the sequence number across successive requests on the same wrapped handler', async () => {
    const handler = vi.fn(async () => new Response('ok'));
    const wrapped = withAppMap(handler, { app: 'test' });
    const span = '5'.repeat(16);

    await wrapped(stampedRequest(span));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await wrapped(stampedRequest(span));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writeTextFile).toHaveBeenCalledTimes(2);
    expect(writeTextFile.mock.calls[0][0]).toMatch(/_001\.appmap\.json$/);
    expect(writeTextFile.mock.calls[1][0]).toMatch(/_002\.appmap\.json$/);
  });

  it('still ships a recording (with a 500 response event) when the handler throws, and rethrows to the caller', async () => {
    const boom = new Error('boom');
    const handler = vi.fn(async () => {
      throw boom;
    });
    const wrapped = withAppMap(handler, { app: 'test' });

    await expect(wrapped(stampedRequest('6'.repeat(16)))).rejects.toThrow('boom');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Deno.serve's own error handling still applies — withAppMap must not
    // swallow the exception, only observe it for recording purposes.
    expect(writeTextFile).toHaveBeenCalledTimes(1);
    const appmap = JSON.parse(writeTextFile.mock.calls[0][1]);
    expect(appmap.events.at(-1)).toMatchObject({
      event: 'return',
      http_server_response: { status_code: 500 },
    });
  });

  it('treats a malformed or non-lowercase traceparent as unstamped', async () => {
    const handler = vi.fn(async () => new Response('ok'));
    const wrapped = withAppMap(handler, { app: 'test' });

    // Uppercase hex, and a trace id that's one character short — both
    // fail the driver's strict lowercase/length match in TRACEPARENT.
    const uppercase = new Request('http://localhost/hello', {
      headers: { traceparent: `00-${'A'.repeat(32)}-${'1'.repeat(16)}-01` },
    });
    const tooShort = new Request('http://localhost/hello', {
      headers: { traceparent: `00-${'a'.repeat(31)}-${'1'.repeat(16)}-01` },
    });

    await wrapped(uppercase);
    await wrapped(tooShort);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handler).toHaveBeenCalledTimes(2);
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('prefers an explicit dir option over APPMAP_DIR', async () => {
    envVars.APPMAP_DIR = 'tmp/from-env';
    const handler = vi.fn(async () => new Response('ok'));
    const wrapped = withAppMap(handler, { app: 'test', dir: 'tmp/from-option' });

    await wrapped(stampedRequest('7'.repeat(16)));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mkdir).toHaveBeenCalledWith('tmp/from-option', { recursive: true });
    expect(writeTextFile.mock.calls[0][0]).toMatch(/^tmp\/from-option\//);
  });

  it('stamps an outbound fetch made during handling with the caller\'s trace_id, not a freshly generated one', async () => {
    // The driver's own docstring: "the function's own outbound fetches
    // are stamped and recorded too, so an edge function shows up as a
    // middle tier in the stitch." For that stitch to work, the stamp
    // must carry the SAME trace_id as the inbound request this handler
    // is part of — the one withAppMap copies from the caller's
    // traceparent into recording.metadata.trace_id.
    const downstream = vi.fn().mockResolvedValue(new Response('downstream ok'));
    vi.stubGlobal('fetch', downstream);

    const handler = vi.fn(async () => {
      await fetch('https://api.example.com/verify');
      return new Response('ok');
    });
    const wrapped = withAppMap(handler, { app: 'test' });

    await wrapped(stampedRequest('9'.repeat(16)));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sentRequest: Request = downstream.mock.calls[0][0];
    expect(sentRequest.headers.get('traceparent')).toContain(TRACE);

    vi.unstubAllGlobals();
  });
});
