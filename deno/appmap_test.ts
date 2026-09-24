// Smoke test for the Deno driver (docs/design/02's Deno twin of the
// PetClinicGo middleware). This is the Deno path's first automated
// test — previously it was validated by an undocumented manual
// procedure only (see the header comment in appmap.ts, now updated).
//
// Run: deno test -A --unstable-sloppy-imports deno/
// (permissions and sloppy-imports match the usage note in appmap.ts;
// wired into CI via .github/workflows/ci.yml's `deno` job.)

import assert from 'node:assert/strict';
import { autoInstrument, withAppMap } from './appmap.ts';

async function waitForFile(dir: string, timeoutMs = 2000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const entry of Deno.readDirSync(dir)) {
      if (entry.isFile) return entry.name;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no file appeared in ${dir} within ${timeoutMs}ms`);
}

Deno.test('withAppMap records a traceparent-stamped request and writes an AppMap', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'appmap-deno-test-' });
  const handler = (_req: Request) => Response.json({ ok: true });
  const wrapped = withAppMap(handler, { app: 'test-app', dir });

  const traceId = 'a'.repeat(32);
  const spanId = 'b'.repeat(16);
  const req = new Request('http://localhost/widgets', {
    headers: { traceparent: `00-${traceId}-${spanId}-01` },
  });

  const res = await wrapped(req);
  assert.equal(res.status, 200);

  // ship() is fire-and-forget (not awaited by the wrapped handler), so
  // the file may not exist the instant the response resolves.
  const file = await waitForFile(dir);
  const appmap = JSON.parse(await Deno.readTextFile(`${dir}/${file}`));

  assert.equal(appmap.version, '1.12');
  assert.ok(appmap.metadata.language.version, 'language.version is required by the spec');
  assert.equal(appmap.metadata.trace_id, traceId);
  assert.equal(appmap.metadata.parent_span_id, spanId);
  assert.equal(appmap.metadata.recorder.name, 'funwithappmap-deno');

  const call = appmap.events.find((e: { event: string }) => e.event === 'call');
  assert.ok(call.http_server_request);
  assert.equal(call.http_server_request.path_info, '/widgets');
  assert.equal(call.http_server_request.headers.traceparent, req.headers.get('traceparent'));

  const ret = appmap.events.find((e: { event: string }) => e.event === 'return');
  assert.equal(ret.http_server_response.status_code, 200);
});

Deno.test('withAppMap runs the handler unrecorded when there is no traceparent header', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'appmap-deno-test-unstamped-' });
  const handler = (_req: Request) => Response.json({ ok: true });
  const wrapped = withAppMap(handler, { app: 'test-app', dir });

  const res = await wrapped(new Request('http://localhost/widgets'));
  assert.equal(res.status, 200);

  const files = [...Deno.readDirSync(dir)];
  assert.equal(files.length, 0);
});

Deno.test('withAppMap captures EdgeRuntime.waitUntil background work (docs/design/11, E0a)', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'appmap-deno-test-waituntil-' });

  // Stand in for the Supabase Edge Runtime global: waitUntil keeps a
  // handle so the test can await the same background work the driver does.
  // The driver reads and patches the global `EdgeRuntime`, which is this
  // same object, so the handler's edge.waitUntil(...) hits the patched fn.
  const background: Promise<unknown>[] = [];
  const edge = {
    waitUntil(p: Promise<unknown>) {
      background.push(p);
    },
  };
  const globals = globalThis as Record<string, unknown>;
  globals.EdgeRuntime = edge;

  // A 202-then-background handler, like discovery-scan: it returns
  // immediately and does the real work (here, one fetch) under waitUntil.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(Response.json({ scraped: true }));
  try {
    const handler = (_req: Request): Response => {
      const pipeline = (async () => {
        await new Promise((r) => setTimeout(r, 10));
        await fetch('https://vendor.example/scrape');
      })();
      edge.waitUntil(pipeline);
      return new Response(null, { status: 202 });
    };
    const wrapped = withAppMap(handler, { app: 'scan-app', dir });

    const req = new Request('http://localhost/discovery-scan', {
      headers: { traceparent: `00-${'a'.repeat(32)}-${'c'.repeat(16)}-01` },
    });
    const res = await wrapped(req);
    assert.equal(res.status, 202); // response is NOT delayed by the background

    // Let the driver's deferred finalize run: await the same background,
    // then a couple of macrotasks for ship() to write.
    await Promise.allSettled(background);
    const file = await waitForFile(dir);
    const appmap = JSON.parse(await Deno.readTextFile(`${dir}/${file}`));

    // The background fetch was captured — the whole point of E0a.
    const clientReq = appmap.events.find(
      (e: { http_client_request?: unknown }) => e.http_client_request,
    );
    assert.ok(clientReq, 'background fetch under waitUntil should be recorded');
    assert.equal(appmap.metadata.truncated, undefined); // closed cleanly, balanced
  } finally {
    globalThis.fetch = originalFetch;
    delete globals.EdgeRuntime;
  }
});

Deno.test('concurrent stamped requests each get their own recording; unstamped traffic is never stamped', async () => {
  // docs/design/01, "Per-request async context". Stamped and unstamped
  // requests overlap in time; every stamped one must end up in its own
  // file holding only its own events, and no outbound call made for an
  // unstamped request may carry a traceparent.
  const dir = await Deno.makeTempDir({ prefix: 'appmap-deno-test-concurrent-' });
  const sent: { url: string; traceparent: string | null }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push({ url: request.url, traceparent: request.headers.get('traceparent') });
    return Promise.resolve(Response.json({ ok: true }));
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    const lookup = autoInstrument(
      async function lookup(id: string) {
        await sleep(id.length * 3);
        await fetch(`https://db.example/items/${id}`);
        return id;
      },
      { definedClass: 'items', methodId: 'lookup', path: 'items.ts', lineno: 1 },
      ['id'],
    );
    const handler = async (req: Request) => {
      const id = new URL(req.url).searchParams.get('id')!;
      await sleep(5);
      await lookup(id);
      return Response.json({ id });
    };
    const wrapped = withAppMap(handler, { app: 'concurrent', dir });

    const trace = (i: number) => `${String(i).padStart(2, '0')}${'e'.repeat(30)}`;
    const span = (i: number) => `${String(i).padStart(2, '0')}${'f'.repeat(14)}`;
    const stamped = Array.from({ length: 6 }, (_, i) =>
      wrapped(
        new Request(`http://localhost/items?id=s${'x'.repeat(i)}`, {
          headers: { traceparent: `00-${trace(i)}-${span(i)}-01` },
        }),
      ),
    );
    const unstamped = Array.from({ length: 4 }, (_, i) =>
      wrapped(new Request(`http://localhost/items?id=u${'y'.repeat(i)}`)),
    );
    for (const res of await Promise.all([...stamped, ...unstamped])) assert.equal(res.status, 200);

    const deadline = Date.now() + 3000;
    let files: string[] = [];
    while (Date.now() < deadline) {
      files = [...Deno.readDirSync(dir)].filter((e) => e.name.endsWith('.appmap.json')).map((e) => e.name);
      if (files.length >= 6) break;
      await sleep(10);
    }
    assert.equal(files.length, 6, `one file per stamped request, got ${files.join(', ')}`);

    for (let i = 0; i < 6; i++) {
      const file = files.find((f) => f.includes(`_${span(i)}_`));
      assert.ok(file, `recording for stamped request ${i}`);
      const appmap = JSON.parse(await Deno.readTextFile(`${dir}/${file}`));
      const calls = appmap.events.filter((e: { event: string }) => e.event === 'call');
      const lookups = calls.filter((e: { method_id?: string }) => e.method_id === 'lookup');
      assert.deepEqual(
        lookups.map((e: { parameters: { value: string }[] }) => e.parameters[0].value),
        [`s${'x'.repeat(i)}`],
        `request ${i} recorded only its own lookup`,
      );
      const clients = calls.filter((e: { http_client_request?: unknown }) => e.http_client_request);
      assert.equal(clients.length, 1, `request ${i} recorded only its own outbound call`);
      assert.ok(clients[0].http_client_request.headers.traceparent.startsWith(`00-${trace(i)}-`));
      assert.equal(calls.filter((e: { http_server_request?: unknown }) => e.http_server_request).length, 1);
      assert.equal(appmap.metadata.truncated, undefined);
    }

    for (const s of sent) {
      const id = s.url.split('/').pop()!;
      if (id.startsWith('u')) assert.equal(s.traceparent, null, `unstamped request's call to ${s.url} was stamped`);
      else assert.ok(s.traceparent?.startsWith(`00-${trace(id.length - 1)}-`), `${s.url} stamped with its own trace`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('a recorded request is one call tree rooted at its http_server_request, with language.version', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'appmap-deno-test-tree-' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response(null, { status: 204 }));
  try {
    const deleteTask = autoInstrument(
      async function deleteTask(id: string) {
        await new Promise((r) => setTimeout(r, 1));
        await fetch(`http://db.example/rest/v1/tasks?id=eq.${id}`, { method: 'DELETE' });
        return Response.json({});
      },
      { definedClass: 'index', methodId: 'deleteTask', path: 'index.ts', lineno: 38 },
      ['id'],
    );
    const wrapped = withAppMap((req) => deleteTask(new URL(req.url).pathname.split('/').pop()!), { dir });
    await wrapped(
      new Request('http://localhost/restful-tasks/2?verbose=1', {
        method: 'DELETE',
        headers: { traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01` },
      }),
    );
    const file = await waitForFile(dir);
    const appmap = JSON.parse(await Deno.readTextFile(`${dir}/${file}`));
    assert.equal(appmap.metadata.language.version, Deno.version.typescript);
    const shape = appmap.events.map((e: Record<string, any>) =>
      `${e.event}:${e.thread_id}:${e.method_id ?? e.http_server_request?.path_info ?? e.http_client_request?.url ?? ''}`,
    );
    assert.deepEqual(shape, [
      'call:1:/restful-tasks/2',
      'call:1:deleteTask',
      'call:1:http://db.example/rest/v1/tasks',
      'return:1:',
      'return:1:',
      'return:1:',
    ]);
    assert.deepEqual(appmap.events[0].message, [{ name: 'verbose', class: 'String', value: '1' }]);
    assert.deepEqual(appmap.events[2].message, [{ name: 'id', class: 'String', value: 'eq.2' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
