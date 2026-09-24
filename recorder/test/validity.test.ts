import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Recording, APPMAP_VERSION } from '../src/recording';
import { autoInstrument } from '../src/instrument';
import {
  activeRecording,
  closeScopedRecording,
  openScopedRecording,
  runInRecording,
  stopRecording,
} from '../src/session';
import { startTestRecording, finishTestRecording } from '../src/testRecording';
import type { AppMap, Event } from '../src/types';

// Every recording mode's output must pass the official validator
// (@appland/appmap-validate, getappmap/appmap-js packages/validate) at
// the version it declares — schema and semantics: per-thread call/return
// nesting, event ids, classMap consistency — and calls must form a tree.

const { validate } = createRequire(import.meta.url)('@appland/appmap-validate') as {
  validate: (data: unknown, options?: { version?: string }) => void;
};

const fn = (methodId: string, lineno: number, f: (...a: never[]) => unknown, args: string[] = []) =>
  autoInstrument(f as never, { definedClass: 'app', methodId, path: 'src/app.ts', lineno }, args) as (
    ...a: unknown[]
  ) => any;

const tick = () => new Promise((r) => setTimeout(r, 1));

/** call → children as nested arrays, rebuilt the way standard tooling
 * does: positionally, per thread. */
function tree(events: Event[]): unknown[] {
  const roots: unknown[] = [];
  const stack: { name: string; children: unknown[] }[] = [];
  for (const e of events) {
    if (e.event === 'call') {
      const name =
        'method_id' in e ? e.method_id : 'http_client_request' in e ? `${e.http_client_request.request_method} ${e.http_client_request.url}` : `SERVER ${(e as any).http_server_request.path_info}`;
      const node = { name, children: [] as unknown[] };
      (stack.length ? stack[stack.length - 1].children : roots).push(node);
      stack.push(node);
    } else stack.pop();
  }
  const simplify = (n: any): unknown => (n.children.length ? { [n.name]: n.children.map(simplify) } : n.name);
  return roots.map(simplify);
}

