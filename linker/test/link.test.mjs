import { describe, it, expect } from 'vitest';
import { parseTraceparent, outgoingRequests, linkMaps, isFrontendMap, isBackendMap } from '../src/link.mjs';
import { renderSequenceDiagram } from '../src/diagram.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LINK_CLI = fileURLToPath(new URL('../bin/appmap-link.mjs', import.meta.url));

const TRACE = 'a'.repeat(32);
const SPAN_OWNER = '1'.repeat(16);
const SPAN_VETS = '2'.repeat(16);

function frontendMap() {
  return {
    version: '1.2',
    metadata: { name: 'owner detail', trace_id: TRACE },
    classMap: [],
    events: [
      {
        id: 1,
        event: 'call',
        thread_id: 1,
        http_client_request: {
          request_method: 'GET',
          url: 'http://localhost:8080/owners/1',
          headers: { traceparent: `00-${TRACE}-${SPAN_OWNER}-01` },
        },
      },
      {
        id: 2,
        event: 'call',
        thread_id: 1,
        http_client_request: {
          request_method: 'GET',
          url: 'http://localhost:8080/vets',
          headers: { traceparent: `00-${TRACE}-${SPAN_VETS}-01` },
        },
      },
      // vets responds first: out-of-order completion must not confuse pairing
      { id: 3, event: 'return', thread_id: 1, parent_id: 2, http_client_response: { status_code: 200 } },
      { id: 4, event: 'return', thread_id: 1, parent_id: 1, http_client_response: { status_code: 200 } },
    ],
  };
}

function backendMap(spanId, name) {
  return {
    version: '1.2',
    metadata: { name, app: 'PetClinicGo', trace_id: TRACE, parent_span_id: spanId },
    classMap: [],
    events: [
      {
        id: 1,
        event: 'call',
        thread_id: 1,
        http_server_request: { request_method: 'GET', path_info: '/x' },
      },
      {
        id: 2,
        event: 'call',
        thread_id: 1,
        sql_query: { sql: 'SELECT * FROM owners WHERE id = ?', database_type: 'sqlite' },
      },
      { id: 3, event: 'return', thread_id: 1, parent_id: 2 },
      { id: 4, event: 'return', thread_id: 1, parent_id: 1, http_server_response: { status_code: 200 } },
    ],
  };
}

describe('parseTraceparent', () => {
  it('parses a valid header', () => {
    expect(parseTraceparent(`00-${TRACE}-${SPAN_OWNER}-01`)).toEqual({
      traceId: TRACE,
      spanId: SPAN_OWNER,
      flags: '01',
    });
  });

  it('rejects malformed values', () => {
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(parseTraceparent('00-short-bad-01')).toBeUndefined();
    expect(parseTraceparent(`01-${TRACE}-${SPAN_OWNER}-01`)).toBeUndefined();
  });
});

describe('map classification', () => {
  it('tells frontend and backend maps apart by their event kinds', () => {
    expect(isFrontendMap(frontendMap())).toBe(true);
    expect(isBackendMap(frontendMap())).toBe(false);
    expect(isBackendMap(backendMap(SPAN_OWNER, 'GET /owners/{id}'))).toBe(true);
  });
});

