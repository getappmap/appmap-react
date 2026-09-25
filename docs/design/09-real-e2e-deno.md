# 9. Real end-to-end test: React ↔ real Deno backend ↔ appmap-link

Status: **accepted**, both tests passing against real processes — not
simulated, not mocked. See
[`examples/petclinic-react/test/e2e/deno-fullstack.test.ts`](../../examples/petclinic-react/test/e2e/deno-fullstack.test.ts).

## What this closes

`test/e2e/fullstack.test.tsx` already proves the join against a real
backend — but only when the Go sibling repo is checked out
side-by-side, so it's skipped in most environments (this one
included). Nothing in this repo alone could prove the join end to end
without an external dependency, until now: `examples/deno-edge` is a
real Deno backend that lives here, so the same proof is possible with
no sibling repo, no simulator, on every checkout that has `deno`.

## What it actually does

1. Runs the real, unmodified `examples/deno-edge/src/petLookup.ts`
   through the real `appmap-deno` runner (doc 06) — the same zero-touch
   path a real user gets, not a hand-wired test fixture.
2. Starts a dedicated recording (`startTestRecording`, not the ambient
   per-test one) and makes a plain `fetch()` call — no manual
   `traceparent` header. The recorder's own patched `fetch`
   (`fetchPatch.ts`) stamps it automatically, exactly as it would for
   a component's real fetch; this is the same mechanism
   `interactionRecorder.test.tsx` and `fullstack.test.tsx` rely on,
   now exercised against a live process instead of MSW or a simulator.
3. Waits for the real backend AppMap file the real Deno process wrote.
4. Runs the real `appmap-link` CLI (not a call into its internals) on
   both real files.
5. Asserts on the real join output: `1/1 requests linked, 0 orphan`,
   the backend map's `trace_id`/`parent_span_id` match the link's own
   ids, the classMap shows both `lookupPet` and `handlePetLookup`, and
   the rendered `.puml` diagram contains the expected sequence lines.
6. A second test does the same for a real 404 (the not-found branch),
   matching `fullstack.test.tsx`'s error-path test for the Go side.

Nothing here is asserted from having read the code and expecting it to
work — every assertion is against files these real processes actually
wrote during the test run.

## What's still not covered

A user-driven flow (click → render → real fetch → real Deno backend)
is not exercised here — `interactionRecorder.test.tsx` proves the
click-to-frontend-map half against MSW, and this doc proves the
frontend-map-to-backend-map half against a real process, but nothing
yet does both against the same real backend in one test. That would
mean reshaping which endpoint the app's own data client calls, or
adding a page that calls `deno-edge`'s API — not done here, flagged as
a real gap rather than implied to be covered.

## Amendment 2026-09-24

`test/e2e/fullstack.test.tsx` (the Go half referred to above) has been
removed; see doc 02's amendment of the same date. This test stays, and
in CI (`CI=true`) it now fails instead of skipping when `deno` is
missing. Its backend (`examples/deno-edge`) is this repo's own example,
so it is a regression test, not the proof: the "user-driven flow
against a real backend" gap named above is what
`acceptance/supabase-edge-functions-app` covers, against a real
open-source React + Deno app in real Chromium.
