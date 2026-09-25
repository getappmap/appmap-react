# Results: React recorder on bulletproof-react (apps/react-vite)

- **Recorder under test:** `upstream-pr/deno-waituntil-trace-agent` @ `bef9d18c693c4873752539d8ca88c820ed98060d` (unchanged).
- **Target:** `alan2207/bulletproof-react` @ `9506629ed003a561c6627735480cce4994244bb4`, app `apps/react-vite`. It is a Vite 5.2.11 + React 18.3.1 app, tested with Vitest 2.1.4, React Testing Library and MSW 2.2.14, and its HTTP client is axios 1.6.8. The suite has 21 tests in 12 files.
- **Tools:**
  - Node 22.22.2 and yarn 1.22.22.
  - Official AppMap CLI `@appland/appmap` 3.204.0 (the latest at run time).
  - Official validator `@appland/appmap-validate` 2.5.1 (getappmap/appmap-js `packages/validate`).
  - Spec: `getappmap/appmap` @ `fa68b13`.
  - Playwright 1.59.1, driving Chromium r1194 from `/opt/pw-browsers` via `executablePath`. Playwright's own r1217 is not installed, and `playwright install` was not run.
- **One command:** `acceptance/bulletproof-react/run.sh [WORK_DIR]`. It clones the app at the pinned SHA, installs, runs every check and exits 1 if any check fails. Evidence from the final clean-clone run is in `evidence/`: the reports plus every recording (tests run 1, the extra tests, the browser interactions, and the run 1 sequence diagrams).

EXPECTATIONS.md was committed on its own, before any recording (commit `2b897ae`).

## Update: `integration/pr1` — the fixes merged (read this first)

Branch `integration/pr1` merges `fix/recorder-worst-bugs` into `ci/oss-e2e` and adds further fixes. This
section is the current result; the rest of this file is the original run against the unfixed recorder
(`bef9d18`), kept as the record of what it found. `evidence/` holds that original run; a current run writes
its evidence to `WORK_DIR/out` (CI uploads it as an artifact).

Run: fresh clone of `integration/pr1`, `CI=true`, `npm ci`, then `acceptance/bulletproof-react/run.sh`, on
localhost in a private network namespace (the harness needs ports 3000 and 8080). Same app SHA and tools as
below. "Merged, old checks" is an earlier run of the merged code (with the harness config change, check
change 2) before the other check changes.

| Check | Before (unfixed) | Merged, old checks | After | One line (after) |
|---|---|---|---|---|
| A. Setup | FAIL | PASS | **PASS** | the documented `@funwithappmap/react-recorder/vite` import loads; no app changes. |
| B. Validity | FAIL (0/29) | PASS | **PASS** | 30/30 valid at 1.12 (and 1.6.0–1.13.1). |
| C. Ground truth | FAIL (94 found / 1 wrong / 33 missing) | FAIL (117 / 6 / 5) | **FAIL** (127 found / 1 wrong) | Every HTTP call, `checkAccess`, `toggle`/`open`/`close` and T2's `teamName` are found. The one miss: T6's last `GET /discussions?page=1`, see below. |
| D. Noise | FAIL | PASS | **PASS** | 1311 call events; none from test files, `src/testing` or `node_modules`. |
| E. Exception | PASS | PASS | **PASS** | `useAuthorization` return: `Error: User does not exist!` (with `object_id`). |
| F. Failing test | PASS | PASS | **PASS** | `test_status: "failed"`, `Head` call present. |
| G. Stability | PASS | FAIL | **PASS** | 21/21 identical (random mock-backend ids normalized, rule (d)). |
| H. Change detection | FAIL | FAIL | **PASS** | appmap-trace shows the change (`page` dropped from `GET /comments`) in exactly the three comment-loading tests and nothing else, once the mock backend's random ids are normalized (check change 7). |
| I. Concurrency | FAIL | FAIL | **FAIL** | Vitest isolation: 21/21 identical (PASS). Browser, two clicks 20 ms apart: one window, now marked `ambiguous` and naming both clicks, but still one map (FAIL, known limitation). |
| J. Overhead | MEASURED (+7%) | MEASURED | MEASURED | median 10.9 s without, 11.8 s with (+9%, local CI run sharing the machine); an earlier run: 11.3 → 11.8 s (+5%). |
| Browser | FAIL (0 maps zero-touch) | FAIL | **FAIL** | B1–B4: every expected function and request found, one map each; 6/6 requests on the wire carry `traceparent` (the page load included). B5: see I. |

