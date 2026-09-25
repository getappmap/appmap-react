import { describe, it, expect } from 'vitest';
import {
  buildCallTree,
  labelIndex,
  buildInteractionModel,
  subtreeDigest,
  nodeDigest,
  diffModels,
  captionFor,
  renderAscii,
  renderMermaid,
  renderInteraction,
  backendIndex,
} from '../src/trace-agent.mjs';

const TRACE = 'a'.repeat(32);
const SPAN = '1'.repeat(16);

// A frontend interaction map: event-handler → hook → fetch, with labels
// carried in the classMap (where AppMap actually puts them).
function frontendMap() {
  return {
    version: '1.2',
    metadata: { name: 'save owner', app: 'petclinic-react', trace_id: TRACE },
    classMap: [
      {
        type: 'class',
        name: 'CreateOwner',
        children: [
          { type: 'function', name: 'submit', location: 'x', static: true, labels: ['event-handler'] },
          { type: 'function', name: 'useClinic', location: 'x', static: true, labels: ['hook'] },
        ],
      },
    ],
    events: [
      { id: 1, event: 'call', thread_id: 1, defined_class: 'CreateOwner', method_id: 'submit', path: 'p', static: true },
      { id: 2, event: 'call', thread_id: 1, defined_class: 'CreateOwner', method_id: 'useClinic', path: 'p', static: true },
      { id: 3, event: 'return', thread_id: 1, parent_id: 2, return_value: { class: 'Object', value: '{}' } },
      {
        id: 4,
        event: 'call',
        thread_id: 1,
        http_client_request: {
          request_method: 'POST',
          url: 'http://localhost:8080/owners',
          headers: { traceparent: `00-${TRACE}-${SPAN}-01` },
        },
      },
      { id: 5, event: 'return', thread_id: 1, parent_id: 4, http_client_response: { status_code: 201 } },
      { id: 6, event: 'return', thread_id: 1, parent_id: 1, return_value: { class: 'undefined', value: 'undefined' } },
    ],
  };
}

function backendMap({ span = SPAN, status = 201, sql = ['INSERT INTO owners (...) VALUES (?)'] } = {}) {
  let id = 0;
  const events = [];
  const stack = [];
  const call = (b) => { const e = { id: ++id, event: 'call', thread_id: 1, ...b }; events.push(e); stack.push(e.id); return e.id; };
  const ret = (b = {}) => events.push({ id: ++id, event: 'return', thread_id: 1, parent_id: stack.pop(), ...b });
  call({ http_server_request: { request_method: 'POST', path_info: '/owners' } });
  call({ defined_class: 'handlers', method_id: 'createOwner', path: 'h.go', static: false });
  for (const s of sql) { call({ sql_query: { sql: s, database_type: 'sqlite' } }); ret(); }
  ret();
  ret({ http_server_response: { status_code: status } });
  return { version: '1.2', metadata: { name: 'POST /owners', app: 'PetClinicGo', parent_span_id: span }, classMap: [], events };
}

describe('buildCallTree', () => {
  it('reconstructs nesting from flat call/return via parent_id', () => {
    const roots = buildCallTree(frontendMap().events);
    expect(roots).toHaveLength(1);
    expect(roots[0].event.method_id).toBe('submit');
    const kids = roots[0].children.map((c) => c.event.method_id ?? 'fetch');
    expect(kids).toEqual(['useClinic', 'fetch']); // useClinic call + fetch (no method_id)
    expect(roots[0].children[1].event.http_client_request).toBeTruthy();
    expect(roots[0].children[1].return.http_client_response.status_code).toBe(201);
  });
});

describe('labelIndex', () => {
  it('reads labels out of the classMap by Class.method', () => {
    const idx = labelIndex(frontendMap().classMap);
    expect(idx.get('CreateOwner.submit')).toEqual(['event-handler']);
    expect(idx.get('CreateOwner.useClinic')).toEqual(['hook']);
  });
});

