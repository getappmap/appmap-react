// @vitest-environment node
import { readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { server as msw } from './setup';

// Collector spike (docs/design/04), the server half: the Vite plugin's
// dev-server middleware accepts POSTed interaction AppMaps and writes
// them under tmp/appmap/interactions/. This boots the example's real
// dev server (real vite.config.ts, real plugin) and talks to it over
// real HTTP.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(ROOT, 'tmp', 'appmap', 'interactions');

describe('interaction collector', () => {
  let server: ViteDevServer;
  let base: string;

  beforeAll(async () => {
    // This file talks real HTTP to a local Vite server; MSW would
    // intercept it. Each test file gets its own worker, so this only
    // affects this file.
    msw.close();
    rmSync(OUT_DIR, { recursive: true, force: true });
    server = await createServer({ root: ROOT, server: { port: 0 }, logLevel: 'silent' });
    await server.listen();
    const address = server.httpServer!.address();
    base = `http://localhost:${typeof address === 'object' ? address!.port : address}`;
  }, 30_000);

  afterAll(async () => {
    await server?.close();
    rmSync(OUT_DIR, { recursive: true, force: true });
  });

  it('writes a POSTed AppMap to tmp/appmap/interactions/', async () => {
    const appmap = {
      version: '1.2',
      metadata: { name: 'click button "Find Owner"', recorder: { name: 'funwithappmap-react' } },
      classMap: [],
      events: [],
    };
    const response = await fetch(`${base}/__appmap/interactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(appmap),
    });
    expect(response.status).toBe(204);

    const files = readdirSync(OUT_DIR);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^click_button_Find_Owner_001\.appmap\.json$/);
    expect(JSON.parse(readFileSync(join(OUT_DIR, files[0]), 'utf8'))).toEqual(appmap);
  });

  it('rejects non-POST and invalid bodies', async () => {
    expect((await fetch(`${base}/__appmap/interactions`)).status).toBe(405);
    const bad = await fetch(`${base}/__appmap/interactions`, {
      method: 'POST',
      body: 'not json',
    });
    expect(bad.status).toBe(400);
    expect(existsSync(OUT_DIR) ? readdirSync(OUT_DIR) : []).toHaveLength(1);
  });
});
