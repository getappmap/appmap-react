import { appmapVitePlugin } from '../../../recorder/src/vitePlugin';

// Zero-touch interaction recording (docs/design/07): appmapVitePlugin's
// `app` option should inject installInteractionRecorder() with no
// application code changes, via the same transformIndexHtml +
// virtual-module trick @vitejs/plugin-react itself uses for its Fast
// Refresh preamble. Unit-tested by calling the plugin object's own
// hooks directly — no real Vite server needed.

type HookFn = (...args: any[]) => any;

function configuredPlugin(options: Parameters<typeof appmapVitePlugin>[0], mode = 'development') {
  const plugin = appmapVitePlugin(options);
  (plugin.configResolved as HookFn)({ root: '/project', mode });
  return plugin;
}

describe('appmapVitePlugin zero-touch interaction recording', () => {
  it('does nothing (no virtual module, no injected script) when app is not set', () => {
    const plugin = configuredPlugin({ include: ['src'] });
    expect((plugin.resolveId as HookFn)('virtual:appmap-interaction-recorder')).toBeUndefined();
    expect((plugin.transformIndexHtml as HookFn)()).toBeUndefined();
  });

  it('resolves and loads the virtual module with the configured app name', () => {
    const plugin = configuredPlugin({ include: ['src'], app: 'petclinic-react' });

    const resolved = (plugin.resolveId as HookFn)('virtual:appmap-interaction-recorder');
    expect(resolved).toBe('\0virtual:appmap-interaction-recorder');
    expect((plugin.resolveId as HookFn)('some/other/module')).toBeUndefined();

    const loaded = (plugin.load as HookFn)(resolved) as string;
    expect(loaded).toContain("from '@funwithappmap/react-recorder'");
    expect(loaded).toContain('installInteractionRecorder(');
    expect(loaded).toContain('"app":"petclinic-react"');
    expect((plugin.load as HookFn)('/some/unrelated/file.ts')).toBeUndefined();
  });

  it('injects a module script importing the virtual module into every page', () => {
    const plugin = configuredPlugin({ include: ['src'], app: 'petclinic-react' });
    const tags = (plugin.transformIndexHtml as HookFn)();
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ tag: 'script', attrs: { type: 'module' }, injectTo: 'head' });
    expect(tags[0].children).toContain('virtual:appmap-interaction-recorder');
  });

  it('does not inject in a production build even with app set (dev/test-only gating)', () => {
    const plugin = configuredPlugin({ include: ['src'], app: 'petclinic-react' }, 'production');
    expect((plugin.transformIndexHtml as HookFn)()).toBeUndefined();
  });

  it('force still injects in a production build, matching the existing transform gate', () => {
    const plugin = configuredPlugin({ include: ['src'], app: 'petclinic-react', force: true }, 'production');
    expect((plugin.transformIndexHtml as HookFn)()).toHaveLength(1);
  });
});
