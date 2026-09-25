# Results: AppMap Deno recorder on supabase `restful-tasks`

- **Recorder under test:** evlawler/funwithappmapreact, branch `upstream-pr/deno-waituntil-trace-agent`,
  recorder code at `bef9d18c693c4873752539d8ca88c820ed98060d` (not modified).
- **App:** supabase/supabase `examples/edge-functions/supabase/functions/restful-tasks/index.ts` at
  `74a3be9aa8706755e05f7326f3d25472729cd977`. EXPECTATIONS.md explains the choice and was committed
  before any recording.
- **One command:** `acceptance/supabase-restful-tasks/run.sh`. It makes a clean sparse clone of the
  app at the pinned SHA, starts a real Postgres and a real PostgREST, runs every check, and exits 1
  if any check fails. It exits 1 today.
- **Raw evidence:** `evidence/`. This includes every recording, the official sequence diagrams,
  diffs, `results.json` and `run.log`. The same verdicts came out on four consecutive full runs.

## Update: `integration/pr1` — the fixes merged (read this first)

Branch `integration/pr1` merges `fix/recorder-worst-bugs` into `ci/oss-e2e` and adds further fixes. This
section is the current result; the rest of this file is the original run against the unfixed recorder
(`bef9d18`), kept as the record of what it found. The files in `evidence/` are that original run's; a current
run of `run.sh` rewrites them (CI uploads them as an artifact).

Run: fresh clone of `integration/pr1`, `CI=true`, `npm ci`, then `acceptance/supabase-restful-tasks/run.sh`,
on 127.0.0.1 in a private network namespace. Same app SHA, tools and versions as below. "Merged, old checks"
is the same code run with the checks as they were before the check changes listed below.

| Check | Before (unfixed) | Merged, old checks | After | One line (after) |
|---|---|---|---|---|
| A Setup / zero-touch | PASS | PASS | **PASS** | env only, app tree clean. |
| B Validity + honest version | FAIL (0/49) | PASS | **PASS** | 91/91 valid at 1.12 (and 1.6.0–1.13.1). |
| C Ground truth | FAIL (7/8) | FAIL | **PASS** | R1–R8 found; each has the `Deno.serve` handler (index.ts:68) as entry call with the app function nested in it; R7's exception now carries the thrown object's message. |
| C traceparent gate | PASS | PASS | **PASS** | |
| C call-tree structure | FAIL | PASS | **PASS** | every request is one tree rooted at its HTTP server request. |
| D Noise | PASS | PASS | **PASS** | only `restful-tasks/index.ts`. |
| E Exception | FAIL | FAIL | **PASS** | R7: `{class: "Object", message: "invalid input syntax for type bigint: \"not-a-number\""}` on `getTask`'s return. |
| F Failing test | NOT RUN | NOT RUN | **NOT RUN** | the app has no tests; no Deno test-recording mode. |
| G Stability | PASS | PASS | **PASS** | 8/8 identical. |
| H Change detection | PASS | FAIL | **PASS** | only R6 changed; official diff: "added HTTP client request `GET …/rest/v1/tasks`"; appmap-trace: "1 added. New call restful-tasks→network: GET /rest/v1/tasks?select=*&id=eq.2". |
| I Concurrency | FAIL | FAIL | **PASS** | 3 rounds × (20 stamped + 10 unstamped): 20 maps each, 0 leaks, 0 foreign trace ids on the wire. |
| W1 waitUntil capture | PASS | FAIL | **PASS** | |
| W4 waitUntil overlap | FAIL | FAIL | **PASS** | A and B recorded separately, each with only its own calls. |
| W2 self-heal | PASS | PASS | **PASS** | |
| W3 crash self-heal | FAIL | PASS | **PASS** | SIGKILL / SIGTERM / SIGINT each leave one truncated map. |
| J Overhead | PASS (measured) | PASS | **PASS** (measured) | 200 requests: plain 1136 ms, unstamped 1111 ms (0.98x), stamped 1060 ms (0.93x); an earlier run: 970 / 962 / 1040 ms. Within noise. |

`run.sh` exits 0: nothing fails (F is NOT RUN, which the harness does not count as a failure).

