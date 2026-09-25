# Expectations: full-stack e2e — Supabase's edge-functions example app (React) ↔ its `select-from-table-with-auth-rls` edge function (Deno)

Written from reading the app's source, and from running the app with no
recorder attached, **before any recording was made** (ACCEPTANCE-SPEC rule 4).
Not edited after the first recording. If something here turns out to be
wrong, RESULTS.md says so.

## Recorder under test

- Repo: evlawler/funwithappmapreact, branch `ci/oss-e2e`, based on
  `getappmap/appmap-react` branch `deno-waituntil-trace-agent` @ `1eab09b8753be9a2a5c9ad3220ad13f552373d40`.
  Recorder code (`recorder/`, `deno/`, `linker/`) last changed in `bef9d18c693c4873752539d8ca88c820ed98060d`.
  Tested as is: no recorder change is made by this harness.
- Frontend: `appmapVitePlugin` (`recorder/src/vitePlugin.ts`) with `app` set, which injects the
  zero-touch interaction recorder and serves the collector at `/__appmap/interactions` (docs 04, 07).
- Backend: `deno/bin/appmap-deno.ts` (zero-touch runner, doc 06) around the unmodified function file.
- Join: `linker/bin/appmap-link.mjs` (doc 02).

## The app, and why this one

- **App:** the "Supabase Edge Functions Test Client" in [supabase/supabase](https://github.com/supabase/supabase),
  `examples/edge-functions/app/` (React 18, Create React App), and the edge function it is written to
  exercise, `examples/edge-functions/supabase/functions/select-from-table-with-auth-rls/index.ts`
  (Deno, `Deno.serve`), with the project's own migrations `examples/edge-functions/supabase/migrations/*.sql`.
  License: Apache-2.0. Written and maintained by Supabase, not by us.
- **Pinned commit:** `74a3be9aa8706755e05f7326f3d25472729cd977` (2025-06-09). This is the same commit
  `acceptance/supabase-restful-tasks` pins, for the same reason: it is the last commit at which the
  example functions are plain `Deno.serve` **and** import the real client (`jsr:@supabase/supabase-js@2`).
  From 3c390c7 (2025-06-10) the functions import `npm:supabase-js@2`, a security placeholder package
  that cannot run; from d5fde192 (2026-06-26) they use `export default { fetch }` (the `deno serve`
  convention). The pin was chosen for that reason only, before any recording, not for how the
  recorder does on it.
- **Criteria (task 1) and how this app meets them:**
  1. Real, public, open-source, not built by us: yes (Supabase's official examples, Apache-2.0).
  2. Frontend is React: yes (`app/package.json`: react 18, react-scripts 5.0.0).
  3. Backend is Deno: yes, a Supabase Edge Function using `Deno.serve` (index.ts:10).
  4. Frontend actually calls the backend over HTTP: yes, `supabase.functions.invoke(supaFunction, …)`
     (App.js:18), which is a `fetch` to `<SUPABASE_URL>/functions/v1/<name>`. The dropdown lists
     `select-from-table-with-auth-rls` (functionsList.js:4) and the page heading is "Log in to see RLS
     in action" (App.js:80): signing in and invoking this function is the app's designed flow.
  5. Backend does real work: yes. It calls GoTrue (`auth.getUser`, index.ts:36-38) and queries the
     `users` table through PostgREST under the caller's JWT, so row-level security applies
     (index.ts:41; policy `auth.uid() = id`, migrations/20220331105910_init.sql:12).
- **Other candidates considered and rejected (real search, 2026-09-24):**
  - `denoland/react-vite-ts-template` (Deno's official React + Vite + Oak template): its API only
    returns a bundled JSON file. No DB, KV or outbound calls, so it fails criterion 5.
  - `runreal/deno-monorepo-template` (MIT; React/Vite + Hono/tRPC on Deno + Drizzle/Postgres): a
    starter kit, not an app. Its only DB endpoint (`getUsers`) is behind BetterAuth magic-link
    login, which needs an email provider (Resend). The only public endpoint does no DB work.
  - `NeaByteLab/IDX-UI` (MIT; React/Vite + Deno + SQLite): its data comes from a hard-coded
    `https://www.idx.co.id` origin (services/Client.ts:12) on startup and on a `Deno.cron`. Running
    it locally without calling that deployed service would mean faking the exchange's API.
  - `vincenzo-afk/ethos-wear` (React/Vite + Supabase edge function): proprietary license, and a
    hard-coded `https://<project>.supabase.co` URL.
  - Many personal/generated apps using `supabase.functions.invoke`: no license, or no way to run
    them locally without a deployed project.
- **Known weaknesses of this choice, stated in advance:**
  - The frontend is **Create React App** (webpack). The recorder integrates only with Vite. To
    record at all, the harness runs the app's unmodified `src/` under Vite with a harness-provided
    config (`app-config/cra-compat.mjs`) that does what react-scripts does for this app: serve
    `public/index.html` with the `src/index.js` entry, compile JSX inside `.js` files, and provide
    `process.env` (`NODE_ENV`, `PUBLIC_URL`, `REACT_APP_*`). This is a toolchain substitution, not an
    app edit, but it goes in RESULTS.md under "App changes needed" and counts against the recorder.
  - The app has **no tests of its own**. The "tests" here are real browser interactions (S1–S6)
    plus direct HTTP requests to the function (R1–R4). F ("a failing test still leaves a
    recording, marked failed") therefore has no test status to check; see F below.
  - The function's only code is one anonymous handler (index.ts:10). There are no named helper
    functions to find.
  - The function reaches the database through PostgREST over HTTP, so there is no SQL on the
    Deno side. "SQL tables touched" can only show up as the PostgREST URL (`/rest/v1/users?select=*`);
    the RLS filter (`auth.uid() = id`) runs inside Postgres, where no AppMap agent runs.
  - The app's `package.json` has no lockfile at this commit, so npm resolves current versions
    (supabase-js 2.117.1, @supabase/auth-ui-react 0.2.8, react 18.3.1 when this was written). Its
    documented `npm install` also fails on npm ≥ 7 (`@testing-library/react@12` peer-depends on
    react < 18); the harness installs with `--legacy-peer-deps` (an install flag, not an app change).

## Local stack (all on 127.0.0.1, nothing deployed)

What `supabase start` + `supabase functions serve` would give, built from the real parts:

| Piece | What runs | Notes |
|---|---|---|
| Postgres 16 | real `initdb`/`pg_ctl` | platform roles (`anon`, `authenticated`, `service_role`, `authenticator`), `auth` schema and default grants the supabase/postgres image sets up; then the example's 3 migrations, unmodified |
| Auth | real GoTrue (`supabase/auth` v2.177.0 release binary) | runs its own migrations; email sign-up auto-confirmed (no mail is sent) |
| REST | real PostgREST v12.2.12 | |
| Gateway (Kong stand-in) | `infra/gateway.mjs` on :54321 | `/auth/v1` and `/rest/v1` with Kong's `cors` plugin behaviour (preflight answered, requested headers reflected); `/functions/v1/<name>` passed through to the function, OPTIONS included, because edge functions handle their own CORS; unknown names → 404; JWT not verified (`--no-verify-jwt`, as the example README's local command says) |
| Function | `deno run` of the unmodified `index.ts` (plain), or `appmap-deno` around it (recorded) | env `SUPABASE_URL=http://127.0.0.1:54321`, `SUPABASE_ANON_KEY=<the CLI's well-known local anon key>` |
| Frontend | the app's unmodified `src/` under Vite on :3000 | no `.env`: `supabaseClient.js:4-6` falls back to `http://localhost:54321` and the CLI's well-known local anon key, which is why the stack uses the CLI's well-known JWT secret |
| Browser | real Chromium, driven by Playwright (`scripts/drive.mjs`) | external hosts unresolvable; no request interception (Playwright answers CORS preflights itself when routing is on, which would hide the behaviour under test) |

Observed with **no recorder** (this is how the expectations below were checked against the real app,
not guessed): S1–S6 all work; S3 returns `{"user": null, "data": []}`; S5 returns the signed-in user
and exactly one `users` row, the caller's own. The function's preflight response allows exactly
`authorization, x-client-info, apikey, content-type` (`_shared/cors.ts:3`).

## Browser interactions (S1–S6), one window each

A correct **frontend** recording per interaction (one AppMap per interaction window, collected by the
Vite plugin's collector) must contain:

- **S1. Load the app.** No click, so no interaction map is required. The page must render.
- **S2. Click "Invoke Function" with the default dropdown entry** (`functionsList[0]`, "local: Whatever
  function is currently served by the CLI", functionsList.js:2; App.js:12).
  - Call event: `invokeFunction` (App.js:16, arrow inside `App`), triggered from the button's
    `onClick` (App.js:70). Its `setResponseJson` causes `App` (App.js:10) to re-render: `App` call event(s).
  - `http_client_request` `POST http://localhost:54321/functions/v1/local:%20Whatever%20function%20is%20currently%20served%20by%20the%20CLI`
    (supabase-js URL-encodes the name). Without a recorder the browser gets a 404 from the gateway
    with no CORS headers and `fetch` rejects (`FunctionsFetchError`, shown with `alert`, App.js:21).
    The recording must pair the request with a response; for a rejected `fetch` the recorder's own
    contract is status `0` (recorder/src/fetchPatch.ts:48-52).
  - No backend map (the function is not called).
- **S3. Select `select-from-table-with-auth-rls`, click "Invoke Function", signed out.**
  - Call event: `invokeFunction` (App.js:16); `App` re-render(s). The `<select>` `onChange` arrow
    (App.js:48) runs on `change`, which does not open a window (the recorder's triggers are `click`
    and `submit`, interactionRecording.ts:38), so it is not required in any map.
  - `http_client_request` `POST http://localhost:54321/functions/v1/select-from-table-with-auth-rls`,
    headers include `traceparent` (00-<recording trace_id>-<fresh span>-01), `content-type`.
    Response status **200**, same as without the recorder.
  - The app must behave as without the recorder: the response panel shows `{"user": null, "data": []}`.
- **S4. Sign up** (auth-ui-react's "Don't have an account? Sign up", email + password, "Sign up").
  - `http_client_request` `POST http://localhost:54321/auth/v1/signup` → **200**. auth-ui-react and
    supabase-js live in `node_modules` and must **not** appear as call events (D).
  - `App` re-renders when the session arrives (`Auth.useUser`, App.js:11 → "Logged in as …", App.js:83).
  - No backend map (GoTrue is not recorded; it is not part of the app).
- **S5. Click "Invoke Function", signed in.** The headline interaction.
  - Frontend: `invokeFunction` (App.js:16); `POST …/functions/v1/select-from-table-with-auth-rls`
    with `traceparent`; response **200**. The response panel shows the user and exactly one `users`
    row whose `id` is the user's id (RLS), as without the recorder.
  - Backend: see R2 (same request, recorded by the Deno side).
- **S6. Click "Sign out".** Call event for the anonymous `onClick` arrow (App.js:86);
  `http_client_request` `POST http://localhost:54321/auth/v1/logout?scope=global` → 204. No backend map.

## Backend requests (R1–R4), one Deno AppMap each

A correct **backend** recording (one AppMap per `traceparent`-carrying request, doc 05) must contain:

- `metadata.trace_id` / `metadata.parent_span_id` copied from the incoming `traceparent`.
- `http_server_request` with `request_method` and `path_info` `/select-from-table-with-auth-rls`
  (the gateway strips `/functions/v1`), and the `http_server_response` status below.
- A call event for the request handler, the anonymous arrow at index.ts:10 (any name the recorder
  gives an anonymous function; path `…/select-from-table-with-auth-rls/index.ts`, lineno 10). It is the
  app's only function; if it is not recorded the backend map has no app code in it at all.
- The outbound `http_client_request`/`response` pairs below (supabase-js resolves the global `fetch`
  at call time, so the recorder's patched `fetch` sees them), each carrying `traceparent` with the
  same trace id. Outbound calls go to `http://127.0.0.1:54321` (`SUPABASE_URL`).
- No call events from `jsr:@supabase/supabase-js` or other dependencies (D).

| Id | Request (made how) | Expected status | Expected outbound calls, in order | Source |
|---|---|---|---|---|
| R1 | `POST` with `Authorization: Bearer <anon key>` (= S3) | 200, body `{"user":null,"data":[]}` | `GET /auth/v1/user` → **403** (anon key has no `sub`); `GET /rest/v1/users?select=*` → **200** (`[]`: RLS, `auth.uid()` is null) | index.ts:27, 33, 38, 41; init.sql:12 |
| R2 | `POST` with `Authorization: Bearer <user access token>` (= S5) | 200, body has the user and exactly 1 row (theirs) | `GET /auth/v1/user` → **200**; `GET /rest/v1/users?select=*` → **200** (1 row) | index.ts:33-44; init.sql:12, 18-27 (trigger created the row at sign-up) |
| R3 | `POST` with **no** `Authorization` header (direct request) | **400**, body `{"error":"Cannot read properties of null (reading 'replace')"}` | none: `req.headers.get('Authorization')` is null, `.replace` throws a `TypeError` at index.ts:33 before any outbound call; caught at index.ts:48 | index.ts:27, 33, 48-52 |
| R4 | `OPTIONS` preflight with `Access-Control-Request-Headers` including `traceparent` | **200**, body `ok`, `Access-Control-Allow-Headers: authorization, x-client-info, apikey, content-type` — **not** including `traceparent` | none | index.ts:12-14; _shared/cors.ts:1-4 |

R1 and R2 are made twice each: once by the real browser (S3, S5) and once directly by the harness
with a fixed `traceparent`, so backend checks do not depend on the browser leg.

## The cross-map link (the headline; task 2)

For S5 (and S3), all of these must hold, in the **zero-touch** configuration:

- **L1.** The `POST …/functions/v1/select-from-table-with-auth-rls` that the browser actually sends
  (Playwright's view of the wire, not the recording) carries `traceparent`; its trace id equals the
  frontend map's `metadata.trace_id`, and its span id equals the one on the map's `http_client_request`.
- **L2.** A Deno backend map exists whose `metadata.parent_span_id` equals that span id and whose
  `metadata.trace_id` equals the frontend trace id.
- **L3.** `appmap-link <frontend dir> <backend dir>` links that request to that backend map, with
  0 orphan backend maps. Requests to GoTrue (S4, S6) are expected to stay unlinked (no backend agent).
- **L4.** The stitched diagram for the interaction shows all four of: the **click**
  (`User -> FE : click button "Invoke Function"` or equivalent), the frontend **handler**
  (`invokeFunction`), the **backend** request (`FE -> <function> : POST /functions/v1/select-from-table-with-auth-rls`
  returning 200), and the **DB** access (the function's `GET /rest/v1/users?select=*`).
- **L5.** The app behaves the same with the recorder as without it (S2–S6 responses and UI).

**Prediction written before running** (from reading the code, not a result): L1 and L5 are at risk.
The recorder stamps `traceparent` on every `fetch` during an interaction (fetchPatch.ts:34). Here the
function runs on a different origin (:54321 vs :3000), so the browser preflights, and the function's
own CORS allow-list does not include `traceparent` (R4). If that happens, the browser blocks the call,
the app shows an error instead of the data, and no backend map can exist. Upstream Supabase later
added `traceparent` to that allow-list (fc5db9bb, 2026-08-11), which is evidence that this is a real
condition for deployed functions, not a harness artefact. A second, separate risk: the recorder's
Babel parser enables JSX only for `.jsx`/`.tsx` files (recorder/src/transform.ts:106), and CRA puts
JSX in `.js` files.

## Checks A–J for this app

- **A. Setup.** One command from a clean clone at the pinned SHA. App changes needed: expected none in
  app source; the Vite substitution above is listed.
- **B. Validity.** Every frontend and backend map through the official validator
  (`@appland/appmap-validate`) at its declared version, and per spec version.
- **C. Ground truth.** Every item above (S2–S6 frontend, R1–R4 backend): found / missing / wrong, quoting the event.
- **D. Noise.** Frontend: no call events from `node_modules` (supabase-js, auth-ui-react,
  react-json-editor-ajrm, react-dom). Backend: no call events from `jsr:`/`npm:` dependencies. Count by path.
- **E. Exception.** The app has no path where an exception escapes an app function: the function's
  only throw (R3, index.ts:33) is caught in the same function (index.ts:48). So a correct backend map
  for R3 shows status 400 and **no** `exceptions` on the handler's return (an exception there would
  be wrong). On the frontend, a `fetch` that rejects (S2) must still leave a balanced
  request/response pair (status 0). E passes if both hold. This E is weaker than intended for this app.
- **F. Failing test.** Not applicable as specified: no test runner is involved, so there is no test
  status to mark. The closest analog is checked instead: an interaction that fails for the user (S2,
  error alert) still leaves a frontend recording. Reported as "F (analog)".
- **G. Stability.** The S-sequence (frontend maps) and the direct R1–R3 requests (backend maps)
  are recorded twice, from a fresh database each time. Normalized `appmap sequence-diagram --format json`
  must be identical per interaction/request (ids, timestamps, user ids, emails and tokens don't count).
- **H. Change detection.** On a scratch branch, one behaviour change in the function:
  `.from('users').select('*')` → `.select('id')` (index.ts:41). Re-record R1–R3. The diff must show,
  in R1 and R2 only, the outbound call changing to `GET /rest/v1/users?select=id`, and nothing else;
  R3 must be unchanged (it throws before the query).
- **I. Concurrency.** (a) Backend: 6 stamped requests sent concurrently (3 × R1-style, 3 × R2-style,
  3 different users). Each must yield exactly one backend map, containing only its own request
  (`parent_span_id` = its span) and only its own 2 outbound calls. (b) Browser: 3 users in separate
  browser contexts click "Invoke Function" at the same moment; each frontend map must contain only
  its own request.
- **J. Overhead.** Wall time of the S-sequence and of 20 direct R2 requests, with and without the
  recorders (both sides).
