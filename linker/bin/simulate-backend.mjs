#!/usr/bin/env node
// simulate-backend: synthesize the backend request AppMaps that the
// PetClinicGo agent's HTTP middleware WILL emit once it exists (sibling
// repo follow-up in docs/HANDOFF.md) — one request-recording map per
// http_client_request found in the given frontend maps, with the
// incoming traceparent copied into metadata (trace_id, parent_span_id).
//
// This is a spike harness for docs/design/02: it lets the join and the
// stitched diagram be demonstrated on real frontend files before the
// sibling agents ship traceparent capture. The maps it writes are marked
// recorder.name "funwithappmap-go-simulated" so they can never be
// mistaken for real recordings.
//
// usage: simulate-backend <frontend-dir>... [--out <dir>]

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanAppMaps } from '../src/scan.mjs';
import { isFrontendMap, outgoingRequests } from '../src/link.mjs';

const args = process.argv.slice(2);
const dirs = [];
let out = 'tmp/appmap/backend';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') out = args[++i];
  else dirs.push(args[i]);
}
if (dirs.length === 0) {
  console.error('usage: simulate-backend <frontend-dir>... [--out <dir>]');
  process.exit(2);
}

// The PetClinicGo routes (internal/web/handlers.go) and the queries the
// store layer would run for each.
function simulateRoute(method, pathname, status) {
  if (method === 'GET' && pathname === '/vets') {
    return {
      route: 'GET /vets',
      handler: ['handlers.listVets', 'Vets.List'],
      sql: ['SELECT id, first_name, last_name, specialties FROM vets'],
    };
  }
  if (method === 'GET' && pathname === '/owners') {
    return {
      route: 'GET /owners',
      handler: ['handlers.listOwners', 'Owners.Find'],
      sql: ['SELECT * FROM owners WHERE last_name LIKE ?'],
    };
  }
  if (method === 'GET' && /^\/owners\/\d+$/.test(pathname)) {
    return {
      route: 'GET /owners/{id}',
      handler: ['handlers.getOwner', 'Owners.Get'],
      // Owners.Get runs its two store calls concurrently (errgroup).
      sql:
        status === 404
          ? ['SELECT * FROM owners WHERE id = ?']
          : ['SELECT * FROM owners WHERE id = ?', 'SELECT * FROM pets WHERE owner_id = ?'],
    };
  }
  if (method === 'POST' && pathname === '/owners') {
    return {
      route: 'POST /owners',
      handler: ['handlers.createOwner', 'Owners.Create'],
      // Validation failures never reach the store.
      sql: status >= 400 ? [] : ['INSERT INTO owners (first_name, last_name, city, telephone) VALUES (?, ?, ?, ?)'],
    };
  }
  return { route: `${method} ${pathname}`, handler: ['handlers.unknown'], sql: [] };
}

function buildBackendMap(req) {
  const url = new URL(req.url);
  const { route, handler, sql } = simulateRoute(req.method, url.pathname, req.status);

  let id = 0;
  const events = [];
  const stack = [];
  const call = (body) => {
    const e = { id: ++id, event: 'call', thread_id: 1, ...body };
    events.push(e);
    stack.push(e.id);
    return e.id;
  };
  const ret = (body = {}) => {
    events.push({ id: ++id, event: 'return', thread_id: 1, parent_id: stack.pop(), ...body });
  };

  call({
    http_server_request: {
      request_method: req.method,
      path_info: url.pathname,
      normalized_path_info: route.split(' ')[1],
      headers: { traceparent: `00-${req.traceId}-${req.spanId}-01` },
    },
  });
  for (const fn of handler) {
    const [definedClass, methodId] = fn.split('.');
    call({
      defined_class: definedClass,
      method_id: methodId,
      path: definedClass === 'handlers' ? 'internal/web/handlers.go' : 'internal/service',
      static: false,
    });
  }
  for (const statement of sql) {
    call({ sql_query: { sql: statement, database_type: 'sqlite' } });
    ret();
  }
  for (let i = 0; i < handler.length; i++) ret();
  ret({ http_server_response: { status_code: req.status ?? 200 } });

  return {
    version: '1.12',
    metadata: {
      name: route,
      app: 'PetClinicGo',
      language: { name: 'go' },
      client: { name: 'simulate-backend', url: 'https://github.com/getappmap/appmap-react' },
      recorder: { name: 'funwithappmap-go-simulated', type: 'requests' },
      trace_id: req.traceId,
      parent_span_id: req.spanId,
    },
    classMap: [],
    events,
  };
}

const frontends = scanAppMaps(dirs).filter((m) => isFrontendMap(m.appmap));
mkdirSync(out, { recursive: true });
let written = 0;
for (const f of frontends) {
  for (const req of outgoingRequests(f.appmap)) {
    if (!req.spanId) continue;
    const map = buildBackendMap(req);
    const route = map.metadata.name.replace(/[^a-zA-Z0-9]+/g, '_');
    writeFileSync(join(out, `${route}_${req.spanId}.appmap.json`), JSON.stringify(map, null, 2));
    written++;
  }
}
console.log(`simulated ${written} backend request map(s) from ${frontends.length} frontend map(s) into ${out}`);
