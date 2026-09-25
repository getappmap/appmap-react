// Shared helpers for the full-stack acceptance harness.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export const ACC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const ROOT = path.resolve(ACC, '..', '..');
export const WORK = process.env.WORK ?? '/tmp/acc-fullstack-work';
export const SUPA = path.join(WORK, 'supabase');
export const APP = path.join(SUPA, 'examples', 'edge-functions', 'app');
export const FN_NAME = 'select-from-table-with-auth-rls';
export const FN_REL = `examples/edge-functions/supabase/functions/${FN_NAME}/index.ts`;
export const CORS_REL = 'examples/edge-functions/supabase/functions/_shared/cors.ts';
export const TOOLS = process.env.APPMAP_TOOLS ?? path.join(WORK, 'tools');
export const APPMAP_CLI = path.join(TOOLS, 'node_modules', '.bin', 'appmap');
export const LINK_CLI = path.join(ROOT, 'linker', 'bin', 'appmap-link.mjs');
export const TRACE_CLI = path.join(ROOT, 'linker', 'bin', 'appmap-trace.mjs');
export const APPMAP_DENO = path.join(ROOT, 'deno', 'bin', 'appmap-deno.ts');
export const LOCK = path.join(ACC, 'deno.lock');
export const GW = 'http://127.0.0.1:54321';
export const FN_PORT = 18100;
export const GATEWAY_LOG = path.join(WORK, 'gateway.log');
export const COLLECTOR_DIR = path.join(APP, 'tmp', 'appmap', 'interactions');
// The Supabase CLI's well-known local anon key (also the app's own fallback,
// src/utils/supabaseClient.js:6), signed with the CLI's well-known local secret.
export const ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24ifQ.625_WdcF3KHqz5amU0x2X5WWHP-OEs_4qj0ssLNHzTs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Background process in its own process group; stop() kills the group. */
export function bg(name, cmd, args, { cwd, env } = {}) {
  const logFile = path.join(WORK, 'logs', `${name}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  const proc = spawn(cmd, args, { cwd, env: env ?? process.env, detached: true, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  return {
    proc,
    log: () => fs.readFileSync(logFile, 'utf8'),
    async stop() {
      if (proc.exitCode !== null || proc.signalCode) return;
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch {}
      for (let i = 0; i < 60 && proc.exitCode === null && !proc.signalCode; i++) await sleep(50);
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {}
    },
  };
}

export async function waitHttp(url, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      await fetch(url);
      return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

export async function waitPortFree(url, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      await fetch(url);
    } catch {
      return true;
    }
    await sleep(200);
  }
  return false;
}

/** The function, plain (`deno run`) or under the zero-touch runner. */
export async function startFunction({ recorded, appmapDir, tag }) {
  const env = {
    ...process.env,
    SUPABASE_URL: GW,
    SUPABASE_ANON_KEY: ANON,
    DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${FN_PORT}`,
    DENO_NO_UPDATE_CHECK: '1',
  };
  if (appmapDir) env.APPMAP_DIR = appmapDir;
  const args = recorded
    ? ['--no-warnings', '--experimental-strip-types', APPMAP_DENO, '--app', FN_NAME, FN_REL, '--', `--lock=${LOCK}`]
    : ['run', '-A', `--lock=${LOCK}`, FN_REL];
  await waitPortFree(`http://127.0.0.1:${FN_PORT}/`);
  const p = bg(`fn-${tag}`, recorded ? process.execPath : 'deno', args, { cwd: SUPA, env });
  const t0 = Date.now();
  while (!/Listening on/.test(p.log())) {
    if (p.proc.exitCode !== null) throw new Error(`function exited early:\n${p.log()}`);
    if (Date.now() - t0 > 120000) throw new Error(`function did not start:\n${p.log()}`);
    await sleep(100);
  }
  return p;
}

