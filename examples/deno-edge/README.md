# deno-edge example

Runnable spike for [docs/design/06](../../docs/design/06-zero-touch-deno.md):
`src/petLookup.ts` is a minimal `Deno.serve` edge function (in the
family's shared PetClinic domain) that contains **nothing
appmap-related** — no import, no wrapping. It gets recorded anyway.

## Run it

```bash
npm test --workspace examples/deno-edge
```

Runs the unmodified `src/petLookup.ts` through `appmap-deno` (see
below), sends one `traceparent`-stamped request and one plain request,
and asserts exactly one AppMap was written — for the stamped request
only — with the right trace/span ids and call events; and asserts the
source file on disk was never touched. If `deno` isn't on `PATH`, it
reports itself as skipped rather than failing (the same convention
`linker`'s real-PetClinicGo integration test already uses).

## Do it by hand — zero-touch (recommended)

```bash
node --experimental-strip-types ../../deno/bin/appmap-deno.ts \
  --app deno-edge-petclinic src/petLookup.ts

# in another terminal
curl 'http://localhost:8000/?name=Leo' \
  -H 'traceparent: 00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1111111111111111-01'
curl 'http://localhost:8000/?name=Leo'   # unstamped — recorded nothing

ls tmp/appmap/requests/   # exactly one file — src/petLookup.ts is untouched
```

Only covers plain `deno run` / self-hosted Deno — **not** Supabase
Edge Functions, which have no equivalent hook. See
[doc 06](../../docs/design/06-zero-touch-deno.md#the-gap-supabase-edge-runtime).

## Do it by hand — explicit wiring (advanced / Supabase)

For a host with no zero-touch path, `withAppMap` is still the direct,
documented way in:

```ts
import { withAppMap } from '<path-to>/deno/appmap.ts';
Deno.serve(withAppMap(handleRequest, { app: 'my-function' }));
```

then transform as doc 05 describes:

```bash
node --experimental-strip-types ../../recorder/bin/transform-file.ts \
  src/myFunction.ts tmp/myFunction.instrumented.ts \
  --runtime ../../../deno/appmap.ts
```

## Joining to a frontend map

Same `appmap-link` used for the React↔Go/`.NET` join — a backend map
produced here links to any frontend map whose `fetch` carried the same
`traceparent`:

```bash
node ../../linker/bin/appmap-link.mjs <frontend-maps-dir> tmp/appmap/requests --out tmp/links
```
