# Handoff: React AppMap agent (new repo)

Paste this into a Claude Code session attached to the new React agent
repo (suggested name, following the family pattern:
`FunwithAppMapandClaudeReact`). The repo starts empty; this document
is the design brief.

## Project family and ground rules

This is the third agent in a family, all owned by evlawler:

- `Fun-with-Appmap-and-Claude-` — .NET agent (working: Harmony-based
  runtime instrumentation, ASP.NET Core middleware, per-request /
  remote / test recording, PetClinic example).
- `FunwithAppMapandClaudeGolang` — Go agent (design phase: docs 01–02,
  recorder + toolexec `runtime.g` GLS spikes proven, PetClinicGo
  example).
- This repo — React (browser) agent. **Headline goal: full-stack
  linking — correlate frontend AppMaps with backend AppMaps so a user
  interaction can be followed from click to SQL.**

Standing rule: do NOT write to any getappmap/AppMap-org repos. All
work stays in the owner's repos. Working convention carried over from
the Go repo: every design decision gets a doc in `docs/design/NN-*.md`
plus a runnable spike that proves it against the example app;
amendments are dated sections, not history rewrites.

## What the React agent records

AppMap JSON v1.2, same as the siblings. Mapping:

- Components → classMap classes (module/file → package); renders and
  event handlers → `call`/`return` events with props/args captured
  (size-capped, like APPMAP_EVENT_VALUESIZE in the .NET agent).
- Hooks (`useState`/`useEffect`/custom) → labeled function events.
- `fetch`/XHR → `http_client_request` / `http_client_response` events
  (already in the v1.2 spec — this is the linking hook, see below).
- Recording unit: **one AppMap per user interaction** (the analogue of
  per-HTTP-request on servers): start at the triggering DOM event,
  stop when the microtask queue drains / idle timeout. Route
  navigations and test cases are additional units.

## Architecture (transfers from the Go design)

1. **Instrumentation = build-time injection.** The toolexec role is
   played by a Vite plugin (or Babel/SWC transform) — a first-class,
   documented extension point, unlike Go where we had to own the
   toolchain wrapper. It injects the `Enter(...)` prologue /
   `try/finally Exit(...)` epilogue into functions selected by an
   appmap.yml equivalent. The Enter/Exit + CallToken contract from the
   Go recorder spike reuses directly; `finally` plays the role of Go's
   `defer`.
2. **The "doc 01 problem", browser edition.** Browsers have no
   AsyncLocalStorage (the TC39 AsyncContext proposal hasn't shipped).
   Synchronous attribution is trivial — single thread, one
   current-session global. Crossing `await` is the design decision:
   options are Zone.js-style promise patching, transform-injected
   continuation passing, or interaction-window scoping (attribute
   everything that runs inside the window; accept attribution noise
   from overlapping async work). Recommend starting with interaction
   windows + transform-injected propagation; this is doc 01 here.
3. **Output needs a collector.** Browsers can't write tmp/appmap/. The
   Vite dev-server side of the plugin doubles as the receiver: the
   in-page recorder POSTs finished AppMaps to it; it writes
   `tmp/appmap/interactions/*.appmap.json`. This is the remote
   recording protocol with roles reversed.
4. **First milestone: test recording.** React Testing Library under
   Vitest runs in Node/jsdom — no browser constraints. "One AppMap per
   RTL test" proves the event model and serializer before touching
   interaction windows. (Node HAS AsyncLocalStorage, so test recording
   doesn't even hit the async gap.)

## Full-stack linking design (the centerpiece)

**Mechanism: W3C Trace Context.** When the in-page recorder patches
`fetch`, every request made during a recording gets a `traceparent`
header (`00-<trace-id>-<span-id>-01`):

- one **trace-id** per interaction recording (also stored in the
  frontend AppMap's `metadata`),
- a fresh **span-id** per outgoing request, recorded on that
  `http_client_request` event (header capture gets it for free).

On the backend, the agent middleware records request headers already
(.NET does; Go middleware will). Add one small behavior to each:
**copy `traceparent` into the request AppMap's `metadata`** (e.g.
`metadata.trace_id`, `metadata.parent_span_id`) so the link is
queryable without parsing event headers.

**The join:** frontend map's `http_client_request` span-id ==
backend map's incoming `traceparent` parent-span-id. One interaction
fans out to N fetches → 1 frontend map linked to N backend request
maps (1:N, by design).

**The linker:** AppMap v1.2 has no cross-map link concept, so don't
fight the format — build a small CLI (`appmap-link`) that scans a
directory of frontend + backend maps and:

1. emits `appmap-links.json` (interaction map → ordered backend maps,
   keyed by trace/span ids), and
2. optionally renders a **stitched sequence diagram** (PlantUML, like
   the .NET repo's PetClinic docs): actor → component → handler →
   `fetch` → [backend lane] controller → service → SQL. The diagram is
   the deliverable that makes linking visible; the maps themselves
   stay separate and valid.

**Why traceparent and not a custom header:** it's the standard — if a
backend already runs OpenTelemetry, our ids coexist/interop instead of
colliding, and any service we don't instrument still propagates it.

**Gotchas to design for:**
- CORS: a custom header on fetch triggers preflight; `traceparent`
  must be in the backend's `Access-Control-Allow-Headers` in dev. The
  PetClinicGo backend needs a permissive dev CORS middleware anyway
  for a separate frontend origin.
- Only stamp requests while a recording is active; never leak headers
  in production builds (the transform should be dev/test-only).
- Clock skew between client and server: order by causality (span ids),
  not timestamps.

**Sibling-repo follow-ups this creates** (do in their own sessions):
- Go repo: when the HTTP middleware gets built (its doc 03-ish),
  include traceparent capture into request-AppMap metadata.
- .NET repo: small change to `AppMap.AspNetCore` middleware to copy
  traceparent into metadata the same way.

## Example app

`examples/petclinic-react`: a Vite + React (TypeScript) frontend for
the SAME PetClinic domain — owners list/search, owner detail with
pets, vets list, create-owner form with validation errors — talking to
the PetClinicGo backend over REST (it already serves exactly these
endpoints: GET /vets, GET /owners?lastName=, GET /owners/{id},
POST /owners). Include at least: a custom hook, a context provider,
concurrent fetches in one interaction (owner detail fires two), an
error path rendered in UI, and RTL tests (mock fetch with MSW). This
keeps the three repos demo-compatible: same domain, three agents, one
stitched diagram.

## Suggested doc roadmap

- 01 — recording sessions and interaction windows (the async-gap
  decision; spike: hand-instrumented mini-recorder + RTL test
  recording in Node).
- 02 — cross-map correlation via traceparent (spike: patched fetch +
  PetClinicGo with CORS + the join demonstrated on real files; the
  linker CLI can start here).
- 03 — build-time instrumentation (Vite plugin transform; selection
  config; dev/test-only gating).
- 04 — collector + interaction-window capture in a real browser.

Milestone order is deliberate: linking (the owner's priority) lands at
doc 02 using hand-instrumentation, before the transform exists.
