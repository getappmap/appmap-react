// Smoke test for the Deno driver (docs/design/02's Deno twin of the
// PetClinicGo middleware). This is the Deno path's first automated
// test — previously it was validated by an undocumented manual
// procedure only (see the header comment in appmap.ts, now updated).
//
// Run: deno test -A --unstable-sloppy-imports deno/
// (permissions and sloppy-imports match the usage note in appmap.ts;
// wired into CI via .github/workflows/ci.yml's `deno` job.)

import assert from 'node:assert/strict';
import { withAppMap } from './appmap.ts';

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
