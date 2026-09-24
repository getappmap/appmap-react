#!/usr/bin/env node
// appmap-trace: the tracing agent CLI. Scan a directory of AppMap
// recordings (frontend interaction/test maps + linked backend request
// maps) and render, per interaction:
//
//   (a) an ASCII call-graph to the terminal, and
//   (b) a GitHub-native mermaid sequence diagram.
//
// With --baseline <dir>, it diffs each interaction against the matching
// interaction (by metadata.name) in the baseline set and bands the
// changed/added steps amber, removed steps red, with a plain-English
// "what changed" caption.
//
// usage:
//   appmap-trace <maps-dir>... [options]
//     --baseline <dir>       diff against this recording set
//     --out <dir>            write .md (mermaid) + .txt (ascii) per interaction
//     --format ascii|mermaid|both   default: both
//     --interaction <substr>  only interactions whose name contains <substr>
//     --highlight <regex>     label highlight (default: security|secret|auth|crypto)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanAppMaps } from '../src/scan.mjs';
import { isFrontendMap, isBackendMap, outgoingRequests } from '../src/link.mjs';
import { renderInteraction, backendIndex } from '../src/trace-agent.mjs';

const args = process.argv.slice(2);
const dirs = [];
let baseline;
let out;
let format = 'both';
let filter;
let highlight;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--baseline') baseline = args[++i];
  else if (a === '--out') out = args[++i];
  else if (a === '--format') format = args[++i];
  else if (a === '--interaction') filter = args[++i];
  else if (a === '--highlight') highlight = new RegExp(args[++i], 'i');
  else if (a === '--help' || a === '-h') {
    printUsage();
    process.exit(0);
  } else dirs.push(a);
}
if (dirs.length === 0) {
  printUsage();
  process.exit(2);
}

// The interactions to trace: every frontend map (outgoing requests, no
// incoming one), plus every backend request map no frontend map links to
// — a request traced on its own (an edge function called directly),
// drawn in its own app's lane rather than mislabeled "frontend".
function loadSet(scanDirs) {
  const maps = scanAppMaps(scanDirs);
  const spanToBackend = backendIndex(maps);
  const frontends = maps.filter((m) => isFrontendMap(m.appmap) && !isBackendMap(m.appmap));
  const linked = new Set();
  for (const f of frontends) {
    for (const r of outgoingRequests(f.appmap)) if (r.spanId && spanToBackend.has(r.spanId)) linked.add(r.spanId);
  }
  const standalone = maps.filter(
    (m) => isBackendMap(m.appmap) && !linked.has(m.appmap.metadata?.parent_span_id),
  );
  return { frontends: [...frontends, ...standalone], spanToBackend };
}

const current = loadSet(dirs);
const base = baseline ? loadSet([baseline]) : null;
const baseByName = new Map();
if (base) for (const f of base.frontends) baseByName.set(f.appmap.metadata?.name, f.appmap);

if (out) mkdirSync(out, { recursive: true });

let rendered = 0;
for (const f of current.frontends) {
  const name = f.appmap.metadata?.name ?? f.path;
  if (filter && !name.includes(filter)) continue;

  const baselineAppmap = base ? baseByName.get(name) : undefined;
  const result = renderInteraction(f.appmap, {
    spanToBackend: current.spanToBackend,
    baselineAppmap,
    baselineSpanToBackend: base?.spanToBackend,
    highlight,
  });

  rendered++;
  const slug = sanitize(name);

  if (out) {
    if (format === 'ascii' || format === 'both')
      writeFileSync(join(out, `${slug}.txt`), result.ascii);
    if (format === 'mermaid' || format === 'both')
      writeFileSync(join(out, `${slug}.md`), toMarkdown(name, result));
  } else {
    if (format === 'ascii' || format === 'both') {
      process.stdout.write(result.ascii);
      process.stdout.write('\n');
    }
    if (format === 'mermaid' || format === 'both') {
      process.stdout.write('```mermaid\n');
      process.stdout.write(result.mermaid);
      process.stdout.write('```\n\n');
    }
  }
}

if (baseline && rendered === 0) {
  console.error(`no interactions matched between ${dirs.join(', ')} and baseline ${baseline}`);
}
console.log(
  `traced ${rendered} interaction(s)${baseline ? ` (diffed against ${baseline})` : ''}` +
    (out ? ` → ${out}` : ''),
);

function toMarkdown(name, result) {
  const parts = [`# ${name}`, ''];
  if (result.caption) parts.push(`> ${result.caption}`, '');
  parts.push('```mermaid', result.mermaid.trimEnd(), '```', '');
  return parts.join('\n');
}

function sanitize(name) {
  return String(name)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 200);
}

function printUsage() {
  console.log(
    [
      'usage: appmap-trace <maps-dir>... [options]',
      '  --baseline <dir>          diff each interaction against this recording set',
      '  --out <dir>               write .md (mermaid) + .txt (ascii) per interaction',
      '  --format ascii|mermaid|both   (default: both)',
      '  --interaction <substr>    only interactions whose name contains <substr>',
      '  --highlight <regex>       label highlight (default: security|secret|auth|crypto)',
    ].join('\n'),
  );
}
