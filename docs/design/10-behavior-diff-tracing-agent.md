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

The full-stack e2e test still needs a live PetClinicGo backend and is skipped
without one (doc 02); the backend maps used here are the simulated ones, which
share the exact v1.2 shape the real Go middleware will emit.
