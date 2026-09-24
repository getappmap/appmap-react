# 11. Recording background work (`EdgeRuntime.waitUntil`)

Status: **accepted**, prompted by a real-app pilot (finding **E0a**) —
the first time the Deno driver met a real edge function instead of the
`deno-edge` toy. Validated by
[`deno/appmap_test.ts`](../../deno/appmap_test.ts) (waitUntil capture,
under real `deno test`) and
[`recorder/test/recording.test.ts`](../../recorder/test/recording.test.ts)
(the self-heal, under Vitest/Node).

## The finding (E0a)

The pilot app's `discovery-scan` edge function returns **202 immediately** and
does the entire scrape-and-synthesis pipeline — 2–4 minutes of vendor
calls — in a background task:

```ts
// discovery-scan/index.ts (paraphrased)
EdgeRuntime.waitUntil(runPipeline());   // scrape + synthesis, 2-4 min
return new Response(null, { status: 202 });
```

`EdgeRuntime.waitUntil(promise)` is how Supabase Edge Runtime / Deno
Deploy keep the isolate alive to finish work *after* the response is
sent. The doc 05/06 driver closed the recording the instant the
handler resolved:

```ts
const response = await handler(req);   // resolves at the 202
...
} finally {
  recording.httpServerResponse(token, status);
  stopRecording();                     // closed here — background hasn't run yet
  void ship(...);
}
```

So the recorded map held the accept path and the first couple of
synchronous DB reads, and **none** of the vendor calls the pipeline
makes under `waitUntil`. The pilot saw a lone
`GET /rest/v1/user_source_materials` and no Firecrawl, no
ScrapeCreators, no transcript fetch — the "conservation ledger" (does
every source read get a write?) can't be built from a trace that stops
at the 202. A settle-delay doesn't help: the recording is already
closed and shipped.

## Two problems, two fixes

### 1. Capture the background work

`EdgeRuntime.waitUntil` is a global, so the driver wraps it once
([`deno/appmap.ts`](../../deno/appmap.ts), `patchWaitUntil`) — the same
kind of global patch as doc 06's `Deno.serve` preload. While a
recording is open, every promise the handler hands to `waitUntil` is
also collected by the recorder. The wrapped handler then:

1. records the real response at its true time (the 202 — **not**
   delayed);
2. returns the response immediately, so the client is never blocked on
   the background work (blocking it would defeat the reason the handler
   used `waitUntil` at all);
3. keeps the recording **open**, and finalizes (`stopRecording` +
   `ship`) only after `Promise.allSettled(background)` settles.

Because the recording stays open through the background window, the
pipeline's own instrumented calls and its stamped outbound fetches land
in the same map — the edge function shows up complete, and as a middle
tier in the full-stack stitch.

**Event ordering.** The `http_server_response` (202) is recorded at
its true time, before the background work. In the serialized map (doc
12) the background calls nest under the request — they were started by
its handler — so the `http_server_response` appears after them, closing
the request's tree; its `elapsed` still says when the response went
out.

**Overlap.** Each stamped request records in its own async context
(doc 01, "Per-request async context" amendment), and `waitUntil`
promises are collected for the recording of the context that registered
them. A second stamped request arriving during a long background window
therefore gets its own map, and its own background work lands there —
not in the first request's map. (Before that amendment the ambient
session stayed held for the whole window, the second request ran
unrecorded, and its background work leaked into the first map.)

**Scope.** No-ops cleanly where `EdgeRuntime.waitUntil` doesn't exist —
plain `deno run`, the zero-touch runner, the Node/Vitest suite — so
existing behavior is unchanged. Nested `waitUntil` (background work that
itself calls `waitUntil`) is not chased; noted, not handled.

### 2. Never ship an unbalanced map

The pilot's truncated recording also **could not be sanitized**:
appmap-js's sanitizer threw "failed trying to compute event stack,
call.id: 47". That's the second failure and a more general one: a
`call` with no matching `return` — which any hard teardown produces,
`waitUntil` or not (the process is killed while calls are open) — makes
any tool that reconstructs the call stack throw. A map that can't be
sanitized can't be committed, so a truncated recording was worthless
even for the part it *did* capture.

`Recording.toAppMap()` now **self-heals**: any call still open at
serialization gets a synthesized `return` appended, so the event list
is always balanced, and `metadata.truncated: true` flags that some
returns are synthetic. This is defense in depth — fix 1 makes clean
teardown the normal case; fix 2 guarantees that even a genuinely killed
isolate yields a balanced, sanitizable, committable (if incomplete)
map instead of an unusable one. The synthesis is a non-mutating
snapshot: the recording's own event list is untouched, so it composes
with everything else.

## What the fixes do not solve

- A hard `kill -9` mid-`waitUntil` still loses the un-run tail of the
  pipeline (nothing client-side can capture that); fix 2 just makes the
  captured prefix committable, flagged truncated.
- Attribution of concurrent background work to distinct recordings is
  still the doc 01 async gap.
