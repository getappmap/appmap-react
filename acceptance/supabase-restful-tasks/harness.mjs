// Acceptance harness: AppMap Deno recorder vs supabase restful-tasks @ 74a3be9.
// Run through run.sh (which starts Postgres + PostgREST and clones the app).
// Writes evidence/ and evidence/results.json; exits 1 if any check FAILs.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { diagnose } from './lib/schema-diagnose.mjs';
import {
  ACC, ROOT, WORK, APPDIR, ENTRY_REL, PROBE, APP_PORT, PROBE_PORT, GW, GATEWAY_LOG, AUTH, ANON,
  sleep, startServer, traceparent, request, listMaps, waitForMap, gatewayLines, summarize, sh,
  validateMap, sequenceDiagrams, normalizeDiagram, APPMAP_CLI,
} from './lib/util.mjs';

const EVID = path.join(ACC, 'evidence');
const REC = path.join(WORK, 'rec');
fs.rmSync(EVID, { recursive: true, force: true });
fs.rmSync(REC, { recursive: true, force: true });
fs.mkdirSync(EVID, { recursive: true });

const results = {};
const log = (...a) => console.log('[acc]', ...a);
function verdict(key, status, evidence) {
  results[key] = { status, evidence };
  log(`${key}: ${status}`);
  for (const e of [].concat(evidence)) log(`   ${e}`);
}
const j = (o) => JSON.stringify(o);
const save = (name, data) =>
  fs.writeFileSync(path.join(EVID, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));

function resetDb() {
  const r = sh(path.join(ACC, 'infra', 'db.sh'), ['reset'], { env: { ...process.env, WORK } });
  if (r.code !== 0) throw new Error(`db reset failed: ${r.out}`);
}

// ---------------------------------------------------------------- gateway
fs.rmSync(GATEWAY_LOG, { force: true });
const gateway = spawn(process.execPath, [path.join(ACC, 'infra', 'gateway.mjs')], {
  env: { ...process.env, GATEWAY_LOG },
  stdio: 'ignore',
});
await sleep(600);

// ---------------------------------------------------------------- the ground-truth sequence
// (EXPECTATIONS.md R1-R8, T1-T2). Fixed traceparents so runs are comparable.
const SEQ = [
  { id: 'R1', method: 'OPTIONS', path: '/restful-tasks', status: 200, fns: [], clients: [] },
  { id: 'R2', method: 'GET', path: '/restful-tasks', status: 200, fns: [['index.getAllTasks', 28, []]],
    clients: [['GET', `${GW}/rest/v1/tasks?select=*`, 200]] },
  { id: 'R3', method: 'GET', path: '/restful-tasks/1', status: 200, fns: [['index.getTask', 18, ['1']]],
    clients: [['GET', `${GW}/rest/v1/tasks?select=*&id=eq.1`, 200]] },
  { id: 'R4', method: 'POST', path: '/restful-tasks', body: { task: { name: 'acc-new', status: 0 } }, status: 200,
    fns: [['index.createTask', 58, ['{"name":"acc-new","status":0}']]],
    clients: [['POST', `${GW}/rest/v1/tasks`, 201]] },
  { id: 'R5', method: 'PUT', path: '/restful-tasks/1', body: { task: { name: 'renamed', status: 1 } }, status: 200,
    fns: [['index.updateTask', 48, ['1', '{"name":"renamed","status":1}']]],
    clients: [['PATCH', `${GW}/rest/v1/tasks?id=eq.1`, 204]] },
  { id: 'R6', method: 'DELETE', path: '/restful-tasks/2', status: 200, fns: [['index.deleteTask', 38, ['2']]],
    clients: [['DELETE', `${GW}/rest/v1/tasks?id=eq.2`, 204]] },
  { id: 'R7', method: 'GET', path: '/restful-tasks/not-a-number', status: 500,
    fns: [['index.getTask', 18, ['not-a-number']]],
    // EXPECTATIONS.md said class "PostgrestError"; that was wrong: supabase-js returns
    // (and the app throws) the plain parsed JSON error object. See RESULTS.md.
    exception: { message: 'invalid input syntax for type bigint' },
    clients: [['GET', `${GW}/rest/v1/tasks?select=*&id=eq.not-a-number`, 400]] },
  { id: 'R8', method: 'POST', path: '/restful-tasks', body: 'not json', status: 400, fns: [], clients: [] },
];

/** Run SEQ against a fresh recorded app; returns per-request observations. */
async function runSequence(label, { withGate = false } = {}) {
  resetDb();
  const dir = path.join(REC, label);
  const server = await startServer({ recorded: true, entry: ENTRY_REL, cwd: APPDIR, port: APP_PORT, appmapDir: dir, app: 'restful-tasks' });
  const obs = [];
  try {
    for (const [i, r] of SEQ.entries()) {
      const tp = traceparent(`seq`, i + 1);
      const before = gatewayLines().length;
      const res = await request(APP_PORT, r.method, r.path, { body: r.body, tp });
      const map = await waitForMap(dir, tp.span);
      await sleep(100);
      const gw = gatewayLines().slice(before);
      obs.push({ req: r, tp, res: { status: res.status, body: res.text.slice(0, 300) }, map, gw });
    }
    if (withGate) {
      // T1: no traceparent
      const n0 = listMaps(dir).length;
      const b1 = gatewayLines().length;
      const t1 = await request(APP_PORT, 'GET', '/restful-tasks');
      await sleep(800);
      const t1gw = gatewayLines().slice(b1);
      const t1files = listMaps(dir).length - n0;
      // T2: malformed traceparents
      const bad = [
        '00-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-1111111111111111-01', // uppercase hex
        'ff-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1111111111111111-01', // version ff
        '00-aaaa-1111111111111111-01', // short trace id
        '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1111111111111111', // no flags
      ];
      const t2 = [];
      for (const h of bad) {
        const n = listMaps(dir).length;
        const res = await request(APP_PORT, 'GET', '/restful-tasks', { tp: h });
        await sleep(600);
        t2.push({ header: h, status: res.status, newFiles: listMaps(dir).length - n });
      }
      obs.gate = { t1: { status: t1.status, newFiles: t1files, outboundTraceparents: t1gw.map((g) => g.traceparent) }, t2 };
    }
  } finally {
    await server.stop();
  }
  obs.command = server.command;
  obs.dir = dir;
  obs.appOutput = server.output();
  return obs;
}

