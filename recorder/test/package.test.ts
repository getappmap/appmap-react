import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The package must be usable by another app exactly as documented:
// `npm pack` → install → import '@funwithappmap/react-recorder',
// '/vite', '/vitest' with no workarounds. It used to ship two files
// (package.json + src/index.ts), point its exports at .ts sources Node
// refuses to load from node_modules, and build a dist whose
// extensionless relative imports Node ESM could not resolve.

const recorderRoot = fileURLToPath(new URL('..', import.meta.url));
const work = join(recorderRoot, 'tmp', 'package-test');
// Inside the repo, so the consumer resolves the package's own
// dependencies (@babel/core, vite, vitest) from the workspace root.
const consumer = join(work, 'consumer');
const installed = join(consumer, 'node_modules', '@funwithappmap', 'react-recorder');

let files: string[] = [];

beforeAll(() => {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(installed, { recursive: true });
  const out = execFileSync('npm', ['pack', '--json', '--pack-destination', work], {
    cwd: recorderRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [info] = JSON.parse(out.slice(out.indexOf('[')));
  files = info.files.map((f: { path: string }) => f.path);
  execFileSync('tar', ['-xzf', join(work, info.filename), '-C', installed, '--strip-components=1']);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', type: 'module', private: true }));
}, 120_000);

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('npm pack output', () => {
  it('ships the built entry points', () => {
    for (const f of ['dist/index.js', 'dist/vitePlugin.js', 'dist/vitest.js', 'dist/transform.js', 'dist/index.d.ts']) {
      expect(files).toContain(f);
    }
    expect(files.some((f) => f.startsWith('test/'))).toBe(false);
  });

  it('imports by its documented specifiers in plain Node ESM (as a vite.config.ts does)', () => {
    const script = `
      const vite = await import('@funwithappmap/react-recorder/vite');
      const core = await import('@funwithappmap/react-recorder');
      const transform = await import('@funwithappmap/react-recorder/transform');
      const plugin = vite.appmapVitePlugin({ include: ['src'] });
      console.log(JSON.stringify({
        plugin: plugin.name,
        core: typeof core.autoInstrument + typeof core.Recording + typeof core.installInteractionRecorder,
        transform: typeof transform.transformSource,
      }));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: consumer,
      encoding: 'utf8',
    });
    expect(JSON.parse(out)).toEqual({
      plugin: 'appmap-instrument',
      core: 'functionfunctionfunction',
      transform: 'function',
    });
  });

  it('records a consumer app\'s tests with the plugin and the /vitest hooks, as the README documents', () => {
    mkdirSync(join(consumer, 'src'), { recursive: true });
    mkdirSync(join(consumer, 'test'), { recursive: true });
    writeFileSync(
      join(consumer, 'vite.config.ts'),
      [
        "import { defineConfig } from 'vite';",
        "import { appmapVitePlugin } from '@funwithappmap/react-recorder/vite';",
        'export default defineConfig({',
        "  plugins: [appmapVitePlugin({ include: ['src'], app: 'consumer' })],",
        "  test: { setupFiles: ['./test/setup.ts'] },",
        '});',
      ].join('\n'),
    );
    writeFileSync(
      join(consumer, 'test', 'setup.ts'),
      "import { registerAppMapHooks } from '@funwithappmap/react-recorder/vitest';\nregisterAppMapHooks({ app: 'consumer' });\n",
    );
    writeFileSync(join(consumer, 'src', 'greet.ts'), "export function greet(name: string) {\n  return `hi ${name}`;\n}\n");
    writeFileSync(
      join(consumer, 'test', 'greet.test.ts'),
      "import { test, expect } from 'vitest';\nimport { greet } from '../src/greet';\ntest('greets', () => expect(greet('Ada')).toBe('hi Ada'));\n",
    );
    const vitestBin = join(recorderRoot, '..', 'node_modules', 'vitest', 'vitest.mjs');
    execFileSync(process.execPath, [vitestBin, 'run'], { cwd: consumer, encoding: 'utf8', stdio: 'pipe' });
    const appmap = JSON.parse(readFileSync(join(consumer, 'tmp', 'appmap', 'tests', 'greets.appmap.json'), 'utf8'));
    expect(appmap.metadata.app).toBe('consumer');
    const call = appmap.events.find((e: { method_id?: string }) => e.method_id === 'greet');
    expect(call).toMatchObject({ path: 'src/greet.ts', parameters: [{ name: 'name', value: 'Ada' }] });
  }, 120_000);

  it('resolves the documented specifiers to type declarations', () => {
    writeFileSync(
      join(consumer, 'check.ts'),
      [
        "import { appmapVitePlugin } from '@funwithappmap/react-recorder/vite';",
        "import { registerAppMapHooks } from '@funwithappmap/react-recorder/vitest';",
        "import { autoInstrument, type AppMap } from '@funwithappmap/react-recorder';",
        "const p: { name: string } = appmapVitePlugin({ include: ['src'] });",
        'const r: (o?: { app?: string }) => void = registerAppMapHooks;',
        'const a: typeof autoInstrument = autoInstrument;',
        'let m: AppMap | undefined;',
        'export { p, r, a, m };',
      ].join('\n'),
    );
    for (const resolution of ['bundler', 'nodenext']) {
      const tsc = join(recorderRoot, '..', 'node_modules', 'typescript', 'bin', 'tsc');
      const moduleKind = resolution === 'bundler' ? 'esnext' : 'nodenext';
      execFileSync(
        process.execPath,
        [tsc, '--noEmit', '--strict', '--skipLibCheck', '--module', moduleKind, '--moduleResolution', resolution, '--target', 'es2022', 'check.ts'],
        { cwd: consumer, encoding: 'utf8' },
      );
    }
    expect(readdirSync(consumer)).toContain('check.ts');
  });
});
