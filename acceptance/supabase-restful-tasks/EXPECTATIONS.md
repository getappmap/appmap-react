# Expectations: AppMap Deno recorder on supabase `restful-tasks`

Written from reading the app's source **before any recording was made**
(ACCEPTANCE-SPEC rule 4). Not edited after the first recording. If
something here turns out to be wrong, RESULTS.md says so.

## Recorder under test

- Repo: evlawler/funwithappmapreact, branch `upstream-pr/deno-waituntil-trace-agent`
  (same content as draft PR getappmap/appmap-react#1)
- Commit: `bef9d18c693c4873752539d8ca88c820ed98060d`
- Entry points used: `deno/bin/appmap-deno.ts` (zero-touch runner, `deno run --preload deno/preload.ts`),
  which wraps `Deno.serve` with `withAppMap` from `deno/appmap.ts`.

## Target app and why

- **App:** Supabase's official example edge function `restful-tasks`,
  `examples/edge-functions/supabase/functions/restful-tasks/index.ts` in
  [supabase/supabase](https://github.com/supabase/supabase).
- **Pinned commit:** `74a3be9aa8706755e05f7326f3d25472729cd977` (2025-06-09).
- **Why this app:**
  - It is the kind of code this recorder is meant for: a Supabase edge function (see doc 05, which
    names a Supabase project as the downstream user). It is a real, published example
    that the recorder's authors did not write.
  - Plain `Deno.serve(async (req) => ...)` (line 68). No framework.
  - It has 6 routes behind one handler: `OPTIONS *`, `GET /restful-tasks`, `GET /restful-tasks/:id`,
    `POST /restful-tasks`, `PUT /restful-tasks/:id`, `DELETE /restful-tasks/:id` (lines 72-117).
  - It uses a database through `@supabase/supabase-js` (`jsr:@supabase/supabase-js@2`, line 5).
    The client talks to PostgREST over `fetch`, so all database work shows up as outbound HTTP.
- **Why this commit and not HEAD:** at supabase HEAD (`8ab2197e`, 2026-09), every example
  function was migrated to `export default { fetch: withSupabase(...) }` (commit d5fde192,
  2026-06-26). That is the `deno serve` convention, which never calls `Deno.serve()`. The task
  asks for plain `Deno.serve`, so HEAD does not qualify. From 3c390c7 (2025-06-10) until that
  migration, the file imports `npm:supabase-js@2`. That npm package is a security placeholder
  (`0.0.1-security`), so those versions cannot run at all. `74a3be9` is the last commit
  where `restful-tasks` is plain `Deno.serve` and imports the real client
  (`jsr:@supabase/supabase-js@2`).
- **Known weaknesses of this choice, stated in advance:**
  - It is a single file, and all of its named functions are top-level. That suits a recorder
    that only instruments the entry file (doc 06 non-goal).
  - It has **no `EdgeRuntime.waitUntil`**, so the waitUntil checks use a separate synthetic probe
    (below).
  - It has **no test suite**, so check F and the "record `deno test`" item have nothing to run against.
- **Local services (all on 127.0.0.1, nothing deployed):**
  - Real PostgreSQL 16 (system install) with a `public.tasks(id bigserial, name text, status int)`
    table. There is no migration for it in the repo, so the harness creates it.
  - Real PostgREST 12.2.12 (release binary) in front of that database.
  - A small Node reverse proxy on `:54321` that maps `/rest/v1/*` to PostgREST, as Supabase's Kong
    gateway does. It logs each request's method, URL and `traceparent` header. That log is the
    ground truth for outbound calls.
  - Env for the function: `SUPABASE_URL=http://127.0.0.1:54321`, `SUPABASE_ANON_KEY=<local JWT>`.
    Callers send `Authorization: Bearer <JWT with role=authenticated>`, signed with the local
    PostgREST secret.
- **No app source edits.** The recorder gets only a run command, `--app restful-tasks` and env vars.

## Source facts the expectations rest on (index.ts @ 74a3be9)

| Line | Fact |
|---|---|
| 5 | `import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'` |
| 18-26 | `async function getTask(supabaseClient, id)`: `.from('tasks').select('*').eq('id', id)`; `if (error) throw error` (20); returns 200 JSON `{task}` |
| 28-36 | `async function getAllTasks(supabaseClient)`: `.from('tasks').select('*')`; returns 200 `{tasks}` |
| 38-46 | `async function deleteTask(supabaseClient, id)`: `.from('tasks').delete().eq('id', id)`; returns 200 `{}` |
| 48-56 | `async function updateTask(supabaseClient, id, task)`: `.from('tasks').update(task).eq('id', id)`; returns 200 `{task}` |
| 58-66 | `async function createTask(supabaseClient, task)`: `.from('tasks').insert(task)`; returns 200 `{task}` |
| 68 | `Deno.serve(async (req) => {`: the handler is an **anonymous arrow** |
| 72-74 | `OPTIONS` returns `new Response('ok', {headers: corsHeaders})` (200) before any client is made |
| 78-90 | `createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {global:{headers:{Authorization: req.headers.get('Authorization')!}}})` |
| 93-95 | `URLPattern({pathname: '/restful-tasks/:id'})` gives the id |
| 98-101 | `POST`/`PUT` read `await req.json()` and use `body.task` |
| 104-117 | dispatch, `return getTask(...)` etc. **without `await`** |
| 118-125 | `catch (error)` returns 400 `{error: error.message}`. Because 106-116 return the promise without awaiting it, a rejection from `getTask` & co. is **not** caught here. It escapes the `Deno.serve` handler and Deno answers 500. |

## Ground-truth requests (check C)

All requests go to `http://127.0.0.1:8000`. "Stamped" means the request carries a valid
`traceparent: 00-<32 hex>-<16 hex>-01`. Each stamped request uses a distinct trace id.
Task ids refer to rows the harness seeds before the run: id 1 "seed-1", id 2 "seed-2", id 3 "seed-3".

A correct recording of each stamped request must contain:

| # | Request | Server event | App functions (call + return) | Outbound HTTP (http_client_request, then response) | Exceptions |
|---|---|---|---|---|---|
| R1 | `OPTIONS /restful-tasks` | `http_server_request` OPTIONS `/restful-tasks`, then `http_server_response` 200 | anonymous handler (68) only. No named function. | none | none |
| R2 | `GET /restful-tasks` | GET `/restful-tasks` 200 | `index.getAllTasks` (index.ts:28), 1 call, returns a `Response` | GET `http://127.0.0.1:54321/rest/v1/tasks?select=*` 200. Table `tasks`, no filter. | none |
| R3 | `GET /restful-tasks/1` | GET `/restful-tasks/1` 200 | `index.getTask` (index.ts:18), params (supabaseClient, `"1"`) | GET `.../rest/v1/tasks?select=*&id=eq.1` 200. Table `tasks`, `WHERE id = 1`. | none |
| R4 | `POST /restful-tasks` body `{"task":{"name":"acc-new","status":0}}` | POST `/restful-tasks` 200 | `index.createTask` (index.ts:58), params (supabaseClient, `{name:"acc-new",status:0}`) | POST `.../rest/v1/tasks` 201 (insert into `tasks`) | none |
| R5 | `PUT /restful-tasks/1` body `{"task":{"name":"renamed","status":1}}` | PUT `/restful-tasks/1` 200 | `index.updateTask` (index.ts:48), params (supabaseClient, `"1"`, task) | PATCH `.../rest/v1/tasks?id=eq.1` 204. `UPDATE tasks ... WHERE id = 1`. | none |
| R6 | `DELETE /restful-tasks/2` | DELETE `/restful-tasks/2` 200 | `index.deleteTask` (index.ts:38), params (supabaseClient, `"2"`) | DELETE `.../rest/v1/tasks?id=eq.2` 204. `DELETE FROM tasks WHERE id = 2`. | none |
| R7 | `GET /restful-tasks/not-a-number` | GET 500 (the rejection escapes; see line 118 note) | `index.getTask` (18), whose return event carries `exceptions: [{class: "PostgrestError", message contains 'invalid input syntax for type bigint: "not-a-number"'}]` | GET `.../rest/v1/tasks?select=*&id=eq.not-a-number` 400 | the PostgrestError above (check E) |
| R8 | `POST /restful-tasks` with body `not json` | POST 400 (caught at 118, body `{error: ...}`) | anonymous handler only. The SyntaxError is caught inside it, so no exception event is expected on a named function. | none | none on named functions |

Across all of the above:
- `sql_query` events: **none expected.** The app has no SQL driver. Every DB touch is an HTTP
  call to PostgREST, so the table and filter evidence is the request URL (method + path + filter).
- The anonymous `Deno.serve` arrow (line 68) is the real entry function. A complete recording
  would show it, but it has no name, and the recorder only wraps named top-level declarations
  (transform.ts). **Decided now:** its absence is reported as a gap in C and does not by
  itself fail C. C passes if every row's server event, status, named functions (with the
  right params) and outbound calls are present and correct, and there is nothing extra.
- supabase-js internals (`jsr:`/`npm:` code) must not appear as function events (check D). Only
  `index.ts` functions should appear.

## traceparent gate (from doc 05, deno/appmap.ts:105-111)

- T1. `GET /restful-tasks` with **no** `traceparent`: request served normally (200), **no** AppMap file written.
- T2. `GET /restful-tasks` with a **malformed** `traceparent` (e.g. version `ff`/uppercase hex/short id): no file.
- T3. A stamped request: exactly one file. `metadata.trace_id` equals the incoming trace id and
  `metadata.parent_span_id` equals the incoming span id. `http_server_request.headers.traceparent`
  equals the incoming header.
- T4. A stamped request's outbound PostgREST calls carry `traceparent: 00-<same trace id>-<new 16-hex span>-01`.
  This shows in the proxy log and in `http_client_request.headers.traceparent`.
- T5. An unstamped request's outbound PostgREST calls carry **no** recorder-added `traceparent`
  (proxy log). Doc 02/05 say production traffic is left untouched.
- T6. doc 05: a stamped request that arrives while another recording is open runs unrecorded (no file).

## waitUntil (synthetic probe, not the app)

The app has no `EdgeRuntime.waitUntil`. A separate, clearly labelled **synthetic probe**
`acceptance/supabase-restful-tasks/probe/probe.ts` (Supabase edge-function style, plain
`Deno.serve`) is used instead. It defines a minimal `EdgeRuntime.waitUntil` shim only if the
host has none: plain `deno run` has no `EdgeRuntime`, and Supabase Edge Runtime cannot be
reached by the zero-touch runner (doc 06). Routes:

- W1. `POST /probe/ingest?n=<k>`: calls `EdgeRuntime.waitUntil(ingest(k))` and returns **202** at once.
  `ingest` does: POST `/rest/v1/tasks` (insert `probe-<k>`), sleeps 1.5 s, GET the local
  "enrich" stub `http://127.0.0.1:54399/enrich?n=<k>`, sleeps 1.5 s, PATCH
  `/rest/v1/tasks?name=eq.probe-<k>`. Expected:
  - the client gets 202 in well under 1 s;
  - the recording contains `http_server_response` 202, one `ingest` call/return pair, and all 3
    `http_client_request`s with their responses (201, 200, 204);
  - the file appears only after the background work finishes (at least 3 s after the 202), and
    has no `truncated` flag;
  - the events are balanced.
- W2. `POST /probe/fire-and-forget?n=<k>`: starts `ingest(k)` **without** waitUntil and returns 202.
  Expected per doc 11: the recording closes at the response, and the still-open `ingest` call
  gets a synthesized return with `metadata.truncated: true`. This is the self-heal path.
- W3. Crash mid-recording: start W1, then `kill -9` the deno process about 1.5 s into the
  background window. Doc 11 claims "even a genuinely killed isolate yields a balanced,
  sanitizable, committable (if incomplete) map". Expected by that claim: a file with
  `truncated: true` and balanced events. (Predicted from reading `deno/appmap.ts`: `ship()` runs
  only in `finalize()`, so a killed process writes **nothing**. The run decides which is true.)
  The same is repeated with SIGTERM and SIGINT through the `appmap-deno` wrapper.

## Other checks

- B. `appmap-validate` (official, appmap-js `packages/validate`) and `appmap index` /
  `appmap sequence-diagram` must accept every recording. Declared `version: "1.12"` must be
  honest. Required fields (spec README) that I expect to be **missing** from reading
  recording.ts/appmap.ts: `metadata.language.version` (appmap.ts:119 sets name+engine only) and
  exception `object_id` (recording.ts:216-219). Also expected: `http_client_request.url` includes
  the query string, though the spec says "excluding the query string".
- D. Events by package: only the app package (path of `index.ts`). Zero events from supabase-js,
  jsr/npm deps, or the recorder itself.
- G. The same request sequence recorded twice gives identical normalized sequence diagrams per request.
- H. One change on a scratch copy: `deleteTask` first reads the row
  (`.from('tasks').select('*').eq('id', id)`) before deleting. Expected diff: only the DELETE
  request changes, gaining exactly one GET `.../rest/v1/tasks?select=*&id=eq.<id>`. Every other
  request is unchanged.
- I. 20 stamped requests fired at once across the routes, each with a unique trace id and
  (where it has one) a unique task id, mixed with unstamped ones. Expected by doc 05/11: some
  requests are recorded and the rest run unrecorded. **Every file that exists must contain only
  its own request**: one `http_server_request` whose path matches, named functions for that route
  only, and outbound URLs with its own id only. In the proxy log, every outbound call stamped
  with that file's trace id must belong to that request.
- J. Overhead: wall time for 200 sequential mixed requests, plain `deno run` vs `appmap-deno`
  with every request stamped.
- F. The app has no tests, and the recorder has no Deno test-recording mode. Expected: NOT
  APPLICABLE / NOT RUN, with the reason.
