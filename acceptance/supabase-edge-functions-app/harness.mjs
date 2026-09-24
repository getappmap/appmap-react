// Full-stack acceptance harness: React (supabase edge-functions test client)
// -> Deno (select-from-table-with-auth-rls) -> GoTrue/PostgREST/Postgres, with
// the AppMap React recorder, the AppMap Deno recorder and appmap-link.
// Run through run.sh, which clones the app at the pinned SHA, installs it and
// starts the local stack. Writes evidence/ and evidence/results.json; exits 1
// if any check is not PASS (J is MEASURED).
import fs from 'node:fs';
import path from 'node:path';
import {
  ACC, ROOT, WORK, SUPA, APP, FN_NAME, FN_REL, CORS_REL, APPMAP_CLI, LINK_CLI, TRACE_CLI, GATEWAY_LOG,
  COLLECTOR_DIR, sleep, sh, bg, startFunction, startVite, drive, listMaps, readMap, waitForMap, traceparent,
  invokeDirect, signUp, gatewayLines, summarize, validateFile, sequenceDiagrams, normalizeDiagram, ANON,
} from './lib/util.mjs';

const EVID = path.join(ACC, 'evidence');
const REC = path.join(WORK, 'rec');
fs.rmSync(EVID, { recursive: true, force: true });
fs.rmSync(REC, { recursive: true, force: true });
fs.mkdirSync(EVID, { recursive: true });
fs.rmSync(path.join(WORK, 'logs'), { recursive: true, force: true });

const results = { verdicts: {}, diagnostics: {} };
const log = (...a) => console.log('[acc]', ...a);
const j = (o) => JSON.stringify(o);
const save = (name, data) => {
  const p = path.join(EVID, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
};
function verdict(key, status, evidence) {
  results.verdicts[key] = { status, evidence: [].concat(evidence) };
  log(`${key}: ${status}`);
  for (const e of [].concat(evidence)) log(`   ${e}`);
}
const resetDb = () => {
  const r = sh(path.join(ACC, 'infra', 'stack.sh'), ['reset']);
  if (r.code !== 0) throw new Error(`db reset failed: ${r.out}`);
};
const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const f of listMaps(from)) fs.copyFileSync(f, path.join(to, path.basename(f)));
};
const mapByName = (dir) => Object.fromEntries(listMaps(dir).map((f) => [path.basename(f), f]));

// ------------------------------------------------------------------ gateway
fs.rmSync(GATEWAY_LOG, { force: true });
const gateway = bg('gateway', process.execPath, [path.join(ACC, 'infra', 'gateway.mjs')], {
  env: { ...process.env, GATEWAY_LOG },
});
await sleep(800);

const cfg = (name) => path.join(APP, name);
const FE_CONFIGS = {
  baseline: cfg('vite.config.cra.mjs'),
  Z: cfg('vite.config.appmap.mjs'),
  W: cfg('vite.config.appmap-workaround.mjs'),
};

/** One browser pass: fresh DB, function (plain or recorded), Vite, drive. */
async function browserPass(tag, { fe, recorded, mode = 'sequence', corsPatch = false }) {
  resetDb();
  const backendDir = path.join(REC, tag, 'backend');
  const frontendDir = path.join(REC, tag, 'frontend');
  fs.mkdirSync(backendDir, { recursive: true });
  if (corsPatch) sh('git', ['-C', SUPA, 'apply', path.join(ACC, 'app-config', 'p-cors-traceparent.patch')]);
  const fn = await startFunction({ recorded, appmapDir: recorded ? backendDir : undefined, tag });
  const vite = await startVite(FE_CONFIGS[fe], tag);
  const gwBefore = gatewayLines().length;
  const t0 = Date.now();
  let report;
  try {
    report = drive(mode, path.join(WORK, `drive-${tag}.json`), `${tag}-${Date.now()}`);
  } finally {
    report && (report.wallMs = Date.now() - t0);
    await vite.stop();
    await fn.stop();
    if (corsPatch) sh('git', ['-C', SUPA, 'checkout', '--', CORS_REL]);
  }
  copyDir(COLLECTOR_DIR, frontendDir);
  report.gateway = gatewayLines().slice(gwBefore);
  report.viteLog = vite.log().slice(-4000);
  report.fnLog = fn.log().slice(-4000);
  save(`browser-${tag}.json`, report);
  // map each step to its frontend map / backend maps
  for (const s of report.steps) {
    s.frontend = (s.newMaps ?? []).map((f) => path.join(frontendDir, f));
    s.backend = [];
    for (const w of s.wire ?? []) {
      const span = w.traceparent?.split('-')[2];
      if (!span) continue;
      const hit = listMaps(backendDir).find((f) => readMap(f).metadata?.parent_span_id === span);
      if (hit) s.backend.push(hit);
    }
  }
  log(`${tag}: ${report.steps.map((s) => `${s.id}${s.error ? '(err)' : ''} fe=${s.frontend.length} be=${s.backend.length}`).join(', ')}; ${listMaps(frontendDir).length} frontend, ${listMaps(backendDir).length} backend maps`);
  return { tag, report, frontendDir, backendDir };
}