**Bugs listed below, now:** 1 and 2 (leaks, wrong trace ids) fixed by per-request async context (6402f0d);
3 (flat call tree) and 6 (declared version) fixed (4893004); 4 (crash loses the recording) fixed (971f16b);
5 (plain-object throws) fixed (0ad3121); 7 (anonymous `Deno.serve` handler) fixed (d4be568); 8 (tracer
mislabels Deno maps) fixed (84bae82), and its "1 added, 3 changed" count fixed (8227fac); 9 (credentials)
fixed (1315646).

### Check changes

Each is its own commit; the message quotes the old and new rule. EXPECTATIONS.md is unchanged.

1. **URLs are `url` + `message`** (c02e032, rule (a), AppMap spec): `summarize()` rebuilds an outbound
   call's URL from `url` and the event's `message`, for C, H, I and W1.
2. **The recorded `Deno.serve` handler is the entry call** (ad26266, rule (b)): C accepts
   `index.handler` (index.ts:68) as the first function call, not nested in another function, and then
   requires every expected function nested inside it and, compared exactly as before, equal to the
   expected list. No other extra call.
3. **The supabase client parameter is identified by its class** (5b5d581; follows the requested
   observer-effect fix, not one of rules (a)–(f): flagged for review): the old rule dropped the client by
   its old rendering `[object Object]`; value capture now renders the client's data, so C drops the
   parameter recorded with class `SupabaseClient` (the first parameter of every app function) and compares
   the rest as before.
4. **I counts only other requests' events as leaks** (21900af, rule (e)): the request's own entry handler is
   not foreign; every other call, a second handler included, is judged as before, and app functions must
   be nested in the request's handler.
5. **W4 requires two separate recordings** (09244e1, rule (c)): A and B must each have their own map with
   their own trace id, exactly their own `probe.ingest(n)` and outbound calls, and none of the other's.
   Stricter than before (B used to be required to be *un*recorded).
6. **H reads the query from appmap-trace; the lane is the app's** (081f893, rules (a)/(f) and the requested
   tracer fix): the official diff must name the added `GET …/rest/v1/tasks` (it cannot show the query, which
   is in `message`); appmap-trace must say "New call restful-tasks→network: GET
   /rest/v1/tasks?select=*&id=eq.2" (was "frontend→network", the mislabel of bug 8).

Setup only: shellcheck cleanups (0ddada4).

## Tool versions

| Tool | Version |
|---|---|
| Deno | 2.9.7 (release binary from github.com/denoland/deno) |
| Node | 22.22.2 (runs `appmap-deno.ts` via `--experimental-strip-types`) |
| @supabase/supabase-js (jsr) | 2.117.1, pinned by `deno.lock` |
| PostgreSQL | 16.13 (system package) |
| PostgREST | 12.2.12 (release binary) |
| Official AppMap CLI `@appland/appmap` | 3.204.0 |
| Official validator `@appland/appmap-validate` | 2.5.1 (ships schemas 1.2.0 through 1.13.1) |
| AppMap spec | github.com/getappmap/appmap @ fa68b13 |

## Summary

