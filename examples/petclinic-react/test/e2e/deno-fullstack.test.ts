// Full-stack integration test, Deno half (docs/design/02 + 06): boots
// the real deno-edge example through the real appmap-deno zero-touch
// runner, drives a real fetch against it over real HTTP with the
// recorder's real fetch-patching (no manual traceparent header), then
// runs the real appmap-link CLI and asserts the frontend and backend
// maps stitch by traceparent ids.
//
// This needs no sibling repo — the Deno backend lives in this repo, at
// examples/deno-edge. Only requires the `deno` binary. Locally it skips
// itself when `deno` is missing; in CI (CI=true) a missing `deno` is a
// failure, so this test can never silently skip on a PR run.
//
// Both ends of this test are this repo's own code (recorder + example
// backend). The end-to-end proof against a real open-source app is
// acceptance/supabase-edge-functions-app (docs/design/02, 2026-09-24).

import { mkdirSync, rmSync, copyFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { waitFor } from '@testing-library/react';
import { stopRecording } from '@funwithappmap/react-recorder';
import { startTestRecording, finishTestRecording } from '@funwithappmap/react-recorder/vitest';
import { server as msw } from '../setup';

function findExampleRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).name === 'petclinic-react') {
      return dir;
    }
    const nested = join(dir, 'examples', 'petclinic-react');
    if (existsSync(join(nested, 'package.json'))) return nested;
    dir = dirname(dir);
  }
  throw new Error('cannot locate examples/petclinic-react from ' + process.cwd());
}

const EXAMPLE_ROOT = findExampleRoot();
const REPO_ROOT = join(EXAMPLE_ROOT, '..', '..');
const LINKER_CLI = join(REPO_ROOT, 'linker', 'bin', 'appmap-link.mjs');
const APPMAP_DENO_CLI = join(REPO_ROOT, 'deno', 'bin', 'appmap-deno.ts');
const PET_LOOKUP_ENTRY = join(REPO_ROOT, 'examples', 'deno-edge', 'src', 'petLookup.ts');
const E2E_DIR = join(EXAMPLE_ROOT, 'tmp', 'appmap', 'e2e-deno');

const denoAvailable = spawnSync('deno', ['--version']).status === 0;
const inCI = process.env.CI === 'true' || process.env.CI === '1';

if (!denoAvailable && inCI) {
  describe('full-stack: React ↔ real deno-edge (zero-touch) ↔ appmap-link', () => {
    it('requires `deno` on PATH in CI', () => {
      throw new Error('`deno` is not on PATH and CI=true: this e2e test must run on every CI run, not skip');
    });
  });
}