// ------------------------------------------------------------ browser passes
log('baseline (no recorder), twice');
const base1 = await browserPass('baseline-1', { fe: 'baseline', recorded: false });
const base2 = await browserPass('baseline-2', { fe: 'baseline', recorded: false });
log('Z: zero-touch (recorder plugin exactly as documented) + recorded function');
const Z = await browserPass('Z', { fe: 'Z', recorded: true });
const Zpar = await browserPass('Z-parallel', { fe: 'Z', recorded: true, mode: 'parallel' });
log('W: config-only workaround (diagnostic), twice');
const W1 = await browserPass('W1', { fe: 'W', recorded: true });
const W2 = await browserPass('W2', { fe: 'W', recorded: true });
log('P: W + the app patched to allow traceparent in CORS (diagnostic only; an app change)');
const P = await browserPass('P', { fe: 'W', recorded: true, corsPatch: true });
const Ppar = await browserPass('P-parallel', { fe: 'W', recorded: true, mode: 'parallel', corsPatch: true });

// ------------------------------------------------------- direct requests R1-R4
async function directSeries(tag, { recorded = true } = {}) {
  resetDb();
  const dir = path.join(REC, tag, 'backend');
  fs.mkdirSync(dir, { recursive: true });
  const fn = await startFunction({ recorded, appmapDir: recorded ? dir : undefined, tag });
  const user = await signUp(`${tag}-${Date.now()}@example.com`);
  const obs = {};
  try {
    const reqs = [
      ['R1', { token: undefined, anonBearer: true }],
      ['R2', { token: user.token }],
      ['R3', { noAuth: true }],
    ];
    for (const [i, [id, o]] of reqs.entries()) {
      const tp = traceparent('direct', i + 1);
      const before = gatewayLines().length;
      const res = await invokeDirect({ token: o.anonBearer ? ANON : o.token, tp });
      const file = recorded ? await waitForMap(dir, tp.span) : undefined;
      await sleep(100);
      obs[id] = {
        tp: tp.header,
        status: res.status,
        body: res.text,
        file,
        wire: gatewayLines().slice(before).filter((l) => l.traceparent?.includes(tp.trace)).map((l) => `${l.method} ${l.url} ${l.status}`),
      };
    }
    const pre = await invokeDirect({
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:3300',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'apikey,authorization,traceparent,x-client-info',
      },
    });
    obs.R4 = { status: pre.status, body: pre.text, allowHeaders: pre.headers['access-control-allow-headers'] ?? null, backendMaps: listMaps(dir).length };
  } finally {
    await fn.stop();
  }
  obs.userId = user.id;
  return { tag, dir, obs };
}
log('R-series (direct stamped requests), twice, for C/E/G');
const R1run = await directSeries('R-run1');
const R2run = await directSeries('R-run2');
save('direct-R-run1.json', R1run.obs);
save('direct-R-run2.json', R2run.obs);

// ---------------------------------------------------------------- H change
log('H: one behaviour change in the function (select * -> select id), re-record R1-R3');
const hPatch = path.join(ACC, 'app-config', 'h-change.patch');
const applied = sh('git', ['-C', SUPA, 'apply', hPatch]);
let Hrun;
try {
  Hrun = await directSeries('R-h');
} finally {
  sh('git', ['-C', SUPA, 'checkout', '--', FN_REL]);
}
save('direct-R-h.json', { applied: applied.code === 0, applyOut: applied.out, ...Hrun.obs });

// --------------------------------------------------------- I backend concurrency
log('I(a): 6 concurrent stamped requests to the recorded function');
async function concurrentBackend() {
  resetDb();
  const dir = path.join(REC, 'I-backend', 'backend');
  fs.mkdirSync(dir, { recursive: true });
  const fn = await startFunction({ recorded: true, appmapDir: dir, tag: 'I-backend' });
  const users = [];
  for (let i = 0; i < 3; i++) users.push(await signUp(`conc${i}-${Date.now()}@example.com`));
  const plan = [0, 1, 2, 3, 4, 5].map((i) => ({ i, tp: traceparent(`conc${i}`, 100 + i), token: i < 3 ? ANON : users[i - 3].token }));
  const before = gatewayLines().length;
  const responses = await Promise.all(plan.map((p) => invokeDirect({ token: p.token, tp: p.tp })));
  await sleep(1500);
  await fn.stop();
  const gw = gatewayLines().slice(before);
  const out = plan.map((p, k) => {
    const file = listMaps(dir).find((f) => readMap(f).metadata?.parent_span_id === p.tp.span);
    const s = file ? summarize(readMap(file)) : undefined;
    const ownWire = gw.filter((l) => l.traceparent?.includes(p.tp.trace) && l.route !== 'functions').map((l) => `${l.method} ${l.url}`);
    return {
      request: p.i,
      status: responses[k].status,
      traceparent: p.tp.header,
      map: file ? path.basename(file) : null,
      clients: s?.clients.map((c) => `${c.method} ${c.url.replace('http://127.0.0.1:54321', '')} ${c.status}`),
      // each request makes exactly 2 outbound calls; more in one map = other requests' calls leaked in
      leakedClients: s ? Math.max(0, s.clients.length - 2) : null,
      // outbound calls that reached the gateway carrying THIS request's trace id (expected 2)
      wireOutbound: ownWire,
    };
  });
  return { dir, out, totalMaps: listMaps(dir).length };
}
const Ib = await concurrentBackend();
save('i-backend.json', Ib.out);

