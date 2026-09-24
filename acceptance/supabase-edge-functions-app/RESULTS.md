# Results: full-stack e2e — Supabase edge-functions example app (React) ↔ `select-from-table-with-auth-rls` (Deno)

- **Recorder under test:** branch `ci/oss-e2e`, based on `getappmap/appmap-react` `deno-waituntil-trace-agent` @ `1eab09b`.
  Recorder code (`recorder/`, `deno/`, `linker/`) is unchanged since `bef9d18`; this harness changes none of it.
- **Target:** `supabase/supabase` @ `74a3be9aa8706755e05f7326f3d25472729cd977`: `examples/edge-functions/app`
  (Create React App, React 18.3.1, supabase-js 2.117.1, @supabase/auth-ui-react 0.2.8; no lockfile at this
  commit, so these are what npm resolved) and `examples/edge-functions/supabase/functions/select-from-table-with-auth-rls`
  (Deno, `Deno.serve`, `jsr:@supabase/supabase-js@2`, locked by `deno.lock`).
- **Local stack:** PostgreSQL 16 (`initdb`), GoTrue `v2.177.0` and PostgREST `v12.2.12` release binaries, the
  example's own 3 migrations, a Kong stand-in (`infra/gateway.mjs`). Nothing deployed is called; the browser
  cannot resolve any non-local host.
- **Tools:** Node 22.22.2, Deno 2.9.7, Vite 6.4.3 (the recorder repo's own), official AppMap CLI `@appland/appmap`
  3.204.0, official validator `@appland/appmap-validate` 2.5.1, playwright-core 1.56.1 driving Chromium r1194.
- **One command:** `acceptance/supabase-edge-functions-app/run.sh`. It clones the app at the pinned SHA, installs
  it, starts the stack, runs every pass and check, and exits 1 if any check is not PASS. CI runs it on every push
  and PR (job `acceptance-supabase-edge-functions-app`). Evidence from the last clean run is in `evidence/`
  (`run.log`, one JSON per check, every recording).

`EXPECTATIONS.md` was committed on its own before any recording (commit `3d00c68`).

## The short version

**The end-to-end proof does not hold today.** With the recorder configured exactly as documented, the React app
does not render at all, so there is no click, no stamped request and no backend map to link. With a config-only
workaround the app renders and the frontend is recorded well, but the recorder's `traceparent` header makes the
browser block every call to the edge function (CORS), so the app's main feature stops working and there is still
nothing to link. Only when the app's CORS allow-list is also edited (the change upstream Supabase itself made
later) does the join work: browser `traceparent` → Deno map `parent_span_id` → `appmap-link` joins them. Even then
the stitched diagram shows neither the frontend handler nor the database call.

The Deno side, driven directly, records requests correctly (status, outbound GoTrue/PostgREST calls, trace ids),
is stable, and shows the one-line behaviour change exactly (H PASS). It does not record the app's handler (it is
an anonymous arrow), and under concurrency it records only one request and **stamps the other requests' outbound
calls with that one request's trace id**.

## Summary table

