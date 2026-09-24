# appmap-react

An [AppMap](https://appmap.io) agent for React (browser) apps and Deno
edge functions, sharing one recorder core. Together they record
[AppMap v1.12](https://github.com/getappmap/appmap) JSON from component
renders, hooks, event handlers, `fetch` calls, and `Deno.serve`
requests — and the headline goal is **full-stack linking**:
correlating frontend AppMaps with backend AppMaps via W3C Trace
Context, so a user interaction can be followed from click to SQL. This
is a join AppMap itself has no concept of: each runtime's recorder
only ever produces its own isolated trace, so `linker/` exists
specifically to stitch a browser interaction to the backend request(s)
it caused.

Alpha. Started as the third in a family of AppMap agent prototypes,
all owned by evlawler:

| Repo | Runtime | Approach |
|---|---|---|
| `Fun-with-Appmap-and-Claude-` | .NET | Harmony runtime instrumentation, ASP.NET Core middleware |
| `FunwithAppMapandClaudeGolang` | Go | toolexec build-time rewriting, `context.Context` sessions |
| this repo | React (browser) + Deno | build-time injection (Vite plugin / Babel transform), zero-touch recording on both sides |

The React and Go agents use the same PetClinic domain, so a stitched
sequence diagram can span both. The full design brief for that
earlier work is in [`docs/HANDOFF.md`](docs/HANDOFF.md); everything
specific to this repo is in `docs/design/`.

## Status

Eleven design docs, listed below with what each one proved. Highlights:
full-stack linking (doc 02) now has a real end-to-end test with no
external dependency (doc 09), and both runtimes record with zero
application-code changes (docs 06 and 07). Interaction-window capture
is still pending a manual real-browser run (doc 04).

- [`recorder/`](recorder) — the recorder core (Enter/Exit + CallToken
  contract, value capture with size caps, `fetch` →
  `http_client_request`/`response` events with `traceparent` stamping,
  AppMap v1.12 serializer), Vitest per-test recording hooks
  (`./vitest`), and the Vite plugin (`./vite`) that auto-instruments
  top-level functions in configured paths — dev/test only, with
  components and hooks labeled by naming convention.
- [`examples/petclinic-react/`](examples/petclinic-react) — Vite +
  React + TypeScript frontend for the PetClinicGo backend (sibling
  repo), auto-instrumented by the plugin (plus two hand-wrapped nested
  handlers), with RTL tests under Vitest/jsdom and MSW. Running the
  tests writes one AppMap per test. `main.tsx` calls nothing
  appmap-related — interaction recording is zero-touch (doc 07).
- [`linker/`](linker) — `appmap-link`: joins frontend interaction maps
  to backend request maps via W3C Trace Context (`traceparent`) ids,
  emitting `appmap-links.json` and a stitched PlantUML sequence
  diagram per interaction (click → component → fetch → handler →
  SQL). A clearly-marked simulator can synthesize backend maps, and a
  **real end-to-end integration test** boots the actual PetClinicGo
  server (with its new AppMap middleware) and asserts the stitch on
  real maps — it runs automatically when the Go toolchain and the Go
  sibling repo are present (`PETCLINIC_GO_DIR` to point elsewhere),
  and skips itself otherwise. See the doc 02 amendment.
- [`deno/`](deno) — `withAppMap`, a per-request session driver for
  `Deno.serve` / Supabase edge functions: reuses the same recorder
  core and the same build-time transform (unchanged), adding only a
  traceparent-gated request wrapper and a file-or-collector shipper.
  [`examples/deno-edge`](examples/deno-edge) is the runnable spike —
  a real `deno run` process, instrumented and recorded end to end,
  skipped automatically where no Deno binary is present. See
  [doc 05](docs/design/05-deno-edge-functions.md).
- [`deno/bin/appmap-deno.ts`](deno/bin/appmap-deno.ts) — a zero-touch
  runner (`appmap-deno -- deno run -A entry.ts`'s Deno twin) that
  transforms and runs an entry file with no source edits at all, via
  `deno run --preload`. Covers plain `deno run` / self-hosted Deno;
  **not** Supabase Edge Functions, which expose no equivalent hook —
  that gap is named, not silently missing. See
  [doc 06](docs/design/06-zero-touch-deno.md).
  Work a handler hands to `EdgeRuntime.waitUntil` (runs after the
  response is sent) is recorded too, and a recording cut off mid-write
  is repaired rather than lost. See
  [doc 11](docs/design/11-waituntil-background-work.md).
- [`linker/bin/appmap-trace.mjs`](linker/bin/appmap-trace.mjs) — the
  tracing agent: shows each interaction as an ASCII call tree and a
  mermaid sequence diagram, and with `--baseline <dir>` shows a
  behavior diff (added, removed and changed steps) against an earlier
  set of recordings. Label-aware, no dependencies. See
  [doc 10](docs/design/10-behavior-diff-tracing-agent.md).

## Quickstart

```bash
npm install
npm test
ls examples/petclinic-react/tmp/appmap/tests/   # one .appmap.json per test

npm run link:demo                               # tests + simulate backend + link
ls examples/petclinic-react/tmp/appmap/links/   # appmap-links.json + .puml diagrams

npm test --workspace examples/deno-edge         # real deno run, if deno is on PATH
                                                 # (this also runs the real React <-> Deno
                                                 # e2e test in examples/petclinic-react, doc 09)

# tracing agent: ASCII + mermaid per interaction (add --baseline <dir> to diff)
node linker/bin/appmap-trace.mjs examples/petclinic-react/tmp/appmap
```

To run the example app against a live PetClinicGo backend
(`FunwithAppMapandClaudeGolang/examples/PetClinicGo` on :8080):

```bash
npm run dev --workspace examples/petclinic-react
```

## Design docs

Working convention (carried over from the Go repo): every design
decision gets a doc in `docs/design/NN-*.md` plus a runnable spike
that proves it against the example app; amendments are dated sections,
not history rewrites.

- [01 — recording sessions and interaction windows](docs/design/01-recording-sessions-and-interaction-windows.md)
  (the async-gap decision; spiked by the recorder + RTL test recording)
- [02 — cross-map correlation via `traceparent`](docs/design/02-cross-map-correlation-via-traceparent.md)
  (the linking centerpiece; spiked by the stamping + `appmap-link` +
  the simulated PetClinicGo backend)
- [03 — build-time instrumentation](docs/design/03-build-time-instrumentation.md)
  (the Vite plugin transform; spiked by converting the example app off
  hand-instrumentation)
- [04 — collector and interaction windows](docs/design/04-collector-and-interaction-windows.md)
  (window state machine spiked in jsdom, collector spiked over real
  HTTP; manual real-browser validation pending)
- [05 — Deno edge functions](docs/design/05-deno-edge-functions.md)
  (the backend half doc 03's amendment predicted; spiked by a real
  `deno run` process in `examples/deno-edge`)
- [06 — zero-touch recording for Deno](docs/design/06-zero-touch-deno.md)
  (`--preload`-based auto-injection, prompted directly by a getappmap
  maintainer's review on a sibling agent's PR; documents the Supabase
  Edge Runtime gap explicitly rather than leaving it implicit)
- [07 — zero-touch interaction recording for React](docs/design/07-zero-touch-react.md)
  (the same standard applied to the frontend: `main.tsx` no longer
  calls `installInteractionRecorder` itself; the 2026-09-24 amendment
  fixes the injected import so a real browser actually loads it, proven
  with a real dev server and headless Chromium)
- [08 — labels: comment tags and built-in patterns](docs/design/08-labels.md)
  (`@label` comments, no import required; automatic
  `security.authentication` / `io.sql` / `security.crypto` labels for
  Supabase, Web Crypto, bcrypt/argon2/scrypt, and JWT calls)
- [09 — real end-to-end test: React ↔ real Deno backend](docs/design/09-real-e2e-deno.md)
  (no sibling repo needed, unlike the Go e2e test — real appmap-deno
  process, real fetch, real appmap-link, on every checkout with `deno`)
- [10 — behavior-diff tracing agent](docs/design/10-behavior-diff-tracing-agent.md)
  (ASCII + mermaid views and a computed behavior diff; spiked by
  `appmap-trace` over the example recordings, checked against the real
  mermaid parser)
- [11 — recording background work (`EdgeRuntime.waitUntil`)](docs/design/11-waituntil-background-work.md)
  (found by the first real edge function the Deno driver met; also
  repairs recordings cut off mid-write)
