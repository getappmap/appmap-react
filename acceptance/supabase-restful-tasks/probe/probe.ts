// SYNTHETIC PROBE: NOT THE APP UNDER TEST.
//
// The target app (supabase restful-tasks @ 74a3be9) has no
// EdgeRuntime.waitUntil. This file exists only to exercise the recorder's
// waitUntil capture (docs/design/11) with a Supabase-edge-function-shaped
// handler. It is plain Deno.serve with no appmap imports, and runs through the
// zero-touch runner like the app does.
//
// Plain `deno run` has no EdgeRuntime global (Supabase Edge Runtime provides
// it). The shim below keeps the isolate alive the same way: it holds a
// reference to the promise. It is used only when the host has no EdgeRuntime.

declare global {
  // deno-lint-ignore no-var
  var EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;
}
if (typeof globalThis.EdgeRuntime === 'undefined') {
  const held = new Set<Promise<unknown>>();
  globalThis.EdgeRuntime = {
    waitUntil(p: Promise<unknown>) {
      held.add(p);
      p.finally(() => held.delete(p));
    },
  };
}

const REST = `${Deno.env.get('SUPABASE_URL') ?? 'http://127.0.0.1:54321'}/rest/v1`;
const ENRICH = Deno.env.get('ENRICH_URL') ?? 'http://127.0.0.1:54399';
const KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ingest(n: string, auth: string) {
  const headers = { apikey: KEY, Authorization: auth, 'Content-Type': 'application/json' };
  const ins = await fetch(`${REST}/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: `probe-${n}`, status: 0 }),
  });
  await ins.body?.cancel();
  await sleep(1500);
  const enrich = await fetch(`${ENRICH}/enrich?n=${n}`);
  const { score } = await enrich.json();
  await sleep(1500);
  const upd = await fetch(`${REST}/tasks?name=eq.probe-${n}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: score }),
  });
  await upd.body?.cancel();
  return score;
}

Deno.serve({ port: Number(Deno.env.get('PORT') ?? 8001) }, (req) => {
  const url = new URL(req.url);
  const n = url.searchParams.get('n') ?? '0';
  const auth = req.headers.get('Authorization') ?? '';
  if (req.method === 'POST' && url.pathname === '/probe/ingest') {
    EdgeRuntime!.waitUntil(ingest(n, auth));
    return new Response(null, { status: 202 });
  }
  if (req.method === 'POST' && url.pathname === '/probe/fire-and-forget') {
    void ingest(n, auth);
    return new Response(null, { status: 202 });
  }
  return new Response('not found', { status: 404 });
});
