#!/usr/bin/env node
// Runnable spike for docs/design/06 (zero-touch): run a genuinely
// untouched Deno.serve function — src/petLookup.ts has no appmap
// import, no wrapping — through the appmap-deno runner, send a
// stamped and an unstamped request, and assert exactly one AppMap was
// written, with the right shape. Mirrors the linker's own "runs
// automatically when the [external tool] is present, skips itself
// otherwise" convention; no Deno binary means this reports itself as
// skipped rather than failing the suite.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repoRoot = path.resolve(root, '../..');
const tmpDir = path.join(root, 'tmp');
const appmapDir = path.join(tmpDir, 'appmap', 'requests');
const entryPath = path.join(root, 'src/petLookup.ts');
const entryRelToRepo = path.relative(repoRoot, entryPath);
// appmap-deno writes its transformed copy next to the entry file itself.
const tempInstrumented = path.join(root, 'src', '.appmap.petLookup.ts');

function hasDeno() {
  const check = spawnSync('deno', ['--version'], { stdio: 'ignore' });
  return !check.error && check.status === 0;
}

if (!hasDeno()) {
  console.log('deno-edge smoke test: `deno` not found on PATH — skipping (this is not a failure).');
  process.exit(0);
}

rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(appmapDir, { recursive: true });
if (existsSync(tempInstrumented)) unlinkSync(tempInstrumented);

console.log('1. running the UNMODIFIED src/petLookup.ts through appmap-deno …');
const server = spawn(
  process.execPath,
  ['--experimental-strip-types', 'deno/bin/appmap-deno.ts', '--app', 'deno-edge-petclinic', entryRelToRepo],
  { cwd: repoRoot, env: { ...process.env, APPMAP_DIR: appmapDir }, stdio: ['ignore', 'pipe', 'pipe'] },
);

let ready = false;
let startupOutput = '';
const onData = (chunk) => {
  startupOutput += chunk.toString();
  if (chunk.toString().includes('Listening')) ready = true;
};
server.stdout.on('data', onData);
server.stderr.on('data', onData);

try {
  const deadline = Date.now() + 10_000;
  while (!ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw new Error(`server did not report "Listening" within 10s. Output so far:\n${startupOutput}`);

  console.log('2. asserting the source file on disk was never touched …');
  // Checks for actual usage, not the word "appmap" — the file's own
  // doc comment mentions this example's purpose by name.
  const source = readFileSync(entryPath, 'utf8');
  if (/\bimport\b.*appmap|withAppMap\(/i.test(source)) {
    throw new Error('src/petLookup.ts imports or calls appmap code — this example exists to prove zero-touch');
  }

  console.log('3. sending a stamped and an unstamped request …');
  const traceparent = '00-' + 'd'.repeat(32) + '-' + '5'.repeat(16) + '-01';
  const stamped = await fetch('http://localhost:8000/?name=Leo', { headers: { traceparent } });
  if (stamped.status !== 200) throw new Error(`stamped request got ${stamped.status}`);
  const unstamped = await fetch('http://localhost:8000/?name=Leo');
  if (unstamped.status !== 200) throw new Error(`unstamped request got ${unstamped.status}`);

  console.log('4. checking the recorded AppMap …');
  const files = readdirSync(appmapDir);
  if (files.length !== 1) {
    throw new Error(`expected exactly 1 recorded AppMap (one per stamped request), found ${files.length}: ${files.join(', ')}`);
  }
  const appmap = JSON.parse(readFileSync(path.join(appmapDir, files[0]), 'utf8'));
  const checks = [
    [appmap.metadata.recorder?.name === 'funwithappmap-deno', 'metadata.recorder.name'],
    [appmap.metadata.app === 'deno-edge-petclinic', 'metadata.app (from --app / APPMAP_APP)'],
    [appmap.metadata.trace_id === 'd'.repeat(32), 'metadata.trace_id'],
    [appmap.metadata.parent_span_id === '5'.repeat(16), 'metadata.parent_span_id'],
    [appmap.events.some((e) => e.http_server_request), 'an http_server_request event'],
    [appmap.events.some((e) => e.http_server_response?.status_code === 200), 'an http_server_response 200 event'],
    [appmap.events.some((e) => e.method_id === 'lookupPet'), 'a lookupPet call event'],
    [appmap.events.some((e) => e.method_id === 'handlePetLookup'), 'a handlePetLookup call event'],
  ];
  const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
  if (failed.length) throw new Error(`recorded AppMap is missing: ${failed.join(', ')}`);

  console.log('deno-edge smoke test (zero-touch): PASS');
} finally {
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  // appmap-deno cleans this up itself on a normal exit; belt-and-braces
  // in case the smoke test itself failed before that happened.
  if (existsSync(tempInstrumented)) unlinkSync(tempInstrumented);
}
