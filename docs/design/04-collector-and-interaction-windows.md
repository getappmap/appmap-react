# 4. Collector and interaction-window capture

Status: **implemented; browser validation pending.** The window state
machine and the collector are both proven by automated spikes —
the window against real DOM events in jsdom
([`examples/petclinic-react/test/interactionRecorder.test.tsx`](../../examples/petclinic-react/test/interactionRecorder.test.tsx)),
the collector over real HTTP against the example's real dev server
([`examples/petclinic-react/test/collector.test.ts`](../../examples/petclinic-react/test/collector.test.ts)).
What no automated spike here covers yet is the combination running in
an actual browser; the manual procedure is at the end, and this doc
should get an amendment when it's been done.

## Recording unit: the interaction window

Doc 01 made the decision; this doc implements it. A window
([`recorder/src/interactionRecording.ts`](../../recorder/src/interactionRecording.ts)):

- **opens** on a trigger DOM event (`click`, `submit` — capture phase,
  so the recording starts before any handler runs). If a recording is
  already open, the trigger is absorbed into it — that's
  interaction-window scoping, and it also makes the recorder a no-op
  during test recording.
- **stays open** while the recording is active: every Enter/Exit and
  every stamped fetch lands in it.
- **closes** when an idle check passes — no new events for a full
  `idleMs` interval **and** no `http_client_request` still awaiting
  its response — or at a hard `maxMs` cap. The pending-request check
  matters: a slow fetch produces no events while in flight, and
  without it the window would close before the response and the
  re-render it causes.

The microtask-drain idea from the handoff reduces, in practice, to
this idle check: with no native hook for "queue drained" available to
page script, "no recorded activity for one interval" is the observable
proxy.

## Shipping: the collector

Browsers can't write `tmp/appmap/`. The Vite plugin's dev server
doubles as the receiver (the remote-recording protocol with roles
reversed): the in-page recorder POSTs each finished map to
`/__appmap/interactions`, and the middleware (in
[`recorder/src/vitePlugin.ts`](../../recorder/src/vitePlugin.ts))
writes `tmp/appmap/interactions/<name>_<seq>.appmap.json` under the
project root. The POST happens after `stopRecording()` has unpatched
fetch, so shipping is never itself recorded or stamped. Same-origin
(the dev server serves the page), so no CORS surface.

## What the spikes proved

The jsdom spike drives a real click through the real app (MSW
backend): the window opens at the click, sweeps in the hand-wrapped
`search` handler, the auto-instrumented `findOwners` and component
re-renders, holds open across the fetch, idle-closes, and ships one
AppMap whose fetch is traceparent-stamped against the map's own
`trace_id` — interaction maps are linkable (doc 02) with zero extra
work, which was the point of putting the stamp in the fetch choke
point.

The collector spike boots the example's actual `vite.config.ts` via
`createServer()` and exercises the middleware over HTTP: 204 + file
written for a valid map, 405 for non-POST, 400 for unparseable bodies.

In the example app the recorder installs only in dev
(`import.meta.env.DEV` in `main.tsx`); the production-bundle check
from doc 03 still passes — the dead branch and everything it imports
tree-shake away.

## Known limitations (accepted for the spike)

- Late completions: a fetch that outlives `maxMs`, or activity after
  idle-close, is lost or lands in the next window. Doc 01 names the
  refinement path (transform-injected continuation passing).
- Trigger set is `click`/`submit` only; route navigations and keyboard
  interactions are future units.
- One window at a time by construction; rapid-fire clicking merges
  into the open window rather than erroring.

## Manual browser validation (the remaining step)

This environment cannot download a browser (network policy), so run
locally:

```bash
# terminal 1: the Go backend
cd FunwithAppMapandClaudeGolang/examples/PetClinicGo && go run .

# terminal 2: this repo
npm run dev --workspace examples/petclinic-react
```

Open the printed URL, click around (find owners, open an owner,
add an owner with a missing field), then:

```bash
ls examples/petclinic-react/tmp/appmap/interactions/
```

Expect one map per interaction, named after the trigger (e.g.
`click_button_Find_Owner_001.appmap.json`); the dev-server log prints
each write. Record findings — especially idle-timing behavior against
the real backend's latency — as a dated amendment here.