describe('linkMaps', () => {
  it('joins 1 frontend map to N backend maps by span-id, with statuses paired', () => {
    const { links, orphanBackends } = linkMaps(
      [{ path: 'fe/owner-detail.appmap.json', appmap: frontendMap() }],
      [
        { path: 'be/owner.appmap.json', appmap: backendMap(SPAN_OWNER, 'GET /owners/{id}') },
        { path: 'be/vets.appmap.json', appmap: backendMap(SPAN_VETS, 'GET /vets') },
        { path: 'be/orphan.appmap.json', appmap: backendMap('f'.repeat(16), 'GET /orphan') },
      ],
    );

    expect(links).toHaveLength(1);
    expect(links[0].interaction.trace_id).toBe(TRACE);
    expect(links[0].requests).toEqual([
      {
        span_id: SPAN_OWNER,
        request: { method: 'GET', url: 'http://localhost:8080/owners/1', status: 200 },
        backend: { path: 'be/owner.appmap.json', name: 'GET /owners/{id}' },
      },
      {
        span_id: SPAN_VETS,
        request: { method: 'GET', url: 'http://localhost:8080/vets', status: 200 },
        backend: { path: 'be/vets.appmap.json', name: 'GET /vets' },
      },
    ]);
    expect(orphanBackends).toEqual(['be/orphan.appmap.json']);
  });

  it('reports a fetch with no matching backend map as unlinked', () => {
    const { links } = linkMaps(
      [{ path: 'fe/owner-detail.appmap.json', appmap: frontendMap() }],
      [],
    );
    expect(links[0].requests.every((r) => r.backend === null)).toBe(true);
  });
});

describe('renderSequenceDiagram', () => {
  it('stitches actor → frontend → backend → SQL into one diagram', () => {
    const backends = [
      { path: 'be/owner.appmap.json', appmap: backendMap(SPAN_OWNER, 'GET /owners/{id}') },
      { path: 'be/vets.appmap.json', appmap: backendMap(SPAN_VETS, 'GET /vets') },
    ];
    const { links } = linkMaps(
      [{ path: 'fe/owner-detail.appmap.json', appmap: frontendMap() }],
      backends,
    );
    const puml = renderSequenceDiagram(links[0], new Map(backends.map((b) => [b.path, b.appmap])));

    expect(puml).toContain('@startuml');
    expect(puml).toContain('actor User');
    expect(puml).toContain('User -> FE : owner detail');
    expect(puml).toContain('FE -> BE0 : GET /owners/1');
    expect(puml).toContain('FE -> BE0 : GET /vets');
    expect(puml).toContain('BE0 -> DB : SELECT * FROM owners WHERE id = ?');
    expect(puml).toContain('BE0 --> FE : 200');
    expect(puml).toContain('@enduml');
  });

  it('marks unlinked fetches instead of dropping them', () => {
    const { links } = linkMaps(
      [{ path: 'fe/owner-detail.appmap.json', appmap: frontendMap() }],
      [],
    );
    const puml = renderSequenceDiagram(links[0], new Map());
    expect(puml).toContain('(no backend map)');
  });
});

// acceptance/supabase-edge-functions-app (bug 7): the stitched diagram of a
// React app calling a Supabase edge function showed the click and the
// backend call only. The frontend handler was in the frontend map but the
// diagram drew no frontend events, and the function reaches its database
// through PostgREST over HTTP, which was not drawn either. And appmap-link
// counted the edge function's own maps (they call out) as frontend maps.
function interactionMap() {
  return {
    version: '1.12',
    metadata: { name: 'click button "Invoke Function"', trace_id: TRACE },
    classMap: [],
    events: [
      { id: 1, event: 'call', thread_id: 1, defined_class: 'App', method_id: 'invokeFunction', path: 'src/App.js', lineno: 16 },
      {
        id: 2,
        event: 'call',
        thread_id: 1,
        http_client_request: {
          request_method: 'POST',
          url: 'http://localhost:54321/functions/v1/select-from-table-with-auth-rls',
          headers: { traceparent: `00-${TRACE}-${SPAN_OWNER}-01` },
        },
        message: [],
      },
      { id: 3, event: 'return', thread_id: 1, parent_id: 2, http_client_response: { status_code: 200 } },
      { id: 4, event: 'return', thread_id: 1, parent_id: 1 },
    ],
  };
}
function edgeFunctionMap() {
  return {
    version: '1.12',
    metadata: { name: 'POST /select-from-table-with-auth-rls', app: 'select-from-table-with-auth-rls', trace_id: TRACE, parent_span_id: SPAN_OWNER },
    classMap: [],
    events: [
      { id: 1, event: 'call', thread_id: 1, http_server_request: { request_method: 'POST', path_info: '/select-from-table-with-auth-rls' }, message: [] },
      { id: 2, event: 'call', thread_id: 1, defined_class: 'index', method_id: 'handler', path: 'index.ts', lineno: 10 },
      { id: 3, event: 'call', thread_id: 1, http_client_request: { request_method: 'GET', url: 'http://127.0.0.1:54321/auth/v1/user' }, message: [] },
      { id: 4, event: 'return', thread_id: 1, parent_id: 3, http_client_response: { status_code: 200 } },
      {
        id: 5,
        event: 'call',
        thread_id: 1,
        http_client_request: { request_method: 'GET', url: 'http://127.0.0.1:54321/rest/v1/users' },
        message: [{ name: 'select', class: 'String', value: '*' }],
      },
      { id: 6, event: 'return', thread_id: 1, parent_id: 5, http_client_response: { status_code: 200 } },
      { id: 7, event: 'return', thread_id: 1, parent_id: 2 },
      { id: 8, event: 'return', thread_id: 1, parent_id: 1, http_server_response: { status_code: 200 } },
    ],
  };
}