The recorder no longer changes the app's behaviour: all 21 tests pass with it (before: `discussions.test.tsx`
failed 3/3 under the recorder).

**Remaining failures, and why:**

- **C, T6** — the test's last step deletes a discussion and ends when "Discussion Deleted" appears. The
  delete's `onSuccess` starts a refetch (`getDiscussions`, recorded, its return still pending at the end:
  `truncated: true`) whose `GET /discussions?page=1` answer arrives after the test has finished, so no
  per-test recording can hold that `→ 200`. The request itself is missing too, which is a recorder
  limitation: under MSW's XHR interceptor the request is only observable when the mocked response starts
  (MSW fires `loadstart` then, and intercepts `send()` itself), so a request still waiting when the
  recording closes leaves nothing. Not fixed: seeing it would mean wrapping the app's XHR object in a
  proxy, which risks breaking apps. Left failing.
- **I (browser) and Browser B5** — the browser has no async context, so two clicks 20 ms apart share one
  interaction window. The map is now marked `ambiguous: true` with both clicks in
  `metadata.interactions` instead of being silently named after the first, but the check requires two
  separate maps. Known limitation.
- **Page-load requests**: now recorded, in a `load <path>` window opened by the zero-touch injection
  (0fdc935).

**Bugs listed below, now:** 1 (package entry points) fixed (49fee5c); 2 (zero-touch injection) fixed
(32157ad); 3 (observer effect) fixed (6c8680c); 4 (XHR invisible) fixed (753a208); 5 (`React.useCallback`)
fixed (cfcffce); 6 (not valid 1.12) fixed (4893004); 7 (thread nesting) fixed (4893004); 8 (test files
recorded, `exclude` prefix-only) fixed (aca9d44: globs, test files excluded by default); 9 (function props
vanish) fixed (6c8680c: `[function name]`); 9b (React dev-mode probe calls recorded as calls throwing
TypeError): still there, in the E recording only (`Authorization` and `AppProvider` called with no props by
React's dev-mode component-stack probing, which catches the error). Not changed: those calls really run; the
recorder records what runs, and telling React's probe apart from app calls would mean guessing.

### Check changes

Each is its own commit; the message quotes the old and new rule. EXPECTATIONS.md is unchanged.

1. **URLs are `url` + `message`** (c658fa2, rule (a), AppMap spec): C and the browser check match URL
   patterns against `url` plus the event's `message` parameters.
2. **Config: the documented plugin import, and the API origin listed** (b9ec2bd, the user's requested
   behaviour): `vite.config.appmap.ts` imports `@funwithappmap/react-recorder/vite` and sets
   `propagateTraceHeaderOrigins` to the origin of `VITE_APP_API_URL`. The recorder stamps cross-origin
   requests only for listed origins, and EXPECTATIONS.md requires `traceparent` on every request; this app's
   API is cross-origin in both modes. No check logic changed.
3. **A field name may be found in parameter `properties`** (0369b02, AppMap spec): values are capped at 100
   characters (schema 1.6+), so T2's `teamName` cannot be in the value; the recorder now writes the spec's
   parameter `properties` for plain objects (f652594), and the check accepts an exact field name there.
4. **checkAccess's line: expectation wrong** (4e509ac): EXPECTATIONS.md says line 35
   (`const checkAccess = React.useCallback(`); the function, the arrow, starts on line 36. The check now
   requires 36 and says "expectation wrong" in its evidence.
5. **Random mock-backend ids normalized in G and I only** (1c623ba, rule (d)): regex
   `(https://api\.bulletproofapp\.com/(?:discussions|comments)/)(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{21})(?=$|[/?\s])`
   → `\1<id>`, and the official tool's `digest`/`subtreeDigest` (hashes over those URLs) left out, in those
   two comparisons only.
6. **H requires the query change in the trace diff** (f7c7411, rule (f)): the official diagrams cannot
   show a query-only change (the query is in `message`); they are reported. H requires appmap-trace to show
   each `…&page=1` → without `page` in the three comment-loading tests, and nothing else changed anywhere.

7. **H ignores the mock backend's random ids** (4965306, rule (d) extended to H): the before and after
   runs name the same created discussion/comment by different random ids, which is run-to-run noise like a
   timestamp. With the same regex as G and I, a `- X` / `+ X` pair that is identical once the ids are
   normalized is the same step. Anything else marked still fails H (checked: turning one GET into a POST in
   the saved trace output makes H fail).

In CI this suite runs through `acceptance/known-failures.mjs`: every verdict must match
`KNOWN_FAILURES.json` exactly (C, I and Browser are listed as known failures, with C's evidence line), and
a known failure that starts passing also fails the job. Local CI run of 7877d44 on Node 22: every verdict
matches.

Reporting only: B5's evidence shows the `ambiguous` flag (a619051). Setup only: `run.sh` builds the
recorder before installing it (2cc967c); shellcheck cleanups (0ddada4).

## Summary table

| Check | Result | Evidence (one line) |
|---|---|---|
| A. Setup | **FAIL** | The documented plugin import `@funwithappmap/react-recorder/vite` cannot be loaded by the app's Vite config (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, `evidence/a-pkgimport.log`). Recordings needed a relative import into `node_modules`. No app source changes were needed. |
| B. Validity | **FAIL** | Official validator: **0 of 29 recordings valid** at the declared 1.12, and 0 at every version from 1.2 to 1.13.1. 24 fail on `metadata.frameworks[0]` missing required `version`; the 5 browser maps fail on values over 100 chars (`evidence/b-validate.json`). |
| C. Ground truth | **FAIL** | 94 found, 1 wrong, 33 missing (`evidence/c-ground-truth.json`). All 25 expected HTTP calls are missing (axios uses XHR; the recorder only patches `fetch`). All 8 expected `React.useCallback` callbacks are missing. |
| D. Noise | **FAIL** | No `node_modules` or `src/testing` code is recorded. But functions defined in the app's own test files are: `renderDiscussion` (discussion.test.tsx:13), `TestDialog` (dialog.test.tsx:20) and `TestDrawer` (drawer.test.tsx:19). `exclude` only takes directory prefixes, so it can't express `**/__tests__/**` (`evidence/d-noise.json`). |
| E. Exception | **PASS** | `useAuthorization` return: `exceptions:[{"class":"Error","message":"User does not exist!"}]`, recorded 4×. The exception object lacks the `object_id` the spec requires (see B). |
| F. Failing test | **PASS** | `F_deliberately_failing_copy...appmap.json`: `test_status:"failed"`, `Head` call present. No `test_failure` (optional in 1.12). |
| G. Stability | **PASS** | 21 of 21 normalized sequence diagrams identical between run 1 and run 2 (`evidence/g-stability.json`). |
| H. Change detection | **FAIL** | `getComments` stopped sending `page`. `appmap-trace --baseline` printed "traced 0 interaction(s)" and exited 0. The official `sequence-diagram-diff` said "identical" for all 21 tests. Neither tool showed the change. |
| I. Concurrency | **FAIL** | Vitest: each of the 21 tests run alone produced the same diagram as inside the parallel suite, so nothing leaks. Browser: two clicks 20 ms apart produced **one** map named `click a "Users"` containing both the Users loader and the Dashboard render. |
| J. Overhead | MEASURED | Suite wall time: 12.0 s / 11.2 s without the agent, 12.4 s / 12.2 s with it (median +7%; the earlier run-a measured +11%). |
| Browser (interaction recording) | **FAIL** | As documented (zero-touch): **0 maps** for 5 interactions, because the injected script never loads. With a config-only workaround: 1 map per interaction with the right handlers, but no HTTP events, no `traceparent` on the wire, and 2 of 4 maps cut off before the response. |

The recorder also **changes the app's behavior**: `discussions.test.tsx › should create, render and delete discussions` passes 3/3 without the recorder and fails 3/3 with it. See bug 3.

## Details per check

### A. Setup
Commands (run.sh does all of these):
```
git clone https://github.com/alan2207/bulletproof-react.git && git checkout 9506629ed003a561c6627735480cce4994244bb4
cd apps/react-vite
sed -i 's#https://registry.npmmirror.com/#https://registry.yarnpkg.com/#' yarn.lock   # sandbox egress only, see below
yarn install --frozen-lockfile --ignore-scripts
yarn add -D file:<recorder-repo>/recorder --ignore-scripts
cp <acceptance>/app-config/*.ts .       # vite.config.appmap.ts + appmap.setup.ts (+ diagnostics)
VITE_APP_API_URL=https://api.bulletproofapp.com npx vitest run --config vite.config.appmap.ts
```
Config used, following the docs: `appmapVitePlugin({ include: ['src'], exclude: ['src/testing'], app: 'bulletproof-react' })`, plus a Vitest setup file calling `registerAppMapHooks({ app })`. Both live in new files, `vite.config.appmap.ts` (which merges into the app's own `vite.config.ts`) and `appmap.setup.ts`. The app's own files are untouched (`evidence/app-tree-changes.txt`: only `package.json`/`yarn.lock` from the install, plus the new config files).

Why A fails: the plugin had to be imported as `./node_modules/@funwithappmap/react-recorder/src/vitePlugin` (bug 1). The documented package import fails for any consuming app.

### B. Validity and declared-version honesty
- Official validator, every recording (21 tests, 3 extra, 5 browser maps): **0 valid** at the declared `1.12`, and 0 valid at every version from 1.2.0 to 1.13.1. The validator has no 1.4.1 schema.
- Reasons, in the order they block:
  1. `metadata.frameworks[0].version` is missing, and it is *Required* in the spec and in every schema. The default is `[{ name: 'vitest' }]` (recorder/src/testRecording.ts:35).
  2. Parameter and return values run to 1024 chars, but schemas 1.6 and later cap `value` at 100 (spec: "should be trimmed … to 100 characters").
  3. `exceptions[]` lacks `object_id`, which every schema 1.2–1.13.1 requires.
  4. Versions 1.2–1.5 also require parameter `object_id` and `receiver`, which the recorder doesn't always write.
  5. From recorder code, confirmed only on the recorder's own example (supplementary): `http_client_request` events have no `message` array, which schemas 1.5 and later require.
- The spec also says `http_client_request.url` should exclude the query string, with params in `message`. The recorder puts the full URL, query included, in `url`.
- Diagnostic only, not a pass (`evidence/b-validate-bestconfig.json`): with every option the recorder exposes (frameworks passed with versions through `registerAppMapHooks`, and `APPMAP_EVENT_VALUESIZE=99`), **all 21 test recordings pass 1.6.0–1.13.1**, semantic checks included (per-thread call/return nesting, classMap consistency). The E recording still fails (no exception `object_id`). `APPMAP_EVENT_VALUESIZE=100` would not be enough, because the recorder appends "…" after cutting.
- **Highest version it actually satisfies: none, as shipped.** With non-default options it satisfies 1.6–1.13.1, but only for recordings with no exceptions and no HTTP events. So the "1.12" label is not honest for default output.

### C. Ground truth (EXPECTATIONS.md T1–T9)
Found in the recordings, for example:
- `{"method_id":"loginWithEmailAndPassword","path":"src/lib/auth.tsx","lineno":29,"parameters":[{"name":"data","value":"{\"email\":…,\"password\":…}"}]}`
- `getDiscussion` called with `{"discussionId":…}`.
- `onOpenChange` (form-drawer.tsx:42) called with `true`.
- `updateDiscussion` with `{data:{title,body},discussionId}`.
- Labels `component`, `hook` and `event-handler` present as expected.

Missing:
- **Every HTTP call** (25 items): `GET /auth/me`, `POST /auth/login`, `POST /auth/register`, `GET/PATCH/POST/DELETE /discussions…` and `GET/POST/DELETE /comments…`. So there is no `traceparent` to check either. Cause: the recorder only wraps `globalThis.fetch` (recorder/src/fetchPatch.ts:26), and axios 1.6.8 uses `XMLHttpRequest`. The only trace of HTTP in the maps is the app's axios interceptor `authRequestInterceptor` (src/lib/api-client.ts:7).
- `checkAccess` (authorization.tsx:35) in T3, T4, T5, T7a and T7b, and `toggle`/`open`/`close` (use-disclosure.ts:6-8). The transform only wraps callbacks of a bare `useCallback(...)`. This app writes `React.useCallback(...)` (recorder/src/transform.ts:198-199).

Wrong:
- T1 `LoginForm` props are recorded as `"value":"{}","size":1`. The one prop (`onSuccess`, a function) is silently dropped from the value by `JSON.stringify`.

Not predicted in EXPECTATIONS.md but observed:
- Parameter values carry plaintext passwords, e.g. `"password":"secret-pw-1"` in the browser map.
- In the E recording, React's dev-mode component-stack probing calls `Authorization()` and `AppProvider()` with no props. These are recorded as real calls throwing `TypeError: Cannot destructure property … of 'undefined'`.

Where EXPECTATIONS.md itself was imprecise:
- B1 said the map would be "named after the click on the Register button". It is named `click span "Register"`, after the inner span. The substance holds.
- T3 predicted `checkAccess` returns true. That couldn't be checked, because `checkAccess` is never recorded.

### D. Noise
1342 call events in run 1. The biggest share is `src/utils` (565, almost all the `cn` class-name helper). No calls come from `node_modules` or the excluded `src/testing`. But test-file code is recorded: `renderDiscussion` 3×, `TestDialog` 3×, `TestDialog`'s inline `onOpenChange` 1× and `TestDrawer` 1×. The plugin's `exclude` is a prefix match (recorder/src/vitePlugin.ts:44-50). With co-located `__tests__/` directories, the only way to keep test code out is to list every test directory by hand.

### E. Exception (extra test outside the app's source, `app-config/appmap-extra/exception.test.tsx`)
`<Authorization allowedRoles={['ADMIN']}>` with no user:
```
call 14 useAuthorization → return 15 exceptions:[{"class":"Error","message":"User does not exist!"}]
return 16 Authorization  exceptions:[{"class":"Error","message":"User does not exist!"}]
```
PASS on content. Two caveats: the exception objects are schema-invalid (no `object_id`), and React's fake probe calls show up as extra TypeError exceptions.

### F. Failing test (copy of head.test.tsx with a wrong assertion, outside `src/`)
The recording is written with `test_status: "failed"` and contains the `Head` call. PASS. `metadata.test_failure` (added in 1.12, optional) is not written. The app's own `discussions.test.tsx` failure, caused by bug 3, is also recorded as `failed`.

### G. Stability
Two recorded runs of the whole suite, then `appmap sequence-diagram --format json` per test. Compared with `elapsed` and `eventIds` removed: **21 of 21 identical**. The one test that fails under the recorder fails the same way in both runs.

### H. Change detection
The change, on a scratch branch: `src/features/comments/api/get-comments.ts` stops sending `page` (`app-config/h-change.patch`). The request becomes `GET /comments?discussionId=…` instead of `…&page=1`, and the tests still pass.
- `linker/bin/appmap-trace.mjs <after> --baseline <before>`: **"traced 0 interaction(s)"**, exit 0. It only looks at maps that contain an `http_client_request` event (linker/src/link.mjs:20-22), and no map from this app has one. It gives no warning.
- Official `appmap sequence-diagram` on both sets, then `appmap sequence-diagram-diff`: **"… are identical"** for all 21 tests, including the three that load comments.
- The diff showed nothing, so the change was not detected. The cause is C's missing HTTP events: the only thing that changed is a request URL.

### I. Concurrency
- **Vitest:** the files run in parallel workers. Each of the 21 tests was also re-run alone (`vitest run <file> -t '^name$'`), and every isolated diagram is identical to the one from the parallel suite. No test-file function shows up in another file's map. No leakage found.
- **Browser** (with the workaround): a click on "Users", then a click on "Dashboard" 20 ms later, produced one map, `click a "Users"`. It contains `getUsers` (Users loader) **and** `DashboardRoute` (the second click's work). Doc 04 says this merging is by design, but it means one map holds two interactions under the first one's name.

### J. Overhead
| run | wall s |
|---|---|
| plain-1 / plain-2 | 12.05 / 11.19 |
| recorded-1 / recorded-2 | 12.42 / 12.24 |

That is +7% median. The earlier full run (run-a) measured 12.8 s vs 14.1 s, +11%.

### Browser interaction recording (real Chromium, all on localhost)
Setup: the app's own mock server (`mock-server.ts`, express + the app's MSW handlers) on :8080; `vite --config vite.config.appmap.ts` on :3000 with the plugin's `app` option; Playwright headless Chromium. Non-localhost requests were aborted (only the app's `rsms.me` web font).

1. **As documented (zero-touch): FAIL, 0 maps.** The served HTML contains `<script type="module">import "virtual:appmap-interaction-recorder";</script>`, and Chromium refuses it: *"Access to script at 'virtual:appmap-interaction-recorder' … blocked by CORS policy: Cross origin requests are only supported for protocol schemes …"*. The recorder's own example app (Vite 6.4.3) fails the same way in Chromium, so this is not specific to Vite 5 (bug 2).
2. **With a config-only workaround** (`app-config/vite.config.appmap-browserfix.ts` rewrites the specifier to `/@id/virtual:…`): 5 interactions produced 5 maps.

| Step | Map | Recorded | Missing |
|---|---|---|---|
| B1 register | `click span "Register"` | `onSubmit` (register-form.tsx:30), `registerWithEmailAndPassword` | `POST /api/auth/register`; the `onSuccess` navigation (register.tsx:24). `truncated: true`: the window closed before the response. |
| B2 list page | `click a "Discussions"` | `DiscussionsRoute`, `DiscussionsList`, `getDiscussions(1)` | `GET /api/discussions?page=1` |
| B3 open drawer | `click span "Create Discussion"` | `onOpenChange(true)`, i.e. everything expected | — |
| B4 create item | `click span "Submit"` | `onSubmit`, `createDiscussion({data:{title,body}})` | `POST` and the refetch `GET`. `truncated: true`. |
| B5 two clicks | one merged map | see I | — |

Wire capture: 6 requests to :8080, and **0 carry `traceparent`**. So the full-stack linking the recorder is built for cannot work on an axios app. The truncation follows from the missing HTTP events: the idle check only waits for *recorded* pending requests (recorder/src/interactionRecording.ts:67). With XHR invisible, the window closes 250–500 ms after the click, before the mock server replies (300–1000 ms), and the response handling is recorded nowhere.

## Recorder bugs found

Each has a symptom, a location and a repro.

1. **The package entry points can't be used by a consuming app.**
   - Where: recorder/package.json:9-13 and :25.
   - Symptom: `exports` point at `.ts` source. Node refuses to type-strip under `node_modules`, so `import { appmapVitePlugin } from '@funwithappmap/react-recorder/vite'` in an app's `vite.config.ts` throws `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.
   - Packing makes it worse: `npm pack` ships only `package.json` + `src/index.ts`, because `files: ["dist"]` and no dist exists. After `npm run build`, dist uses extensionless relative imports (`from './recording'`) that Node ESM can't resolve, and `publishConfig.exports` isn't applied by npm.
   - Repro: `run.sh` step A, or `vitest run --config vite.config.appmap-pkgimport.ts` in the app.
2. **Zero-touch interaction recording never starts in a browser.**
   - Where: recorder/src/vitePlugin.ts:129-139.
   - Symptom: `transformIndexHtml` is a plain function, so Vite runs it *after* its dev-HTML import rewriting (Vite `resolveHtmlTransforms` puts function hooks in `normalHooks`). The injected `import "virtual:appmap-interaction-recorder"` reaches the browser as a bare `virtual:` URL and is blocked. It affects Vite 5.2.11 (this app) and Vite 6.4.3 (the recorder's own example). Doc 07's "verified against a real dev server" checked the HTML text and the `/@id/` URL separately, never in a browser.
   - Repro: browser pass 1 in run.sh (`evidence/browser-zerotouch.json`, console error).
3. **Recording changes app behavior (observer effect).**
   - Where: recorder/src/recording.ts:49 (`JSON.stringify(v)`), called on every return value from recorder/src/instrument.ts:47 via recording.ts:230.
   - Symptom: serializing a hook's return value reads every getter on React Query's *tracked* result object, which subscribes the component to every field. Components then re-render on `isFetching` changes they would otherwise ignore. In this app, `discussions.test.tsx` goes from 3/3 pass to 3/3 fail (deterministic).
   - Not verified step by step: the most likely chain is that the extra `DiscussionsList` re-render remounts its inline `Cell` components (new component types each render). That closes the delete-confirmation dialog, and with it the aria-hidden that made the test's final assertion pass.
   - Minimal repro: `app-config/appmap-extra/observer-effect.test.tsx`. Under an active recording the wrapped hook re-renders once after `invalidateQueries`; the unwrapped one re-renders 0 times (`expected { recorded: 1 } to deeply equal { recorded: +0 }`). The same getter-reading applies to react-hook-form's `formState` proxy and anything else with side-effecting getters.
4. **HTTP made through XMLHttpRequest (axios, and any XHR-based client) is invisible.**
   - Where: recorder/src/fetchPatch.ts:26 patches only `fetch`.
   - Effects: no `http_client_request` events and no `traceparent` stamping, in tests or in the browser. Interaction windows close before responses (interactionRecording.ts:67). `appmap-trace` silently traces 0 interactions (linker/src/link.mjs:20-22).
   - Repro: run.sh check C, H and the browser pass.
5. **`React.useCallback` / `React.useMemo` callbacks are not instrumented.**
   - Where: recorder/src/transform.ts:198-199 accepts only a bare `useCallback`/`useMemo` identifier.
   - Repro: C items T7a/T8a (`toggle` and `checkAccess` never appear).
6. **Output is not valid 1.12 (or any version).**
   - `frameworks` entries lack `version` (recorder/src/testRecording.ts:35).
   - The value cap is 1024, and the spec/validator cap is 100 (recorder/src/recording.ts:16). The cap is also exceeded by one character, because "…" is appended after cutting (recording.ts:53).
   - Exceptions lack `object_id` (recording.ts:215).
   - `http_client_request` has no `message` (recording.ts:242).
   - Repro: `node scripts/validate-all.cjs <validator> <dir>`, `evidence/b-validate*.json`.
7. **Thread nesting breaks around async children.**
   - Supplementary, seen only on the recorder's own example app (examples/petclinic-react), not on bulletproof-react.
   - Symptom: `onSubmit` (id 51) returns synchronously while the async `search → findOwners → request → fetch` it started (52-55) are still open on the same `thread_id` 1. After adding the missing `message`, the official validator reports `expected parent id of return event #56 to be 55 but got 51`.
   - Where: thread allocation in recorder/src/recording.ts:122-166 (allocateThread / leaveSyncFrame).
   - Repro: `npx vitest run test/owners.test.tsx` in examples/petclinic-react, then validate `OwnersSearch_finds_owners_by_last_name.appmap.json` with frameworks versions and values patched.
8. **Test-file code is recorded, and `exclude` can't prevent it** (recorder/src/vitePlugin.ts:44-50, prefix match only). See D.
9. **Function-valued props vanish from values:** `{onSuccess: fn}` is recorded as `"{}"` (recording.ts:49). Also, React dev-mode stack probes are recorded as real calls throwing TypeErrors (E recording, events 21-24).

## App changes needed
- **App source / test changes: none.**
- Config (new files, the documented kind): `vite.config.appmap.ts` (plugin entry, merged into the app's own config) and `appmap.setup.ts` (the `registerAppMapHooks` setup file).
- Config workarounds forced by recorder bugs. These count against the recorder:
  1. Importing the plugin by relative path into `node_modules` (bug 1).
  2. `vite.config.appmap-browserfix.ts`, needed for any browser recording at all (bug 2).
- Environment only, not an app or recorder issue: the app's `yarn.lock` resolves one lint plugin (`eslint-plugin-check-file`) from `registry.npmmirror.com`, which this sandbox's egress policy blocks. run.sh rewrites that one URL to the default registry; the integrity hash is unchanged. `VITE_APP_*` env vars are passed on the command line instead of creating `.env`.

## What could not be run, or was run differently
- The Playwright version installed by the app (1.59.1) expects Chromium r1217, which is not installed. Following instructions, `playwright install` was not run, and Chromium r1194 from `/opt/pw-browsers` was used via `executablePath`. It worked for everything above.
- No official "validate" command exists in `@appland/appmap` 3.204.0. The official validator package from getappmap/appmap-js (`@appland/appmap-validate`, which the spec README links) was used instead, along with the CLI's `sequence-diagram` and `sequence-diagram-diff`.
- Whether HTTP events carry `traceparent` and are schema-valid could not be tested on this app, because it produces none (bug 4). The HTTP event shape was checked only on the recorder's own example, and is reported as supplementary.
- `run.sh` pins the CLI to 3.204.0 for reproducibility. `APPMAP_CLI_VERSION=latest` overrides it.