// ------------------------------------------------------------------ J timing
log('J: 20 direct R2 requests, plain vs recorded');
async function timeDirect(recorded) {
  resetDb();
  const dir = path.join(REC, `J-${recorded ? 'rec' : 'plain'}`, 'backend');
  fs.mkdirSync(dir, { recursive: true });
  const fn = await startFunction({ recorded, appmapDir: recorded ? dir : undefined, tag: `J-${recorded}` });
  const user = await signUp(`timing-${recorded}-${Date.now()}@example.com`);
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) await invokeDirect({ token: user.token, tp: traceparent('timing', 1000 + i) });
  const ms = performance.now() - t0;
  await fn.stop();
  return ms;
}
const jDirect = { plain: await timeDirect(false), recorded: await timeDirect(true) };

await gateway.stop();

// =============================================================== the checks
const stepOf = (pass, id) => pass.report.steps.find((s) => s.id === id) ?? { frontend: [], backend: [], wire: [] };
const feSummary = (pass, id) => stepOf(pass, id).frontend.map((f) => summarize(readMap(f)));
const FN_URL = `http://localhost:54321/functions/v1/${FN_NAME}`;
const S2_URL = 'http://localhost:54321/functions/v1/local:%20Whatever%20function%20is%20currently%20served%20by%20the%20CLI';

// --- A ---------------------------------------------------------------------
const setup = JSON.parse(fs.readFileSync(path.join(WORK, 'setup.json'), 'utf8'));
const zRendered = !Z.report.appDidNotRender;
const zViteLog = fs.readFileSync(path.join(WORK, 'logs', 'vite-Z.log'), 'utf8');
const zViteErr = [...new Set((zViteLog.match(/Internal server error: [^\n]*/gi) ?? []).map((l) => l.replace(/\/\S*\/(src\/)/, '$1')))].slice(0, 3);
const zConsole = Z.report.console.filter((c) => c.type === 'error').map((c) => c.text.slice(0, 160)).slice(0, 3);
const appTree = sh('git', ['-C', SUPA, 'status', '--short']).stdout.trim();
save('a-app-tree-changes.txt', appTree + '\n');
// A cannot pass while the recorder needs the app's build tool swapped out
// (pre-registered in EXPECTATIONS.md); the other conditions are reported too.
verdict('A', 'FAIL', [
  `setup ${setup.ok ? 'completed' : 'FAILED'}: ${setup.note}`,
  `app source edits: none (git status of the app tree: ${j(appTree.split('\n'))} -- package.json/lockfile from the dev-dependency install and the harness's Vite config files only)`,
  'toolchain substitution needed: the recorder has no Create React App / webpack integration, so the app is run under Vite (app-config/cra-compat.mjs). Counts against the recorder (EXPECTATIONS.md).',
  `zero-touch config (recorder plugin exactly as documented) ${zRendered ? 'serves a working app' : 'BREAKS the app: it does not render'}`,
  ...zViteErr.map((e) => `  vite: ${e.slice(0, 300)}`),
  ...zConsole.map((e) => `  browser: ${e}`),
]);

// --- B ---------------------------------------------------------------------
const allMaps = [Z, Zpar, W1, P, Ppar].flatMap((p) => [...listMaps(p.frontendDir), ...listMaps(p.backendDir)])
  .concat(listMaps(R1run.dir), listMaps(Ib.dir));
const bReport = allMaps.map(validateFile);
save('b-validate.json', bReport);
const bValid = bReport.filter((r) => r.declaredResult === 'valid').length;
const bReasons = {};
for (const r of bReport) if (r.declaredResult !== 'valid') bReasons[r.declaredResult.slice(0, 200)] = (bReasons[r.declaredResult.slice(0, 200)] ?? 0) + 1;
const zMaps = listMaps(Z.frontendDir).length + listMaps(Z.backendDir).length;
verdict('B', bReport.length && bValid === bReport.length && zMaps > 0 ? 'PASS' : 'FAIL', [
  `official validator (@appland/appmap-validate): ${bValid}/${bReport.length} maps valid at their declared version (${[...new Set(bReport.map((r) => r.declared))].join(', ')})`,
  ...Object.entries(bReasons).map(([k, v]) => `${v}x ${k}`),
  `zero-touch pass produced ${zMaps} map(s)`,
]);