| Check | Result | Evidence (one line) |
|---|---|---|
| A. Setup | **FAIL** | Setup itself works from a clean clone (no app source edits). But the recorder has no Create React App/webpack integration, so the app had to be moved onto Vite (`app-config/cra-compat.mjs`), and with the plugin exactly as documented the app **does not render**: Vite returns 500 for the app's component files (`src/index.js: Unexpected token` at the first JSX, bug 1) and the injected `virtual:` import is refused by the browser (bug 2). |
| B. Validity | **FAIL** | Official validator: **0 of 23** maps valid at their declared `1.12` (`evidence/b-validate.json`). Frontend: `http_client_request` events lack the required `message` (bug 6). Backend: `metadata.language.version` missing (bug 6). The zero-touch pass produced 0 maps. |
| C. Ground truth | **FAIL** | Zero-touch frontend: 5 of 5 interaction maps missing (app did not render). Backend (direct requests): 12 found, 3 missing — the request handler (index.ts:10) is never a call event (bug 4). Workaround frontend (diagnostic): 8 found, 2 wrong (function call status 0 instead of 200: CORS, bug 3), 1 missing (a harness artefact, see C). |
| D. Noise | **FAIL** | Zero-touch: nothing to judge (0 call events). Diagnostic: the workaround pass recorded 23 call events, all in `src/App.js`, none from `node_modules`; the backend recorded no dependency code. |
| E. Exception | **FAIL** | Backend R3 (TypeError at index.ts:33, caught at :48): map present, status 400, no exception attached — correct. Frontend S2 (rejected `fetch`): no zero-touch map; the workaround map has the balanced pair with status 0. E is weak for this app (no exception escapes an app function). |
| F. Failing test | **FAIL (analog)** | Not applicable as specified (no test runner). Analog: the failing interaction S2 left no zero-touch map (it does in the workaround pass). |
| G. Stability | **NOT RUN** | Frontend zero-touch: nothing to compare. Backend R1–R3 run 1 vs run 2: 3/3 identical. Diagnostic workaround frontend S2–S6: 5/5 identical. |
| H. Change detection | **PASS** | `.select('*')` → `.select('id')` in the function. Before/after sequence diagrams differ in R1 and R2 only; R3 identical. Official `sequence-diagram-diff`: "changed HTTP client request `GET …/rest/v1/users?select=*` to … `select=id`", nothing else. |
| I. Concurrency | **FAIL** | 6 concurrent stamped requests → **1** backend map. That map holds 12 outbound calls (expected 2): 10 belong to the other 5 requests, and those calls went out **stamped with the first request's trace id** (bug 5). Browser zero-touch: app did not render. |
| J. Overhead | MEASURED | Browser S1–S6: 11.1 / 11.3 s without the recorders, 13.3 / 13.6 s with them (workaround config, +20%). 20 direct requests: 258 ms plain, 276 ms recorded (+7%). |
| **L. The cross-map link (headline)** | **FAIL** | Zero-touch: L1–L5 all fail (no app). Workaround: L1 ok (browser sends `traceparent`), L2–L5 fail — the browser blocks the call: "Request header field traceparent is not allowed by Access-Control-Allow-Headers in preflight response." With the app's CORS also patched (diagnostic): L1, L2, L3, L5 ok; L4 fails — the stitched diagram shows the click and the backend call, but not the handler and not the DB call (bug 7). |

## Details per check

### A. Setup

Commands (`run.sh` does all of these):

```
git clone (sparse) https://github.com/supabase/supabase && git checkout 74a3be9aa8706755e05f7326f3d25472729cd977
cd examples/edge-functions/app
npm install --legacy-peer-deps            # the documented `npm install` fails on npm >= 7 (ERESOLVE, @testing-library/react@12 wants react < 18)
npm install -D --legacy-peer-deps vite@6.4.3 file:<recorder-repo>/recorder
cp <acceptance>/app-config/*.mjs .        # Vite configs only
infra/stack.sh start                      # Postgres + GoTrue + PostgREST; the example's migrations, unmodified
node infra/gateway.mjs                    # :54321, the URL the app falls back to with no .env
node deno/bin/appmap-deno.ts --app select-from-table-with-auth-rls <function>/index.ts -- --lock=deno.lock
npx vite --config vite.config.appmap.mjs  # recorder plugin as documented: appmapVitePlugin({ include: ['src'], app })
node scripts/drive.mjs sequence           # real Chromium: S1-S6
```

- **App source edits: none.** `evidence/a-app-tree-changes.txt`: only `package.json` (the dev-dependency install)
  and the harness's four Vite config files are new or changed.
- **App changes needed (counts against the recorder):** the recorder integrates only with Vite, so the app's
  unmodified `src/` was moved off react-scripts onto Vite by `app-config/cra-compat.mjs` (serve
  `public/index.html` plus the `src/index.js` entry, JSX in `.js`, `process.env`). Without that there is no way to
  record this app at all.
- With the plugin exactly as documented (`vite.config.appmap.mjs`), the app does not render
  (`evidence/browser-Z.json`):
  - Vite: `Internal server error: src/index.js: Unexpected token, expected "," (9:8)` (in an earlier run the
    first file hit was `src/App.js (26:9)`; every `.js` file with JSX fails). The recorder's `pre`
    transform parses every selected file with Babel and enables the `jsx` parser plugin only for `.jsx`/`.tsx`
    (bug 1). Create React App puts JSX in `.js` files, so every component file fails to compile.
  - Browser: `Access to script at 'virtual:appmap-interaction-recorder' … blocked by CORS policy` — the injected
    zero-touch script uses a bare `virtual:` specifier (bug 2, the same as `acceptance/bulletproof-react` bug 2).
- EXPECTATIONS.md said the app would be served on :3000; the harness uses :3300 so it cannot collide with the
  bulletproof-react harness (which owns :3000) when both run on one machine. Nothing else depends on the port.