| Check | Result | One line of evidence |
|---|---|---|
| A Setup / zero-touch | **PASS** | `node deno/bin/appmap-deno.ts --app restful-tasks <entry> -- --lock=…` with only env vars. `git status` in the app clone is clean after every run, and no `.appmap.*` copy is left behind. |
| B Validity + honest version | **FAIL** | Official `appmap-validate`: **0/49** recordings valid (`/metadata/language must have required property 'version'`). No recording satisfies **any** schema version as written. |
| C Ground truth (content) | **FAIL** (7/8) | R1-R6 and R8 match exactly: route, status, function+line+params, PostgREST method+URL+status, and they agree with the gateway log. R7's exception is recorded as `{"class":"object","message":"[object Object]"}`, so the error's message is lost. |
| C traceparent gate | **PASS** | Unstamped: HTTP 200, 0 files, outbound `traceparent` null. Four malformed headers: 0 files each. 8/8 stamped maps carry the caller's `trace_id`/`parent_span_id`, and outbound calls go out as `00-<same trace>-<new span>-01`. |
| C call-tree structure | **FAIL** | For every request with a handler, the official `appmap sequence-diagram` shows 3 disconnected roots, e.g. `["GET /restful-tasks/1" (0 children), "GET …/rest/v1/tasks?select=*&id=eq.1" (0), "getTask" (0)]`. |
| D Noise | **PASS** | run1 call events: `http_server_request` 8, `function …/restful-tasks` 6, `http_client_request 127.0.0.1:54321` 6. No supabase-js, jsr/npm or recorder frames. |
| E Exception | **FAIL** | The throw on the R7 path is recorded on `getTask`'s return, but as `class:"object", message:"[object Object]"` with no `object_id`. The app threw `{code:"22P02", message:'invalid input syntax for type bigint: "not-a-number"'}`. |
| F Failing test | **NOT RUN** | The app has no tests, and the recorder has no Deno test-recording mode. |
| G Stability | **PASS** | 8/8 requests: normalized official sequence-diagram JSON (elapsed/eventIds removed) and the event/thread shape are identical across two fresh runs. |
| H Change detection | **PASS** (with tool caveats) | Only R6 (DELETE) changed. The official diff says "changed … `DELETE …?id=eq.2` to … `GET …?select=*&id=eq.2` … added … `DELETE …?id=eq.2`". `appmap-trace --baseline` says "New call frontend→network: GET /rest/v1/tasks?select=*&id=eq.2" for DELETE and "No behavior change" for the other 5. |
| I Concurrency | **FAIL** | In a burst of 20 stamped + 10 unstamped, **1** map is written (`GET /restful-tasks/4`). It holds **all 29 other requests'** function calls and PostgREST calls, is `truncated`, and has 58 synthetic returns. The gateway saw those 29 outbound calls stamped with **its** trace id. |
| waitUntil W1 capture | **PASS** | 202 in 12 ms. The map is written 3053 ms after the response. It contains `POST /rest/v1/tasks 201`, `GET /enrich?n=1 200`, `PATCH …name=eq.probe-1 204` and a completed `probe.ingest`, and is not truncated. |
| waitUntil W4 overlap | **FAIL** | A second stamped request (B) arriving during A's background window is correctly unrecorded, but **its** `ingest(3)`, insert and `GET /enrich?n=3` land in A's map. |
| waitUntil W2 self-heal (no waitUntil) | **PASS** | Map closed at the 202 with `truncated:true`. The open `probe.ingest` and fetch get synthetic returns, and the events are balanced. |
| waitUntil W3 crash mid-recording | **FAIL** | `kill -9` of deno, SIGTERM to the runner and SIGINT to the runner, each 1.5 s into the background: **0 files** written each time. There is nothing to self-heal. |
| J Overhead | **PASS** (measured) | 200 sequential requests: plain 999 ms; appmap-deno unstamped 1030 ms (1.03x); all stamped 1058 ms (1.06x, 200 maps). The spec sets no threshold. |

Extra items the task asked for:

