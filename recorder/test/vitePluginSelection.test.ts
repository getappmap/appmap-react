import { describe, it, expect } from 'vitest';
import { appmapVitePlugin, type AppMapPluginOptions } from '../src/vitePlugin';
import { syntaxFor } from '../src/transform';

// Which files the Vite plugin instruments, and that it can parse them.
// Found by acceptance runs on real apps:
// - a Create React App app keeps JSX in .js files; the transform parsed
//   JSX only in .jsx/.tsx, so every component file failed with
//   "Unexpected token" and Vite served a 500 (the app did not render).

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