### B. Validity

`evidence/b-validate.json` — every map from every pass (zero-touch, workaround, CORS-patched, direct requests,
concurrency) through `@appland/appmap-validate` 2.5.1: **0 / 23 valid** at the declared 1.12, and none valid at any
version 1.2.0–1.13.1. The first blocking error per map:

- 16 frontend maps: `/events/N must have required property 'message'` on `http_client_request` (required from 1.5).
  `recorder/src/recording.ts:236-251` writes `request_method`, `url`, `headers` and nothing else.
- 7 backend maps: `/metadata/language must have required property 'version'`. `deno/appmap.ts:119` writes
  `{ name: 'typescript', engine: 'deno' }`.
- So the declared `1.12` is not honest for this recorder's output on either side.

### C. Ground truth (`evidence/c-ground-truth.json`)

**Zero-touch frontend (the verdict):** S2–S6 all **missing** — the app never rendered, so there was nothing to click.

**Backend, direct stamped requests (the Deno side is zero-touch already):** 12 found, 3 missing.

| Item | R1 (anon) | R2 (user) | R3 (no auth) |
|---|---|---|---|
| `trace_id` / `parent_span_id` from `traceparent` | found | found | found |
| `http_server_request POST /select-from-table-with-auth-rls` + status | found, 200 | found, 200 | found, 400 |
| call event for the handler (index.ts:10) | **missing** | **missing** | **missing** |
| outbound `GET /auth/v1/user` | found, 403 | found, 200 | — (none expected; none recorded) |
| outbound `GET /rest/v1/users?select=*` | found, 200 | found, 200 | — |
| response: the user + exactly one row, their own (RLS) | — | found | — |

R4 (preflight asking for `traceparent`): found — 200, `Access-Control-Allow-Headers: authorization, x-client-info, apikey, content-type`.
The handler is missing because the only app code is `Deno.serve(async (req) => { … })`: an arrow passed straight
to a call at statement level, which the transform does not instrument (bug 4). So the backend maps contain HTTP
envelopes and outbound calls but no app code at all.

**Workaround frontend (diagnostic only):** 8 found, 2 wrong, 1 missing.

- Found: `App.invokeFunction src/App.js:16` in S2, S3, S5; `App.App src/App.js:10` re-renders; `POST /auth/v1/signup → 200`
  (S4); `POST /auth/v1/logout?scope=global → 204` (S6); S2's rejected request recorded with status 0.
- Wrong: S3 and S5 `POST …/functions/v1/select-from-table-with-auth-rls` carries `traceparent` but has status **0**
  instead of 200 — the browser blocked it (bug 3).
- Missing: S6's `onClick` arrow (App.js:86). **This one is caused by the harness, not the recorder:** the
  workaround compiles JSX before the recorder's transform, so the recorder never sees the `onClick={…}` JSX
  attribute it wraps (`recorder/src/transform.ts:212-221`).
- Line numbers match the source (the workaround compiles JSX with Babel `retainLines`).
- Interaction scoping: S4 is one map named `click a "Don't have an account? Sign up"` that also contains the sign-up
  `POST` of the later "Sign up" button click, because Playwright filled the form and clicked within the window's
  250 ms idle period. That is the documented interaction-window behaviour, but the map's name is misleading.

### D. Noise (`evidence/d-noise.json`)

Zero-touch: 0 call events, so nothing to judge; **FAIL** by rule (a check with no evidence is not a pass).
Diagnostic: workaround frontend maps have 23 call events, all `src/App.js`; no supabase-js, auth-ui-react,
react-json-editor-ajrm or react-dom code. Backend maps have no call events from `jsr:`/`npm:` code.

### E. Exception

- Backend R3 (no `Authorization`): `TypeError` thrown at index.ts:33 and caught at :48 in the same function. The map
  shows status 400, no `exceptions`, balanced events. Correct.
- Frontend S2: no zero-touch map. In the workaround pass the rejected `fetch` is recorded as a balanced
  request/response with status 0, as `recorder/src/fetchPatch.ts:48-52` intends.
- E fails because the zero-touch frontend half has no recording. As pre-registered, E is weak for this app.

### F. Failing test

Not applicable as specified: no test runner is involved. The analog (an interaction that fails for the user still
leaves a recording) fails in the zero-touch pass (no maps) and holds in the workaround pass.

### G. Stability (`evidence/g-stability.json`)