describe.skipIf(!denoAvailable)('full-stack: React ↔ real deno-edge (zero-touch) ↔ appmap-link', () => {
  const frontendDir = join(E2E_DIR, 'frontend');
  const backendDir = join(E2E_DIR, 'backend');
  const linksDir = join(E2E_DIR, 'links');
  let runner: ChildProcess | undefined;
  let base: string;

  beforeAll(async () => {
    msw.close(); // this file talks real HTTP

    rmSync(E2E_DIR, { recursive: true, force: true });
    mkdirSync(frontendDir, { recursive: true });
    mkdirSync(backendDir, { recursive: true });

    // Run the real, unmodified pet-lookup source through the real
    // zero-touch runner -- not a hand-wired copy.
    runner = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        APPMAP_DENO_CLI,
        '--app',
        'deno-edge-petclinic',
        PET_LOOKUP_ENTRY,
      ],
      { cwd: REPO_ROOT, env: { ...process.env, APPMAP_DIR: backendDir }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    runner.stdout?.on('data', (c) => (out += c));
    runner.stderr?.on('data', (c) => (out += c));

    base = 'http://localhost:8000';
    await waitFor(
      async () => {
        if (!out.includes('Listening')) throw new Error(`not listening yet:\n${out}`);
      },
      { timeout: 15_000, interval: 250 },
    );
  }, 30_000);

  afterAll(() => {
    runner?.kill('SIGTERM'); // appmap-deno forwards this to its own deno child and cleans up
  });

  it('stitches a real pet lookup end to end: real fetch, real Deno backend map, real join', async () => {
    stopRecording();
    startTestRecording('e2e: deno pet lookup', { app: 'petclinic-react' });

    // No manual traceparent header -- the recorder's own fetch patch
    // stamps it, exactly as it would for a component's real fetch.
    const response = await fetch(`${base}/?name=Leo`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: 'Leo', species: 'cat' });

    const frontendMap = finishTestRecording('succeeded');
    copyFileSync(frontendMap, join(frontendDir, basename(frontendMap)));

    await waitFor(() => expect(readdirSync(backendDir)).toHaveLength(1), { timeout: 5000 });

    const link = spawnSync('node', [LINKER_CLI, frontendDir, backendDir, '--out', linksDir], {
      encoding: 'utf8',
    });
    expect(link.status, link.stderr).toBe(0);
    expect(link.stdout).toContain('1/1 requests linked, 0 orphan backend map(s)');

    const { links, orphan_backends } = JSON.parse(readFileSync(join(linksDir, 'appmap-links.json'), 'utf8'));
    expect(orphan_backends).toEqual([]);
    expect(links).toHaveLength(1);

    const req = links[0].requests[0];
    expect(req.backend?.name).toBe('GET /');
    expect(req.request.status).toBe(200);

    // The backend map is real appmap-deno output -- not simulated.
    const backendMap = JSON.parse(readFileSync(req.backend.path, 'utf8'));
    expect(backendMap.metadata.recorder.name).toBe('funwithappmap-deno');
    expect(backendMap.metadata.app).toBe('deno-edge-petclinic');
    expect(backendMap.metadata.parent_span_id).toBe(req.span_id);
    expect(backendMap.metadata.trace_id).toBe(links[0].interaction.trace_id);
    expect(backendMap.events.some((e: any) => e.method_id === 'lookupPet')).toBe(true);
    expect(backendMap.events.some((e: any) => e.method_id === 'handlePetLookup')).toBe(true);

    const puml = readdirSync(linksDir).find((f) => f.endsWith('.puml'));
    const diagram = readFileSync(join(linksDir, puml!), 'utf8');
    expect(diagram).toContain('FE -> BE0 : GET /');
    expect(diagram).toContain('BE0 --> FE : 200');
  }, 30_000);

  it('links the not-found path too: a real 404 from the real backend', async () => {
    stopRecording();
    startTestRecording('e2e: deno pet lookup not found', { app: 'petclinic-react' });

    const response = await fetch(`${base}/?name=nonexistent`);
    expect(response.status).toBe(404);

    const frontendMap = finishTestRecording('succeeded');
    const errFrontendDir = join(E2E_DIR, 'frontend-404');
    mkdirSync(errFrontendDir, { recursive: true });
    copyFileSync(frontendMap, join(errFrontendDir, basename(frontendMap)));

    await waitFor(() => expect(readdirSync(backendDir).length).toBeGreaterThanOrEqual(2), { timeout: 5000 });

    const outDir = join(E2E_DIR, 'links-404');
    const link = spawnSync('node', [LINKER_CLI, errFrontendDir, backendDir, '--out', outDir], {
      encoding: 'utf8',
    });
    expect(link.status, link.stderr).toBe(0);

    const { links } = JSON.parse(readFileSync(join(outDir, 'appmap-links.json'), 'utf8'));
    expect(links[0].requests[0].request.status).toBe(404);
    const backendMap = JSON.parse(readFileSync(links[0].requests[0].backend.path, 'utf8'));
    expect(backendMap.events.at(-1).http_server_response.status_code).toBe(404);
  }, 30_000);
});