// ---------------------------------------------------------------- A + C (run 1)
log('run1: ground-truth sequence (recorded, zero-touch)');
const srcBefore = fs.readFileSync(path.join(APPDIR, ENTRY_REL), 'utf8');
const run1 = await runSequence('run1', { withGate: true });
save('run1-app-output.txt', run1.appOutput);
fs.cpSync(run1.dir, path.join(EVID, 'recordings', 'run1'), { recursive: true });

const cRows = [];
let cFail = 0;
for (const o of run1) {
  const r = o.req;
  const problems = [];
  const found = [];
  if (o.res.status !== r.status) problems.push(`client got HTTP ${o.res.status}, expected ${r.status}`);
  if (!o.map) {
    problems.push('no recording file');
    cRows.push({ id: r.id, verdict: 'MISSING', problems });
    cFail++;
    continue;
  }
  const s = summarize(o.map.appmap);
  // server event
  const srv = s.servers[0];
  if (s.servers.length !== 1) problems.push(`${s.servers.length} http_server_request events`);
  if (!srv || srv.method !== r.method || srv.path !== r.path || srv.status !== r.status)
    problems.push(`server event ${j(srv)} != ${r.method} ${r.path} ${r.status}`);
  else found.push(`http_server_request ${srv.method} ${srv.path} -> http_server_response ${srv.status}`);
  // functions
  // The anonymous Deno.serve handler (index.ts:68) is now recorded (the
  // requested fix; EXPECTATIONS.md lists it as a gap, not an expected
  // call). It may appear once, as the entry call, and every expected
  // function must then be nested inside it; the expected functions are
  // compared exactly as before.
  const isEntry = (f) => f.fn === 'index.handler' && f.lineno === 68 && f.path === ENTRY_REL && f.ancestors.every((a) => !s.functions.some((g) => g.id === a));
  const entry = s.functions[0] && isEntry(s.functions[0]) ? s.functions[0] : undefined;
  const appFns = entry ? s.functions.slice(1) : s.functions;
  if (entry) {
    const outside = appFns.filter((f) => !f.ancestors.includes(entry.id));
    if (outside.length) problems.push(`functions not nested in the Deno.serve handler: ${j(outside.map((f) => f.fn))}`);
    else found.push(`entry index.handler@68 (anonymous Deno.serve handler)`);
  }
  // Every app function takes the supabase client first (index.ts:18, 28,
  // 38, 48, 58); compare the non-client params. The client is the
  // parameter recorded with class SupabaseClient.
  const gotFns = appFns.map((f) => `${f.fn}@${f.lineno}(${f.params.filter((_, i) => f.paramClasses[i] !== 'SupabaseClient').join(',')})`);
  const expFns = r.fns.map(([fn, line, params]) => `${fn}@${line}(${params.join(',')})`);
  const norm = (arr) => [...arr].sort();
  if (j(norm(gotFns)) !== j(norm(expFns))) problems.push(`functions ${j(gotFns)} != expected ${j(expFns)}`);
  else if (expFns.length) found.push(`functions ${gotFns.join(' ')}`);
  // outbound http
  const gotCl = s.clients.map((c) => `${c.method} ${c.url} ${c.status}`);
  const expCl = r.clients.map(([m, u, st]) => `${m} ${u} ${st}`);
  if (j(gotCl) !== j(expCl)) problems.push(`clients ${j(gotCl)} != expected ${j(expCl)}`);
  else if (expCl.length) found.push(`http_client ${gotCl.join('; ')}`);
  // gateway agrees with recording
  const gwCl = o.gw.map((g) => `${g.method} ${GW}${g.url} ${g.status}`);
  if (j(gwCl) !== j(gotCl)) problems.push(`gateway saw ${j(gwCl)} but recording has ${j(gotCl)}`);
  // exceptions
  const exc = s.functions.flatMap((f) => f.exceptions ?? []);
  if (r.exception) {
    const hit = exc.find((e) => String(e.message).includes(r.exception.message));
    if (!hit) problems.push(`thrown value's message ${j(r.exception.message)} not in recorded exception ${j(exc)} (the app threw {code:'22P02', message:'invalid input syntax for type bigint: "not-a-number"', ...})`);
    else found.push(`exception ${hit.class}: ${hit.message}`);
  } else if (exc.length) problems.push(`unexpected exceptions ${j(exc)}`);
  if (s.sql.length) problems.push(`unexpected sql_query events ${j(s.sql)}`);
  if (s.unbalanced.length) problems.push(`unbalanced calls ${j(s.unbalanced)}`);
  if (s.truncated) problems.push('metadata.truncated set');
  const v = problems.length ? 'WRONG' : 'FOUND';
  if (problems.length) cFail++;
  cRows.push({ id: r.id, file: path.basename(o.map.file), verdict: v, found, problems });
}
save('C-ground-truth.json', cRows);

// traceparent gate (T1-T5)
const gate = run1.gate;
const t3 = run1
  .filter((o) => o.map)
  .map((o) => ({
    id: o.req.id,
    trace_ok: o.map.appmap.metadata.trace_id === o.tp.trace,
    span_ok: o.map.appmap.metadata.parent_span_id === o.tp.span,
    hdr_ok: summarize(o.map.appmap).servers[0]?.traceparent === o.tp.header,
    outbound: o.gw.map((g) => g.traceparent),
    outbound_ok: o.gw.every((g) => g.traceparent?.startsWith(`00-${o.tp.trace}-`) && g.traceparent.split('-')[2] !== o.tp.span),
    recorded_outbound_ok: summarize(o.map.appmap).clients.every((c) => o.gw.some((g) => g.traceparent === c.traceparent)),
  }));