describe('buildInteractionModel', () => {
  it('stitches fetch → backend handler → SQL and keeps labels', () => {
    const spanToBackend = new Map([[SPAN, backendMap()]]);
    const model = buildInteractionModel(frontendMap(), { spanToBackend });
    expect(model.kind).toBe('interaction');
    const submit = model.children[0];
    expect(submit.label).toBe('CreateOwner.submit');
    expect(submit.labels).toEqual(['event-handler']);
    const fetch = submit.children.find((c) => c.kind === 'fetch');
    expect(fetch.target).toBe('PetClinicGo');
    expect(fetch.detail.status).toBe(201);
    expect(fetch.detail.linked).toBe(true);
    const sql = fetch.children[0].children.find((c) => c.kind === 'sql');
    expect(sql.label).toContain('INSERT INTO owners');
  });

  it('is honest: an unlinked fetch draws no backend, and no invented calls appear', () => {
    const model = buildInteractionModel(frontendMap(), { spanToBackend: new Map() });
    const fetch = model.children[0].children.find((c) => c.kind === 'fetch');
    expect(fetch.detail.linked).toBe(false);
    expect(fetch.children).toEqual([]);
    // No method that is not in the recording ever shows up.
    const json = JSON.stringify(model);
    expect(json).not.toContain('createOwner');
  });
});

describe('digests', () => {
  it('subtreeDigest is equal for identical trees and differs when SQL changes', () => {
    const a = buildInteractionModel(frontendMap(), { spanToBackend: new Map([[SPAN, backendMap()]]) });
    const b = buildInteractionModel(frontendMap(), { spanToBackend: new Map([[SPAN, backendMap()]]) });
    expect(subtreeDigest(a)).toBe(subtreeDigest(b));
    const c = buildInteractionModel(frontendMap(), {
      spanToBackend: new Map([[SPAN, backendMap({ sql: ['INSERT INTO owners (...) VALUES (?, ?)'] })]]),
    });
    expect(subtreeDigest(c)).not.toBe(subtreeDigest(a));
  });
});

describe('diffModels', () => {
  const base = () => buildInteractionModel(frontendMap(), { spanToBackend: new Map([[SPAN, backendMap()]]) });

  it('reports no change for identical recordings', () => {
    const { summary } = diffModels(base(), base());
    expect(summary.added).toBe(0);
    expect(summary.removed).toBe(0);
    expect(summary.changed).toBe(0);
  });

  it('detects a removed SQL step and propagates change up the ancestry', () => {
    const cur = buildInteractionModel(frontendMap(), {
      spanToBackend: new Map([[SPAN, backendMap({ sql: [] })]]),
    });
    const { tree, summary } = diffModels(base(), cur);
    expect(summary.removed).toBe(1);
    // The fetch and its handler are marked changed because a descendant changed.
    const submit = tree.children.find((c) => c.label === 'CreateOwner.submit');
    const fetch = submit.children.find((c) => c.kind === 'fetch');
    expect(fetch.status).toBe('changed');
  });

  it('detects an added step and a changed HTTP status', () => {
    // baseline: 201; current: 500 + an extra SQL statement (added).
    const cur = buildInteractionModel(frontendMap(), {
      spanToBackend: new Map([[SPAN, backendMap({ status: 500, sql: ['INSERT INTO owners (...) VALUES (?)', 'INSERT INTO audit (...) VALUES (?)'] })]]),
    });
    const { summary } = diffModels(base(), cur);
    expect(summary.added).toBe(1);
    expect(summary.changed).toBeGreaterThan(0);
  });
});

describe('captionFor', () => {
  it('names a new security-labeled step in plain English', () => {
    const baseMap = frontendMap();
    const curMap = frontendMap();
    // add a security.crypto call under submit in the current recording
    curMap.classMap[0].children.push({ type: 'function', name: 'encrypt', location: 'x', static: true, labels: ['security.crypto'] });
    curMap.events.splice(1, 0,
      { id: 90, event: 'call', thread_id: 1, defined_class: 'CreateOwner', method_id: 'encrypt', path: 'p', static: true },
      { id: 91, event: 'return', thread_id: 1, parent_id: 90 });
    const base = buildInteractionModel(baseMap, { spanToBackend: new Map() });
    const cur = buildInteractionModel(curMap, { spanToBackend: new Map() });
    const { tree, summary } = diffModels(base, cur);
    const caption = captionFor(summary, tree);
    expect(caption).toContain('security.crypto');
    expect(caption).toMatch(/added/);
  });

  it('says so when nothing changed', () => {
    const m = buildInteractionModel(frontendMap(), { spanToBackend: new Map() });
    const { tree, summary } = diffModels(m, m);
    expect(captionFor(summary, tree)).toMatch(/No behavior change/i);
  });
});

