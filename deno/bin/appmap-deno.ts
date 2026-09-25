#!/usr/bin/env -S node --experimental-strip-types
// Zero-touch runner (docs/design/06) — the Deno twin of `appmap-dotnet
// -- dotnet run`. Transforms the entry file in memory (same build-time
// transform the React side uses), runs the transformed copy under real
// Deno with the recording preload wired in via `--preload`, and cleans
// up afterward. The entry file on disk is never modified.
//
// usage:
//   node --experimental-strip-types deno/bin/appmap-deno.ts [--app <name>] <entry> [-- <extra deno run args>]
//
// Only covers the plain `deno run` / self-hosted Deno case (docs/design/06,
// "Tier 1"). Hosts with their own embedded runtime and no CLI flag
// surface — Supabase Edge Runtime chief among them — cannot be reached
// this way; see doc 06's Tier 2 for that gap, documented rather than
// silently unsupported.

import { readFileSync, writeFileSync, unlinkSync, readdirSync, renameSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSource } from '../../recorder/src/transform.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(here, '..', 'preload.ts');
const appmapRuntimePath = path.join(here, '..', 'appmap.ts');

function parseArgs(argv: string[]) {
  let app: string | undefined;
  let entry: string | undefined;
  const passthrough: string[] = [];
  let i = 0;
  for (; i < argv.length; i++) {
    if (argv[i] === '--app') {
      app = argv[++i];
    } else if (argv[i] === '--') {
      passthrough.push(...argv.slice(i + 1));
      break;
    } else if (!entry) {
      entry = argv[i];
    }
  }
  return { app, entry, passthrough };
}

const { app, entry, passthrough } = parseArgs(process.argv.slice(2));
if (!entry) {
  console.error(
    'usage: node --experimental-strip-types deno/bin/appmap-deno.ts [--app <name>] <entry> [-- <extra deno run args>]',
  );
  process.exit(2);
}

const entryAbs = path.resolve(entry);
const entryDir = path.dirname(entryAbs);
const relPath = path.relative(process.cwd(), entryAbs);
const runtimeModule = path.relative(entryDir, appmapRuntimePath);

const source = readFileSync(entryAbs, 'utf8');
const result = await transformSource(source, {
  relPath,
  filename: relPath,
  runtimeModule: runtimeModule.startsWith('.') ? runtimeModule : `./${runtimeModule}`,
});
if (!result?.code) {
  console.error(`appmap-deno: transform produced no output for ${entry}`);
  process.exit(1);
}

// Written next to the original so its own relative imports (e.g.
// `../_shared/foo.ts`) resolve exactly as they would for the real file
// — never touched itself, and removed again once the child exits.
const tempPath = path.join(entryDir, `.appmap.${path.basename(entryAbs)}`);
writeFileSync(tempPath, result.code + '\n');

const appName = app ?? path.basename(entryAbs).replace(/\.[jt]sx?$/, '');
const child = spawn(
  'deno',
  ['run', '--preload', preloadPath, '-A', '--unstable-sloppy-imports', ...passthrough, tempPath],
  { stdio: 'inherit', env: { ...process.env, APPMAP_APP: appName } },
);

function cleanup() {
  try {
    unlinkSync(tempPath);
  } catch {
    // already gone — fine
  }
  healPartialRecordings();
}

// A child killed outright (kill -9) can't flush its open recordings; the
// driver snapshots them as `<file>.part` while they run (deno/appmap.ts,
// "crash safety"). Each is already a valid, truncated map: keep it.
function healPartialRecordings() {
  if (process.env.APPMAP_COLLECTOR) return;
  const dir = path.resolve(process.env.APPMAP_DIR ?? 'tmp/appmap/requests');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // nothing recorded
  }
  for (const name of names) {
    if (!name.endsWith('.appmap.json.part')) continue;
    try {
      renameSync(path.join(dir, name), path.join(dir, name.slice(0, -'.part'.length)));
      console.error(`appmap-deno: kept partial recording ${name.slice(0, -'.part'.length)} (truncated)`);
    } catch {
      // raced with something else — leave it
    }
  }
}

let exiting = false;
const forwardSignal = (signal: NodeJS.Signals) => {
  if (exiting) return;
  exiting = true;
  child.kill(signal);
};
process.on('SIGINT', forwardSignal);
process.on('SIGTERM', forwardSignal);

child.on('exit', (code, signal) => {
  cleanup();
  if (signal) {
    // End the same way the child did; drop our forwarding handlers first
    // or the re-raised signal would just be caught by them again.
    process.removeListener('SIGINT', forwardSignal);
    process.removeListener('SIGTERM', forwardSignal);
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});
child.on('error', (err) => {
  cleanup();
  console.error('appmap-deno: failed to start deno —', err.message);
  process.exit(1);
});
