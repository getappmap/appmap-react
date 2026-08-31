// The Deno half of the family's shared PetClinic domain (see README):
// a minimal Deno.serve edge function, in the shape of a real Supabase
// edge function, used as the runnable spike for docs/design/05 and 06
// (build-time instrumentation, then zero-touch recording, for Deno /
// Supabase edge functions — the backend half of the full-stack join
// demonstrated in doc 02).
//
// Deliberately, this file contains NOTHING appmap-related — no import,
// no wrapping. That's the point of doc 06: run it via
// `npm test --workspace examples/deno-edge` (or by hand, see the
// README) and it gets recorded anyway.

const PETS: Record<string, { name: string; species: string }> = {
  leo: { name: 'Leo', species: 'cat' },
  rex: { name: 'Rex', species: 'dog' },
};

function lookupPet(name: string): { name: string; species: string } | null {
  return PETS[name.toLowerCase()] ?? null;
}

export async function handlePetLookup(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const name = url.searchParams.get('name') ?? '';
  const pet = lookupPet(name);
  if (!pet) return Response.json({ error: 'not found' }, { status: 404 });
  return Response.json(pet);
}

Deno.serve(handlePetLookup);
