import { describe, it, expect } from 'vitest';
import { appmapVitePlugin, DEFAULT_TEST_EXCLUDE, type AppMapPluginOptions } from '../src/vitePlugin';
import { pathMatcher } from '../src/pathMatch';
import { syntaxFor } from '../src/transform';

// Which files the Vite plugin instruments, and that it can parse them.
// Found by acceptance runs on real apps:
// - a Create React App app keeps JSX in .js files; the transform parsed
//   JSX only in .jsx/.tsx, so every component file failed with
//   "Unexpected token" and Vite served a 500 (the app did not render);
// - bulletproof-react co-locates tests (`__tests__/`, `*.test.tsx`) under
//   src/, and `exclude` only took directory prefixes, so functions defined
//   in test files were recorded as app code.

const ROOT = '/project';

type TransformHook = (this: { warn(msg: string): void }, code: string, id: string) => Promise<unknown>;

function plugin(options: Partial<AppMapPluginOptions> = {}) {
  const p = appmapVitePlugin({ include: ['src'], ...options });
  (p.configResolved as (c: unknown) => void)({ root: ROOT, base: '/', command: 'serve', mode: 'development', build: {} });
  const warnings: string[] = [];
  const transform = (code: string, rel: string) =>
    (p.transform as unknown as TransformHook).call({ warn: (m: string) => warnings.push(m) }, code, `${ROOT}/${rel}`) as Promise<
      { code: string } | null
    >;
  return { transform, warnings };
}

const JSX_IN_JS = `import { useState } from 'react';
function App() {
  const [n, setN] = useState(0);
  const invokeFunction = async () => setN(n + 1);
  return <button onClick={() => invokeFunction()}>Invoke Function {n}</button>;
}
export default App;
`;

describe('JSX and TypeScript syntax, by extension', () => {
  it('instruments JSX in a .js file (Create React App convention)', async () => {
    const { transform, warnings } = plugin();
    const out = await transform(JSX_IN_JS, 'src/App.js');
    expect(out?.code).toContain('__appmap_instrument__(App');
    expect(out?.code).toContain('methodId: "invokeFunction"');
    expect(out?.code).toContain('methodId: "onClick"');
    expect(warnings).toEqual([]);
  });

  it('keeps TypeScript type assertions working in .ts (no JSX there)', async () => {
    const { transform } = plugin();
    const out = await transform('export function f(x: unknown) { return (<string>x).length; }\n', 'src/f.ts');
    expect(out?.code).toContain('__appmap_instrument__(f');
  });

  it('parses .tsx and .jsx', async () => {
    const { transform } = plugin();
    expect((await transform('export const C = (p: { a: string }) => <b>{p.a}</b>;\n', 'src/C.tsx'))?.code).toContain(
      '__appmap_instrument__',
    );
    expect((await transform('export const C = (p) => <b>{p.a}</b>;\n', 'src/C.jsx'))?.code).toContain('__appmap_instrument__');
  });

  it('serves a file it cannot parse uninstrumented, with a warning, instead of breaking the app', async () => {
    const { transform, warnings } = plugin();
    await expect(transform('export const = ;\n', 'src/broken.js')).resolves.toBeNull();
    expect(warnings[0]).toMatch(/^appmap: not instrumenting src\/broken\.js: /);
  });

  it('syntaxFor matches the extension rules', () => {
    expect(syntaxFor('/a/b.js')).toEqual({ jsx: true, typescript: false });
    expect(syntaxFor('/a/b.mjs?v=1')).toEqual({ jsx: true, typescript: false });
    expect(syntaxFor('/a/b.jsx')).toEqual({ jsx: true, typescript: false });
    expect(syntaxFor('/a/b.ts')).toEqual({ jsx: false, typescript: true });
    expect(syntaxFor('/a/b.mts')).toEqual({ jsx: false, typescript: true });
    expect(syntaxFor('/a/b.tsx')).toEqual({ jsx: true, typescript: true });
  });
});

describe('include / exclude', () => {
  const FN = 'export function f() { return 1; }\n';

  it('leaves common test-file patterns out by default', async () => {
    const { transform } = plugin({ exclude: ['src/testing'] });
    for (const rel of [
      'src/features/x/__tests__/discussion.test.tsx',
      'src/components/ui/dialog/__tests__/dialog.test.tsx',
      'src/lib/auth.test.ts',
      'src/lib/auth.spec.js',
      'src/__mocks__/api.ts',
      'src/testing/mocks/db.ts',
    ]) {
      expect(await transform(FN, rel), rel).toBeNull();
    }
    expect((await transform(FN, 'src/lib/auth.tsx'))?.code).toContain('__appmap_instrument__');
    expect((await transform(FN, 'src/lib/latest.ts'))?.code).toContain('__appmap_instrument__');
  });

  it('defaultExclude: false instruments test files too; a custom list replaces the default', async () => {
    expect((await plugin({ defaultExclude: false }).transform(FN, 'src/a/__tests__/a.test.ts'))?.code).toContain(
      '__appmap_instrument__',
    );
    const custom = plugin({ defaultExclude: ['**/*.stories.tsx'] });
    expect(await custom.transform(FN, 'src/button.stories.tsx')).toBeNull();
    expect((await custom.transform(FN, 'src/a.test.ts'))?.code).toContain('__appmap_instrument__');
  });

  it('accepts globs in include and exclude', async () => {
    const { transform } = plugin({ include: ['src/features/**/*.tsx'], exclude: ['**/legacy/**'] });
    expect((await transform(FN, 'src/features/a/b.tsx'))?.code).toContain('__appmap_instrument__');
    expect(await transform(FN, 'src/features/a/b.ts')).toBeNull();
    expect(await transform(FN, 'src/features/legacy/b.tsx')).toBeNull();
    expect(await transform(FN, 'src/lib/b.tsx')).toBeNull();
  });

  it('pathMatcher: prefixes, **, *, ?, {a,b}', () => {
    const m = pathMatcher(['src/testing', './lib/', '**/__tests__/**', 'src/*.{test,spec}.ts', 'a/?.js']);
    expect(m('src/testing')).toBe(true);
    expect(m('src/testing/x.ts')).toBe(true);
    expect(m('src/testingx/x.ts')).toBe(false);
    expect(m('lib/x.ts')).toBe(true);
    expect(m('__tests__/x.ts')).toBe(true);
    expect(m('src/a/b/__tests__/c/d.tsx')).toBe(true);
    expect(m('src/a.test.ts')).toBe(true);
    expect(m('src/a.spec.ts')).toBe(true);
    expect(m('src/x/a.test.ts')).toBe(false);
    expect(m('a/b.js')).toBe(true);
    expect(m('a/bc.js')).toBe(false);
    expect(DEFAULT_TEST_EXCLUDE).toContain('**/__tests__/**');
  });
});
