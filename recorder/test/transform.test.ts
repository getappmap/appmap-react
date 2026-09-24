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
