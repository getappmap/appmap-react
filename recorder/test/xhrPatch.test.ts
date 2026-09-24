// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { Recording } from '../src/recording';
import { startRecording, stopRecording, activeRecording } from '../src/session';
import { installInteractionRecorder } from '../src/interactionRecording';
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
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
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

  it('records a mocked XHR (MSW never calls the real send) and MSW sees the traceparent', async () => {
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
