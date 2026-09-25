// Local stand-in for Supabase's API gateway (Kong): maps /rest/v1/* to a
// real PostgREST, and serves a tiny "enrich" stub used by the synthetic
// waitUntil probe. Every request is appended to GATEWAY_LOG as one JSON
// line {t, port, method, url, traceparent, status}; that log is the
// ground truth for the app's outbound calls.
import http from 'node:http';
import fs from 'node:fs';

const GW_PORT = Number(process.env.GW_PORT ?? 54321);
const ENRICH_PORT = Number(process.env.ENRICH_PORT ?? 54399);
const PGRST = `http://127.0.0.1:${process.env.PGRST_PORT ?? 54330}`;
const LOG = process.env.GATEWAY_LOG ?? '/tmp/acc-deno-work/gateway.log';

const log = (rec) => fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...rec }) + '\n');

http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const tp = req.headers['traceparent'] ?? null;
    if (!req.url.startsWith('/rest/v1/')) {
      res.writeHead(404).end();
      log({ port: GW_PORT, method: req.method, url: req.url, traceparent: tp, status: 404 });
      return;
    }
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    delete headers['connection'];
    const upstream = await fetch(PGRST + req.url.slice('/rest/v1'.length), {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });
    const out = Buffer.from(await upstream.arrayBuffer());
    const h = {};
    upstream.headers.forEach((v, k) => {
      if (!['content-encoding', 'transfer-encoding', 'content-length', 'connection'].includes(k)) h[k] = v;
    });
    res.writeHead(upstream.status, h).end(out);
    log({ port: GW_PORT, method: req.method, url: req.url, traceparent: tp, status: upstream.status });
  })
  .listen(GW_PORT, '127.0.0.1');

http
  .createServer((req, res) => {
    const tp = req.headers['traceparent'] ?? null;
    const u = new URL(req.url, 'http://x');
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({ n: u.searchParams.get('n'), score: 42 }),
    );
    log({ port: ENRICH_PORT, method: req.method, url: req.url, traceparent: tp, status: 200 });
  })
  .listen(ENRICH_PORT, '127.0.0.1');

console.log(`gateway :${GW_PORT} -> ${PGRST}, enrich stub :${ENRICH_PORT}, log ${LOG}`);
