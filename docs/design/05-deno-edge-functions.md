# 5. Deno edge functions: the backend half completed

Status: **accepted**, validated by [`deno/test/withAppMap.test.ts`](../../deno/test/withAppMap.test.ts)
(driver logic, under plain Node/Vitest) and
[`examples/deno-edge`](../../examples/deno-edge) (a real `deno run`
spike, skipped automatically where no Deno binary is present — see
"What the spike proved"). Prompted by a downstream user (a Supabase
project with all its runtime-critical code in Deno edge functions)
asking whether this project's Node-side gap-fill — official AppMap
tooling has no Deno support — could be closed the same way this repo
already closed the React gap.

## The role

Doc 03's 2026-08-28 amendment named exactly what a Deno port would
need: "an output writer (`Deno.writeTextFile` or POST to a collector)
and a per-request session driver that copies the incoming traceparent
into metadata, i.e. the Deno twin of the PetClinicGo middleware."
[`deno/appmap.ts`](../../deno/appmap.ts) is that driver. It completes
the backend half of doc 02's join for a runtime this project's own
`transform-file.ts` (born from that same amendment) already knew how
to instrument — the missing piece was never the transform, it was
having something to run the instrumented output *as*, and something
to catch what it produces.

## Mechanism: `withAppMap`

```ts
import { withAppMap } from './appmap.ts';
Deno.serve(withAppMap(handleRequest, { app: 'what2say' }));
```

One `Recording` per stamped request, each in its own async context
(doc 01, "Per-request async context" amendment):

- **No `traceparent` header** → the wrapped handler runs unrecorded and
  untouched, in a context with no recording at all, so even while other
  requests are being recorded its code is not recorded and its outbound
  calls are not stamped. This is recording-driven by design (same as
  the frontend side): production traffic is silent unless something
  upstream chose to stamp it.
- **A stamped request** → a `Recording` opens, scoped to that request's
  async context. `metadata.trace_id`/`parent_span_id` are copied from
  the incoming header (doc 02's join key — a backend request map
  carries the *caller's* ids, never its own), `httpServerRequest`/
  `httpServerResponse` bracket the call, and the finished map ships
  after the response is ready to send — never blocking it.

Concurrent stamped requests each get their own map holding only their
own events. (This replaced an earlier one-recording-at-a-time rule that
let concurrent requests' events leak into whichever map was open.)
`deno/appmap_test.ts` pins this with overlapping stamped and unstamped
requests; `deno/test/withAppMap.test.ts` with two concurrent
`withAppMap`-wrapped handlers and a held promise gate.

## Shipping: file or collector

```
APPMAP_DIR (default tmp/appmap/requests) — one file per request, or
APPMAP_COLLECTOR — POST the AppMap JSON there instead
```

Some edge runtimes don't allow file writes. Rather than guess, the
driver takes whichever the environment sets and falls back to a local
directory otherwise — the same shape as the browser recorder's window
vs. collector choice in doc 04, for the same reason: don't assume
which sink is available.

## What the spike proved

`examples/deno-edge` transforms a small `Deno.serve` function (in the
family's shared PetClinic domain — a pet-lookup handler calling one
helper), runs it under real `deno run`, sends one stamped and one
unstamped request, and asserts on the file that comes out:

- exactly one AppMap is written, for the stamped request only;
- `metadata.trace_id` / `parent_span_id` match the incoming
  `traceparent` exactly;
- both `lookupPet` (the helper) and `handlePetLookup` (the handler)
  appear as call events, confirming the existing transform needed no
  changes to reach a Deno target — doc 03's amendment already made it
  host-agnostic.

The recorder core needed no Deno-specific changes either: it was
already portable (`performance.now`, `crypto.getRandomValues`, global
`fetch`/`Request`/`Headers`; `node:fs` quarantined behind `./vitest`).
Everything Deno-specific lives in `deno/appmap.ts` alone.

## Consequences

- **The transform and recorder core are now proven across three
  hosts** (Vite/browser, Vitest/Node, Deno) with zero changes to
  either — doc 03's `runtimeModule` option was the one seam that
  needed to exist, and it already did.
- **Labels are not yet applied on this side.** The React transform
  labels by naming convention (`instrument.ts`'s `autoInstrument`
  heuristics); the Deno driver uses the same `autoInstrument` but
  nothing yet maps a handler's shape or name to a label the way
  PascalCase → `component` does. Worth a naming-convention pass if a
  downstream project's review tooling starts reasoning over Deno
  traces' labels the way it already does for their Node-side ones —
  not addressed here.
- **No CI runs the real `deno run` spike** — `examples/deno-edge`'s
  smoke test skips itself when no `deno` binary is on `PATH`, the same
  convention the linker's real-PetClinicGo integration test already
  uses for an optional external dependency. `deno/test/` covers the
  driver's own logic without needing the binary at all.