| Item | Result |
|---|---|
| Record the app's own `deno test` suite | **NOT RUN.** The app has none. |
| Supabase Edge Runtime (doc 06's named gap) | **NOT RUN.** As doc 06 says, `appmap-deno` cannot reach it because it has no `--preload`. I tried the real runtime to at least test manual wiring. Docker Hub answered 429, and blob downloads from public.ecr.aws and ghcr.io were refused by this session's egress proxy (403). I did not work around it. All results here are plain `deno run`. |
| Declared format 1.12 honest? | **No.** See B. |

## Details

### A. Setup (exact commands)

```
acceptance/supabase-restful-tasks/run.sh
  # clones supabase/supabase sparse at 74a3be9 into $WORK/supabase
  # infra/db.sh start: initdb + pg_ctl (Postgres 16), table public.tasks (no migration in the app repo), PostgREST 12.2.12
  # infra/gateway.mjs: :54321 /rest/v1/* -> PostgREST (Kong's role), logs method/url/traceparent
  # the recorded app, cwd $WORK/supabase:
  SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=<local anon JWT> APPMAP_DIR=<dir> \
  DENO_SERVE_ADDRESS=tcp:127.0.0.1:18000 \
  node --experimental-strip-types deno/bin/appmap-deno.ts --app restful-tasks \
       examples/edge-functions/supabase/functions/restful-tasks/index.ts -- --lock=acceptance/supabase-restful-tasks/deno.lock
```

**App changes needed: none.** `DENO_SERVE_ADDRESS` is a Deno env var used only to move the port off 8000. It is not a source edit.

### B. Validity and the declared version

The official validator (`appmap-validate <file>`) rejects all 49 recordings: run1, run2, run3,
the concurrency rounds and the probe. `lib/schema-diagnose.mjs` finds the smallest set of named
additions that makes each map valid. It checks each schema version the official validator ships,
using that validator's own schema files:

| Missing item | In 1.12 spec / validator | Where the recorder omits it | Maps affected |
|---|---|---|---|
| `metadata.language.version` | Spec README: *Required* whenever `language` is present | `deno/appmap.ts:119` sets `{name, engine}` only | 49/49 |
| `message` array on `http_server_request` / `http_client_request` call events | Required by the official validator schema (README describes `message` as where query params go) | `recorder/src/recording.ts:236-249`, `268-287` | 49/49 |
| exception `object_id` | Spec README: *Required* | `recorder/src/recording.ts:215-220` | 3 (R7 maps) |
| parameter `value` ≤ 100 chars | Validator schema (README: "should be trimmed … to 100 characters") | cap is 1024, `recorder/src/recording.ts:16,53` | 3 (probe maps holding a 191-char bearer token) |

- **Highest version satisfied as recorded: none.** 1.2.0 through 1.13.1 all fail.
- With the two or three additions above, every map would satisfy 1.6.0 through 1.13.1.
- 6 maps without HTTP client events would also satisfy 1.2.0.
- Also against the spec text, though the validator does not enforce it: `http_client_request.url` includes the query string (`recorder/src/fetchPatch.ts:37`). The spec says "Request URL, excluding the query string".
- `appmap sequence-diagram` does not reject any of them (exit 0 over all 49).

### C. Ground truth

Evidence: `evidence/C-ground-truth.json`, `evidence/recordings/run1/`. A quote from R6
(`DELETE_restful-tasks_2_…_006.appmap.json`):

```
{"id":1,"event":"call","thread_id":1,"http_server_request":{"request_method":"DELETE","path_info":"/restful-tasks/2","headers":{"traceparent":"00-73657100000000000000000000000006-0000000600000006-01"}}}
{"id":2,"event":"call","thread_id":2,"defined_class":"index","method_id":"deleteTask","path":"examples/edge-functions/supabase/functions/restful-tasks/index.ts","lineno":38,"static":true}
{"id":3,"event":"call","thread_id":3,"http_client_request":{"request_method":"DELETE","url":"http://127.0.0.1:54321/rest/v1/tasks?id=eq.2","headers":{"content-type":"application/json","traceparent":"00-73657100000000000000000000000006-bfad9f90e0f9fb7f-01"}}}
{"id":4,"event":"return","thread_id":3,"parent_id":3,"http_client_response":{"status_code":204}}
{"id":5,"event":"return","thread_id":2,"parent_id":2,"return_value":{"class":"Response","value":"{}",...}}
{"id":6,"event":"return","thread_id":1,"parent_id":1,"http_server_response":{"status_code":200}}
```

| # | Verdict | Note |
|---|---|---|
| R1 OPTIONS | found | 200, no functions, no outbound calls |
| R2 GET list | found | `index.getAllTasks@28`, `GET …/tasks?select=* 200` |
| R3 GET 1 | found | `index.getTask@18("1")`, `GET …/tasks?select=*&id=eq.1 200` |
| R4 POST | found | `index.createTask@58({"name":"acc-new","status":0})`, `POST …/tasks 201` |
| R5 PUT 1 | found | `index.updateTask@48("1",{…"renamed"…})`, `PATCH …/tasks?id=eq.1 204` |
| R6 DELETE 2 | found | `index.deleteTask@38("2")`, `DELETE …/tasks?id=eq.2 204` |
| R7 GET not-a-number | **wrong** | 500, `getTask`, `GET …?id=eq.not-a-number 400` all present. The exception is `{"class":"object","message":"[object Object]"}` (see E). |
| R8 POST bad JSON | found | 400, no functions, no outbound calls |

- **The real handler is invisible.** The anonymous `Deno.serve(async (req) => …)` arrow at
  index.ts:68 (the dispatcher, where OPTIONS, JSON parsing and the 400 path happen) never appears.
  The transform only wraps named top-level declarations. As decided in EXPECTATIONS, this is a
  gap and does not by itself fail C.
- **No `sql_query` events**, as expected. The app reaches the DB only through PostgREST over HTTP.
- **Structure (separate FAIL).** Each recording is a flat set of threads:
  - the server request is on thread 1, `getTask` on thread 2, and the fetch on thread 3;
  - the official `appmap sequence-diagram` therefore renders three unrelated roots with no
    children (`evidence/sequence/run1/*.sequence.json`, `evidence/C-structure.json`);
  - a reader of the official diagram cannot see that `getTask` ran inside `GET /restful-tasks/1`
    or that the PostgREST call came from `getTask`.

### D. Noise

- Only `examples/edge-functions/supabase/functions/restful-tasks/index.ts` functions are recorded.
- supabase-js, auth-js, postgrest-js and the recorder itself produce zero events.
- The upside comes with a limit. Only the entry file is instrumented (doc 06 non-goal), so a
  function split across files would record nothing beyond its entry. That did not matter for
  this single-file app.

### E. Exception

`getTask` (index.ts:20) runs `if (error) throw error`, where `error` is the plain parsed JSON
object that supabase-js 2.117.1 returns (postgrest-js `PostgrestBuilder.ts:450`,
`error = JSON.parse(body)`). The recorder writes:

```
{"id":5,"event":"return","thread_id":2,"parent_id":2,"exceptions":[{"class":"object","message":"[object Object]"}]}
```

`recorder/src/recording.ts:217-218` uses `typeof e` and `String(e)` for anything that is not an
`Error`. So the class is `object` (the parameter formatter would have said `Object`), the message
is useless, and `object_id` (required) is missing.

**My expectation was wrong about the class.** EXPECTATIONS.md said `PostgrestError`. It is a
plain object; supabase-js only builds a `PostgrestError` with `throwOnError()`. The message
expectation stands: the thrown object's `message` is `'invalid input syntax for type bigint: "not-a-number"'`.

### G. Stability

Two fresh processes, DB reset in between, same sequence and headers: no differences in
normalized sequence-diagram JSON or in the event/thread shape for any of the 8 requests
(`evidence/G-stability.json` is empty).

### H. Change detection

The change (`h-change.patch`, applied on scratch branch `acceptance-h-change` of the app clone,
then removed) makes `deleteTask` first run `supabaseClient.from('tasks').select('*').eq('id', id)`.
Line numbers of other functions are preserved.

- **Official** `appmap sequence-diagram-diff run1 run3 --format text`:
  - R6: `changed HTTP client request DELETE …?id=eq.2 to HTTP client request GET …?select=*&id=eq.2 and changed to return 200 instead of 204` / `added HTTP client request DELETE …?id=eq.2`.
  - R1-R5, R7 and R8: identical.
  - The change and only the change is detected. The wording reads as "DELETE became GET, plus a new DELETE" rather than "GET inserted before DELETE", because all calls are sibling roots (see C-structure).
- **Repo tool** `linker/bin/appmap-trace.mjs run3 --baseline run1`:
  - DELETE: `Behavior changed — 1 added, 3 changed. New call frontend→network: GET /rest/v1/tasks?select=*&id=eq.2.`
  - Other 5: `No behavior change`.
  - It nests correctly, but labels the Deno request map as a "frontend", renders the server
    request as `undefined.undefined`, and counts "3 changed" for one inserted call. That is a
    tracer bug, below.
  - OPTIONS and bad-JSON maps are skipped because they have no outbound call.

### I. Concurrency

`evidence/I-concurrency.json`, `evidence/recordings/concurrency-*`. Each round seeds 30 rows so
every request touches its own id. Every one of the 30 requests got HTTP 200.

**Rounds 1-2 (one burst):**
- Only `GET /restful-tasks/4` (req#0) is recorded. That is the documented one-at-a-time rule
  (doc 05/11).
- Its map has 61 call events. They are the other 19 stamped requests' and the 10 unstamped
  requests' `getTask/updateTask/deleteTask/createTask` calls and their PostgREST calls, e.g.
  ```
  {"id":4,"thread_id":4,"method_id":"updateTask"} params ["[object Object]","5","{\"name\":\"c-upd-1\",\"status\":1}"]
  {"id":5,"event":"call","thread_id":5,"http_client_request":{"request_method":"PATCH","url":"http://127.0.0.1:54321/rest/v1/tasks?id=eq.5",
     "headers":{"traceparent":"00-63310000000000000000000000000001-470676f35ffbc15f-01"}}}
  ```
- `00-6331…0001` is req#0's trace id. The PATCH belongs to req#1, which carried its own
  `00-6331…0002-…` header.
- The gateway confirms the same thing on the wire: 29 foreign outbound calls went out stamped
  with req#0's trace id. `appmap-link` would join those backend calls to the wrong map.
- The map closed while 29 of those calls were still open: `truncated:true`, 58 synthetic returns.

**Round 3 (staggered 25 ms):**
- 20 maps are written.
- `GET /restful-tasks/4` still contains an unstamped request's `getTask(24)` and
  `GET …?id=eq.24`, which went out stamped with req#0's trace id.

### waitUntil (synthetic probe `probe/probe.ts`, not the app)

`evidence/W-waituntil.json`, `evidence/recordings/probe-*`.

- **W1: pass.**
  - Capture works as doc 11 says. The response is not delayed (12 ms), and the map is written
    only after the 3 s of background work.
  - Under plain `deno run` this needs an `EdgeRuntime` global. The probe defines a minimal shim;
    without one, `patchWaitUntil` (`deno/appmap.ts:85-97`) is a no-op.
- **W4: fail.**
  - While A's background work runs, a stamped request B is correctly not recorded.
  - But B's background `ingest(3)`, its insert and `GET /enrich?n=3` are all in A's map:
    `['/probe/ingest', ingest(2), POST /rest/v1/tasks, sleep, ingest(3), POST /rest/v1/tasks, sleep, GET /enrich?n=2, sleep, GET /enrich?n=3, sleep, PATCH …probe-2]`.
  - Doc 11 extends the recording window to the whole background run. That makes this leak much
    wider than the request itself: seconds to minutes instead of milliseconds.
- **W2: pass.** Background work not registered with waitUntil is cut at the 202:
  `truncated:true`, synthetic returns `{"id":5,"event":"return","thread_id":2,"parent_id":3}`,
  balanced.
- **W3: fail.**
  - Doc 11 (line 105) says "even a genuinely killed isolate yields a balanced, sanitizable,
    committable (if incomplete) map".
  - Measured: SIGKILL of deno, SIGTERM to the runner and SIGINT to the runner, each 1.5 s into
    the background, write **no file**.
  - `ship()` is only called from `finalize()` (`deno/appmap.ts:139-143`). There is no
    signal/`unload`/`beforeunload` flush, so the self-heal in `toAppMap()` never runs on a
    crash. It only runs on paths like W2 and I.

### J. Overhead

Best of 2 runs of 200 sequential GETs:

| Mode | Time | vs plain |
|---|---|---|
| Plain `deno run` | 999 ms | 1.00x |
| `appmap-deno`, unstamped | 1030 ms | 1.03x |
| `appmap-deno`, every request stamped | 1058 ms | 1.06x (200 maps written) |

That is within run-to-run noise at this size (`evidence/J-overhead.json`).

## Recorder bugs found

All repros assume `run.sh` has set up the DB, gateway and app clone (`WORK=/tmp/acc-deno-work`),
or run `run.sh` itself.

1. **Events from concurrent requests leak into whichever recording is open.**
   - Found by I and W4.
   - Cause: the session is one module-global (`recorder/src/session.ts:11`, read by
     `activeRecording()` at `:32`). Instrumented functions (`recorder/src/instrument.ts:19`) and
     the fetch patch (`recorder/src/fetchPatch.ts:30`) attribute every call in the process to
     it. `deno/appmap.ts:111` only stops a second recording from *starting*; it does not stop
     other requests' events from *entering* the open one.
   - Repro:
     ```
     cd $WORK/supabase && APPMAP_DIR=/tmp/i SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=… \
       node --experimental-strip-types <repo>/deno/bin/appmap-deno.ts examples/edge-functions/supabase/functions/restful-tasks/index.ts
     ```
     Fire 20 stamped requests with `Promise.all`. You get one file with about 30 handler calls.
2. **Other requests' outbound calls are stamped with the open recording's trace id.**
   - Found by I.
   - `recorder/src/fetchPatch.ts:34` sets `traceparent: 00-<active recording trace>-…` on
     *every* fetch in the process while a recording is open. That includes unstamped
     production requests and stamped-but-skipped ones, whose own incoming trace context is
     overwritten.
   - This breaks doc 02/05's "production traffic is untouched" and gives `appmap-link` wrong
     joins.
   - Repro: same as #1, then look at the gateway log. 29/29 foreign PostgREST calls carry
     req#0's trace id.
3. **The call tree is flattened, so official diagrams show disconnected roots.**
   - Found by C-structure.
   - `http_server_request` and `http_client_request` are opened with `openDangling()`
     (`recorder/src/recording.ts:149-155`, used at `:237` and `:274`).
   - `allocateThread()` (`:122-130`) then gives every handler call and every fetch a new
     `thread_id`, so no call nests under the request.
   - Repro: any single stamped request, then `appmap sequence-diagram --format json <map>`.
     `rootActions` has 3 entries with 0 children.
4. **Crash and teardown lose the whole recording; the self-heal is unreachable there.**
   - Found by W3.
   - `deno/appmap.ts:139-143` (`finalize`) is the only caller of `ship()`, and there is no
     signal/unload hook. This contradicts doc 11:105.
   - Repro: `POST /probe/ingest` stamped against `probe/probe.ts` under `appmap-deno`, then
     `kill -9 <deno pid>` (or SIGTERM/SIGINT to the runner) 1.5 s later. `APPMAP_DIR` stays
     empty.
5. **Non-`Error` throws are recorded as `class:"object", message:"[object Object]"`.**
   - Found by E.
   - `recorder/src/recording.ts:217-218`. supabase-js errors are plain objects with a
     `message`, so every PostgREST failure in a Supabase function records this way.
   - Repro: `GET /restful-tasks/not-a-number` stamped.
6. **Declared `version: "1.12"` is not honest.**
   - Found by B.
   - Missing `metadata.language.version` (`deno/appmap.ts:119`), missing exception `object_id`
     (`recording.ts:215-220`), no `message` on HTTP events (`recording.ts:236-249, 268-287`),
     and values capped at 1024 rather than 100 (`recording.ts:16`).
   - Official `appmap-validate`: 0/49 valid.
   - `http_client_request.url` also keeps the query string (`fetchPatch.ts:37`).
7. **The anonymous `Deno.serve` handler is never recorded.**
   - The transform (`recorder/src/transform.ts:237-272`) wraps only named top-level functions.
   - For the common `Deno.serve(async (req) => …)` shape, the request's actual entry function,
     including routing and the 400 path, is missing from every map.
8. **The tracer mislabels Deno request maps.**
   - `linker/src/link.mjs:20-22` classifies any map with an `http_client_request` as a
     frontend map.
   - `linker/src/trace-agent.mjs:174-179` then renders the `http_server_request` event as
     `undefined.undefined`, and the caption says "1 added, 3 changed" for one inserted call.
   - Repro: `node linker/bin/appmap-trace.mjs evidence/recordings/run3-h-change --baseline evidence/recordings/run1`.
9. **Credentials are captured verbatim (observation).**
   - Parameter values are recorded unredacted, up to 1024 chars, e.g. the probe's
     `Authorization: Bearer eyJ…` passed to `ingest` (`evidence/recordings/probe-w1-w4`).
   - That is a local test token here. On a real edge function the same thing would capture
     service-role keys.

## Could not run, and why

- **F (failing test) and recording `deno test`:** the app has no tests. The Deno side has no
  test-recording mode; `appmap-deno` only wraps `deno run`.
- **Supabase Edge Runtime:**
  - Doc 06 already names it as unreachable for `appmap-deno` (it has no `--preload`). Reaching
    it would also require editing the app (manual `withAppMap` wiring).
  - I tried the real runtime image to test at least the probe there. Docker Hub returned 429,
    and blob downloads from public.ecr.aws and ghcr.io returned 403 from this session's egress
    proxy (policy). I did not work around it.
  - Because of that, the waitUntil checks ran under plain `deno run` with an `EdgeRuntime` shim
    in the synthetic probe.
- **Supabase CLI local stack (Kong/GoTrue):** not used. Real Postgres and real PostgREST were
  used directly, behind a 60-line gateway that does Kong's path mapping.

## Expectations that were wrong

- **R7 exception class:** I expected `PostgrestError`. It is a plain object (see E).
- Everything else in EXPECTATIONS.md held:
  - routes, statuses, functions, lines, params, PostgREST URLs and status codes (201/204/400);
  - the 500 for R7 caused by the un-awaited `return getTask(...)` at index.ts:106;
  - no `sql_query` events;
  - the gate behaviour;
  - the W3 prediction from code (no file) against the doc's claim (truncated file).

> Evidence (recordings, logs, reports) is regenerated by every run of `run.sh` and uploaded by CI as the job artifact; it is no longer committed.
