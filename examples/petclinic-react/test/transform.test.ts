import { transformSource } from '../../../recorder/src/transform';

// The transform as a standalone pre-build pass for a runtime with no
// loader hook — a Supabase/Deno edge function shape. Deno resolves
// modules by URL or import-map name, so the runtime import specifier
// is configurable. (Deno itself can't run in every environment; this
// verifies the instrumented *output* Deno would execute.)

const DENO_RUNTIME = 'https://raw.example/funwithappmap/react-recorder/mod.ts';

const EDGE_FUNCTION_SOURCE = `
const lookup = async (phrase: string) => ({ phrase, count: phrase.length });

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const data = await lookup(url.searchParams.get('phrase') ?? '');
  return Response.json(data);
}

Deno.serve(handleRequest);
`;

describe('standalone transform (Deno pre-build shape)', () => {
  it('instruments top-level functions and imports the runtime by configured specifier', async () => {
    const result = await transformSource(EDGE_FUNCTION_SOURCE, {
      relPath: 'supabase/functions/what2say/index.ts',
      runtimeModule: DENO_RUNTIME,
    });

    expect(result).not.toBeNull();
    const code = result!.code;

    // Runtime import uses the Deno-resolvable specifier, not the bare npm name.
    expect(code).toContain(
      `import { autoInstrument as __appmap_instrument__ } from "${DENO_RUNTIME}"`,
    );
    expect(code).not.toContain('@funwithappmap/react-recorder');

    // Both top-level functions are wrapped, with identity from the AST.
    expect(code).toMatch(/const lookup = __appmap_instrument__\(async \(phrase(: string)?\) =>/);
    expect(code).toContain('handleRequest = __appmap_instrument__(handleRequest, {');
    expect(code).toContain('definedClass: "index"');
    expect(code).toContain('path: "supabase/functions/what2say/index.ts"');

    // The Deno.serve wiring is untouched; the export binding it uses is
    // rebound to the wrapped function (live ESM bindings).
    expect(code).toContain('Deno.serve(handleRequest)');
  });

  it('leaves a module with no top-level functions untouched (no runtime import)', async () => {
    const result = await transformSource(`export const VERSION = "1.0";\n`, {
      relPath: 'supabase/functions/what2say/version.ts',
      runtimeModule: DENO_RUNTIME,
    });
    expect(result!.code).not.toContain('__appmap_instrument__');
    expect(result!.code).not.toContain(DENO_RUNTIME);
  });
});