- Frontend zero-touch: **NOT RUN**, no recordings.
- Backend R1–R3, two runs from a fresh database: normalized official sequence diagrams identical for 3/3.
- Diagnostic, workaround frontend S2–S6 across two runs: 5/5 identical.

### H. Change detection (`evidence/h-change.json`, `evidence/h-appmap-trace.txt`)

Scratch change (`app-config/h-change.patch`): index.ts:41 `.select('*')` → `.select('id')`. R1–R3 re-recorded.

- Normalized sequence diagrams: R1 and R2 differ, R3 identical — exactly as expected.
- Official `appmap sequence-diagram-diff`, R1 and R2: `changed HTTP client request GET http://127.0.0.1:54321/rest/v1/users?select=*
  to HTTP client request GET http://127.0.0.1:54321/rest/v1/users?select=id`. Nothing else.
- The repo's `appmap-trace --baseline` also shows the change (`+ GET /rest/v1/users?select=id`, `- … select=*`),
  but labels the handler `undefined.undefined`, calls the backend map "frontend", and reports "3 changed" for R1
  where one call changed (the unchanged `GET /auth/v1/user` is marked changed). Reported, not counted against H.

### I. Concurrency (`evidence/i-concurrency.json`, `evidence/i-backend.json`)

- **Backend:** 6 stamped requests sent at once (3 anonymous, 3 signed-in users). All 6 got HTTP 200. **1 map** was
  written. It holds **12** outbound calls instead of 2: 10 belong to the other five requests. On the wire, all 12
  outbound calls carried the first request's trace id, and 0 carried their own request's trace id. (The exact
  split varies with timing: an earlier run had 11 of 12.) The Deno
  driver records one request at a time (`deno/appmap.ts:111`, documented in doc 05), but the patched `fetch`
  records and stamps against whatever recording is active (`recorder/src/fetchPatch.ts:30-34`), so a request that
  is not being recorded has its outbound calls attributed to, and propagated as, a different request (bug 5).
  Any downstream tracer would join those calls to the wrong trace.
- **Browser, zero-touch:** app did not render.
- Diagnostic, CORS-patched pass with 3 users clicking at once: 3 frontend maps, each with exactly its own function
  request (separate browser contexts cannot leak into each other), but only **1** backend map (same cause).

### J. Overhead (`evidence/j-overhead.json`)

| | without recorders | with recorders |
|---|---|---|
| Browser S1–S6 wall time | 11.14 s, 11.32 s | 13.27 s, 13.63 s (workaround config; zero-touch broke the app) |
| 20 sequential direct R2 requests | 258 ms | 276 ms |

### L. The cross-map link (`evidence/l-link.json`)

| | L1 wire `traceparent` = map ids | L2 Deno map with matching `parent_span_id` | L3 `appmap-link` joins, 0 orphans | L4 diagram: click → handler → backend → DB | L5 app behaves as without recorder |
|---|---|---|---|---|---|
| Zero-touch (verdict) | FAIL | FAIL | FAIL | FAIL | FAIL |
| Workaround (diagnostic) | ok | FAIL | FAIL | FAIL | FAIL |
| Workaround + app CORS patched (diagnostic; an app change) | ok | ok | ok | FAIL | ok |

Same result for S3 and S5.

- Workaround pass, browser console: `Access to fetch at 'http://localhost:54321/functions/v1/select-from-table-with-auth-rls'
  from origin 'http://127.0.0.1:3300' has been blocked by CORS policy: Request header field traceparent is not
  allowed by Access-Control-Allow-Headers in preflight response.` The app shows `FunctionsFetchError: Failed to
  send a request to the Edge Function` and the response panel shows `null` where, without the recorder, it shows
  the user and their row. The recorder changes the app's behaviour (bug 3).
- CORS-patched pass (`app-config/p-cors-traceparent.patch`, adding `traceparent` to `_shared/cors.ts` as upstream
  did in fc5db9bb): the browser's `traceparent` span equals the Deno map's `parent_span_id`, trace ids match,
  `appmap-link` links it with 0 orphan backend maps, and the app's responses match the no-recorder run. The
  stitched diagram (`evidence/links-P-S5.puml`) is:

  ```
  User -> FE : click button "Invoke Function"
  FE -> BE0 : POST /functions/v1/select-from-table-with-auth-rls
  BE0 --> FE : 200
  ```

  No frontend handler (`invokeFunction` is in the frontend map, but the diagram renders no frontend events) and no
  DB step (the function's `GET /rest/v1/users?select=*` is in the backend map, but the diagram renders only
  `sql_query` and `defined_class` events) (bug 7).
