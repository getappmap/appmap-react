// Local stand-in for the Supabase API gateway (Kong) on 127.0.0.1:54321,
// the URL the app's src/utils/supabaseClient.js falls back to.
//
//   /auth/v1/*       -> GoTrue      (Kong `cors` plugin emulated: preflight
//   /rest/v1/*       -> PostgREST    answered here, headers reflected)
//   /functions/v1/<name>/* -> the one function being served, path rewritten
//                    to /<name>/*; OPTIONS passed through untouched, because
//                    edge functions handle their own CORS (that is why the
//                    example ships _shared/cors.ts). Unknown names -> 404.
//
// JWT verification for functions is off, as in the example README's
// documented local command (`supabase functions serve ... --no-verify-jwt`).
// Every request is appended to GATEWAY_LOG as one JSON line; that log is the
// wire-level ground truth the checks compare recordings against.
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.GW_PORT ?? 54321);
const GOTRUE = `http://127.0.0.1:${process.env.GOTRUE_PORT ?? 54341}`;
const PGRST = `http://127.0.0.1:${process.env.PGRST_PORT ?? 54340}`;
const FUNCTION_NAME = process.env.FUNCTION_NAME ?? 'select-from-table-with-auth-rls';
const FUNCTION_URL = `http://127.0.0.1:${process.env.FUNCTION_PORT ?? 18100}`;
const LOG = process.env.GATEWAY_LOG;

const log = (rec) => LOG && fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...rec }) + '\n');

function kongCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS,TRACE,CONNECT');
    if (req.headers['access-control-request-headers']) {
      res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers']);
    }
    res.writeHead(200).end();
    return true;
  }
  return false;
}

async function proxy(req, res, target, body) {
  const headers = { ...req.headers };
  for (const h of ['host', 'content-length', 'connection']) delete headers[h];
  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      redirect: 'manual',
    });
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(err) }));
    return 502;
  }
  const out = Buffer.from(await upstream.arrayBuffer());
  upstream.headers.forEach((v, k) => {
    if (!['content-encoding', 'transfer-encoding', 'content-length', 'connection'].includes(k)) res.setHeader(k, v);
  });
  res.writeHead(upstream.status).end(out);
  return upstream.status;
}

http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const rec = {
      method: req.method,
      url: req.url,
      traceparent: req.headers.traceparent ?? null,
      acrh: req.headers['access-control-request-headers'] ?? null,
      origin: req.headers.origin ?? null,
    };
    let status;
    let route;
    const url = new URL(req.url, 'http://gateway');
    if (url.pathname.startsWith('/auth/v1/') || url.pathname.startsWith('/rest/v1/')) {
      route = url.pathname.startsWith('/auth/') ? 'auth' : 'rest';
      if (kongCors(req, res)) status = 200;
      else status = await proxy(req, res, (route === 'auth' ? GOTRUE : PGRST) + req.url.slice(8), body);
    } else if (url.pathname.startsWith('/functions/v1/')) {
      route = 'functions';
      const rest = req.url.slice('/functions/v1'.length); // "/<name>..."
      const name = decodeURIComponent(url.pathname.slice('/functions/v1/'.length).split('/')[0]);
      if (name !== FUNCTION_NAME) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `function ${name} not served` }));
        status = 404;
      } else {
        status = await proxy(req, res, FUNCTION_URL + rest, body);
      }
    } else {
      route = 'none';
      res.writeHead(404).end();
      status = 404;
    }
    log({ ...rec, route, status, allowHeaders: res.getHeader('access-control-allow-headers') ?? null });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`gateway :${PORT} auth->${GOTRUE} rest->${PGRST} functions/${FUNCTION_NAME}->${FUNCTION_URL}`));