const gateProblems = [];
if (gate.t1.newFiles !== 0) gateProblems.push(`T1 unstamped request wrote ${gate.t1.newFiles} file(s)`);
if (gate.t1.status !== 200) gateProblems.push(`T1 status ${gate.t1.status}`);
if (gate.t1.outboundTraceparents.some((x) => x)) gateProblems.push(`T5 unstamped request's outbound calls carried traceparent ${j(gate.t1.outboundTraceparents)}`);
for (const t of gate.t2) if (t.newFiles !== 0) gateProblems.push(`T2 malformed '${t.header}' wrote ${t.newFiles} file(s)`);
for (const t of t3) {
  if (!t.trace_ok || !t.span_ok || !t.hdr_ok) gateProblems.push(`T3 ${t.id} metadata ids wrong ${j(t)}`);
  if (!t.outbound_ok || !t.recorded_outbound_ok) gateProblems.push(`T4 ${t.id} outbound traceparent wrong ${j(t.outbound)}`);
}
save('C-traceparent-gate.json', { gate, t3 });

// structure: does the official sequence diagram nest the handler's work under the request?
const sd1 = path.join(EVID, 'sequence', 'run1');
sequenceDiagrams(listMaps(run1.dir), sd1);
const structure = [];
for (const o of run1) {
  if (!o.map) continue;
  const f = path.join(sd1, path.basename(o.map.file).replace('.appmap.json', '.sequence.json'));
  if (!fs.existsSync(f)) { structure.push({ id: o.req.id, roots: 'NO DIAGRAM' }); continue; }
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const roots = d.rootActions.map((a) => a.route ?? a.name);
  const nested = d.rootActions.length === 1;
  structure.push({ id: o.req.id, rootCount: d.rootActions.length, roots, serverChildren: d.rootActions[0]?.children?.length ?? 0, nested });
}
save('C-structure.json', structure);
const badStructure = structure.filter((s) => s.rootCount > 1);

verdict('C', cFail ? 'FAIL' : 'PASS', [
  ...cRows.map((r) => `${r.id} ${r.verdict}: ${r.problems?.length ? r.problems.join(' | ') : r.found.join(' | ')}`),
  `anonymous Deno.serve handler (index.ts:68): recorded as the entry call in ${run1.filter((o) => o.map && summarize(o.map.appmap).functions[0]?.fn === 'index.handler').length}/${run1.filter((o) => o.map).length} recordings (EXPECTATIONS listed it as a gap)`,
]);
verdict('C-traceparent-gate', gateProblems.length ? 'FAIL' : 'PASS', gateProblems.length ? gateProblems : [
  `T1 unstamped: HTTP ${gate.t1.status}, ${gate.t1.newFiles} files, outbound traceparent ${j(gate.t1.outboundTraceparents)}`,
  `T2 malformed: ${gate.t2.map((t) => `${t.header.slice(0, 12)}…→${t.newFiles} files`).join(', ')}`,
  `T3/T4 stamped: ${t3.length}/${t3.length} maps carry caller trace_id+parent_span_id; outbound calls stamped with same trace id, new span`,
]);
verdict('C-structure', badStructure.length ? 'FAIL' : 'PASS', badStructure.length
  ? badStructure.map((s) => `${s.id}: official sequence diagram has ${s.rootCount} disconnected roots ${j(s.roots)} (handler work not nested under the HTTP request)`)
  : ['every request is a single tree rooted at the HTTP server request']);

// ---------------------------------------------------------------- D noise
const pkgCount = {};
for (const f of listMaps(run1.dir)) {
  for (const e of JSON.parse(fs.readFileSync(f, 'utf8')).events) {
    if (e.event !== 'call') continue;
    const key = e.http_server_request ? 'http_server_request' : e.http_client_request ? `http_client_request ${new URL(e.http_client_request.url).host}`
      : e.sql_query ? 'sql_query' : `function ${path.dirname(e.path ?? '?')}`;
    pkgCount[key] = (pkgCount[key] ?? 0) + 1;
  }
}
const foreign = Object.keys(pkgCount).filter((k) => k.startsWith('function ') && k !== `function ${path.dirname(ENTRY_REL)}`);
save('D-events-by-package.json', pkgCount);
verdict('D', foreign.length ? 'FAIL' : 'PASS', [`call events by package over run1: ${j(pkgCount)}`, ...foreign.map((f) => `foreign: ${f}`)]);

// ---------------------------------------------------------------- E exception
const r7 = cRows.find((r) => r.id === 'R7');
verdict('E', r7?.verdict === 'FOUND' ? 'PASS' : 'FAIL', r7 ? (r7.found.length && r7.verdict === 'FOUND' ? r7.found : r7.problems) : ['R7 missing']);

// ---------------------------------------------------------------- G stability (run 2)
log('run2: same sequence again');
const run2 = await runSequence('run2');
fs.cpSync(run2.dir, path.join(EVID, 'recordings', 'run2'), { recursive: true });
const sd2 = path.join(EVID, 'sequence', 'run2');
sequenceDiagrams(listMaps(run2.dir), sd2);
const gDiffs = [];
for (const [i, o1] of run1.entries()) {
  const o2 = run2[i];
  if (!o1.map || !o2.map) { gDiffs.push(`${o1.req.id}: recording missing in ${!o1.map ? 'run1' : 'run2'}`); continue; }
  const f1 = path.join(sd1, path.basename(o1.map.file).replace('.appmap.json', '.sequence.json'));
  const f2 = path.join(sd2, path.basename(o2.map.file).replace('.appmap.json', '.sequence.json'));
  const d1 = normalizeDiagram(JSON.parse(fs.readFileSync(f1, 'utf8')));
  const d2 = normalizeDiagram(JSON.parse(fs.readFileSync(f2, 'utf8')));
  if (j(d1) !== j(d2)) {
    const r1 = d1.rootActions.map((a) => `${a.route ?? a.name}#${a.subtreeDigest.slice(0, 8)}`);
    const r2 = d2.rootActions.map((a) => `${a.route ?? a.name}#${a.subtreeDigest.slice(0, 8)}`);
    gDiffs.push(`${o1.req.id}: run1 ${j(r1)} vs run2 ${j(r2)}`);
  }
  // also the event-level shape (ids/timings/random spans removed)
  const shape = (m) => m.events.map((e) => `${e.event}:${e.thread_id}:${e.method_id ?? e.http_client_request?.url ?? e.http_server_request?.path_info ?? ''}:${e.parent_id ?? ''}`).join('|');
  if (shape(o1.map.appmap) !== shape(o2.map.appmap)) gDiffs.push(`${o1.req.id}: event order/thread shape differs`);
}
save('G-stability.json', gDiffs);
verdict('G', gDiffs.length ? 'FAIL' : 'PASS', gDiffs.length ? gDiffs : [`${run1.length}/${run1.length} requests: normalized official sequence-diagram JSON identical between run1 and run2 (elapsed/eventIds removed); event order/thread shape identical`]);