- `appmap-link` also classifies the two backend maps as frontend maps (they contain `http_client_request` events):
  its summary reads `7 frontend map(s), 2 backend map(s): 2/9 requests linked` for 5 interactions and 2 requests.

## Recorder bugs found

Each reproduces with `acceptance/supabase-edge-functions-app/run.sh`; evidence file in brackets.

1. **JSX in `.js` files breaks the app.** `recorder/src/vitePlugin.ts:115` passes `jsx: /\.[jt]sx$/.test(id)`,
   and `recorder/src/transform.ts:106` enables Babel's `jsx` parser plugin only then. Any `.js` file with JSX (the
   Create React App convention; also common in Vite apps that set `esbuild.loader`) fails with `Unexpected token`,
   Vite serves a 500 and the app does not render. [`browser-Z.json`, `logs/vite-Z.log`]
2. **Zero-touch injection emits a bare `virtual:` import** that the browser refuses
   (`recorder/src/vitePlugin.ts:129-138`). Same as acceptance/bulletproof-react bug 2. [`browser-Z.json` console]
3. **`traceparent` stamping breaks cross-origin calls whose CORS policy does not list it**
   (`recorder/src/fetchPatch.ts:34` stamps every `fetch` while a window is open). The browser blocks the request,
   the app fails for the user, and no backend recording can exist. This is the normal case for a React app calling
   a Supabase edge function (or any API on another origin) that was written before trace propagation was
   considered. [`browser-W1.json`, `l-link.json`]
4. **The Deno transform does not instrument a handler passed directly to `Deno.serve`** — the canonical
   `Deno.serve(async (req) => …)` shape. Only function declarations, variable-bound functions and JSX `on*`
   attributes are wrapped (`recorder/src/transform.ts:172-221`). Backend maps contain no app code. [`c-ground-truth.json`]
5. **Concurrent requests on the Deno side: lost recordings and wrong trace propagation.** One recording at a time
   (`deno/appmap.ts:111`), but the global `fetch` patch records and stamps every outbound call against the active
   recording (`recorder/src/fetchPatch.ts:30-34`). 6 concurrent requests → 1 map containing 12 outbound calls, 10 of
   them from other requests, sent on the wire with the wrong trace id. [`i-backend.json`]
6. **Declared version 1.12 is not honest.** Frontend `http_client_request` has no `message`
   (`recorder/src/recording.ts:236-251`); backend `metadata.language` has no `version` (`deno/appmap.ts:119`).
   [`b-validate.json`]
7. **The stitched diagram cannot show handler → DB for this stack.** `linker/src/diagram.mjs:36-61` renders no
   frontend events, and on the backend only `sql_query` and `defined_class` events, so an edge function's database
   access through PostgREST (HTTP) never appears. `linker/src/link.mjs:20-22` also counts any backend map with
   outbound HTTP as a frontend map. [`links-P-S5.puml`, `l-link.json`]

Not counted against the recorder: the missing S6 `onClick` in the workaround pass (caused by the workaround).

## App changes needed

- No app source edits in the zero-touch pass.
- Toolchain: run on Vite instead of react-scripts (`app-config/cra-compat.mjs`), because the recorder only
  supports Vite. Counts against the recorder.
- Install flag: `npm install --legacy-peer-deps` (the app's own dependency tree, not the recorder).
- Diagnostic passes only, never used for a verdict: the workaround Vite config (`vite.config.appmap-workaround.mjs`,
  config only) and the CORS patch (`app-config/p-cors-traceparent.patch`, an app change).

## What could not be run or checked

- The app's real toolchain (react-scripts/webpack) with the recorder: there is no integration to run.
- The Supabase Edge Runtime itself: the function runs under `deno run` (as in acceptance/supabase-restful-tasks);
  doc 06 names the Edge Runtime as unsupported.
- Kong: `infra/gateway.mjs` emulates what the example needs (routing, Kong's `cors` plugin on `/auth/v1` and
  `/rest/v1`, functions passed through, `--no-verify-jwt`). A real Kong might answer the function's preflight
  differently; the Supabase docs say functions handle their own CORS, which is what the gateway does.
- SQL ground truth inside Postgres (the RLS `WHERE auth.uid() = id`): no agent runs there; checked only through
  the response (exactly one row, the caller's).
