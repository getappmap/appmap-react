import { describe, it, expect } from 'vitest';
import { transformSource } from '../src/transform';

// Callbacks passed to useCallback/useMemo are instrumented whichever way
// the hook is spelled: bulletproof-react writes React.useCallback, and its
// toggle/open/close/checkAccess callbacks were never recorded.

const source = `
import * as React from 'react';
import { useCallback, useMemo } from 'react';

export const useDisclosure = (initial = false) => {
  const [isOpen, setIsOpen] = React.useState(initial);
  const open = React.useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const label = React.useMemo(() => (isOpen ? 'open' : 'closed'), [isOpen]);
  const same = useMemo(function compute() { return 1; }, []);
  const notAHook = React.useState(() => 0);
  return { isOpen, open, close, label, same, notAHook };
};
`;

describe('transform: useCallback / useMemo callbacks', () => {
  it('wraps React.useCallback / React.useMemo callbacks like the bare hooks', async () => {
    const result = await transformSource(source, { relPath: 'src/hooks/use-disclosure.ts' });
    const code = result!.code;
    for (const [hook, name] of [
      ['React.useCallback', 'open'],
      ['useCallback', 'close'],
      ['React.useMemo', 'label'],
      ['useMemo', 'same'],
    ]) {
      const wrapped = new RegExp(
        `const ${name} = ${hook.replace('.', '\\.')}\\(__appmap_instrument_handler__\\([\\s\\S]*?methodId: "${name}"`,
      );
      expect(code, `${hook} callback for ${name}`).toMatch(wrapped);
    }
    // Other React.* calls are left alone.
    expect(code).toMatch(/const notAHook = React\.useState\(\(\) => 0\)/);
  });
});

describe('transform: the Deno.serve handler', () => {
  for (const [shape, call] of [
    ['Deno.serve(handler)', 'Deno.serve(async (req) => new Response(req.url));'],
    ['Deno.serve(options, handler)', 'Deno.serve({ port: 8000 }, async (req) => new Response(req.url));'],
    ['Deno.serve({ handler })', 'Deno.serve({ port: 8000, handler: async (req) => new Response(req.url) });'],
  ]) {
    it(`instruments an anonymous handler: ${shape}`, async () => {
      const result = await transformSource(`function helper() {}\n\n${call}\n`, { relPath: 'functions/tasks/index.ts' });
      expect(result!.code).toMatch(
        /__appmap_instrument__\(async req => new Response\(req\.url\), \{[\s\S]*?methodId: "handler",[\s\S]*?lineno: 3[\s\S]*?\}, \["req"\]\)/,
      );
    });
  }

  it('leaves other top-level calls alone', async () => {
    const result = await transformSource('console.log(() => 1);\nfoo.serve(async () => 1);\n', { relPath: 'x.ts' });
    expect(result!.code).not.toContain('__appmap_instrument__');
  });
});
