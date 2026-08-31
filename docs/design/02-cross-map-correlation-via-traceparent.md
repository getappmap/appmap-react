# 2. Cross-map correlation via traceparent

Status: **accepted**, validated by the spike in
[`../../linker`](../../linker) plus the stamping in
[`../../recorder/src/fetchPatch.ts`](../../recorder/src/fetchPatch.ts)
— originally against **simulated** backend maps; since the 2026-06-12
amendment below, also end to end against the **real** PetClinicGo
server emitting real backend maps.

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

AppMap v1.2 has no cross-map link concept, so we don't fight the
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

## Amendment 2026-06-12: end-to-end integration test, no simulator

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