// --- C ---------------------------------------------------------------------
function frontendItems(pass) {
  const items = [];
  const add = (id, expect, status, quote) => items.push({ id, expect, status, quote });
  const one = (id) => {
    const maps = feSummary(pass, id);
    if (!maps.length) add(id, 'one frontend interaction map', 'missing', stepOf(pass, id).error ?? 'no map collected');
    return maps[0];
  };
  const fnItem = (id, m, method, lineno) => {
    const f = m?.functions.find((x) => x.method_id === method || (method === '*' && x.lineno === lineno));
    if (!m) return;
    if (!f) add(id, `call ${method} (src/App.js:${lineno})`, 'missing', m.functions.map((x) => `${x.fn}@${x.lineno}`).join(', '));
    else add(id, `call ${method} (src/App.js:${lineno})`, f.path === 'src/App.js' && f.lineno === lineno ? 'found' : 'wrong', `${f.fn} ${f.path}:${f.lineno}`);
  };
  const clientItem = (id, m, method, url, status, needTp) => {
    if (!m) return;
    const c = m.clients.find((x) => x.method === method && x.url === url);
    const exp = `${method} ${url.replace('http://localhost:54321', '')} -> ${status}${needTp ? ' with traceparent' : ''}`;
    if (!c) add(id, exp, 'missing', m.clients.map((x) => `${x.method} ${x.url} ${x.status}`).join(', ') || 'no http_client_request');
    else {
      const tpOk = !needTp || (c.traceparent && c.traceparent.split('-')[1] === m.trace_id);
      add(id, exp, c.status === status && tpOk ? 'found' : 'wrong', `${c.method} ${c.url} status=${c.status} traceparent=${c.traceparent ?? 'none'}`);
    }
  };
  let m = one('S2');
  fnItem('S2', m, 'invokeFunction', 16);
  fnItem('S2', m, 'App', 10);
  clientItem('S2', m, 'POST', S2_URL, 0, false);
  m = one('S3');
  fnItem('S3', m, 'invokeFunction', 16);
  clientItem('S3', m, 'POST', FN_URL, 200, true);
  m = one('S4');
  clientItem('S4', m, 'POST', 'http://localhost:54321/auth/v1/signup', 200, false);
  fnItem('S4', m, 'App', 10);
  m = one('S5');
  fnItem('S5', m, 'invokeFunction', 16);
  clientItem('S5', m, 'POST', FN_URL, 200, true);
  m = one('S6');
  fnItem('S6', m, '*', 86);
  clientItem('S6', m, 'POST', 'http://localhost:54321/auth/v1/logout?scope=global', 204, false);
  return items;
}
function backendItems(run) {
  const items = [];
  const add = (id, expect, status, quote) => items.push({ id, expect, status, quote });
  const exp = {
    R1: { status: 200, clients: [['GET', '/auth/v1/user', 403], ['GET', '/rest/v1/users?select=*', 200]] },
    R2: { status: 200, clients: [['GET', '/auth/v1/user', 200], ['GET', '/rest/v1/users?select=*', 200]] },
    R3: { status: 400, clients: [] },
  };
  for (const [id, e] of Object.entries(exp)) {
    const o = run.obs[id];
    if (!o.file) {
      add(id, 'backend map', 'missing', `response ${o.status}`);
      continue;
    }
    const m = readMap(o.file);
    const s = summarize(m);
    const span = o.tp.split('-')[2];
    const trace = o.tp.split('-')[1];
    add(id, 'metadata trace_id/parent_span_id from traceparent', m.metadata.trace_id === trace && m.metadata.parent_span_id === span ? 'found' : 'wrong', `trace_id=${m.metadata.trace_id} parent_span_id=${m.metadata.parent_span_id}`);
    const srv = s.servers[0];
    add(id, `http_server_request POST /${FN_NAME} -> ${e.status}`, srv && srv.method === 'POST' && srv.path === `/${FN_NAME}` && srv.status === e.status ? 'found' : srv ? 'wrong' : 'missing', j(srv ?? null));
    const h = s.functions.find((f) => f.path?.endsWith(`${FN_NAME}/index.ts`) && f.lineno === 10);
    add(id, 'call event for the request handler (index.ts:10)', h ? 'found' : 'missing', h ? `${h.fn}@${h.lineno}` : `call events: ${j(s.functions.map((f) => `${f.fn}@${f.path}:${f.lineno}`))}`);
    const got = s.clients.map((c) => [c.method, c.url.replace('http://127.0.0.1:54321', ''), c.status]);
    e.clients.forEach((c, k) => {
      const g = got[k];
      add(id, `outbound #${k + 1}: ${c.join(' ')}`, g && j(g) === j(c) ? (s.clients[k].traceparent?.split('-')[1] === trace ? 'found' : 'wrong') : g ? 'wrong' : 'missing', g ? `${g.join(' ')} traceparent=${s.clients[k].traceparent}` : 'none');
    });
    if (got.length > e.clients.length) add(id, `exactly ${e.clients.length} outbound call(s)`, 'wrong', j(got));
    if (id === 'R2') {
      const body = JSON.parse(o.body.startsWith('{') ? o.body : '{}');
      add(id, 'response: user + exactly 1 row, their own (RLS)', body?.data?.length === 1 && body.data[0].id === run.obs.userId ? 'found' : 'wrong', o.body.slice(0, 120));
    }
  }
  const r4 = run.obs.R4;
  add('R4', 'preflight 200, allow-headers exactly "authorization, x-client-info, apikey, content-type"', r4.status === 200 && r4.allowHeaders === 'authorization, x-client-info, apikey, content-type' ? 'found' : 'wrong', `${r4.status} ${r4.allowHeaders}`);
  return items;
}
const cZ = frontendItems(Z);
const cW = frontendItems(W1);
const cR = backendItems(R1run);
save('c-ground-truth.json', { zeroTouchFrontend: cZ, workaroundFrontendDiagnostic: cW, backend: cR });
const tally = (items) => items.reduce((t, i) => ((t[i.status] = (t[i.status] ?? 0) + 1), t), {});
const bad = (items) => items.filter((i) => i.status !== 'found').map((i) => `${i.id} ${i.status}: ${i.expect} [${String(i.quote).slice(0, 140)}]`);
verdict('C', [...cZ, ...cR].every((i) => i.status === 'found') ? 'PASS' : 'FAIL', [
  `zero-touch frontend: ${j(tally(cZ))}; backend: ${j(tally(cR))}; (diagnostic) workaround frontend: ${j(tally(cW))}`,
  ...bad(cZ).slice(0, 8),
  ...bad(cR),
  ...bad(cW).map((s) => `(W) ${s}`),
]);

