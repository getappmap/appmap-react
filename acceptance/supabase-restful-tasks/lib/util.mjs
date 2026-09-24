// Shared helpers for the restful-tasks acceptance harness.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { jwt } from './jwt.mjs';

export const ACC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const ROOT = path.resolve(ACC, '..', '..');
export const WORK = process.env.WORK ?? '/tmp/acc-deno-work';
export const APPDIR = path.join(WORK, 'supabase');
export const ENTRY_REL = 'examples/edge-functions/supabase/functions/restful-tasks/index.ts';
export const PROBE = path.join(ACC, 'probe', 'probe.ts');
export const TOOLS = process.env.APPMAP_TOOLS ?? '/root/appmap-tools';
export const APPMAP_CLI = path.join(TOOLS, 'node_modules', '.bin', 'appmap');
export const VALIDATE_CLI = path.join(TOOLS, 'node_modules', '.bin', 'appmap-validate');
export const DENO = process.env.DENO ?? 'deno';
export const APP_PORT = Number(process.env.APP_PORT ?? 18000);
export const PROBE_PORT = Number(process.env.PROBE_PORT ?? 18001);
export const GW = `http://127.0.0.1:${process.env.GW_PORT ?? 54321}`;
export const GATEWAY_LOG = path.join(WORK, 'gateway.log');
export const LOCK = path.join(ACC, 'deno.lock');

export const AUTH = `Bearer ${jwt('authenticated')}`;
export const ANON = jwt('anon');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function appEnv(extra = {}) {
  return {
    ...process.env,
    SUPABASE_URL: GW,
    SUPABASE_ANON_KEY: ANON,
    APPMAP_TELEMETRY_DISABLED: 'true',
    ...extra,
  };
}

/** Start the app (or the probe) either plain or under the zero-touch runner.
 * Resolves once Deno prints "Listening on". */