// ---------------------------------------------------------------- H change detection
log('run3: H change applied on a scratch branch');
const patch = path.join(ACC, 'h-change.patch');
let hApplied = sh('git', ['-C', APPDIR, 'checkout', '-q', '-b', 'acceptance-h-change']);
hApplied = sh('git', ['-C', APPDIR, 'apply', patch]);
if (hApplied.code !== 0) throw new Error(`patch failed: ${hApplied.out}`);
save('H-app-diff.txt', sh('git', ['-C', APPDIR, 'diff']).out);
let run3;
try {
  run3 = await runSequence('run3');
} finally {
  sh('git', ['-C', APPDIR, 'checkout', '-q', '--', '.']);
  sh('git', ['-C', APPDIR, 'checkout', '-q', '-']);
  sh('git', ['-C', APPDIR, 'branch', '-q', '-D', 'acceptance-h-change']);
}
fs.cpSync(run3.dir, path.join(EVID, 'recordings', 'run3-h-change'), { recursive: true });
const sd3 = path.join(EVID, 'sequence', 'run3-h-change');
sequenceDiagrams(listMaps(run3.dir), sd3);
const hOfficial = [];
const hChanged = [];
fs.mkdirSync(path.join(EVID, 'H-diff'), { recursive: true });
for (const [i, o1] of run1.entries()) {
  const o3 = run3[i];
  if (!o1.map || !o3.map) { hChanged.push(`${o1.req.id}: missing recording`); continue; }
  const f1 = path.join(sd1, path.basename(o1.map.file).replace('.appmap.json', '.sequence.json'));
  const f3 = path.join(sd3, path.basename(o3.map.file).replace('.appmap.json', '.sequence.json'));
  const outDir = path.join(EVID, 'H-diff', o1.req.id);
  const r = sh(APPMAP_CLI, ['sequence-diagram-diff', f1, f3, '--format', 'text', '--output-dir', outDir], { env: { ...process.env, APPMAP_TELEMETRY_DISABLED: 'true' } });
  const txtFiles = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
  const text = txtFiles.map((f) => fs.readFileSync(path.join(outDir, f), 'utf8')).join('\n');
  const same = j(normalizeDiagram(JSON.parse(fs.readFileSync(f1, 'utf8')))) === j(normalizeDiagram(JSON.parse(fs.readFileSync(f3, 'utf8'))));
  hOfficial.push({ id: o1.req.id, exit: r.code, cli: r.out.trim().split('\n').filter((l) => !/telemetry/i.test(l)).slice(0, 5), diff: text.trim(), identical: same });
  if (!same) hChanged.push(o1.req.id);
}
save('H-official-diff.json', hOfficial);
// repo's own behavior-diff tracer
const traceOut = path.join(EVID, 'H-appmap-trace');
const tr = sh(process.execPath, [path.join(ROOT, 'linker', 'bin', 'appmap-trace.mjs'), run3.dir, '--baseline', run1.dir, '--out', traceOut]);
save('H-appmap-trace-stdout.txt', tr.out);
const traceDel = fs.existsSync(traceOut) ? fs.readdirSync(traceOut).filter((f) => f.startsWith('DELETE') && f.endsWith('.md')) : [];
const traceDelText = traceDel.map((f) => fs.readFileSync(path.join(traceOut, f), 'utf8')).join('\n');
const delOfficial = hOfficial.find((h) => h.id === 'R6');
const delRec = run3.find((o) => o.req.id === 'R6')?.map;
const delClients = delRec ? summarize(delRec.appmap).clients.map((c) => `${c.method} ${c.url} ${c.status}`) : [];
const expectedDel = [`GET ${GW}/rest/v1/tasks?select=*&id=eq.2 200`, `DELETE ${GW}/rest/v1/tasks?id=eq.2 204`];
const hProblems = [];
if (j(hChanged) !== j(['R6'])) hProblems.push(`requests whose diagram changed: ${j(hChanged)} (expected only R6)`);
if (j(delClients) !== j(expectedDel)) hProblems.push(`R6 after change has clients ${j(delClients)}, expected ${j(expectedDel)}`);
if (!delOfficial?.diff || !/eq\.2/.test(delOfficial.diff)) hProblems.push(`official sequence-diagram-diff text for R6 does not name the added GET: ${j(delOfficial?.diff?.slice(0, 400))}`);
if (!traceDelText.includes('New call frontend→network: GET /rest/v1/tasks?select=*&id=eq.2')) hProblems.push(`appmap-trace --baseline for DELETE did not name the added call: ${j(traceDelText.slice(0, 400))}`);
const traceOthers = fs.existsSync(traceOut) ? fs.readdirSync(traceOut).filter((f) => f.endsWith('.md') && !f.startsWith('DELETE')) : [];
for (const f of traceOthers) if (!fs.readFileSync(path.join(traceOut, f), 'utf8').includes('No behavior change')) hProblems.push(`appmap-trace reports a change in ${f}`);
const traceCaption = (traceDelText.match(/^> (.*)$/m) ?? [])[1];
verdict('H', hProblems.length ? 'FAIL' : 'PASS', [
  ...hProblems,
  `official diff R6: ${j(delOfficial?.diff?.slice(0, 600))}`,
  `appmap-trace DELETE caption: ${j(traceCaption)}; other ${traceOthers.length} interactions: "No behavior change"`,
  `appmap-trace stdout: ${tr.out.trim().split('\n').slice(-1)[0]}`,
]);

