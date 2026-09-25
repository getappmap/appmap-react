# 5. Behavior-diff tracing agent

Status: **implemented; validated against real recordings and a real
mermaid parser.** The agent
([`linker/src/trace-agent.mjs`](../../linker/src/trace-agent.mjs)) and its CLI
([`linker/bin/appmap-trace.mjs`](../../linker/bin/appmap-trace.mjs)) are
covered by 14 automated tests
([`linker/test/trace-agent.test.mjs`](../../linker/test/trace-agent.test.mjs))
and were smoke-rendered on the example app's real recordings. Every
generated mermaid diagram was checked with the actual `mermaid.parse()`.

## The decision

Recordings and links are the *data*; a person needs a *view*. The .NET and
Go siblings render PlantUML; this repo already does too (doc 02,
[`diagram.mjs`](../../linker/src/diagram.mjs)). This doc adds the view that a
code reviewer actually wants: **what a change did to behavior**, rendered
where they read code — the terminal and a GitHub PR.

So the tracing agent produces, per interaction:

1. an **ASCII call-graph** — the full honest tree, for the terminal;
2. a **GitHub-native mermaid sequence diagram** — no PlantUML server needed;
3. an optional **behavior diff** against a baseline recording, with changed/
   added steps in an amber band and removed steps in red, plus a one-line
   plain-English caption.

## The contract it reads

The agent reads exactly what this repo already produces — AppMap v1.2 maps
plus the linker's join — and nothing else. The contract itself is described in docs
[01](01-recording-sessions-and-interaction-windows.md), [02](02-cross-map-correlation-via-traceparent.md) and [05](05-deno-edge-functions.md). The
one thing worth repeating here: **AppMap v1.2 in this repo has no native diff
export** — no `diffMode` enum, no `subtreeDigest` field, no `formerName`. Those
belong to upstream `@appland/sequence-diagram`, which we do not use. The diff
is therefore *computed by the agent* from two recordings; its status words
(`unchanged | added | removed | changed`) are the agent's, not the data's.

## How the diff works

- **Build an honest model.** Reconstruct the call tree from the flat event
  list (call/return + `parent_id` stack), then splice each linked fetch to its
  backend handler + SQL. Labels come from the `classMap`
  (`component`/`hook`/`event-handler`), joined by `defined_class`+`method_id`.
- **Digest for identity and for collapse.** `nodeDigest` = a step's identity
  ignoring volatile detail; `subtreeDigest` (FNV-1a over the node + its
  ordered children) = whether a whole subtree behaved identically. Equal
  subtreeDigests is exactly when it is safe to collapse in a diff.
- **Match children order-preservingly** (LCS over node digests). Unmatched
  current children are `added`; unmatched baseline children are `removed` and
  **spliced back in at position** so nothing is hidden. A matched step is
  `changed` if its own outcome differs (HTTP status, exception, SQL text) or
  any descendant changed — change propagates up the ancestry, the same
  intuition as a subtree digest mismatch.

## Honesty rules (enforced by tests)

- Never draw a call that is not in the recording; an unlinked fetch draws no
  backend.
- Never drop a changed/added/removed step to fit a cap.
- Collapse **only** unchanged subtrees (proven equal by `subtreeDigest`).

## Label-aware highlighting

Any function label matching `--highlight` (default
`^(security|secret|auth|crypto)`) is banded amber (mermaid) / marked `⚠`
(ASCII) regardless of the diff, and named in the caption when it is new. This
is the highest-value hook: the day a `security.*` label appears in a
recording, a new sensitive call shows up highlighted with no further work.

## Spike / how to run

```
npm run link:demo          # produce real recordings + links under tmp/appmap
node linker/bin/appmap-trace.mjs examples/petclinic-react/tmp/appmap
# behavior diff against a baseline set of recordings:
node linker/bin/appmap-trace.mjs <current-dir> --baseline <baseline-dir> --out out
```

## Validation

