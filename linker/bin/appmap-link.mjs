#!/usr/bin/env node
// appmap-link: scan directories of frontend + backend AppMaps, join them
// by W3C Trace Context ids, emit appmap-links.json, and render one
// stitched PlantUML sequence diagram per linked interaction.
//
// usage: appmap-link <dir>... [--out <dir>]

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { scanAppMaps } from '../src/scan.mjs';
import { isFrontendMap, isBackendMap, linkMaps } from '../src/link.mjs';
import { renderSequenceDiagram } from '../src/diagram.mjs';

const args = process.argv.slice(2);
const dirs = [];
let out = 'appmap-links';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') out = args[++i];
  else if (args[i] === '--help' || args[i] === '-h') {
    console.log('usage: appmap-link <dir>... [--out <dir>]');
    process.exit(0);
  } else dirs.push(args[i]);
}
if (dirs.length === 0) {
  console.error('usage: appmap-link <dir>... [--out <dir>]');
  process.exit(2);
}

const maps = scanAppMaps(dirs);
const frontends = maps.filter((m) => isFrontendMap(m.appmap));
const backends = maps.filter((m) => isBackendMap(m.appmap));
const { links, orphanBackends } = linkMaps(frontends, backends);

mkdirSync(out, { recursive: true });
writeFileSync(
  join(out, 'appmap-links.json'),
  JSON.stringify({ links, orphan_backends: orphanBackends }, null, 2),
);

const backendByPath = new Map(backends.map((b) => [b.path, b.appmap]));
let diagrams = 0;
for (const link of links) {
  if (!link.requests.some((r) => r.backend)) continue;
  const name = link.interaction.path
    .split('/')
    .pop()
    .replace(/\.appmap\.json$/, '');
  writeFileSync(join(out, `${name}.puml`), renderSequenceDiagram(link, backendByPath));
  diagrams++;
}

const linked = links.reduce((n, l) => n + l.requests.filter((r) => r.backend).length, 0);
const total = links.reduce((n, l) => n + l.requests.length, 0);
console.log(
  `${frontends.length} frontend map(s), ${backends.length} backend map(s): ` +
    `${linked}/${total} requests linked, ${orphanBackends.length} orphan backend map(s)`,
);
console.log(`wrote ${relative('.', join(out, 'appmap-links.json'))} and ${diagrams} diagram(s)`);
