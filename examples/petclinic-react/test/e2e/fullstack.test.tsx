// Full-stack integration test (docs/design/02, "the join demonstrated
// on real files" — now with NO simulator): boots the real PetClinicGo
// server with its AppMap middleware, drives the real React app against
// it over real HTTP, then runs the real appmap-link CLI and asserts
// the frontend and backend maps stitch by traceparent ids.
//
// Requires the Go toolchain and a checkout of the Go sibling repo
// (set PETCLINIC_GO_DIR, or keep the default side-by-side layout).
// Skips itself cleanly when either is missing, so plain `npm test`
// stays green everywhere.

import { mkdirSync, rmSync, copyFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { screen } from '@testing-library/react';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { stopRecording } from '@funwithappmap/react-recorder';
import {
  startTestRecording,
  finishTestRecording,
} from '@funwithappmap/react-recorder/vitest';
import { server as msw } from '../setup';
import { ClinicProvider } from '../../src/context/ClinicContext';
import { App } from '../../src/App';

// import.meta.url is not a file:// URL under the jsdom environment, so
// anchor on the workspace layout instead, starting from cwd.
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
const E2E_DIR = join(EXAMPLE_ROOT, 'tmp', 'appmap', 'e2e');

const PETCLINIC_GO_DIR =
  process.env.PETCLINIC_GO_DIR ??
  join(REPO_ROOT, '..', 'FunwithAppMapandClaudeGolang', 'FunwithAppMapandClaudeGolang', 'examples', 'PetClinicGo');

const goAvailable = spawnSync('go', ['version']).status === 0;
const backendAvailable = goAvailable && existsSync(join(PETCLINIC_GO_DIR, 'main.go'));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

describe.skipIf(!backendAvailable)('full-stack: React ↔ PetClinicGo ↔ appmap-link', () => {
  const frontendDir = join(E2E_DIR, 'frontend');
  const backendDir = join(E2E_DIR, 'backend');
  const linksDir = join(E2E_DIR, 'links');
  let petclinic: ChildProcess | undefined;
  let base: string;

  beforeAll(async () => {
    msw.close(); // this file talks real HTTP

    rmSync(E2E_DIR, { recursive: true, force: true });
    mkdirSync(frontendDir, { recursive: true });

    const binary = join(E2E_DIR, 'petclinic');
    const build = spawnSync('go', ['build', '-o', binary, '.'], {
      cwd: PETCLINIC_GO_DIR,
      encoding: 'utf8',
    });
    if (build.status !== 0) throw new Error(`go build failed:\n${build.stderr}`);

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    petclinic = spawn(
      binary,
      ['-addr', `127.0.0.1:${port}`, '-db', join(E2E_DIR, 'petclinic.db'), '-appmap-dir', backendDir],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );

    await waitFor(
      async () => {
        const res = await fetch(`${base}/vets`);
        expect(res.ok).toBe(true);
      },
      { timeout: 15_000, interval: 250 },
    );
  }, 120_000);

  afterAll(() => {
    petclinic?.kill('SIGTERM');
  });

  it('stitches owner detail end to end: real fetches, real backend maps, real join', async () => {
    // Drive a dedicated recording instead of the ambient per-test one,
    // so we know exactly which file to link.
    stopRecording();
    startTestRecording('e2e: owner detail', { app: 'petclinic-react' });

    render(
      <ClinicProvider config={{ apiBase: base }}>
        <MemoryRouter initialEntries={['/owners/1']}>
          <App />
        </MemoryRouter>
      </ClinicProvider>,
    );
    // Real seeded data from the real SQLite database.
    expect(await screen.findByRole('heading', { name: 'George Franklin' })).toBeInTheDocument();
    expect(screen.getByText('Leo (cat)')).toBeInTheDocument();

    const frontendMap = finishTestRecording('succeeded');
    copyFileSync(frontendMap, join(frontendDir, basename(frontendMap)));

    // The middleware writes after the response is flushed; allow for that.
    await waitFor(() => expect(readdirSync(backendDir)).toHaveLength(2), { timeout: 5000 });

    const link = spawnSync(
      'node',
      [LINKER_CLI, frontendDir, backendDir, '--out', linksDir],
      { encoding: 'utf8' },
    );
    expect(link.status, link.stderr).toBe(0);
    expect(link.stdout).toContain('2/2 requests linked, 0 orphan backend map(s)');

    const { links, orphan_backends } = JSON.parse(
      readFileSync(join(linksDir, 'appmap-links.json'), 'utf8'),
    );
    expect(orphan_backends).toEqual([]);
    expect(links).toHaveLength(1);

    const requests = links[0].requests;
    expect(requests).toHaveLength(2);
    expect(requests.map((r: any) => r.backend?.name).sort()).toEqual(['GET /owners/1', 'GET /vets']);
    expect(requests.every((r: any) => r.request.status === 200)).toBe(true);

    // The backend maps are REAL middleware output, not the simulator:
    for (const req of requests) {
      const backendMap = JSON.parse(readFileSync(req.backend.path, 'utf8'));
      expect(backendMap.metadata.recorder.name).toBe('funwithappmap-go');
      expect(backendMap.metadata.parent_span_id).toBe(req.span_id);
      expect(backendMap.metadata.trace_id).toBe(links[0].interaction.trace_id);
    }

    // And the stitched diagram exists.
    const puml = readdirSync(linksDir).find((f) => f.endsWith('.puml'));
    expect(puml).toBeDefined();
    const diagram = readFileSync(join(linksDir, puml!), 'utf8');
    expect(diagram).toContain('FE -> BE0 : GET /owners/1');
    expect(diagram).toContain('FE -> BE0 : GET /vets');
    expect(diagram).toContain('BE0 --> FE : 200');
  }, 30_000);

  it('links the error path too: a 400 validation response', async () => {
    stopRecording();
    startTestRecording('e2e: create owner validation error', { app: 'petclinic-react' });

    const response = await fetch(`${base}/owners`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Maria' }), // lastName missing
    });
    expect(response.status).toBe(400);

    const frontendMap = finishTestRecording('succeeded');
    const errFrontendDir = join(E2E_DIR, 'frontend-err');
    mkdirSync(errFrontendDir, { recursive: true });
    copyFileSync(frontendMap, join(errFrontendDir, basename(frontendMap)));

    await waitFor(() => expect(readdirSync(backendDir).length).toBeGreaterThanOrEqual(3), {
      timeout: 5000,
    });

    const outDir = join(E2E_DIR, 'links-err');
    const link = spawnSync('node', [LINKER_CLI, errFrontendDir, backendDir, '--out', outDir], {
      encoding: 'utf8',
    });
    expect(link.status, link.stderr).toBe(0);

    const { links } = JSON.parse(readFileSync(join(outDir, 'appmap-links.json'), 'utf8'));
    const post = links[0].requests.find((r: any) => r.request.method === 'POST');
    expect(post.request.status).toBe(400);
    expect(post.backend?.name).toBe('POST /owners');
    const backendMap = JSON.parse(readFileSync(post.backend.path, 'utf8'));
    expect(backendMap.events.at(-1).http_server_response.status_code).toBe(400);
  }, 30_000);
});
