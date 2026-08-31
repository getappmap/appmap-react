// Stitched sequence diagram (PlantUML) for one linked interaction:
// actor → frontend → [backend lane] handler → service → SQL. The
// diagram is what makes linking visible; the maps stay separate files.

const SQL_PREVIEW = 60;

/**
 * @param {object} link one entry of linkMaps().links
 * @param {Map<string, object>} backendMapsByPath path → appmap
 * @returns {string} PlantUML source
 */
export function renderSequenceDiagram(link, backendMapsByPath) {
  const lines = [
    '@startuml',
    `title ${escapeText(link.interaction.name ?? link.interaction.path)}`,
    'actor User',
    'participant "frontend" as FE',
  ];

  const backendApps = new Map(); // alias → display name
  let anySql = false;
  for (const req of link.requests) {
    if (!req.backend) continue;
    const appmap = backendMapsByPath.get(req.backend.path);
    const app = appmap?.metadata?.app ?? 'backend';
    if (![...backendApps.values()].includes(app)) {
      backendApps.set(`BE${backendApps.size}`, app);
    }
    if (appmap?.events?.some((e) => e.sql_query)) anySql = true;
  }
  for (const [alias, app] of backendApps) {
    lines.push(`participant "${escapeText(app)}" as ${alias}`);
  }
  if (anySql) lines.push('database DB');

  lines.push(`User -> FE : ${escapeText(link.interaction.name ?? 'interaction')}`);

  for (const req of link.requests) {
    const label = `${req.request.method} ${pathOf(req.request.url)}`;
    if (!req.backend) {
      lines.push(`FE -> FE : ${escapeText(label)} (no backend map)`);
      continue;
    }
    const appmap = backendMapsByPath.get(req.backend.path);
    const app = appmap?.metadata?.app ?? 'backend';
    const alias = [...backendApps.entries()].find(([, a]) => a === app)?.[0] ?? 'BE0';

    lines.push(`FE -> ${alias} : ${escapeText(label)}`);
    lines.push(`activate ${alias}`);
    for (const event of appmap?.events ?? []) {
      if (event.event !== 'call') continue;
      if (event.sql_query) {
        const sql = event.sql_query.sql.replace(/\s+/g, ' ').trim();
        lines.push(
          `${alias} -> DB : ${escapeText(sql.length > SQL_PREVIEW ? sql.slice(0, SQL_PREVIEW) + '…' : sql)}`,
        );
        lines.push(`DB --> ${alias}`);
      } else if (event.defined_class) {
        lines.push(`${alias} -> ${alias} : ${escapeText(`${event.defined_class}.${event.method_id}`)}`);
      }
    }
    lines.push(`${alias} --> FE : ${req.request.status ?? '?'}`);
    lines.push(`deactivate ${alias}`);
  }

  lines.push('@enduml');
  return lines.join('\n') + '\n';
}

function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function escapeText(text) {
  return String(text).replace(/\n/g, ' ');
}
