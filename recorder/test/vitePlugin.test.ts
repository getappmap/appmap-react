import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer, type ViteDevServer } from 'vite';
import { appmapVitePlugin } from '../src/vitePlugin';

// Zero-touch interaction recording (docs/design/07) against a real Vite
// dev server. The injected script must be something a browser can
// actually load: before the fix, the page carried
// `import "virtual:appmap-interaction-recorder"`, a URL scheme browsers
// refuse, so interaction recording never started in a real browser.

const recorderRoot = fileURLToPath(new URL('..', import.meta.url));
const fixture = join(recorderRoot, 'tmp', 'vite-plugin-fixture');

function injectedSpecifier(html: string): string {
  const match = /<script type="module">import "([^"]*appmap-interaction-recorder[^"]*)";<\/script>/.exec(html);
  if (!match) throw new Error(`no injected interaction-recorder import in:\n${html}`);
  return match[1];
}

async function devServer(base: string): Promise<{ server: ViteDevServer; origin: string }> {
  const server = await createServer({
    root: fixture,
    base,
    configFile: false,
    logLevel: 'silent',
    server: { port: 0, host: '127.0.0.1' },
    resolve: {
      alias: [{ find: '@funwithappmap/react-recorder', replacement: join(recorderRoot, 'src', 'index.ts') }],
    },
    plugins: [appmapVitePlugin({ include: ['src'], app: 'fixture-app' })],
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

describe('appmapVitePlugin zero-touch injection on a real dev server', () => {
  mkdirSync(join(fixture, 'src'), { recursive: true });
  writeFileSync(
    join(fixture, 'index.html'),
    '<!doctype html><html><head></head><body><script type="module" src="./src/main.ts"></script></body></html>',
  );
  writeFileSync(join(fixture, 'src', 'main.ts'), 'export const x = 1;\n');
  afterAll(() => rmSync(fixture, { recursive: true, force: true }));

  for (const base of ['/', '/sub/']) {
    it(`serves a page whose injected recorder import the browser can load (base ${base})`, async () => {
      const { server, origin } = await devServer(base);
      try {
        const pageUrl = `${origin}${base}`;
        const html = await (await fetch(pageUrl)).text();
        const specifier = injectedSpecifier(html);
        // What the browser would request for this import.
        const moduleUrl = new URL(specifier, pageUrl);
        expect(moduleUrl.protocol).toBe('http:');
        const res = await fetch(moduleUrl);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/javascript/);
        const code = await res.text();
        expect(code).toContain('installInteractionRecorder(');
        expect(code).toContain('"app":"fixture-app"');
        // …and its own import of the recorder resolves too.
        const recorderImport = /from\s+"([^"]+)"/.exec(code)![1];
        const recorderRes = await fetch(new URL(recorderImport, moduleUrl));
        expect(recorderRes.status).toBe(200);
        expect(await recorderRes.text()).toContain('installInteractionRecorder');
      } finally {
        await server.close();
      }
    });
  }

  it('links the bundled recorder in a forced production build', async () => {
    const outDir = join(fixture, 'dist');
    await build({
      root: fixture,
      configFile: false,
      logLevel: 'silent',
      mode: 'production',
      build: { outDir, emptyOutDir: true },
      resolve: {
        alias: [{ find: '@funwithappmap/react-recorder', replacement: join(recorderRoot, 'src', 'index.ts') }],
      },
      plugins: [appmapVitePlugin({ include: ['src'], app: 'fixture-app', force: true })],
    });
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    const src = /<script type="module"[^>]* src="\/(assets\/appmap-interaction-recorder[^"]+)"/.exec(html)?.[1];
    expect(src, html).toBeDefined();
    const code = readFileSync(join(outDir, src!), 'utf8');
    expect(code).toContain('fixture-app');
  });
});