describe('renderAscii', () => {
  it('shows every step in plain mode with labels', () => {
    const model = buildInteractionModel(frontendMap(), { spanToBackend: new Map([[SPAN, backendMap()]]) });
    const ascii = renderAscii(model);
    expect(ascii).toContain('CreateOwner.submit');
    expect(ascii).toContain('[event-handler]');
    expect(ascii).toContain('→ PetClinicGo: POST /owners');
    expect(ascii).toContain('→ DB: INSERT INTO owners');
  });

  it('in diff mode: collapses unchanged, marks +/-/~, and flags highlighted labels', () => {
    const baseMap = frontendMap();
    const curMap = frontendMap();
    curMap.classMap[0].children.push({ type: 'function', name: 'encrypt', location: 'x', static: true, labels: ['security.crypto'] });
    curMap.events.splice(1, 0,
      { id: 90, event: 'call', thread_id: 1, defined_class: 'CreateOwner', method_id: 'encrypt', path: 'p', static: true },
      { id: 91, event: 'return', thread_id: 1, parent_id: 90 });
    const { ascii } = renderInteraction(curMap, { baselineAppmap: baseMap });
    expect(ascii).toMatch(/\+ .*encrypt/);
    expect(ascii).toContain('⚠');
    expect(ascii).toContain('unchanged)');
  });
});

// Mermaid grammar guardrails: rect/end and activate/deactivate must be
// balanced and correctly nested (a crossing would break GitHub's renderer).
function assertBalancedMermaid(src) {
  const rect = [];
  const activations = new Map(); // participant → depth
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('rect ')) rect.push(line);
    else if (line === 'end') {
      expect(rect.length, `unbalanced end: ${line}`).toBeGreaterThan(0);
      rect.pop();
    } else if (line.startsWith('activate ')) {
      const p = line.slice('activate '.length);
      activations.set(p, (activations.get(p) ?? 0) + 1);
    } else if (line.startsWith('deactivate ')) {
      const p = line.slice('deactivate '.length);
      expect(activations.get(p) ?? 0, `deactivate with no activation: ${p}`).toBeGreaterThan(0);
      activations.set(p, activations.get(p) - 1);
    }
  }
  expect(rect.length, 'unclosed rect block(s)').toBe(0);
  for (const [p, depth] of activations) expect(depth, `unbalanced activation for ${p}`).toBe(0);
}

describe('renderMermaid', () => {
  it('emits a valid, balanced sequenceDiagram with participants and DB', () => {
    const model = buildInteractionModel(frontendMap(), { spanToBackend: new Map([[SPAN, backendMap()]]) });
    const mmd = renderMermaid(model);
    expect(mmd).toContain('sequenceDiagram');
    expect(mmd).toContain('participant BE0 as PetClinicGo');
    expect(mmd).toContain('participant DB as DB');
    expect(mmd).toContain('FE->>BE0: POST /owners');
    assertBalancedMermaid(mmd);
  });

  it('bands changed/added amber and removed red, stays balanced, and never drops a changed step', () => {
    const baseMap = frontendMap();
    const cur = buildInteractionModel(frontendMap(), {
      spanToBackend: new Map([[SPAN, backendMap({ sql: [] })]]),
    });
    const baseModel = buildInteractionModel(baseMap, { spanToBackend: new Map([[SPAN, backendMap()]]) });
    const { tree } = diffModels(baseModel, cur);
    const mmd = renderMermaid(tree, { diff: true, caption: 'x' });
    expect(mmd).toContain('rect rgb(255, 205, 210)'); // red for the removed SQL
    expect(mmd).toContain('INSERT INTO owners'); // removed step still drawn, not dropped
    assertBalancedMermaid(mmd);
  });
});

