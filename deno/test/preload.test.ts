import { describe, it, expect, vi } from 'vitest';

// deno/preload.ts patches Deno.serve as a side effect of being
// imported, capturing whatever Deno.serve currently is as `original`
// at that moment — so each scenario here needs a fresh module instance
// with its own Deno stub already in place before importing it.

async function loadPreloadWith(denoServe: (...args: unknown[]) => unknown, appName?: string) {
  vi.resetModules();
  (globalThis as unknown as { Deno: unknown }).Deno = {
    env: { get: (key: string) => (key === 'APPMAP_APP' ? appName : undefined) },
    serve: denoServe,
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeTextFile: vi.fn().mockResolvedValue(undefined),
  };
  await import('../preload.ts');
  return (globalThis as unknown as { Deno: { serve: (...args: unknown[]) => unknown } }).Deno.serve;
}

describe('preload (Deno.serve monkey-patch)', () => {
  it('wraps a bare handler: Deno.serve(handler)', async () => {
    const original = vi.fn((handler: unknown) => ({ handlerSeen: handler }));
    const patchedServe = await loadPreloadWith(original);

    const myHandler = async (_req: Request) => new Response('ok');
    const result = patchedServe(myHandler) as { handlerSeen: unknown };

    expect(original).toHaveBeenCalledTimes(1);
    expect(result.handlerSeen).not.toBe(myHandler); // wrapped, not passed through raw
    expect(typeof result.handlerSeen).toBe('function');
  });

  it('wraps the handler in Deno.serve(options, handler)', async () => {
    const original = vi.fn((options: unknown, handler: unknown) => ({ options, handlerSeen: handler }));
    const patchedServe = await loadPreloadWith(original);

    const myHandler = async (_req: Request) => new Response('ok');
    const opts = { port: 9000 };
    const result = patchedServe(opts, myHandler) as { options: unknown; handlerSeen: unknown };

    expect(original).toHaveBeenCalledTimes(1);
    expect(result.options).toBe(opts); // options object passed through unchanged
    expect(result.handlerSeen).not.toBe(myHandler);
  });

  it('wraps the embedded handler in Deno.serve({ port, handler })', async () => {
    const original = vi.fn((options: unknown) => ({ optionsSeen: options }));
    const patchedServe = await loadPreloadWith(original);

    const myHandler = async (_req: Request) => new Response('ok');
    const result = patchedServe({ port: 9000, handler: myHandler }) as {
      optionsSeen: { port: number; handler: unknown };
    };

    expect(original).toHaveBeenCalledTimes(1);
    expect(result.optionsSeen.port).toBe(9000); // rest of the options bag untouched
    expect(result.optionsSeen.handler).not.toBe(myHandler);
  });

  it('the wrapped handler actually records, tagged with APPMAP_APP', async () => {
    const original = vi.fn((handler: unknown) => handler); // hand it back so we can invoke it below
    const patchedServe = await loadPreloadWith(original, 'my-app');

    const myHandler = vi.fn(async () => new Response('ok'));
    const wrapped = patchedServe(myHandler) as (req: Request) => Promise<Response>;

    const traceparent = `00-${'b'.repeat(32)}-${'c'.repeat(16)}-01`;
    await wrapped(new Request('http://localhost/x', { headers: { traceparent } }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const denoStub = (globalThis as unknown as { Deno: { writeTextFile: ReturnType<typeof vi.fn> } }).Deno;
    expect(denoStub.writeTextFile).toHaveBeenCalledTimes(1);
    const appmap = JSON.parse(denoStub.writeTextFile.mock.calls[0][1]);
    expect(appmap.metadata.app).toBe('my-app');
    expect(appmap.metadata.trace_id).toBe('b'.repeat(32));
    expect(myHandler).toHaveBeenCalledTimes(1);
  });

  it('passes an unrecognized call shape straight through rather than guessing', async () => {
    const original = vi.fn((...args: unknown[]) => ({ argsSeen: args }));
    const patchedServe = await loadPreloadWith(original);

    // Not one of Deno.serve's three real shapes (bare handler / options
    // + handler / options.handler) — e.g. a caller that already passed
    // something malformed. Must not throw.
    const result = patchedServe('unexpected-string-arg') as { argsSeen: unknown[] };
    expect(result.argsSeen).toEqual(['unexpected-string-arg']);
  });
});