describe(`recordings are valid AppMap ${APPMAP_VERSION}`, () => {
  afterEach(() => {
    if (activeRecording()) stopRecording();
    vi.unstubAllGlobals();
  });

  it('test recording: async nesting, fetch with a query, network error, exceptions, long values', async () => {
    const underlying = vi.fn(async (input: RequestInfo | URL) => {
      const url = new Request(input).url;
      if (url.includes('down')) throw new TypeError('fetch failed');
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', underlying);

    const findOwners = fn('findOwners', 10, async (lastName: string) => {
      await tick();
      const res = await fetch(`https://api.example.test/owners?lastName=${lastName}&page=1`);
      return res.json();
    }, ['lastName']);
    const search = fn('search', 20, async (lastName: string) => {
      await tick();
      return findOwners(lastName); // called from an async continuation
    }, ['lastName']);
    // Returns synchronously while the search it started is still running.
    const onSubmit = fn('onSubmit', 30, (lastName: string) => {
      void search(lastName);
    }, ['lastName']);
    const both = fn('both', 40, async () => Promise.all([findOwners('a'), findOwners('b')]));
    const failing = fn('failing', 50, async () => {
      await fetch('https://down.example.test/x');
    });
    const throwsPlain = fn('throwsPlain', 60, () => {
      throw { code: '22P02', message: 'invalid input' };
    });
    const echo = fn('echo', 70, (s: string) => s, ['s']);

    startTestRecording('validity test', { sourceLocation: 'test/validity.test.ts' });
    onSubmit('Davis');
    await vi.waitFor(() => expect(underlying).toHaveBeenCalledTimes(1));
    await tick();
    await both();
    await expect(failing()).rejects.toThrow('fetch failed');
    expect(() => throwsPlain()).toThrow();
    expect(() => fn('throwsString', 80, () => { throw 'nope'; })()).toThrow();
    echo('x'.repeat(500));
    const file = finishTestRecording('succeeded');
    const appmap: AppMap = JSON.parse(readFileSync(file, 'utf8'));

    expect(appmap.version).toBe(APPMAP_VERSION);
    expect(() => validate(appmap)).not.toThrow();
    for (const f of appmap.metadata.frameworks!) expect(f.version).toBeTruthy();

    // One thread, and the async chain nests: onSubmit → search →
    // findOwners → GET, though onSubmit returned long before.
    expect(new Set(appmap.events.map((e) => e.thread_id))).toEqual(new Set([1]));
    const t = tree(appmap.events);
    expect(t[0]).toEqual({
      onSubmit: [{ search: [{ findOwners: ['GET https://api.example.test/owners'] }] }],
    });
    expect(t[1]).toEqual({
      both: [
        { findOwners: ['GET https://api.example.test/owners'] },
        { findOwners: ['GET https://api.example.test/owners'] },
      ],
    });

    // The query string lives in `message`, not in `url`.
    const get = appmap.events.find((e) => 'http_client_request' in e) as any;
    expect(get.http_client_request.url).toBe('https://api.example.test/owners');
    expect(get.message).toEqual([
      { name: 'lastName', class: 'String', value: 'Davis' },
      { name: 'page', class: 'String', value: '1' },
    ]);
    // The failed request has no response the format can express: it is
    // listed in metadata, not left as an invalid event.
    expect(appmap.metadata.unanswered_http_requests).toEqual([
      { event: 'http_client_request', request_method: 'GET', url: 'https://down.example.test/x', reason: 'network error' },
    ]);
    const exceptions = appmap.events.flatMap((e: any) => e.exceptions ?? []);
    expect(exceptions.every((x: any) => Number.isInteger(x.object_id))).toBe(true);
    const long = appmap.events.find((e: any) => e.method_id === 'echo') as any;
    expect(long.parameters[0].value).toHaveLength(100);
  });

  it('server request (scoped recording): one tree rooted at the http_server_request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const deleteTask = fn('deleteTask', 38, async (id: string) => {
      await tick();
      await fetch(`http://127.0.0.1:54321/rest/v1/tasks?id=eq.${id}`, { method: 'DELETE' });
      return new Response('{}');
    }, ['id']);

    const recording = openScopedRecording(new Recording({
      name: 'DELETE /restful-tasks/2',
      language: { name: 'typescript', engine: 'deno', version: '5.8.3' },
      client: { name: 'test', url: 'https://example.invalid' },
      recorder: { name: 'test', type: 'requests' },
    }));
    const token = recording.httpServerRequest('DELETE', '/restful-tasks/2', {}, undefined, new URLSearchParams('x=1'));
    const res = await runInRecording(recording, () => deleteTask('2'), token.callId);
    recording.httpServerResponse(token, res.status);
    closeScopedRecording(recording);
    const appmap = recording.toAppMap();

    expect(() => validate(appmap)).not.toThrow();
    expect(tree(appmap.events)).toEqual([
      { 'SERVER /restful-tasks/2': [{ deleteTask: ['DELETE http://127.0.0.1:54321/rest/v1/tasks'] }] },
    ]);
    expect((appmap.events[0] as any).message).toEqual([{ name: 'x', class: 'String', value: '1' }]);
    expect((appmap.events[2] as any).message).toEqual([{ name: 'id', class: 'String', value: 'eq.2' }]);
  });

  it('truncated recording (calls and requests still open) is balanced and valid', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const hang = fn('hang', 90, async () => {
      await fetch('https://slow.example.test/never');
    });
    const recording = openScopedRecording(new Recording({
      name: 'POST /probe/ingest',
      client: { name: 'test', url: 'https://example.invalid' },
      recorder: { name: 'test', type: 'requests' },
    }));
    const token = recording.httpServerRequest('POST', '/probe/ingest');
    void runInRecording(recording, () => hang(), token.callId);
    await tick();
    const appmap = recording.toAppMap();
    closeScopedRecording(recording);

    expect(appmap.metadata.truncated).toBe(true);
    expect(() => validate(appmap)).not.toThrow();
    expect(tree(appmap.events)).toEqual(['hang']);
    expect(appmap.metadata.unanswered_http_requests?.map((u) => u.event)).toEqual([
      'http_server_request',
      'http_client_request',
    ]);
  });
});