// The 1:N showcase case (docs/HANDOFF): one interaction fires two concurrent
// fetches (Promise.all). Concurrent awaits interleave the events out of LIFO
// order — the reconstruction must keep BOTH fetches and BOTH backends, and
// must not bury a concurrent call inside a fetch's backend subtree.
const SPAN_OWNER = '1'.repeat(16);
const SPAN_VETS = '2'.repeat(16);

// Real interleave (from an actual OwnerDetail recording): getOwner and getVets
// both start before either awaits, so both are "open" when the second begins,
// and /vets responds before /owners.
function concurrentFrontendMap() {
  const fetchReq = (id, url, span) => ({
    id, event: 'call', thread_id: 1,
    http_client_request: { request_method: 'GET', url, headers: { traceparent: `00-${TRACE}-${span}-01` } },
  });
  return {
    version: '1.2',
    metadata: { name: 'owner detail', app: 'petclinic-react', trace_id: TRACE },
    classMap: [
      { type: 'class', name: 'client', children: [
        { type: 'function', name: 'getOwner', location: 'x', static: true },
        { type: 'function', name: 'getVets', location: 'x', static: true },
        { type: 'function', name: 'request', location: 'x', static: true },
      ] },
    ],
    events: [
      { id: 9, event: 'call', thread_id: 1, defined_class: 'client', method_id: 'getOwner', path: 'p', static: true },
      { id: 10, event: 'call', thread_id: 1, defined_class: 'client', method_id: 'request', path: 'p', static: true },
      fetchReq(11, 'http://localhost:8080/owners/1', SPAN_OWNER),
      { id: 12, event: 'call', thread_id: 1, defined_class: 'client', method_id: 'getVets', path: 'p', static: true },
      { id: 13, event: 'call', thread_id: 1, defined_class: 'client', method_id: 'request', path: 'p', static: true },
      fetchReq(14, 'http://localhost:8080/vets', SPAN_VETS),
      { id: 15, event: 'return', thread_id: 1, parent_id: 14, http_client_response: { status_code: 200 } },
      { id: 16, event: 'return', thread_id: 1, parent_id: 11, http_client_response: { status_code: 200 } },
      { id: 17, event: 'return', thread_id: 1, parent_id: 13 },
      { id: 18, event: 'return', thread_id: 1, parent_id: 12 },
      { id: 19, event: 'return', thread_id: 1, parent_id: 10 },
      { id: 20, event: 'return', thread_id: 1, parent_id: 9 },
    ],
  };
}

function ownersBackend() {
  return { version: '1.2', metadata: { name: 'GET /owners/{id}', app: 'PetClinicGo', parent_span_id: SPAN_OWNER },
    classMap: [], events: [
      { id: 1, event: 'call', thread_id: 1, http_server_request: { request_method: 'GET', path_info: '/owners/1' } },
      { id: 2, event: 'call', thread_id: 1, sql_query: { sql: 'SELECT * FROM owners WHERE id = ?' } },
      { id: 3, event: 'return', thread_id: 1, parent_id: 2 },
      { id: 4, event: 'return', thread_id: 1, parent_id: 1, http_server_response: { status_code: 200 } },
    ] };
}
function vetsBackend() {
  return { version: '1.2', metadata: { name: 'GET /vets', app: 'PetClinicGo', parent_span_id: SPAN_VETS },
    classMap: [], events: [
      { id: 1, event: 'call', thread_id: 1, http_server_request: { request_method: 'GET', path_info: '/vets' } },
      { id: 2, event: 'call', thread_id: 1, sql_query: { sql: 'SELECT id, last_name FROM vets' } },
      { id: 3, event: 'return', thread_id: 1, parent_id: 2 },
      { id: 4, event: 'return', thread_id: 1, parent_id: 1, http_server_response: { status_code: 200 } },
    ] };
}

