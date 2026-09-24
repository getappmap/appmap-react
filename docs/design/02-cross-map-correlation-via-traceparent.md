# 2. Cross-map correlation via traceparent

Status: **accepted**, validated by the spike in
[`../../linker`](../../linker) plus the stamping in
[`../../recorder/src/fetchPatch.ts`](../../recorder/src/fetchPatch.ts)
— originally against **simulated** backend maps; from the 2026-06-12
amendment to the 2026-09-24 one, against the real PetClinicGo server
(that test is now retired); since the 2026-09-24 amendment, end to end
against a real open-source React + Deno app
(`acceptance/supabase-edge-functions-app`).

This is the project's headline goal landing deliberately early, on
hand-instrumentation, before the build-time transform (doc 03) exists:
correlate frontend AppMaps with backend AppMaps so a user interaction
can be followed from click to SQL.

## Mechanism: W3C Trace Context

While a recording is active, the patched `fetch` stamps every outgoing
request with a `traceparent` header:

```
traceparent: 00-<trace-id>-<span-id>-01
```

- **one trace-id per recording** — generated when the `Recording` is
  constructed and stored in the frontend AppMap's `metadata.trace_id`;
- **a fresh span-id per outgoing request** — generated at the stamping
  choke point in `fetchPatch.ts`. No separate bookkeeping: traceparent
  is in the captured request headers, so it lands on the
  `http_client_request` event for free.

**Why traceparent and not a custom header:** it's the standard. If a
backend already runs OpenTelemetry, our ids coexist and interoperate
instead of colliding; any service we don't instrument still propagates
the header onward.

## The backend half

The agent middleware on the backend records request headers already
(.NET does; the Go middleware will). Each adds one small behavior:
**copy the incoming `traceparent` into the request AppMap's
metadata** — `metadata.trace_id` and `metadata.parent_span_id` — so
the link is queryable without parsing event headers.

## The join

```
frontend map · http_client_request · traceparent span-id
  == backend map · metadata.parent_span_id
```

One interaction fans out to N fetches → 1 frontend map linked to N
backend request maps. 1:N, by design. Maps are ordered by causality
(span ids), never by timestamps — clock skew between client and server
makes timestamps unsafe for ordering.

## The linker: `appmap-link`

AppMap v1.12 has no cross-map link concept, so we don't fight the
format. [`linker/`](../../linker) is a small dependency-free Node CLI
that scans directories of maps (frontend = has `http_client_request`
events; backend = has `http_server_request` events) and:

1. emits `appmap-links.json` — per interaction, the ordered outgoing
   requests with span ids, response statuses, and the matched backend
   map (or `null`), plus a list of orphan backend maps;
2. renders a **stitched PlantUML sequence diagram** per linked
   interaction. The diagram is the deliverable that makes linking
   visible; the maps themselves stay separate, valid AppMaps.

## What the spike proved

```bash
npm run link:demo
```

runs the RTL suite (8 real frontend maps), synthesizes the backend
maps PetClinicGo's agent will emit
([`linker/bin/simulate-backend.mjs`](../../linker/bin/simulate-backend.mjs)),
and links: **13/13 requests linked, 0 orphans**. The owner-detail
interaction — one click, two concurrent fetches — stitches to:

```puml
User -> FE : OwnerDetail > shows the owner, their pets, …
FE -> BE0 : GET /owners/1
activate BE0
BE0 -> BE0 : handlers.getOwner
BE0 -> BE0 : Owners.Get
BE0 -> DB : SELECT * FROM owners WHERE id = ?
DB --> BE0
BE0 -> DB : SELECT * FROM pets WHERE owner_id = ?
DB --> BE0
BE0 --> FE : 200
deactivate BE0
FE -> BE0 : GET /vets
…
```

The error paths link too: the create-owner validation test's POST
carries its span-id, and the simulated backend map shows the 400 with
no SQL (validation fails before the store).

**Real vs. simulated.** The frontend maps, the traceparent values, the
span-ids, and the join logic are all real — the stamping is asserted
by `examples/petclinic-react/test/traceparent.test.tsx` (trace-id
matches the recording, span-ids distinct per request). The backend
maps are synthesized from the frontend maps' own traceparent values,
marked `recorder.name: "funwithappmap-go-simulated"` so they can never
be mistaken for real recordings. What the simulation can NOT prove:
that a real middleware correctly extracts the header under real
network conditions. That lands with the sibling follow-ups.

## Gotchas designed for