export async function startVite(config, tag) {
  fs.rmSync(path.join(APP, 'node_modules', '.vite'), { recursive: true, force: true });
  fs.rmSync(path.join(APP, 'tmp'), { recursive: true, force: true });
  await waitPortFree('http://127.0.0.1:3300/');
  const p = bg(`vite-${tag}`, path.join(APP, 'node_modules', '.bin', 'vite'), ['--config', config], { cwd: APP });
  if (!(await waitHttp('http://127.0.0.1:3300/'))) throw new Error(`vite did not start:\n${p.log()}`);
  return p;
}

export function drive(mode, out, runId, extraEnv = {}) {
  const r = sh(process.execPath, [path.join(ACC, 'scripts', 'drive.mjs'), mode], {
    env: {
      ...process.env,
      TOOLS,
      OUT: out,
      RUN_ID: runId,
      COLLECTOR_DIR,
      APP_URL: 'http://127.0.0.1:3300',
      ...extraEnv,
    },
    timeout: 600000,
  });
  if (!fs.existsSync(out)) throw new Error(`drive ${mode} produced no report:\n${r.out}`);
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

export function listMaps(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.appmap.json'))
    .sort()
    .map((f) => path.join(dir, f));
}

export const readMap = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

export async function waitForMap(dir, span, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = listMaps(dir).find((f) => {
      try {
        return readMap(f).metadata?.parent_span_id === span;
      } catch {
        return false;
      }
    });
    if (hit) return hit;
    await sleep(50);
  }
  return undefined;
}

let spanSeq = 0;
/** Deterministic traceparent for direct requests: fixed trace per tag. */
export function traceparent(tag, n) {
  const trace = Buffer.from(tag).toString('hex').padEnd(24, '0').slice(0, 24) + String(n).padStart(8, '0');
  const span = (String(n).padStart(8, '0') + String(++spanSeq).padStart(8, '0')).slice(0, 16);
  return { header: `00-${trace}-${span}-01`, trace, span };
}