describe('concurrent fetches (1:N, the async-gap case)', () => {
  const spanToBackend = () => new Map([[SPAN_OWNER, ownersBackend()], [SPAN_VETS, vetsBackend()]]);

  function fetchNodes(node, acc = []) {
    if (node.kind === 'fetch') acc.push(node);
    for (const c of node.children ?? []) fetchNodes(c, acc);
    return acc;
  }

  it('keeps BOTH fetches and BOTH backend subtrees — nothing dropped', () => {
    const model = buildInteractionModel(concurrentFrontendMap(), { spanToBackend: spanToBackend() });
    const fetches = fetchNodes(model);
    expect(fetches.map((f) => f.label).sort()).toEqual(['GET /owners/1', 'GET /vets']);
    // each fetch reached its own backend (SQL present under each)
    const sql = (f) => JSON.stringify(f).includes('sql');
    expect(fetches.every(sql)).toBe(true);
  });

  it('never nests an instrumented frontend call inside a fetch node', () => {
    const model = buildInteractionModel(concurrentFrontendMap(), { spanToBackend: spanToBackend() });
    for (const f of fetchNodes(model)) {
      const frontendKids = (f.children ?? []).filter((c) => c.actor === 'frontend' && c.kind === 'call');
      expect(frontendKids, `fetch ${f.label} adopted a frontend call`).toEqual([]);
    }
  });

  it('renders both fetches in ASCII and mermaid, and the mermaid stays balanced', () => {
    const { ascii, mermaid } = renderInteraction(concurrentFrontendMap(), { spanToBackend: spanToBackend() });
    for (const text of [ascii, mermaid]) {
      expect(text).toContain('GET /owners/1');
      expect(text).toContain('GET /vets');
    }
    assertBalancedMermaid(mermaid);
  });
});

// A Deno edge function's request map traced on its own: an incoming
// request, a handler, and an outbound PostgREST call whose query string
// lives in `message` (the spec keeps it out of `url`).
function edgeRequestMap({ withLookup = false } = {}) {
  let id = 0;
  const events = [];
  const stack = [];
  const call = (b) => { const e = { id: ++id, event: 'call', thread_id: 1, ...b }; events.push(e); stack.push(e.id); };
  const ret = (b = {}) => events.push({ id: ++id, event: 'return', thread_id: 1, parent_id: stack.pop(), ...b });
  call({ http_server_request: { request_method: 'DELETE', path_info: '/restful-tasks/2' }, message: [] });
  call({ defined_class: 'index', method_id: 'deleteTask', path: 'index.ts', lineno: 38, static: true });
  if (withLookup) {
    call({ http_client_request: { request_method: 'GET', url: 'http://127.0.0.1:54321/rest/v1/tasks' }, message: [{ name: 'select', class: 'String', value: '*' }, { name: 'id', class: 'String', value: 'eq.2' }] });
    ret({ http_client_response: { status_code: 200 } });
  }
  call({ http_client_request: { request_method: 'DELETE', url: 'http://127.0.0.1:54321/rest/v1/tasks' }, message: [{ name: 'id', class: 'String', value: 'eq.2' }] });
  ret({ http_client_response: { status_code: 204 } });
  ret({ return_value: { class: 'Response', value: '{}' } });
  ret({ http_server_response: { status_code: 200 } });
  return { version: '1.12', metadata: { name: 'DELETE /restful-tasks/2', app: 'restful-tasks', parent_span_id: '9'.repeat(16) }, classMap: [], events };
}

describe('a backend request map traced on its own', () => {
  it('runs in its own app lane, never "frontend" or undefined.undefined', () => {
    const model = buildInteractionModel(edgeRequestMap());
    expect(model).toMatchObject({ actor: 'client', target: 'restful-tasks', label: 'DELETE /restful-tasks/2' });
    const [handler] = model.children;
    expect(handler).toMatchObject({ kind: 'call', actor: 'restful-tasks', label: 'index.deleteTask' });
    expect(handler.children[0]).toMatchObject({
      kind: 'fetch',
      actor: 'restful-tasks',
      target: 'network',
      label: 'DELETE /rest/v1/tasks?id=eq.2',
    });
    const { ascii, mermaid } = renderInteraction(edgeRequestMap());
    expect(ascii + mermaid).not.toMatch(/undefined|frontend/);
    expect(mermaid).toContain('Client->>BE0: DELETE /restful-tasks/2');
  });

  it('names an inserted outbound call, query included, in the diff caption', () => {
    const { caption } = renderInteraction(edgeRequestMap({ withLookup: true }), { baselineAppmap: edgeRequestMap() });
    expect(caption).toContain('New call restful-tasks→network: GET /rest/v1/tasks?select=*&id=eq.2.');
  });
});
