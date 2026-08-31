import { describe, it, expect } from 'vitest';
import { parseTraceparent, outgoingRequests, linkMaps, isFrontendMap, isBackendMap } from '../src/link.mjs';
import { renderSequenceDiagram } from '../src/diagram.mjs';

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