- 14 unit tests: call-tree reconstruction, label join, honest stitching (no
  invented calls), digest equality, diff detection + change propagation,
  security caption, ASCII collapse/marks, and a mermaid **balance guard**
  (every `rect`/`activate` closes, none crosses).
- Smoke-rendered on all 10 example interactions (ASCII + mermaid, plain +
  diff).
- All 20 generated mermaid diagrams pass the real `mermaid.parse()`
  (mermaid v11 under jsdom).

## The async gap (concurrent fetches)

The recorder has no async context (doc 01), so an interaction that fires
several fetches at once (OwnerDetail's `Promise.all([getOwner, getVets])`)
produces events that interleave out of strict call/return nesting. The tree
reconstruction is written for this: a return closes **only** the call it
names (never the calls opened above it), and a fetch is treated as an async
leaf that does not adopt later concurrent calls. The guarantee is that every
call and every linked backend is preserved — a test on the two-fetch case
locks it. The residual limit is honest: the exact parent of a concurrent call
is ambiguous without async context, so it may attach to a sibling branch. An
earlier version of this agent got this wrong and silently dropped the second
fetch; that is fixed and regression-tested.

## Not covered

The backend maps used here are the simulated ones, which share the exact v1.2
shape the real Go middleware will emit. (The PetClinicGo-backed e2e test this
paragraph used to point at was retired on 2026-09-24; the full-stack proof is
now `acceptance/supabase-edge-functions-app`, see doc 02.)

## Amendment (2026-09-24): standalone request maps, XHR apps, query strings

Three things acceptance runs on real apps showed:

- **An edge function's request map was drawn as a frontend.** Any map
  with an outgoing request counted as a frontend map, so a Deno request
  map traced on its own (called directly, not from a recorded browser
  interaction) ran in a lane called "frontend" and its
  `http_server_request` was drawn as `undefined.undefined`. appmap-trace
  now traces frontend maps (outgoing requests, no incoming one) plus
  every backend request map no frontend map links to; the latter run in
  their own app's lane (`client → restful-tasks → network`), with the
  server request unwrapped into the interaction's title. A linked middle
  tier's own outbound calls are drawn as calls to `network`, not `?.?`.
  (`appmap-link`'s notion of a frontend map is unchanged: a middle tier
  still links onward.)
- **An axios app traced 0 interactions** because its maps had no HTTP
  events. The recorder now records XMLHttpRequest (doc 02 amendment), so
  those maps are frontend maps like any other.
- **Query strings.** The recorder now keeps the query out of `url` and
  in the event's `message`, as the spec says (doc 12). The trace shows
  it again from `message`, so a request whose only change is a query
  parameter still shows up in a behavior diff.

Tests: `linker/test/trace-agent.test.mjs` ("a backend request map
traced on its own") and `linker/test/trace-cli.test.mjs`.

## Amendment (2026-09-24, later): same-named interactions; what "changed" counts

Two more things the acceptance runs showed:

- **Same-named interactions were diffed against the wrong baseline.**
  Every direct request to one edge function is named
  `POST /<function>`, and a button clicked twice gives two maps with the
  same name. The baseline was a map keyed by name, so every such
  interaction was diffed against the *last* baseline map of that name
  (`acceptance/supabase-edge-functions-app` H: R1 and R2 were compared
  with R3, which makes no outbound call, so their unchanged
  `GET /auth/v1/user` showed as added). appmap-trace now pairs
  same-named interactions by occurrence in recording order (the file
  name's trailing sequence number), and writes them to `name`,
  `name__2`, … instead of overwriting one file.
- **"1 added, 3 changed" for one inserted call.** The summary counted
  every step that *contains* a change (the request, the handler, the
  function around the call). It now counts a step as changed only when
  its own outcome changed; steps that contain a change are still marked
  `~` in the tree. A linked request's outcome now includes what the
  backend answered (its `http_server_response` status), so a changed
  backend status is a changed step.

Tests: `linker/test/trace-cli.test.mjs`.