// --- D ---------------------------------------------------------------------
function noise(dirs) {
  const byPath = {};
  let total = 0;
  for (const f of dirs.flatMap(listMaps)) {
    for (const e of readMap(f).events) {
      if (e.event !== 'call' || !e.method_id) continue;
      total++;
      const p = e.path ?? '(no path)';
      byPath[p] = (byPath[p] ?? 0) + 1;
    }
  }
  const foreign = Object.entries(byPath).filter(([p]) => !(p.startsWith('src/') || p.endsWith(`${FN_NAME}/index.ts`)));
  return { total, byPath, foreign };
}
const dZ = noise([Z.frontendDir, Z.backendDir, R1run.dir]);
const dW = noise([W1.frontendDir, W1.backendDir]);
save('d-noise.json', { zeroTouch: dZ, workaroundDiagnostic: dW });
verdict('D', dZ.total > 0 && dZ.foreign.length === 0 ? 'PASS' : 'FAIL', [
  `zero-touch + backend: ${dZ.total} call events by path ${j(dZ.byPath)}; outside app code: ${j(dZ.foreign)}`,
  `(W) ${dW.total} call events by path ${j(dW.byPath)}; outside app code: ${j(dW.foreign)}`,
  ...(dZ.total === 0 ? ['no call events at all in the zero-touch recordings: nothing to judge'] : []),
]);

// --- E ---------------------------------------------------------------------
const r3 = R1run.obs.R3.file ? summarize(readMap(R1run.obs.R3.file)) : undefined;
const eBackend = !!r3 && r3.servers[0]?.status === 400 && r3.exceptions.length === 0 && r3.unbalanced.length === 0;
const zS2 = feSummary(Z, 'S2')[0];
const zS2c = zS2?.clients.find((c) => c.url === S2_URL);
const eFrontend = !!zS2c && zS2c.status === 0 && zS2.unbalanced.length === 0;
const wS2 = feSummary(W1, 'S2')[0]?.clients.find((c) => c.url === S2_URL);
verdict('E', eBackend && eFrontend ? 'PASS' : 'FAIL', [
  `backend R3 (TypeError thrown at index.ts:33, caught at :48): ${r3 ? `status ${r3.servers[0]?.status}, exceptions ${j(r3.exceptions)}, unbalanced ${r3.unbalanced.length}` : 'no map'}; response ${R1run.obs.R3.body}`,
  `frontend S2 (fetch rejected): zero-touch ${zS2c ? `request recorded, response status ${zS2c.status}` : 'no map'}; (W) ${wS2 ? `status ${wS2.status}` : 'no map'}`,
  'note: the app has no path where an exception escapes an app function (EXPECTATIONS.md, E).',
]);

// --- F (analog) ------------------------------------------------------------
verdict('F', feSummary(Z, 'S2').length ? 'PASS (analog)' : 'FAIL (analog)', [
  'no test runner is involved, so there is no test status to mark (not applicable as specified)',
  `analog: the failing interaction S2 (error alert) left a zero-touch frontend map: ${feSummary(Z, 'S2').length ? 'yes' : 'no'}; (W): ${feSummary(W1, 'S2').length ? 'yes' : 'no'}`,
]);

