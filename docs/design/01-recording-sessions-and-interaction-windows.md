# 1. Recording sessions and interaction windows

Status: **accepted** for test recording, validated by the spike in
[`../../recorder`](../../recorder) and
[`../../examples/petclinic-react`](../../examples/petclinic-react)
(7 RTL tests → 7 AppMaps, including concurrent fetches and error
paths). The interaction-window half is an **accepted direction**; its
spike lands with the in-browser collector (doc 04).

This is the first design decision for the React agent because it is
the browser edition of the Go repo's doc 01: every AppMap agent must
answer, on every instrumented call, *which recording session does this
event belong to?*

## The problem

On servers the recording unit is the HTTP request, and each runtime
has an ambient-context mechanism to follow it through the call graph:
appmap-java uses `ThreadLocal`, the .NET agent uses `AsyncLocal`, the
Go agent (sibling repo, doc 01) layers `context.Context` over
goroutine pinning.

In the browser the recording unit is the **user interaction** — start
at the triggering DOM event, stop when the microtask queue drains or
an idle timeout fires; route navigations and test cases are additional
units. And the browser has **no ambient-context mechanism at all**:
there is no AsyncLocalStorage, and the TC39 AsyncContext proposal that
would provide one has not shipped in any engine.

Synchronous attribution is trivial — one thread, so a single
"current session" global is exact until the first `await`. Crossing
`await` is the design decision.

## Mechanisms available, and why we defer the hard one

| # | Mechanism | Crosses `await`? | Cost |
|---|---|---|---|
| 1 | single current-session global | no — only synchronous code is attributed exactly | none; exact while one unit runs at a time |
| 2 | Zone.js-style promise/API patching | yes | monkey-patches `Promise`, timers, DOM callbacks; heavyweight, famously fragile with `async/await` (zone.js needs them transpiled away to intercept) |
| 3 | transform-injected continuation passing | yes, for code we compile | the build-time transform (doc 03) rewraps every `.then`/`await` continuation to restore the session; misses async hops inside uninstrumented dependencies |
| 4 | interaction-window scoping | n/a — sidesteps it | attribute *everything* that runs while the window is open; accepts attribution noise from unrelated async work that happens to land inside the window |
| 5 | TC39 AsyncContext | yes | not shipped; the eventual right answer, not available now |

The decisive observation: mechanisms 2 and 3 buy *precision under
concurrency* — distinguishing two recording units whose async work is
in flight simultaneously. But our recording units are **user
interactions**, and interactions, unlike server requests, are rare and
serialized: one click at a time, with the previous interaction's
window typically closed (microtasks drained / idle timeout) before the
next begins. The expensive precision defends against a case the
recording unit makes uncommon — whereas on a server, overlapping
requests are the normal case and ambient context is non-negotiable.

## Design

**One ambient session, module-global.** `startRecording` throws if a
recording is already active; `stopRecording` clears it. Everything the
instrumentation observes while the session is open — `Enter`/`Exit`
pairs, `fetch` request/response — is attributed to it.

Recording units map onto this as:

- **Test recording (milestone 1, this spike):** one session per test,
  started in `beforeEach`, written to disk in `afterEach`. Vitest runs
  tests sequentially within a worker and gives each worker its own
  module registry, so the one-at-a-time invariant holds by
  construction. Node *does* have AsyncLocalStorage, but the global is
  already exact here — using ALS would add nothing and would fork the
  Node and browser implementations.
- **Interaction recording (doc 04):** one session per interaction
  window — opened by the triggering DOM event, closed on microtask
  drain / idle timeout. Async work belonging to the interaction
  (fetches, state updates) almost always completes or at least *starts*
  inside the window; what we lose is attribution of late completions
  after the window closes, and what we tolerate is unrelated work
  (e.g. a polling timer firing mid-window) being swept in.
- **Refinement, not prerequisite:** when the doc 03 transform exists,
  it can inject continuation passing (mechanism 3) to extend
  attribution past window close for code we compile. AsyncContext
  (mechanism 5) replaces all of this when it ships.

**The Enter/Exit + CallToken contract carries over from the Go
recorder unchanged.** `Recording.enter(fn, args)` appends a `call`
event and returns a token; `Recording.exit(token, outcome)` appends
the matching `return`. The hand-written wrappers in
[`recorder/src/instrument.ts`](../../recorder/src/instrument.ts) are
exactly the prologue/epilogue the doc 03 transform will inject, with
`try/finally` (and promise `.then` chaining for async functions)
playing the role of Go's `defer`.

**Why linearized events tolerate async overlap.** AppMap v1.12 events
are a flat list where each `return` names its `call` via `parent_id`.
Two in-flight fetches interleave in the stream but stay correctly
paired — no tree structure has to be repaired when completions arrive
out of order.

## What the spike proved

`examples/petclinic-react` is hand-instrumented (components, a custom
hook, event handlers, the API client) and its RTL tests run under
Vitest/jsdom with MSW mocking the PetClinicGo API. Each test emits
`tmp/appmap/tests/<test name>.appmap.json` with `metadata`,
`classMap` (package-per-directory, like appmap-agent-js), `events`,
`test_status`, and a per-recording `trace_id` (the doc 02 hook).

The owner-detail test — one interaction, two concurrent fetches —
produced this event stream (abbreviated):

```
 1 call  OwnerDetail.OwnerDetail (props)         [component render]
 2 ret   ← 1
 3 call  client.getOwner (base, id)
 4 call  GET http://localhost:8080/owners/1      [http_client_request]
 5 call  client.getVets (base)
 6 call  GET http://localhost:8080/vets          [http_client_request]
 7 ret   ← 6  http_client_response 200           [vets won the race]
 8 ret   ← 4  http_client_response 200
 9 ret   ← 5  return Array
10 ret   ← 3  return Object
11 call  OwnerDetail.OwnerDetail (props)         [re-render with data]
12 ret   ← 11
```