- **CORS.** A custom header on `fetch` triggers preflight; the
  backend's dev CORS middleware must list `traceparent` in
  `Access-Control-Allow-Headers`. Two notes: (1) in this repo's dev
  setup the Vite proxy makes requests same-origin, so no preflight at
  all; (2) PetClinicGo needs a permissive dev CORS middleware anyway
  the moment a separate frontend origin talks to it directly.
- **Never leak headers in production.** Stamping happens only inside
  the patched fetch, which is only installed while a recording is
  active; recording itself is dev/test-only (and the doc 03 transform
  will be dev/test-only gated).
- **Clock skew:** by construction, the linker never compares
  timestamps across machines; order comes from span ids and the
  frontend map's event order.

## Sibling-repo follow-ups (own sessions, per the handoff)

- **Go repo:** when the HTTP middleware gets built (its doc 03-ish),
  include traceparent capture into request-AppMap metadata
  (`trace_id`, `parent_span_id`). The simulator encodes the expected
  output shape. *(Partially done — see the amendment below: PetClinicGo
  now has a minimal envelope-only middleware. The full middleware with
  internal call + sql_query events remains Go-agent work.)*
- **.NET repo:** small change to `AppMap.AspNetCore` middleware to
  copy traceparent into metadata the same way.
- When either ships, point `appmap-link` at a directory of real
  backend maps; the simulator then becomes test fixture machinery
  only.

## Amendment 2026-06-12: end-to-end integration test, no simulator (retired 2026-09-24, see below)

The join now has a fully real automated proof:
[`examples/petclinic-react/test/e2e/fullstack.test.tsx`](../../examples/petclinic-react/test/e2e/fullstack.test.tsx)

1. builds and boots the **real PetClinicGo server** (real handlers,
   real SQLite) with a new minimal AppMap middleware
   (`examples/PetClinicGo/internal/appmap` in the Go repo, enabled by
   `-appmap-dir`/`APPMAP_DIR`) that records one request AppMap per
   **traceparent-carrying** request — envelope only
   (`http_server_request`/`response`), with the header copied into
   `metadata.trace_id`/`parent_span_id` exactly as this doc specifies;
2. drives the real React app against it over real HTTP (jsdom, MSW
   disabled), recording real frontend maps with real stamped fetches;
3. runs the real `appmap-link` CLI and asserts: 2/2 requests linked,
   0 orphans, backend `recorder.name == "funwithappmap-go"` (not the
   simulator), span-ids and trace-ids equal across the join, and the
   stitched diagram rendered. A second test links the **400 validation
   path** end to end.

The test needs the Go toolchain plus a checkout of the Go sibling repo
(`PETCLINIC_GO_DIR` overrides the default side-by-side location) and
**skips itself cleanly** when either is missing, so `npm test` stays
green everywhere. The middleware records only stamped requests, which
keeps the recording-driven semantics: unstamped traffic (health checks,
manual curls) produces no files.

Scope honesty: the real backend maps are request **envelopes** — the
internal `handlers → service → SQL` depth still comes only from the
simulator's synthetic maps (the diagram renderer now draws the DB lane
only when sql_query events exist). That depth is precisely what the Go
agent's own instrumentation roadmap delivers; when it does, this test
upgrades for free.

## Amendment (2026-09-24): XMLHttpRequest

Stamping lived only in the `fetch` patch, so an app whose HTTP client is
axios (XHR under the hood) — bulletproof-react in the acceptance run —
produced no `http_client_request` events and sent no `traceparent` at
all: nothing to link. `recorder/src/xhrPatch.ts` now wraps
`XMLHttpRequest` the same way while a recording is open: `open()`
stamps the request, and the `loadstart`/`loadend` events record the
request/response pair. It observes the instance the app holds rather
than `XMLHttpRequest.prototype`, because request interceptors such as
MSW answer mocked requests without calling the real `send()`. The
interaction window's idle check counts these requests too, so a window
no longer closes before an XHR's response arrives.

## Amendment 2026-09-24: the Go-backed e2e test is retired; the proof is a real OSS app

`examples/petclinic-react/test/e2e/fullstack.test.tsx` (the 2026-06-12
amendment above) has been removed. It was a weak proof: both ends were
this project's own novel tracers (the React recorder and the
experimental Go middleware) vouching for each other, it needed a
checkout of a private sibling repo, and it therefore skipped itself in
CI — so it never actually ran on a PR.

The end-to-end proof of the join is now
[`acceptance/supabase-edge-functions-app`](../../acceptance/supabase-edge-functions-app),
run by CI on every push and PR:

