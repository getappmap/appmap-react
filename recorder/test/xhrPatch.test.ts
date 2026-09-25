// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { Recording } from '../src/recording';
import { startRecording, stopRecording, activeRecording } from '../src/session';
import { installInteractionRecorder } from '../src/interactionRecording';
import { setPropagateTraceHeaderOrigins } from '../src/propagation';
import type { Event } from '../src/types';

// XMLHttpRequest traffic (axios and every other XHR client) must be
// recorded and stamped like fetch traffic.

function metadata() {
  return {
    name: 'xhr test',
    client: { name: 'test', url: 'https://example.invalid' },
    recorder: { name: 'test', type: 'tests' as const },
  };
}

function xhr(method: string, url: string, headers: Record<string, string> = {}): Promise<XMLHttpRequest> {
  return new Promise((resolve, reject) => {
    const req = new XMLHttpRequest();
    req.open(method, url);
    for (const [k, v] of Object.entries(headers)) req.setRequestHeader(k, v);
    req.onloadend = () => resolve(req);
    req.onerror = () => reject(new Error('xhr failed'));
    req.send(method === 'GET' ? null : '{"a":1}');
  });
}

const httpEvents = (events: Event[]) => events.filter((e) => 'http_client_request' in e || 'http_client_response' in e);

describe('XMLHttpRequest recording against a real server', () => {
  let server: Server;
  let origin: string;
  const seen: IncomingHttpHeaders[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'traceparent, content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      if (req.method === 'OPTIONS') return res.end();
      seen.push(req.headers);
      const delay = req.url?.includes('slow') ? 300 : 0;
      setTimeout(() => {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = req.method === 'POST' ? 201 : 200;
        res.end('{"ok":true}');
      }, delay);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as { port: number };
    origin = `http://127.0.0.1:${addr.port}`;
    // Cross-origin from jsdom's page (http://localhost:3000); this backend
    // allows traceparent, so it is listed, as a user linking to it would.
    setPropagateTraceHeaderOrigins([origin]);
  });
  afterAll(() => {
    setPropagateTraceHeaderOrigins([]);
    return new Promise<void>((r) => server.close(() => r()));
  });
  afterEach(() => {
    if (activeRecording()) stopRecording();
    seen.length = 0;
    vi.unstubAllGlobals();
  });

  it('records request and response and stamps a traceparent', async () => {
    const recording = startRecording(new Recording(metadata()));
    const req = await xhr('POST', `${origin}/discussions`, { 'Content-Type': 'application/json' });
    stopRecording();

    expect(req.status).toBe(201);
    const [call, ret] = httpEvents(recording.events) as any[];
    expect(call.http_client_request).toMatchObject({ request_method: 'POST', url: `${origin}/discussions` });
    expect(call.http_client_request.headers['content-type']).toBe('application/json');
    const traceparent = call.http_client_request.headers.traceparent;
    expect(traceparent).toMatch(new RegExp(`^00-${recording.traceId}-[0-9a-f]{16}-01$`));
    expect(seen[0].traceparent).toBe(traceparent);
    expect(ret).toMatchObject({ parent_id: call.id, http_client_response: { status_code: 201 } });
    expect(ret.http_client_response.headers['content-type']).toBe('application/json');
  });

  it('leaves XHRs alone when no recording is open', async () => {
    await xhr('GET', `${origin}/plain`);
    expect(seen[0].traceparent).toBeUndefined();
  });

  it('keeps an interaction window open until a pending XHR has answered', async () => {
    const shipped: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        shipped.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 204 });
      }),
    );
    document.body.innerHTML = '<button>Load</button>';
    document.querySelector('button')!.addEventListener('click', () => void xhr('GET', `${origin}/slow`));
    const uninstall = installInteractionRecorder({ app: 'test', idleMs: 30 });
    try {
      document.querySelector('button')!.click();
      await vi.waitFor(() => expect(shipped).toHaveLength(1), { timeout: 3000 });
    } finally {
      uninstall();
    }
    const events = httpEvents(shipped[0].events) as any[];
    expect(events.map((e) => e.http_client_request?.url ?? e.http_client_response?.status_code)).toEqual([
      `${origin}/slow`,
      200,
    ]);
    expect(shipped[0].metadata.truncated).toBeUndefined();
  });
});