// --- G ---------------------------------------------------------------------
function compareSeq(filesA, filesB, keyOf, label) {
  const dA = path.join(WORK, 'seq', `${label}-a`);
  const dB = path.join(WORK, 'seq', `${label}-b`);
  sequenceDiagrams(filesA, dA);
  sequenceDiagrams(filesB, dB);
  const load = (dir, files) => {
    const m = {};
    for (const f of files) {
      const seq = path.join(dir, path.basename(f).replace(/\.appmap\.json$/, '.sequence.json'));
      if (fs.existsSync(seq)) m[keyOf(f)] = normalizeDiagram(JSON.parse(fs.readFileSync(seq, 'utf8')));
    }
    return m;
  };
  const a = load(dA, filesA);
  const b = load(dB, filesB);
  const same = [];
  const different = {};
  for (const k of Object.keys(a)) {
    if (!(k in b)) continue;
    if (j(a[k]) === j(b[k])) same.push(k);
    else different[k] = { a: j(a[k]).slice(0, 1500), b: j(b[k]).slice(0, 1500) };
  }
  return { same, different, onlyA: Object.keys(a).filter((k) => !(k in b)), onlyB: Object.keys(b).filter((k) => !(k in a)) };
}
const stepKey = (pass) => (f) => pass.report.steps.find((s) => s.frontend.includes(f))?.id ?? path.basename(f);
const reqKey = (run) => (f) => Object.entries(run.obs).find(([, o]) => o?.file === f)?.[0] ?? path.basename(f);
const gBackend = compareSeq(['R1', 'R2', 'R3'].map((k) => R1run.obs[k].file).filter(Boolean), ['R1', 'R2', 'R3'].map((k) => R2run.obs[k].file).filter(Boolean), (f) => reqKey(R1run)(f) !== path.basename(f) ? reqKey(R1run)(f) : reqKey(R2run)(f), 'g-backend');
const gW = compareSeq(listMaps(W1.frontendDir), listMaps(W2.frontendDir), (f) => stepKey(W1)(f) !== path.basename(f) ? stepKey(W1)(f) : stepKey(W2)(f), 'g-w');
const zCount = listMaps(Z.frontendDir).length;
save('g-stability.json', { backend: gBackend, workaroundFrontendDiagnostic: gW, zeroTouchFrontendMaps: zCount });
const gBackOk = gBackend.same.length === 3 && !Object.keys(gBackend.different).length;
verdict('G', zCount === 0 ? 'NOT RUN' : gBackOk ? 'PASS' : 'FAIL', [
  `frontend (zero-touch): ${zCount === 0 ? 'NOT RUN, the zero-touch pass produced no recordings to compare' : 'see evidence'}`,
  `backend R1-R3, run 1 vs run 2: same ${j(gBackend.same)}, different ${j(Object.keys(gBackend.different))}, only in one run ${j([...gBackend.onlyA, ...gBackend.onlyB])}`,
  `(W) frontend S2-S6, run 1 vs run 2: same ${j(gW.same)}, different ${j(Object.keys(gW.different))}, only in one run ${j([...gW.onlyA, ...gW.onlyB])}`,
]);

// --- H ---------------------------------------------------------------------
const hFiles = (run) => ['R1', 'R2', 'R3'].map((k) => run.obs[k]?.file).filter(Boolean);
const hCmp = compareSeq(hFiles(R1run), hFiles(Hrun), (f) => reqKey(R1run)(f) !== path.basename(f) ? reqKey(R1run)(f) : reqKey(Hrun)(f), 'h');
const hDiffs = {};
for (const k of ['R1', 'R2', 'R3']) {
  const a = path.join(WORK, 'seq', 'h-a', path.basename(R1run.obs[k].file ?? 'x').replace(/\.appmap\.json$/, '.sequence.json'));
  const b = path.join(WORK, 'seq', 'h-b', path.basename(Hrun.obs[k].file ?? 'x').replace(/\.appmap\.json$/, '.sequence.json'));
  if (fs.existsSync(a) && fs.existsSync(b)) {
    const outDir = path.join(WORK, 'seq', `h-diff-${k}`);
    fs.rmSync(outDir, { recursive: true, force: true });
    const r = sh(APPMAP_CLI, ['sequence-diagram-diff', a, b, '--format', 'text', '--output-dir', outDir], { env: { ...process.env, APPMAP_TELEMETRY_DISABLED: 'true' }, cwd: WORK });
    const diffFile = path.join(outDir, 'diff.txt');
    hDiffs[k] = fs.existsSync(diffFile) ? fs.readFileSync(diffFile, 'utf8').trim() || '(empty diff: identical)' : `no diff file: ${r.out.trim().slice(0, 300)}`;
  }
}
const hTrace = sh(process.execPath, [TRACE_CLI, Hrun.dir, '--baseline', R1run.dir]);
save('h-change.json', { patchApplied: applied.code === 0, compare: hCmp, sequenceDiagramDiff: hDiffs });
save('h-appmap-trace.txt', hTrace.out);
const hClients = (run, k) => (run.obs[k]?.file ? summarize(readMap(run.obs[k].file)).clients.map((c) => c.url.replace('http://127.0.0.1:54321', '')) : null);
const hOk =
  applied.code === 0 &&
  j(Object.keys(hCmp.different).sort()) === j(['R1', 'R2']) &&
  hCmp.same.includes('R3') &&
  ['R1', 'R2'].every((k) => j(hClients(Hrun, k)) === j(['/auth/v1/user', '/rest/v1/users?select=id'])) &&
  ['R1', 'R2'].every((k) => (hCmp.different[k]?.b ?? '').includes('select=id'));
verdict('H', hOk ? 'PASS' : 'FAIL', [
  `patch applied: ${applied.code === 0}; before vs after: same ${j(hCmp.same)}, different ${j(Object.keys(hCmp.different))}`,
  `R1 outbound after: ${j(hClients(Hrun, 'R1'))}; R2 after: ${j(hClients(Hrun, 'R2'))}; R3 after: ${j(hClients(Hrun, 'R3'))}`,
  `official sequence-diagram-diff R1: ${(hDiffs.R1 ?? 'n/a').replace(/\s+/g, ' ').slice(0, 300)}`,
  `appmap-trace --baseline: ${hTrace.out.trim().split('\n').slice(-1)[0]}`,
]);