/** A direct request through the gateway, shaped like supabase-js's invoke. */
export async function invokeDirect({ token, tp, method = 'POST', headers = {} }) {
  const h = { apikey: ANON, 'x-client-info': 'acceptance-harness', 'content-type': 'text/plain;charset=UTF-8', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (tp) h.traceparent = tp.header;
  const t0 = performance.now();
  const res = await fetch(`${GW}/functions/v1/${FN_NAME}`, {
    method,
    headers: h,
    body: method === 'POST' ? JSON.stringify({ name: 'world' }) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text, headers: Object.fromEntries(res.headers), ms: performance.now() - t0 };
}

export async function signUp(email, password = 'acceptance-pass-123') {
  const res = await fetch(`${GW}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!body.access_token) throw new Error(`sign-up failed: ${JSON.stringify(body)}`);
  return { token: body.access_token, id: body.user.id };
}

export function gatewayLines() {
  if (!fs.existsSync(GATEWAY_LOG)) return [];
  return fs
    .readFileSync(GATEWAY_LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Flatten an AppMap into what the checks compare. */
/** url + '?' + the event's message parameters (name=value, in order). */
export function withQuery(url, message) {
  const q = (message ?? []).map((m) => `${m.name}=${m.value}`).join('&');
  return q ? `${url}?${q}` : url;
}

export function summarize(appmap) {
  const returns = new Map(appmap.events.filter((e) => e.event === 'return').map((e) => [e.parent_id, e]));
  const out = {
    name: appmap.metadata?.name,
    trace_id: appmap.metadata?.trace_id,
    parent_span_id: appmap.metadata?.parent_span_id,
    servers: [],
    functions: [],
    clients: [],
    sql: [],
    unbalanced: [],
    exceptions: [],
    // Requests that got no HTTP response (network error, or none before the
    // recording closed): the AppMap schema only lets an http_client_request
    // be closed by a response with a 100-599 status, so the recorder lists
    // them here instead of closing them with status 0 (docs/design/12).
    unanswered: (appmap.metadata?.unanswered_http_requests ?? []).map((u) => ({
      method: u.request_method,
      url: u.url,
      reason: u.reason,
    })),
  };
  for (const e of appmap.events) {
    if (e.event === 'return' && e.exceptions?.length) out.exceptions.push(...e.exceptions);
    if (e.event !== 'call') continue;
    const r = returns.get(e.id);
    if (!r) out.unbalanced.push(e.id);
    if (e.http_server_request) {
      out.servers.push({
        method: e.http_server_request.request_method,
        path: e.http_server_request.path_info,
        traceparent: e.http_server_request.headers?.traceparent,
        status: r?.http_server_response?.status_code,
      });
    } else if (e.http_client_request) {
      out.clients.push({
        method: e.http_client_request.request_method,
        // AppMap spec: http_client_request.url is the URL "excluding the query
        // string"; the query parameters are the event's `message`. Rebuild
        // path+query from both so URL comparisons see what went on the wire.
        url: withQuery(e.http_client_request.url, e.message),
        traceparent: e.http_client_request.headers?.traceparent,
        status: r?.http_client_response?.status_code,
      });
    } else if (e.sql_query) {
      out.sql.push(e.sql_query.sql);
    } else if (e.method_id) {
      out.functions.push({
        fn: `${e.defined_class}.${e.method_id}`,
        method_id: e.method_id,
        path: e.path,
        lineno: e.lineno,
        exceptions: r?.exceptions,
      });
    }
  }
  return out;
}

// --- official tools -------------------------------------------------------
const toolsRequire = createRequire(path.join(TOOLS, 'package.json'));
const VERSIONS = ['1.2.0', '1.3.0', '1.4.0', '1.5.0', '1.5.1', '1.6.0', '1.7.0', '1.8.0', '1.9.0', '1.10.0', '1.11.0', '1.12.0', '1.13.0', '1.13.1'];
const firstLine = (err) => String(err && err.message).split('\n').slice(0, 6).join(' | ');

/** Official validator (@appland/appmap-validate): the declared version, and
 * the same content relabeled as every spec version. */
export function validateFile(file) {
  const { validate } = toolsRequire('@appland/appmap-validate');
  const data = readMap(file);
  const entry = { file: path.relative(WORK, file), declared: data.version, declaredResult: null, perVersion: {} };
  try {
    validate(data, {});
    entry.declaredResult = 'valid';
  } catch (err) {
    entry.declaredResult = `INVALID: ${firstLine(err)}`;
  }
  for (const version of VERSIONS) {
    try {
      validate({ ...data, version }, { version });
      entry.perVersion[version] = 'valid';
    } catch (err) {
      entry.perVersion[version] = `INVALID: ${firstLine(err)}`;
    }
  }
  return entry;
}

export function sequenceDiagrams(files, outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  if (!files.length) return { code: 0, out: 'no files' };
  return sh(APPMAP_CLI, ['sequence-diagram', '--format', 'json', '--output-dir', outDir, ...files], {
    env: { ...process.env, APPMAP_TELEMETRY_DISABLED: 'true' },
  });
}

/** Drop run-varying fields (timings, ids, uuids, trace ids) from a sequence-diagram JSON. */
export function normalizeDiagram(d) {
  const scrub = (s) =>
    s
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
      .replace(/\b[0-9a-f]{32}\b/g, '<trace>')
      .replace(/\b[0-9a-f]{16}\b/g, '<span>');
  const strip = (n) => {
    if (Array.isArray(n)) return n.map(strip);
    if (n && typeof n === 'object') {
      const o = {};
      for (const [k, v] of Object.entries(n)) {
        if (['elapsed', 'eventIds', 'digest', 'subtreeDigest'].includes(k)) continue;
        o[k] = strip(v);
      }
      return o;
    }
    return typeof n === 'string' ? scrub(n) : n;
  };
  return strip(d);
}