- the app is Supabase's own edge-functions example
  (`supabase/supabase` @ `74a3be9`): a React app (the "Edge Functions
  Test Client") that calls the `select-from-table-with-auth-rls` Deno
  edge function via `supabase.functions.invoke`, which calls GoTrue and
  queries Postgres through PostgREST under row-level security;
- everything runs on localhost from real parts (Postgres, the GoTrue
  and PostgREST release binaries, the app's own migrations), driven by
  real Chromium through Playwright, with no edits to the app's source;
- the checks are the shared acceptance spec (A–J, official validator
  `@appland/appmap-validate`) plus the join itself: the browser's
  request carries `traceparent`, the Deno map has the matching
  `parent_span_id`, `appmap-link` joins them, and the stitched diagram
  shows click → handler → backend → DB.

Its `EXPECTATIONS.md` was written before any recording and its
`RESULTS.md` records what actually happened. It is expected to fail
until the recorder bugs it found are fixed; CI does not hide that.
`examples/petclinic-react/test/e2e/deno-fullstack.test.ts` (doc 09)
stays as a fast regression test, but both of its ends are this repo's
own code, so it is not the proof.

## Amendment (2026-09-24): cross-origin requests — stamp only what the user lists

The recorder stamped `traceparent` on every `fetch`/XHR made while a
recording was open. On a real app that broke the app: Supabase's
edge-functions example calls its function on another origin
(`localhost:54321` from a page on `:3300`), the function's CORS policy
allows `authorization, x-client-info, apikey, content-type` and not
`traceparent`, so the browser's preflight failed and every "Invoke
Function" click ended in `FunctionsFetchError`
(`acceptance/supabase-edge-functions-app`, bug 3). A recorder must never
break the app it records.

The recorder now follows OpenTelemetry's browser model
(`propagateTraceHeaderCorsUrls`), in `recorder/src/propagation.ts`:

- **same-origin requests** are always stamped (no preflight is involved);
- **cross-origin requests** are stamped only when their origin is listed in
  the Vite plugin's `propagateTraceHeaderOrigins` option (or
  `APPMAP_PROPAGATE_TRACE_HEADER_ORIGINS`, comma-separated): an origin, a
  RegExp tested against the request URL, or `'*'`;
- **no page origin** (Node, Deno — server-side code, no CORS): every
  outgoing request is stamped, as before.

Every request is still recorded as `http_client_request`/`response`;
only the header is withheld. The option reaches the browser through the
injected interaction recorder (`installInteractionRecorder({
propagateTraceHeaderOrigins })`) and Vitest test recording through the
environment (the plugin sets the variable before Vitest starts its
workers). `setPropagateTraceHeaderOrigins()` sets it at runtime.

**What the user must configure to link a cross-origin backend** — the
one thing zero-touch cannot do for them: list the backend's origin, and
make the backend allow the header (`traceparent` in its
`Access-Control-Allow-Headers`). Supabase added `traceparent` to the
example functions' `corsHeaders` upstream (fc5db9bb); a function written
before that needs the same one-line change.

Tests: `recorder/test/propagation.test.ts`, and in
`recorder/test/xhrPatch.test.ts` "a cross-origin backend whose CORS does
not allow traceparent" (jsdom enforces CORS for XHR: before this change
the request failed with "Headers traceparent forbidden").


## Amendment (2026-09-24): the stitched diagram shows the frontend handler and the backend's outgoing calls

On the Supabase edge-functions app the link held but the stitched diagram
was `click → POST /functions/v1/… → 200` and nothing else
(`acceptance/supabase-edge-functions-app`, bug 7): `diagram.mjs` drew no
frontend events at all, and on the backend only `sql_query` and function
calls — but an edge function reaches its database through PostgREST, over
HTTP, so its "DB" step is an `http_client_request`, which was not drawn.

`appmap-link` now hands each interaction's own map to the renderer, which
draws its function calls in event order with each request where it was
made (`FE -> FE : App.invokeFunction`, then `FE -> BE0 : POST …`), and
draws a backend's outgoing HTTP calls to a `network` participant with the
query from the event's `message` (`BE0 -> NET : GET /rest/v1/users?select=*`).
Its summary line no longer counts a backend map that calls out as a
frontend map: `1 frontend map(s), 1 backend map(s) (1 of them also make
outgoing requests; 0 linked onward)`. Such maps are still linked onward,
so a middle tier works as before. Tests: `linker/test/link.test.mjs`.