// --- I ---------------------------------------------------------------------
const iBackOk = Ib.out.every((o) => o.map && o.clients?.length === 2 && o.wireOutbound.length === 2) && Ib.totalMaps === 6;
function browserIsolation(pass) {
  const s = pass.report.steps.find((x) => x.id === 'I');
  if (!s || pass.report.appDidNotRender) return { ok: false, note: 'app did not render' };
  const maps = s.frontend.map((f) => summarize(readMap(f)));
  const fnReqs = maps.map((m) => m.clients.filter((c) => c.url === FN_URL).length);
  const traces = new Set(maps.map((m) => m.trace_id));
  return { ok: maps.length === 3 && fnReqs.every((n) => n === 1) && traces.size === 3, maps: maps.length, fnReqsPerMap: fnReqs, backendMaps: listMaps(pass.backendDir).length };
}
const iZ = browserIsolation(Zpar);
const iP = browserIsolation(Ppar);
save('i-concurrency.json', { backend: Ib.out, zeroTouchBrowser: iZ, patchedBrowserDiagnostic: iP });
verdict('I', iBackOk && iZ.ok ? 'PASS' : 'FAIL', [
  `backend: ${Ib.totalMaps}/6 maps for 6 concurrent stamped requests; per request: ${j(Ib.out.map((o) => ({ req: o.request, status: o.status, map: !!o.map, clientsInMap: o.clients?.length ?? null, leaked: o.leakedClients, ownTraceOnWire: o.wireOutbound.length })))}`,
  ...Ib.out.filter((o) => o.leakedClients).map((o) => `   request ${o.request}'s map holds ${o.clients.length} outbound calls (expected 2): ${o.leakedClients} belong to the other concurrent requests, and were stamped with request ${o.request}'s trace id on the wire (${o.wireOutbound.length} gateway hits carry it)`),
  ...Ib.out.filter((o) => !o.map).map((o) => `   request ${o.request} (${o.traceparent}) got HTTP ${o.status}, NO backend map, and ${o.wireOutbound.length} of its outbound calls carried its own trace id`),
  `browser (zero-touch), 3 users clicking at once: ${j(iZ)}`,
  `(P, diagnostic) browser with CORS patched: ${j(iP)}`,
]);

// --- J ---------------------------------------------------------------------
const wall = (p) => p.report.wallMs;
results.timings = {
  browserSequence: { baseline: [wall(base1), wall(base2)], zeroTouch: [wall(Z)], workaround: [wall(W1), wall(W2)] },
  direct20xR2: jDirect,
};
save('j-overhead.json', results.timings);
verdict('J', 'MEASURED', [
  `browser S1-S6 wall time: no recorder ${wall(base1)} / ${wall(base2)} ms; recorded (W config) ${wall(W1)} / ${wall(W2)} ms; zero-touch ${wall(Z)} ms (app broken, not comparable)`,
  `20 direct R2 requests: plain ${jDirect.plain.toFixed(0)} ms, recorded ${jDirect.recorded.toFixed(0)} ms (${((100 * (jDirect.recorded - jDirect.plain)) / jDirect.plain).toFixed(0)}%)`,
]);