The responses arrived out of order (7 before 8) and the pairing stayed
correct — the flat-list/`parent_id` claim above, observed on real
output. Error paths work the same way: the create-owner validation
test records `http_client_response` with `status_code: 400`, and
thrown `ApiError`s appear as `exceptions` on the `return` event.

What the spike deliberately does **not** prove: interaction-window
boundaries (no browser yet) and attribution noise under overlapping
windows. Those are doc 04's spike.

## Consequences

- The recorder core ([`recorder/src/session.ts`](../../recorder/src/session.ts))
  stays identical between Node and browser; only the output path
  differs (filesystem now, POST-to-collector in doc 04).
- `fetch` patching has a single choke point
  ([`recorder/src/fetchPatch.ts`](../../recorder/src/fetchPatch.ts)),
  which is where doc 02's `traceparent` stamping will go; every
  recording already carries a `trace_id` in metadata.
- Overlapping recording units are a hard error, not a silent merge.
  If real-world interaction recording shows frequent overlap (slow
  fetches + fast clicking), that surfaces as thrown errors we can
  measure, and becomes the trigger to invest in mechanism 3.

## Amendment (2026-09-01): thread assignment under concurrency

The "why linearized events tolerate async overlap" claim above is true
for *pairing* (`return.parent_id` always identifies the right `call`,
regardless of settlement order) but was incomplete for *hierarchical
reconstruction*. `thread_id` is a required AppMap field precisely
because a single flat, positionally-nested event stream ("push on
call, pop on return, per thread") can only represent one call being
open at a time on a given thread — true concurrent siblings (e.g. both
legs of a `Promise.all`, both still open at once) violate that if they
share a `thread_id`. The doc 01 spike's own owner-detail example
(`getOwner` and `getVets` both fetching concurrently, sharing
`thread_id: 1`) is exactly this shape, and would reconstruct
incorrectly under the positional-stack model standard AppMap tooling
uses, even though `parent_id` pairing alone stayed correct.

**Fix:** `Recording` (`recorder/src/recording.ts`) now assigns threads
based on real synchronous nesting rather than a single constant. It
tracks `syncStack` — call ids currently *synchronously* executing,
mirroring the real single-threaded JS call stack, popped the instant a
call yields control back to its caller (returns, or hands back a
pending `Promise`) — plus which threads currently have a call that has
left its sync frame but not yet settled ("dangling"). A new call
inherits its parent's thread when safe; when the candidate thread
already has a dangling, non-ancestor call open (a genuine concurrent
sibling), it gets a fresh thread instead. This requires no
`AsyncLocalStorage`, Zone.js, or continuation-passing (mechanisms 2/3
above stay exactly as expensive/deferred as before) — it only needs to
know whether an invocation's result was a `Promise`, which the
Enter/Exit wrapper already had to know.

Ordinary sequential (non-overlapping) calls are unaffected and stay on
one thread, as before. See `recorder/test/concurrency.test.ts` for the
Promise.all case this fixes, asserted against the actual pairing
+ positional-nesting invariant standard tooling relies on.

## Amendment (2026-09-24): per-request async context

Acceptance testing against a real Supabase edge function showed the
"one ambient session" design breaking exactly where this doc said it
would: on a server. With one module-global session, every instrumented
call and every `fetch` in the process was attributed to whichever
recording happened to be open — a burst of 20 stamped + 10 unstamped
requests produced **one** map holding all 30 requests' calls, and the
29 foreign outbound calls went out stamped with the open recording's
`traceparent`, so `appmap-link` would have joined them to the wrong map.
`withAppMap`'s "one at a time" check only stopped a second recording
from *starting*; it did nothing to stop other requests' events from
*entering* the open one.

**Fix: mechanism 2 (AsyncLocalStorage) where the runtime has it.**
`recorder/src/session.ts` now has two kinds of recording:

- **Scoped** (Deno, and any Node driver): the driver installs an
  `AsyncLocalStorage` with `installAsyncContext()` and runs each unit
  of work inside `runInRecording(recording, fn)`. `activeRecording()`
  answers from the *current async context*, so each request sees only
  its own recording; every stamped request gets its own map, however
  many are in flight. Unstamped requests run inside `runUnrecorded()`
  and see no recording at all — their code is never recorded and their
  outbound calls are never stamped. A scoped recording is closed with
  `closeScopedRecording()`; work still running in its context after
  that (un-awaited background promises) is neither recorded nor
  stamped. `node:async_hooks` works in both Deno and Node; session.ts
  only uses it through a structural interface, so it never imports it
  and stays loadable in a browser bundle.
- **Ambient** (`startRecording`/`stopRecording`), unchanged: test
  recording and browser interaction windows. The browser still has no
  async context, which is why doc 04's window scoping remains.

The outbound-request patches stay installed while any recording, of
either kind, is open (reference counted).

**Browser: overlapping interactions are marked, not split.** Without
async context the recorder cannot tell which of two overlapping
interactions a later event (a fetch response, a re-render) belongs to.
Splitting the window at the second trigger would present a guess as
fact — the first interaction's in-flight response would land in the
second map. So a window that absorbs a second trigger keeps going, but
the map says so: its name lists every interaction
(`click a "Users" + click a "Dashboard"`), `metadata.interactions`
holds them in order and `metadata.ambiguous` is `true`. Previously it
was silently named after the first click only. A trigger dispatched in
the same task as the one that opened the window (clicking a submit
button fires `click`, then `submit`) is the same user action and is not
counted as a second interaction.
