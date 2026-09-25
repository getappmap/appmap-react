// Stitched sequence diagram (PlantUML) for one linked interaction:
// actor → frontend handler → [backend lane] handler → service → SQL, or
// the backend's own outgoing HTTP calls (an edge function reaches its
// database through PostgREST over HTTP, so that is its "DB" step). The
// diagram is what makes linking visible; the maps stay separate files.

const SQL_PREVIEW = 60;

/**
 * @param {object} link one entry of linkMaps().links
 * @param {Map<string, object>} backendMapsByPath path → appmap
 * @param {object} [frontendAppmap] the interaction's own map: when given,
 *   its function calls are drawn too, in event order, with each request
 *   where it was made (the handler that made it is visible)
 * @returns {string} PlantUML source
 */
export function renderSequenceDiagram(link, backendMapsByPath, frontendAppmap) {
  const lines = [
    '@startuml',
    `title ${escapeText(link.interaction.name ?? link.interaction.path)}`,
    'actor User',
    'participant "frontend" as FE',
  ];

  const backendApps = new Map(); // alias → display name
  let anySql = false;
  let anyOutbound = false;
  for (const req of link.requests) {
    if (!req.backend) continue;
    const appmap = backendMapsByPath.get(req.backend.path);
    const app = appmap?.metadata?.app ?? 'backend';
    if (![...backendApps.values()].includes(app)) {
      backendApps.set(`BE${backendApps.size}`, app);
    }
    if (appmap?.events?.some((e) => e.sql_query)) anySql = true;
    if (appmap?.events?.some((e) => e.http_client_request)) anyOutbound = true;
  }
  for (const [alias, app] of backendApps) {
    lines.push(`participant "${escapeText(app)}" as ${alias}`);
  }
  if (anySql) lines.push('database DB');
  // A backend's own outgoing HTTP calls: for an edge function this is how
  // it reaches its database (PostgREST) and auth (GoTrue).
  if (anyOutbound) lines.push('participant "network" as NET');

  lines.push(`User -> FE : ${escapeText(link.interaction.name ?? 'interaction')}`);

  const drawRequest = (req) => {
    const label = `${req.request.method} ${pathOf(req.request.url, req.request.message)}`;
    if (!req.backend) {
      lines.push(`FE -> FE : ${escapeText(label)} (no backend map)`);
      return;
    }
    const appmap = backendMapsByPath.get(req.backend.path);
    const app = appmap?.metadata?.app ?? 'backend';
    const alias = [...backendApps.entries()].find(([, a]) => a === app)?.[0] ?? 'BE0';

    lines.push(`FE -> ${alias} : ${escapeText(label)}`);
    lines.push(`activate ${alias}`);
    const statusOf = responses(appmap?.events ?? [], 'http_client_response');
    for (const event of appmap?.events ?? []) {
      if (event.event !== 'call') continue;
      if (event.sql_query) {
        const sql = event.sql_query.sql.replace(/\s+/g, ' ').trim();
        lines.push(
          `${alias} -> DB : ${escapeText(sql.length > SQL_PREVIEW ? sql.slice(0, SQL_PREVIEW) + '…' : sql)}`,
        );
        lines.push(`DB --> ${alias}`);
      } else if (event.http_client_request) {
        const r = event.http_client_request;
        lines.push(`${alias} -> NET : ${escapeText(`${r.request_method} ${pathOf(r.url, event.message)}`)}`);
        lines.push(`NET --> ${alias} : ${statusOf.get(event.id) ?? '?'}`);
      } else if (event.defined_class) {
        lines.push(`${alias} -> ${alias} : ${escapeText(`${event.defined_class}.${event.method_id}`)}`);
      }
    }
    lines.push(`${alias} --> FE : ${req.request.status ?? '?'}`);
    lines.push(`deactivate ${alias}`);
  };

  if (frontendAppmap?.events) {
    // outgoingRequests() lists requests in event order, and so does
    // link.requests: pair them positionally.
    let next = 0;
    for (const event of frontendAppmap.events) {
      if (event.event !== 'call') continue;
      if (event.http_client_request) {
        const req = link.requests[next++];
        if (req) drawRequest({ ...req, request: { ...req.request, message: event.message } });
      } else if (event.defined_class) {
        lines.push(`FE -> FE : ${escapeText(`${event.defined_class}.${event.method_id}`)}`);
      }
    }
    for (const req of link.requests.slice(next)) drawRequest(req);
  } else {
    for (const req of link.requests) drawRequest(req);
  }

  lines.push('@enduml');
  return lines.join('\n') + '\n';
}

function responses(events, kind) {
  const out = new Map();
  for (const e of events) if (e[kind]) out.set(e.parent_id, e[kind].status_code);
  return out;
}

/** Path plus query. Recorders following the spec keep the query out of
 * `url` and in the event's `message`; older ones left it in `url`. */
function pathOf(url, message) {
  let path;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    path = url;
  }
  const query = (message ?? []).map((m) => `${m.name}=${m.value}`).join('&');
  return query && !path.includes('?') ? `${path}?${query}` : path;
}

function escapeText(text) {
  return String(text).replace(/\n/g, ' ');
}