// --- L: the cross-map link -------------------------------------------------
function linkCheck(pass, label) {
  const out = {};
  const linksDir = path.join(WORK, 'links', label);
  fs.rmSync(linksDir, { recursive: true, force: true });
  const link = sh(process.execPath, [LINK_CLI, pass.frontendDir, pass.backendDir, '--out', linksDir]);
  out.linkStdout = link.out.trim();
  const baseS = Object.fromEntries(base1.report.steps.map((s) => [s.id, s]));
  for (const id of ['S3', 'S5']) {
    const s = stepOf(pass, id);
    const r = { step: id };
    const wire = (s.wire ?? []).find((w) => w.method === 'POST' && w.url === FN_URL);
    const fe = s.frontend[0] ? readMap(s.frontend[0]) : undefined;
    const feReq = fe ? summarize(fe).clients.find((c) => c.url === FN_URL) : undefined;
    const span = wire?.traceparent?.split('-')[2];
    r.L1 = !!(wire?.traceparent && fe && wire.traceparent.split('-')[1] === fe.metadata.trace_id && feReq?.traceparent === wire.traceparent);
    r.L1quote = `wire traceparent=${wire?.traceparent ?? 'none'}; map trace_id=${fe?.metadata.trace_id ?? 'no map'}; map request traceparent=${feReq?.traceparent ?? 'none'}`;
    const be = span ? listMaps(pass.backendDir).find((f) => readMap(f).metadata?.parent_span_id === span) : undefined;
    r.L2 = !!(be && readMap(be).metadata.trace_id === fe?.metadata.trace_id);
    r.L2quote = be ? `${path.basename(be)} trace_id=${readMap(be).metadata.trace_id} parent_span_id=${readMap(be).metadata.parent_span_id}` : 'no backend map with that parent_span_id';
    let links = { links: [], orphan_backends: [] };
    try {
      links = JSON.parse(fs.readFileSync(path.join(linksDir, 'appmap-links.json'), 'utf8'));
    } catch {}
    const l = fe ? links.links.find((x) => x.interaction.path === s.frontend[0]) : undefined;
    const lr = l?.requests.find((x) => x.request.url === FN_URL);
    r.L3 = !!(lr?.backend && be && lr.backend.path === be) && links.orphan_backends.length === 0;
    r.L3quote = `link: ${j(lr ?? null)}; orphans ${links.orphan_backends.length}`;
    const puml = fe ? path.join(linksDir, path.basename(s.frontend[0]).replace(/\.appmap\.json$/, '.puml')) : undefined;
    const diagram = puml && fs.existsSync(puml) ? fs.readFileSync(puml, 'utf8') : '';
    const has = {
      click: /User -> FE : click button "Invoke Function"/.test(diagram),
      handler: /invokeFunction/.test(diagram),
      backend: new RegExp(`FE -> BE\\d : POST /functions/v1/${FN_NAME}`).test(diagram),
      db: /rest\/v1\/users/.test(diagram),
    };
    r.L4 = Object.values(has).every(Boolean);
    r.L4quote = `diagram shows ${j(has)}${diagram ? '' : ' (no diagram written)'}`;
    if (diagram) save(`links-${label}-${id}.puml`, diagram);
    const same = (s.response ?? '') === (baseS[id]?.response ?? '') || (id === 'S5' && sameS5(s.response, baseS[id]?.response));
    r.L5 = same;
    r.L5quote = `response ${JSON.stringify((s.response ?? '').replace(/\s+/g, ' ').slice(0, 100))} vs no recorder ${JSON.stringify((baseS[id]?.response ?? '').replace(/\s+/g, ' ').slice(0, 100))}`;
    out[id] = r;
  }
  out.dialogs = pass.report.dialogs;
  out.corsErrors = pass.report.console.filter((c) => /CORS/.test(c.text)).map((c) => c.text.slice(0, 220));
  return out;
}
function sameS5(a, b) {
  try {
    const x = JSON.parse(a);
    const y = JSON.parse(b);
    return x.data?.length === 1 && y.data?.length === 1 && x.data[0].id === x.user.id && y.data[0].id === y.user.id;
  } catch {
    return false;
  }
}
const LZ = linkCheck(Z, 'Z');
const LW = linkCheck(W1, 'W');
const LP = linkCheck(P, 'P');
save('l-link.json', { zeroTouch: LZ, workaroundDiagnostic: LW, corsPatchedDiagnostic: LP });
const lStr = (L) => ['S3', 'S5'].map((id) => `${id}: ${['L1', 'L2', 'L3', 'L4', 'L5'].map((k) => `${k} ${L[id][k] ? 'ok' : 'FAIL'}`).join(', ')}`).join('; ');
const lOk = ['S3', 'S5'].every((id) => ['L1', 'L2', 'L3', 'L4', 'L5'].every((k) => LZ[id][k]));
verdict('L', lOk ? 'PASS' : 'FAIL', [
  `zero-touch: ${lStr(LZ)}`,
  `  S5 ${LZ.S5.L1quote}`,
  `(W, diagnostic) ${lStr(LW)}`,
  `  W S5: ${LW.S5.L1quote}; ${LW.S5.L2quote}; ${LW.S5.L5quote}`,
  ...LW.corsErrors.slice(0, 1).map((c) => `  W browser console: ${c}`),
  `(P, diagnostic, app CORS patched) ${lStr(LP)}`,
  `  P S5: ${LP.S5.L2quote}; ${LP.S5.L3quote.slice(0, 200)}; ${LP.S5.L4quote}`,
  `  appmap-link on P: ${LP.linkStdout.split('\n')[0]}`,
]);

// ---------------------------------------------------------------- evidence
for (const [name, dir] of [
  ['Z/frontend', Z.frontendDir], ['Z/backend', Z.backendDir], ['W1/frontend', W1.frontendDir], ['W1/backend', W1.backendDir],
  ['P/frontend', P.frontendDir], ['P/backend', P.backendDir], ['R-run1/backend', R1run.dir], ['R-h/backend', Hrun.dir],
  ['I-backend/backend', Ib.dir], ['P-parallel/frontend', Ppar.frontendDir], ['P-parallel/backend', Ppar.backendDir],
]) copyDir(dir, path.join(EVID, 'recordings', name));
results.tools = {
  node: process.version,
  deno: sh('deno', ['--version']).stdout.split('\n')[0],
  appmapCli: sh(APPMAP_CLI, ['--version']).out.trim(),
  recorderRepoHead: sh('git', ['-C', ROOT, 'rev-parse', 'HEAD']).stdout.trim(),
  appVersions: Object.fromEntries(
    ['@supabase/supabase-js', '@supabase/auth-ui-react', 'react', 'react-dom', 'vite'].map((p) => {
      try {
        return [p, JSON.parse(fs.readFileSync(path.join(APP, 'node_modules', p, 'package.json'), 'utf8')).version];
      } catch {
        return [p, null];
      }
    }),
  ),
};
save('results.json', results);
let failed = false;
console.log('\n== summary');
for (const k of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'L']) {
  const s = results.verdicts[k]?.status ?? 'NOT RUN';
  console.log(`${k} ${s}`);
  if (!(s.startsWith('PASS') || s === 'MEASURED')) failed = true;
}
process.exit(failed ? 1 : 0);