describe('a cross-origin backend whose CORS does not allow traceparent (Supabase functions default)', () => {
  // The recorder must never break the app. Before cross-origin stamping
  // became opt-in, the XHR below carried traceparent, the browser's
  // preflight was refused (the header is not in Access-Control-Allow-
  // Headers) and the request failed with status 0.
  let server: Server;
  let origin: string;
  const seen: IncomingHttpHeaders[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, x-client-info, apikey, content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') return res.end('ok');
      seen.push(req.headers);
      res.setHeader('Content-Type', 'application/json');
      res.end('{"user":null,"data":[]}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  afterEach(() => {
    if (activeRecording()) stopRecording();
    setPropagateTraceHeaderOrigins([]);
    seen.length = 0;
  });

  it('still works while recorded: the request is recorded but not stamped', async () => {
    const recording = startRecording(new Recording(metadata()));
    const req = await xhr('POST', `${origin}/functions/v1/fn`, { 'Content-Type': 'application/json' });
    stopRecording();

    expect(req.status).toBe(200);
    expect(req.responseText).toBe('{"user":null,"data":[]}');
    expect(seen).toHaveLength(1);
    expect(seen[0].traceparent).toBeUndefined();
    const [call, ret] = httpEvents(recording.events) as any[];
    expect(call.http_client_request).toMatchObject({ request_method: 'POST', url: `${origin}/functions/v1/fn` });
    expect(call.http_client_request.headers.traceparent).toBeUndefined();
    expect(ret.http_client_response.status_code).toBe(200);
  });

  it('fetch: recorded, not stamped', async () => {
    const recording = startRecording(new Recording(metadata()));
    const res = await fetch(`${origin}/functions/v1/fn`, { method: 'POST', body: '{}' });
    stopRecording();
    expect(res.status).toBe(200);
    expect(seen[0].traceparent).toBeUndefined();
    const [call] = httpEvents(recording.events) as any[];
    expect(call.http_client_request.headers.traceparent).toBeUndefined();
  });

  it('is stamped once the user lists the origin (and then fails if the backend does not allow it)', async () => {
    setPropagateTraceHeaderOrigins([origin]);
    const recording = startRecording(new Recording(metadata()));
    // Opting in is the user's call: this backend refuses the header, so the
    // browser (here jsdom: "Headers traceparent forbidden") blocks the
    // request. That is why it is opt-in.
    await expect(xhr('POST', `${origin}/functions/v1/fn`, { 'Content-Type': 'application/json' })).rejects.toThrow(
      'xhr failed',
    );
    stopRecording();
    expect(seen).toHaveLength(0);
    const [call] = httpEvents(recording.events) as any[];
    expect(call.http_client_request.headers.traceparent).toMatch(new RegExp(`^00-${recording.traceId}-`));
  });
});

describe('XMLHttpRequest recording through an MSW interceptor (jsdom + msw/node)', () => {
  const mocked: Headers[] = [];
  const msw = setupServer(
    http.get('https://api.example.test/comments', ({ request }) => {
      mocked.push(request.headers);
      return HttpResponse.json([{ id: 1 }]);
    }),
  );
  beforeAll(() => msw.listen({ onUnhandledRequest: 'error' }));
  afterAll(() => msw.close());

  afterEach(() => {
    setPropagateTraceHeaderOrigins([]);
    mocked.length = 0;
  });

  it('does not stamp a cross-origin XHR whose origin is not listed', async () => {
    const recording = startRecording(new Recording(metadata()));
    await xhr('GET', 'https://api.example.test/comments?discussionId=d1&page=1');
    stopRecording();
    expect(mocked[0].get('traceparent')).toBeNull();
    const [call] = httpEvents(recording.events) as any[];
    expect(call.http_client_request.url).toBe('https://api.example.test/comments');
  });

  it('records a mocked XHR (MSW never calls the real send) and MSW sees the traceparent', async () => {
    setPropagateTraceHeaderOrigins(['https://api.example.test']);
    const recording = startRecording(new Recording(metadata()));
    const req = await xhr('GET', 'https://api.example.test/comments?discussionId=d1&page=1');
    stopRecording();

    expect(req.status).toBe(200);
    const [call, ret] = httpEvents(recording.events) as any[];
    expect(call.http_client_request.request_method).toBe('GET');
    expect(call.http_client_request.url).toContain('https://api.example.test/comments');
    expect(ret).toMatchObject({ parent_id: call.id, http_client_response: { status_code: 200 } });
    expect(mocked[0].get('traceparent')).toBe(call.http_client_request.headers.traceparent);
  });
});