// ---------------------------------------------------------------- I concurrency
log('I: concurrent requests');
const iRounds = [];
for (let round = 1; round <= 3; round++) {
  resetDb();
  // seed 20 rows so every request touches its own id
  const seedRes = await fetch(`${GW}/rest/v1/tasks`, {
    method: 'POST',
    headers: { Authorization: AUTH, apikey: ANON, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(Array.from({ length: 30 }, (_, k) => ({ name: `conc-${k}`, status: 0 }))),
  });
  const rows = await seedRes.json();
  const dir = path.join(REC, `concurrency-${round}`);
  const server = await startServer({ recorded: true, entry: ENTRY_REL, cwd: APPDIR, port: APP_PORT, appmapDir: dir, app: 'restful-tasks' });
  const gwBefore = gatewayLines().length;
  const reqs = [];
  for (let k = 0; k < 20; k++) {
    const id = rows[k].id;
    const tp = traceparent(`c${round}`, k + 1);
    const kind = k % 4;
    const spec = kind === 0 ? { method: 'GET', path: `/restful-tasks/${id}`, fn: 'index.getTask', url: `?select=*&id=eq.${id}` }
      : kind === 1 ? { method: 'PUT', path: `/restful-tasks/${id}`, body: { task: { name: `c-upd-${k}`, status: k } }, fn: 'index.updateTask', url: `?id=eq.${id}` }
      : kind === 2 ? { method: 'DELETE', path: `/restful-tasks/${id}`, fn: 'index.deleteTask', url: `?id=eq.${id}` }
      : { method: 'POST', path: '/restful-tasks', body: { task: { name: `c-new-${k}`, status: k } }, fn: 'index.createTask', url: '', marker: `c-new-${k}` };
    reqs.push({ k, id, tp, ...spec });
  }
  // plus 10 unstamped requests interleaved, on their own rows (ids 21-30)
  const unstamped = Array.from({ length: 10 }, (_, u) => ({ u, id: rows[20 + u].id }));
  // rounds 1-2: one burst; round 3: staggered 25ms apart, so several
  // recordings open and close while other requests are in flight.
  const stagger = round === 3 ? 25 : 0;
  const t0 = performance.now();
  const launch = (i, fn) => sleep(i * stagger).then(fn);
  const responses = await Promise.all([
    ...reqs.map((r, i) => launch(i, () => request(APP_PORT, r.method, r.path, { body: r.body, tp: r.tp })).then((res) => ({ r, res }))),
    ...unstamped.map((u, i) => launch(i * 2 + 0.5, () => request(APP_PORT, 'GET', `/restful-tasks/${u.id}`)).then((res) => ({ u, res }))),
  ]);
  const wall = performance.now() - t0;
  await sleep(1500);
  await server.stop();
  const gw = gatewayLines().slice(gwBefore);
  const files = listMaps(dir);
  const leaks = [];
  const recorded = [];
  for (const f of files) {
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    const s = summarize(m);
    const own = reqs.find((r) => r.tp.span === m.metadata.parent_span_id);
    if (!own) { leaks.push(`${path.basename(f)}: no matching request`); continue; }
    recorded.push(own.k);
    const tag = `req#${own.k} ${own.method} ${own.path}`;
    if (s.servers.length !== 1) leaks.push(`${tag}: ${s.servers.length} http_server_request events ${j(s.servers.map((x) => `${x.method} ${x.path}`))}`);
    // This request's own entry call, the anonymous Deno.serve handler
    // (index.ts:68, recorded since the requested fix), is not a leak: it is
    // the first function call and is nested in no other function. Any other
    // call, including a second handler call, is judged as before.
    const first = s.functions[0];
    const entry = first && first.fn === 'index.handler' && first.lineno === 68 && !first.ancestors.some((a) => s.functions.some((g) => g.id === a)) ? first : undefined;
    const appFns = s.functions.filter((fn) => fn !== entry);
    const foreignFns = appFns.filter((fn) => fn.fn !== own.fn || (own.method !== 'POST' && fn.params[1] !== String(own.id)) || (own.method === 'POST' && !fn.params[1]?.includes(own.marker)));
    if (foreignFns.length) leaks.push(`${tag}: ${foreignFns.length} foreign function call(s): ${j(foreignFns.slice(0, 4).map((x) => `${x.fn}(${x.params.slice(1).join(',')})`))}${foreignFns.length > 4 ? '…' : ''}`);
    if (appFns.length - foreignFns.length !== 1) leaks.push(`${tag}: own handler function recorded ${appFns.length - foreignFns.length} times`);
    if (entry && appFns.some((fn) => !fn.ancestors.includes(entry.id))) leaks.push(`${tag}: function call(s) outside this request's Deno.serve handler`);
    const ownUrl = (c) => c.method === ({ GET: 'GET', PUT: 'PATCH', DELETE: 'DELETE', POST: 'POST' })[own.method] && c.url === `${GW}/rest/v1/tasks${own.url}`;
    const foreignCl = s.clients.filter((c) => !ownUrl(c));
    if (foreignCl.length) leaks.push(`${tag}: ${foreignCl.length} foreign outbound call(s): ${j(foreignCl.slice(0, 4).map((c) => `${c.method} ${c.url.replace(GW, '')}`))}${foreignCl.length > 4 ? '…' : ''}`);
    // gateway: outbound calls stamped with this recording's trace id
    const stampedWithMine = gw.filter((g) => g.traceparent?.split('-')[1] === m.metadata.trace_id);
    const foreignStamped = stampedWithMine.filter((g) => !ownUrl({ method: g.method, url: GW + g.url }));
    if (foreignStamped.length) leaks.push(`${tag}: gateway saw ${foreignStamped.length} OTHER request(s)' outbound calls stamped with this recording's trace id: ${j(foreignStamped.slice(0, 3).map((g) => `${g.method} ${g.url}`))}`);
    const synth = s.functions.filter((x) => x.synthetic).length + s.clients.filter((x) => x.synthetic).length;
    if (s.truncated || synth) leaks.push(`${tag}: metadata.truncated=${s.truncated}, ${synth} synthetic return(s): other requests' calls were still open when this recording closed`);
  }
  const unstampedStamped = gw.filter((g) => g.traceparent && !reqs.some((r) => g.traceparent.split('-')[1] === r.tp.trace && g.url === `/rest/v1/tasks${r.url}`)).length;
  const statuses = responses.map((x) => x.res.status);
  iRounds.push({ round, staggerMs: stagger, wallMs: Math.round(wall), stampedSent: 20, unstampedSent: 10, files: files.length, recorded, statusesOk: statuses.every((s) => s === 200), leaks, outboundCallsWithAForeignTraceparent: unstampedStamped });
  fs.cpSync(dir, path.join(EVID, 'recordings', `concurrency-${round}`), { recursive: true });
}
save('I-concurrency.json', iRounds);
const iLeaks = iRounds.flatMap((r) => r.leaks.map((l) => `round ${r.round}: ${l}`));
verdict('I', iLeaks.length ? 'FAIL' : 'PASS', [
  ...iRounds.map((r) => `round ${r.round}${r.staggerMs ? ` (staggered ${r.staggerMs}ms)` : ' (one burst)'}: 20 stamped + 10 unstamped, all HTTP 200=${r.statusesOk} -> ${r.files} recording(s) (reqs ${j(r.recorded)}), ${r.leaks.length} leak finding(s), ${r.outboundCallsWithAForeignTraceparent} outbound call(s) carried another request's trace id`),
  ...iLeaks.slice(0, 12),
  ...(iLeaks.length > 12 ? [`… ${iLeaks.length - 12} more in evidence/I-concurrency.json`] : []),
]);

// ---------------------------------------------------------------- waitUntil (synthetic probe)
log('W: waitUntil probe');
const probeDir = path.join(REC, 'probe');
const probeRel = path.relative(ROOT, PROBE);
const probeSrcBefore = fs.readFileSync(PROBE, 'utf8');
const W = {};
async function probeServer(dir) {
  return startServer({ recorded: true, entry: probeRel, cwd: ROOT, port: PROBE_PORT, appmapDir: dir, app: 'probe', lock: false });
}
resetDb();
{
  const dir = path.join(probeDir, 'w1');
  const s = await probeServer(dir);
  const tp = traceparent('w1', 1);
  const t0 = Date.now();
  const res = await request(PROBE_PORT, 'POST', '/probe/ingest?n=1', { tp });
  const tResp = Date.now();
  const map = await waitForMap(dir, tp.span, 15000);
  const tFile = Date.now();
  // W4: overlap: A then B during A's background window
  const tpA = traceparent('w4', 2), tpB = traceparent('w4', 3);
  const resA = await request(PROBE_PORT, 'POST', '/probe/ingest?n=2', { tp: tpA });
  await sleep(500);
  const resB = await request(PROBE_PORT, 'POST', '/probe/ingest?n=3', { tp: tpB });
  const mapA = await waitForMap(dir, tpA.span, 15000);
  await sleep(4000);
  const mapB = listMaps(dir).find((f) => f.includes(`_${tpB.span}_`));
  await s.stop();
  const sum = map && summarize(map.appmap);
  W.w1 = { status: res.status, responseMs: tResp - t0, fileAfterResponseMs: tFile - tResp, summary: sum, file: map?.file };
  const sA = mapA && summarize(mapA.appmap);
  const bAppmap = mapB ? JSON.parse(fs.readFileSync(mapB, 'utf8')) : undefined;
  W.w4 = {
    statusA: resA.status,
    statusB: resB.status,
    aSummary: sA,
    aTrace: mapA?.appmap.metadata.trace_id ?? null,
    bFile: mapB ?? null,
    bSummary: bAppmap ? summarize(bAppmap) : null,
    bTrace: bAppmap?.metadata.trace_id ?? null,
    tpA: tpA.header,
    tpB: tpB.header,
  };
  fs.cpSync(dir, path.join(EVID, 'recordings', 'probe-w1-w4'), { recursive: true });
}
{
  const dir = path.join(probeDir, 'w2');
  const s = await probeServer(dir);
  const tp = traceparent('w2', 4);
  const res = await request(PROBE_PORT, 'POST', '/probe/fire-and-forget?n=4', { tp });
  const map = await waitForMap(dir, tp.span, 5000);
  await sleep(4000);
  await s.stop();
  W.w2 = { status: res.status, summary: map && summarize(map.appmap), files: listMaps(dir).length };
  fs.cpSync(dir, path.join(EVID, 'recordings', 'probe-w2'), { recursive: true });
}
W.w3 = [];
for (const [how, n] of [['SIGKILL deno child', 5], ['SIGTERM runner', 6], ['SIGINT runner', 7]]) {
  const dir = path.join(probeDir, `w3-${n}`);
  const s = await probeServer(dir);
  const tp = traceparent('w3', n);
  const res = await request(PROBE_PORT, 'POST', `/probe/ingest?n=${n}`, { tp });
  await sleep(1500); // inside the background window (insert done, enrich pending)
  const denoPid = s.denoPid();
  if (how.startsWith('SIGKILL')) process.kill(denoPid, 'SIGKILL');
  else s.proc.kill(how.startsWith('SIGTERM') ? 'SIGTERM' : 'SIGINT');
  await sleep(2500);
  await s.stop('SIGKILL');
  const files = listMaps(dir);
  const leftovers = fs.readdirSync(path.dirname(PROBE)).filter((f) => f.startsWith('.appmap.'));
  W.w3.push({ how, status: res.status, files: files.map((f) => path.basename(f)), truncated: files.map((f) => !!JSON.parse(fs.readFileSync(f, 'utf8')).metadata.truncated), leftoverTransformedCopy: leftovers });
  for (const l of leftovers) fs.rmSync(path.join(path.dirname(PROBE), l));
}
save('W-waituntil.json', W);
const w1p = [];
const s1 = W.w1.summary;
if (W.w1.status !== 202) w1p.push(`status ${W.w1.status}`);
if (W.w1.responseMs > 1000) w1p.push(`response took ${W.w1.responseMs}ms`);
if (!s1) w1p.push('no recording');
else {
  if (s1.servers[0]?.status !== 202) w1p.push(`server response ${s1.servers[0]?.status}`);
  const cl = s1.clients.map((c) => `${c.method} ${c.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')} ${c.status}`);
  const exp = ['POST /rest/v1/tasks 201', 'GET /enrich?n=1 200', 'PATCH /rest/v1/tasks?name=eq.probe-1 204'];
  if (j(cl) !== j(exp)) w1p.push(`clients ${j(cl)} != ${j(exp)}`);
  if (!s1.functions.some((f) => f.fn === 'probe.ingest' && !f.synthetic)) w1p.push(`no completed probe.ingest call: ${j(s1.functions.map((f) => f.fn))}`);
  if (W.w1.fileAfterResponseMs < 3000) w1p.push(`file appeared ${W.w1.fileAfterResponseMs}ms after the 202 (< 3000ms of background work)`);
  if (s1.truncated || s1.unbalanced.length) w1p.push('truncated/unbalanced');
}
verdict('W1-waitUntil-capture', w1p.length ? 'FAIL' : 'PASS', w1p.length ? w1p : [
  `202 in ${W.w1.responseMs}ms; file written ${W.w1.fileAfterResponseMs}ms after the response; clients ${j(s1.clients.map((c) => `${c.method} ${c.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')} ${c.status}`))}; fns ${j(s1.functions.map((f) => f.fn))}; not truncated`,
]);
// Overlapping stamped requests each get their own recording (the
// requested fix): A and B must be two separate recordings, each holding
// exactly its own request's work and none of the other's.
const w4p = [];
const w4own = {};
for (const [who, n, other, sum, trace, tp] of [
  ['A', 2, 3, W.w4.aSummary, W.w4.aTrace, W.w4.tpA],
  ['B', 3, 2, W.w4.bSummary, W.w4.bTrace, W.w4.tpB],
]) {
  if (!sum) {
    w4p.push(`${who} (n=${n}) has no recording${who === 'B' ? ' (B arrived during A\'s background window)' : ''}`);
    continue;
  }
  if (trace !== tp.split('-')[1]) w4p.push(`${who}'s recording has trace_id ${trace}, not its own request's`);
  const cl = sum.clients.map((c) => `${c.method} ${c.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')}`);
  const fns = sum.functions.map((f) => `${f.fn}(${f.params[0]})`);
  w4own[who] = { clients: cl, functions: fns };
  const foreign = cl.filter((u) => new RegExp(`probe-${other}\\b|n=${other}\\b`).test(u));
  if (foreign.length) w4p.push(`${who}'s recording contains the other request's background calls: ${j(foreign)}`);
  const ingests = fns.filter((x) => x.startsWith('probe.ingest'));
  if (j(ingests) !== j([`probe.ingest(${n})`])) w4p.push(`${who}'s recording has ingest calls ${j(ingests)}, expected only probe.ingest(${n})`);
  const exp = ['POST /rest/v1/tasks', `GET /enrich?n=${n}`, `PATCH /rest/v1/tasks?name=eq.probe-${n}`];
  if (j(cl) !== j(exp)) w4p.push(`${who}'s outbound calls ${j(cl)} != ${j(exp)}`);
}
verdict('W4-waitUntil-overlap', w4p.length ? 'FAIL' : 'PASS', w4p.length ? w4p : [`A and B (overlapping) recorded separately, each with only its own calls: A ${j(w4own.A.clients)}; B ${j(w4own.B.clients)}`]);
const w2s = W.w2.summary;
const w2ok = w2s && w2s.truncated && w2s.unbalanced.length === 0 && w2s.functions.some((f) => f.fn === 'probe.ingest' && f.synthetic);
verdict('W2-self-heal-fire-and-forget', w2ok ? 'PASS' : 'FAIL', [
  w2s ? `truncated=${w2s.truncated}; functions ${j(w2s.functions.map((f) => `${f.fn}${f.synthetic ? '(synthetic return)' : ''}`))}; clients ${j(w2s.clients.map((c) => `${c.method} ${c.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')} ${c.synthetic ? 'synthetic' : c.status}`))}; unbalanced=${w2s.unbalanced.length}` : 'no recording',
]);
const w3ok = W.w3.every((w) => w.files.length === 1 && w.truncated[0]);
verdict('W3-crash-self-heal', w3ok ? 'PASS' : 'FAIL', W.w3.map((w) => `${w.how} 1.5s into background: ${w.files.length} recording file(s) ${j(w.files)}; truncated ${j(w.truncated)}; leftover transformed copy ${j(w.leftoverTransformedCopy)}`));
if (fs.readFileSync(PROBE, 'utf8') !== probeSrcBefore) throw new Error('probe source changed on disk');

// ---------------------------------------------------------------- J overhead
log('J: overhead');
async function timeRun(recorded, stamped, rep) {
  resetDb();
  const dir = path.join(REC, `overhead-${recorded}-${stamped}-${rep}`);
  const s = await startServer({ recorded, entry: ENTRY_REL, cwd: APPDIR, port: APP_PORT, appmapDir: dir, app: 'restful-tasks' });
  // warm up
  for (let i = 0; i < 10; i++) await request(APP_PORT, 'GET', '/restful-tasks/1');
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) {
    const p = i % 2 ? '/restful-tasks/1' : '/restful-tasks';
    await request(APP_PORT, 'GET', p, { tp: stamped ? traceparent('j', i + 1) : undefined });
  }
  const ms = performance.now() - t0;
  await sleep(500);
  await s.stop();
  return { ms: Math.round(ms), files: listMaps(dir).length };
}
const J = { plain: [], recordedUnstamped: [], recordedStamped: [] };
for (let rep = 0; rep < 2; rep++) {
  J.plain.push(await timeRun(false, false, rep));
  J.recordedUnstamped.push(await timeRun(true, false, rep));
  J.recordedStamped.push(await timeRun(true, true, rep));
}
save('J-overhead.json', J);
const med = (a) => a.map((x) => x.ms).sort((x, y) => x - y)[0];
verdict('J', 'PASS', [
  `200 sequential requests, best of 2: plain deno run ${med(J.plain)}ms; appmap-deno unstamped ${med(J.recordedUnstamped)}ms (${(med(J.recordedUnstamped) / med(J.plain)).toFixed(2)}x); appmap-deno all stamped ${med(J.recordedStamped)}ms (${(med(J.recordedStamped) / med(J.plain)).toFixed(2)}x), ${J.recordedStamped[0].files} maps written`,
  'no threshold is defined by the spec; reported as measured',
]);

// ---------------------------------------------------------------- B validity (every recording)
log('B: validating every recording');
const allMaps = [
  ...listMaps(path.join(REC, 'run1')), ...listMaps(path.join(REC, 'run2')), ...listMaps(path.join(REC, 'run3')),
  ...[1, 2, 3].flatMap((r) => listMaps(path.join(REC, `concurrency-${r}`))),
  ...fs.readdirSync(probeDir).flatMap((d) => listMaps(path.join(probeDir, d))),
];
const B = { total: allMaps.length, cliValid: 0, cliMessages: {}, highestVersionSatisfied: {}, violations12: {} };
for (const f of allMaps) {
  const v = validateMap(f);
  if (v.cliExit === 0) B.cliValid++;
  const msg = v.cliOut.split('\n').slice(0, 3).join(' / ');
  B.cliMessages[msg] = (B.cliMessages[msg] ?? 0) + 1;
  const ok = Object.entries(v.perVersion).filter(([, errs]) => errs.length === 0).map(([ver]) => ver);
  const hi = ok.length ? ok[ok.length - 1] : 'none';
  B.highestVersionSatisfied[hi] = (B.highestVersionSatisfied[hi] ?? 0) + 1;
  for (const e of v.perVersion['1.12.0'] ?? []) B.violations12[e] = (B.violations12[e] ?? 0) + 1;
  const d = diagnose(f);
  const fix12 = Array.isArray(d['1.12.0']) ? d['1.12.0'].join(' + ') : d['1.12.0'];
  B.missingFor112 ??= {};
  B.missingFor112[fix12] = (B.missingFor112[fix12] ?? 0) + 1;
  const fixable = Object.entries(d).filter(([, x]) => Array.isArray(x)).map(([ver]) => ver);
  B.oldestFixableVersion ??= {};
  B.oldestFixableVersion[fixable[0] ?? 'none'] = (B.oldestFixableVersion[fixable[0] ?? 'none'] ?? 0) + 1;
}
// sequence-diagram over everything
const sdAll = sequenceDiagrams(allMaps, path.join(WORK, 'sd-all'));
B.sequenceDiagramExit = sdAll.code;
B.sequenceDiagramErrors = sdAll.out.split('\n').filter((l) => /error|fail/i.test(l) && !/telemetry/i.test(l)).slice(0, 10);
save('B-validation.json', B);
verdict('B', B.cliValid === B.total ? 'PASS' : 'FAIL', [
  `official appmap-validate: ${B.cliValid}/${B.total} valid; messages ${j(B.cliMessages)}`,
  `smallest set of missing items that would make each map valid 1.12.0 (count of maps): ${j(B.missingFor112)}`,
  `oldest schema version each map could satisfy even after those additions (count of maps): ${j(B.oldestFixableVersion)}`,
  `highest schema version fully satisfied (per map): ${j(B.highestVersionSatisfied)}`,
  `appmap sequence-diagram over all ${B.total} maps: exit ${B.sequenceDiagramExit}`,
]);

// ---------------------------------------------------------------- A setup / zero-touch
const status = sh('git', ['-C', APPDIR, 'status', '--porcelain', '--ignored']).out.trim();
const head = sh('git', ['-C', APPDIR, 'rev-parse', 'HEAD']).out.trim();
const srcAfter = fs.readFileSync(path.join(APPDIR, ENTRY_REL), 'utf8');
const aProblems = [];
if (status) aProblems.push(`app clone not clean after runs: ${status}`);
if (srcAfter !== srcBefore) aProblems.push('app entry file changed');
if (head !== '74a3be9aa8706755e05f7326f3d25472729cd977') aProblems.push(`app HEAD ${head}`);
if (!listMaps(run1.dir).length) aProblems.push('no recordings produced');
verdict('A', aProblems.length ? 'FAIL' : 'PASS', [
  ...aProblems,
  `app ${head}; command (cwd ${APPDIR}): ${run1.command}`,
  'env only: SUPABASE_URL, SUPABASE_ANON_KEY (local), APPMAP_DIR, DENO_SERVE_ADDRESS (port); no app source edits; git status clean after all runs',
]);
verdict('F', 'NOT RUN', ['the app has no tests; the Deno recorder has no test-recording mode (appmap-deno only wraps `deno run`)']);

save('results.json', results);
gateway.kill();
const failed = Object.entries(results).filter(([, r]) => r.status === 'FAIL').map(([k]) => k);
log(`FAILED: ${failed.join(', ') || 'none'}`);
process.exit(failed.length ? 1 : 0);