export async function startServer({ recorded, entry, cwd, port, appmapDir, app, extraEnv = {}, lock = true }) {
  const env = appEnv({ DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${port}`, PORT: String(port), ...extraEnv });
  if (appmapDir) env.APPMAP_DIR = appmapDir;
  const lockArgs = lock ? [`--lock=${LOCK}`] : [];
  let cmd, args;
  if (recorded) {
    cmd = process.execPath;
    args = [
      '--no-warnings',
      '--experimental-strip-types',
      path.join(ROOT, 'deno', 'bin', 'appmap-deno.ts'),
      ...(app ? ['--app', app] : []),
      entry,
      '--',
      ...lockArgs,
    ];
  } else {
    cmd = DENO;
    args = ['run', '-A', ...lockArgs, entry];
  }
  const proc = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const onData = (d) => (out += d.toString());
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  const started = Date.now();
  while (!/Listening on/.test(out)) {
    if (proc.exitCode !== null) throw new Error(`server exited early (${proc.exitCode}):\n${out}`);
    if (Date.now() - started > 90_000) throw new Error(`server did not start:\n${out}`);
    await sleep(50);
  }
  return {
    proc,
    command: `${cmd === process.execPath ? 'node' : cmd} ${args.join(' ')}`,
    output: () => out,
    denoPid: () => findDenoChild(proc.pid),
    async stop(signal = 'SIGTERM') {
      if (proc.exitCode !== null || proc.signalCode) return;
      proc.kill(signal);
      for (let i = 0; i < 100 && proc.exitCode === null && !proc.signalCode; i++) await sleep(50);
    },
  };
}

function findDenoChild(pid) {
  const r = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  const kids = r.stdout.trim().split('\n').filter(Boolean).map(Number);
  return kids[0];
}

let spanSeq = 0;
/** Deterministic, unique W3C traceparent per call site key. */
export function traceparent(tag, n) {
  const hex = Buffer.from(`${tag}`).toString('hex').padEnd(16, '0').slice(0, 16);
  const trace = (hex + String(n).padStart(16, '0')).slice(0, 32);
  const span = (String(n).padStart(8, '0') + String(++spanSeq % 1e8).padStart(8, '0')).slice(0, 16);
  return { header: `00-${trace}-${span}-01`, trace, span };
}

export async function request(port, method, p, { body, tp, auth = true, headers = {} } = {}) {
  const h = { ...headers };
  if (auth) h.Authorization = AUTH;
  if (tp) h.traceparent = typeof tp === 'string' ? tp : tp.header;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, ms: performance.now() - t0 };
}

export function listMaps(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.appmap.json'))
    .map((f) => path.join(dir, f));
}

export async function waitForMap(dir, span, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = listMaps(dir).find((f) => path.basename(f).includes(`_${span}_`));
    if (hit) {
      // file is written in one writeTextFile call; make sure it parses
      try {
        return { file: hit, appmap: JSON.parse(fs.readFileSync(hit, 'utf8')), afterMs: Date.now() - t0 };
      } catch {
        /* partially written, retry */
      }
    }
    await sleep(25);
  }
  return undefined;
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
  const byId = new Map(appmap.events.map((e) => [e.id, e]));
  const returns = new Map(appmap.events.filter((e) => e.event === 'return').map((e) => [e.parent_id, e]));
  const out = {
    name: appmap.metadata?.name,
    trace_id: appmap.metadata?.trace_id,
    parent_span_id: appmap.metadata?.parent_span_id,
    truncated: !!appmap.metadata?.truncated,
    servers: [],
    functions: [],
    clients: [],
    sql: [],
    unbalanced: [],
  };
  // Calls open around each event, per thread (a call sits between its
  // parent's call and return): lets checks see nesting.
  const open = new Map();
  const ancestorsOf = new Map();
  for (const e of appmap.events) {
    const stack = open.get(e.thread_id) ?? [];
    open.set(e.thread_id, stack);
    if (e.event === 'call') {
      ancestorsOf.set(e.id, [...stack]);
      stack.push(e.id);
    } else {
      const i = stack.lastIndexOf(e.parent_id);
      if (i >= 0) stack.length = i;
    }
  }
  for (const e of appmap.events) {
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
        synthetic: r ? r.elapsed === undefined && !r.http_client_response : true,
      });
    } else if (e.sql_query) {
      out.sql.push(e.sql_query.sql);
    } else if (e.method_id) {
      out.functions.push({
        id: e.id,
        ancestors: ancestorsOf.get(e.id) ?? [],
        fn: `${e.defined_class}.${e.method_id}`,
        path: e.path,
        lineno: e.lineno,
        params: (e.parameters ?? []).map((p) => p.value),
        paramClasses: (e.parameters ?? []).map((p) => p.class),
        exceptions: r?.exceptions,
        returnClass: r?.return_value?.class,
        synthetic: r ? r.elapsed === undefined && !r.return_value && !r.exceptions : true,
      });
    }
  }
  void byId;
  return out;
}

export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// --- official validation -------------------------------------------------
const toolsRequire = createRequire(path.join(TOOLS, 'package.json'));
let schemaCache;
function schemas() {
  if (schemaCache) return schemaCache;
  const Ajv = toolsRequire('ajv');
  const ajv = new Ajv({ allErrors: true, strict: false });
  const dir = path.join(TOOLS, 'node_modules', '@appland', 'appmap-validate', 'schema');
  schemaCache = fs
    .readdirSync(dir)
    .filter((f) => /^1-\d+-\d+\.js$/.test(f))
    .map((f) => {
      const v = f.replace('.js', '').replace(/-/g, '.');
      return { v, check: ajv.compile(toolsRequire(path.join(dir, f)).schema) };
    })
    .sort((a, b) => a.v.localeCompare(b.v, undefined, { numeric: true }));
  return schemaCache;
}

/** Official CLI verdict plus, per schema version shipped in the official
 * validator, the leaf violations (allErrors) — so "highest version it
 * actually satisfies" is computed, not guessed. */
export function validateMap(file) {
  const cli = sh(VALIDATE_CLI, [file]);
  const appmap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const perVersion = {};
  for (const { v, check } of schemas()) {
    const copy = { ...appmap, version: v };
    const ok = check(copy);
    perVersion[v] = ok
      ? []
      : [
          ...new Set(
            check.errors
              .filter((e) => !['anyOf', 'allOf', 'oneOf', 'if'].includes(e.keyword))
              .map((e) => `${e.instancePath.replace(/\/\d+/g, '/N')} ${e.message}`),
          ),
        ];
  }
  return { cliExit: cli.code, cliOut: cli.out.trim(), perVersion };
}

export function sequenceDiagrams(files, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const r = sh(APPMAP_CLI, ['sequence-diagram', '--format', 'json', '--output-dir', outDir, ...files], {
    env: { ...process.env, APPMAP_TELEMETRY_DISABLED: 'true' },
  });
  return r;
}

/** Drop run-varying fields (timings, ids) from a sequence-diagram JSON. */
export function normalizeDiagram(d) {
  const strip = (n) => {
    if (Array.isArray(n)) return n.map(strip);
    if (n && typeof n === 'object') {
      const o = {};
      for (const [k, v] of Object.entries(n)) {
        if (['elapsed', 'eventIds'].includes(k)) continue;
        o[k] = strip(v);
      }
      return o;
    }
    return n;
  };
  return strip(d);
}