describe('stitched diagram for a frontend handler → edge function → PostgREST', () => {
  it('draws the frontend handler and the backend\'s outgoing (database) calls', () => {
    const fe = { path: 'fe/invoke.appmap.json', appmap: interactionMap() };
    const be = { path: 'be/fn.appmap.json', appmap: edgeFunctionMap() };
    const { links } = linkMaps([fe], [be]);
    const puml = renderSequenceDiagram(links[0], new Map([[be.path, be.appmap]]), fe.appmap);
    const lines = puml.split('\n');
    const at = (s) => lines.indexOf(s);
    expect(at('User -> FE : click button "Invoke Function"')).toBeGreaterThan(0);
    expect(at('FE -> FE : App.invokeFunction')).toBeGreaterThan(at('User -> FE : click button "Invoke Function"'));
    expect(at('FE -> BE0 : POST /functions/v1/select-from-table-with-auth-rls')).toBeGreaterThan(at('FE -> FE : App.invokeFunction'));
    expect(at('BE0 -> BE0 : index.handler')).toBeGreaterThan(at('FE -> BE0 : POST /functions/v1/select-from-table-with-auth-rls'));
    expect(at('BE0 -> NET : GET /auth/v1/user')).toBeGreaterThan(at('BE0 -> BE0 : index.handler'));
    expect(at('BE0 -> NET : GET /rest/v1/users?select=*')).toBeGreaterThan(at('BE0 -> NET : GET /auth/v1/user'));
    expect(at('NET --> BE0 : 200')).toBeGreaterThan(0);
    expect(at('BE0 --> FE : 200')).toBeGreaterThan(at('BE0 -> NET : GET /rest/v1/users?select=*'));
    expect(puml).toContain('participant "network" as NET');
  });

  it('appmap-link counts an edge function map that calls out as a backend map, not a frontend map', () => {
    const dir = mkdtempSync(join(tmpdir(), 'appmap-link-'));
    try {
      mkdirSync(join(dir, 'fe'));
      mkdirSync(join(dir, 'be'));
      writeFileSync(join(dir, 'fe', 'invoke.appmap.json'), JSON.stringify(interactionMap()));
      writeFileSync(join(dir, 'be', 'fn.appmap.json'), JSON.stringify(edgeFunctionMap()));
      const r = spawnSync(process.execPath, [LINK_CLI, join(dir, 'fe'), join(dir, 'be'), '--out', join(dir, 'links')], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(
        '1 frontend map(s), 1 backend map(s) (1 of them also make outgoing requests; 0 linked onward): 1/1 requests linked, 0 orphan backend map(s)',
      );
      const puml = readFileSync(join(dir, 'links', 'invoke.puml'), 'utf8');
      expect(puml).toContain('FE -> FE : App.invokeFunction');
      expect(puml).toContain('BE0 -> NET : GET /rest/v1/users?select=*');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
