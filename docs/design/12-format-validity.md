# 12 — Format validity and the declared version

**Status:** implemented. Every recording mode's output is checked with
the official validator, `@appland/appmap-validate` (getappmap/appmap-js
`packages/validate`, the validator the spec README links), in
`recorder/test/validity.test.ts` and `deno/test/withAppMap.test.ts`.

## Why

The recorder declared `"version": "1.12"` from day one, but nothing
checked it. An acceptance run on two real apps (bulletproof-react and a
Supabase edge function) validated every recording it produced with the
official validator: **0 of 29 and 0 of 49 were valid**, at 1.12 and at
every other version from 1.2 to 1.13.1. The label was unearned.

## What was wrong, and what the recorder does now

| Problem | Fix |
|---|---|
| `metadata.frameworks[]` had no `version` (required). | Test recordings fill each framework's version from the installed package (`vitest`, and `react` when installed); a framework that can't be found is left out rather than listed without a version. |
| `metadata.language.version` missing on Deno maps (required whenever `language` is present). | `{ name: 'typescript', engine: 'deno', version: Deno.version.typescript }`. Browser interaction maps still carry no `language` (optional). |
| Values capped at 1024 characters, plus a `…` appended *after* the cut (1025). Schemas 1.6+ allow 100. | `VALUE_SIZE_CAP` is 100 and the `…` counts toward it; a cut never splits a surrogate pair. `APPMAP_EVENT_VALUESIZE` still overrides it. |
| `exceptions[]` had no `object_id` (required). | Objects get their recording-wide `object_id`; thrown primitives get a fresh one. |
| `http_client_request` / `http_server_request` had no `message` (required from 1.5). `url` kept the query string, which the spec says it excludes. | `url` is origin + path; the query parameters are the event's `message` (`{ name, class: 'String', value }`), `[]` when there are none. The same for `http_server_request`. |
| A failed fetch was closed with `status_code: 0`; a self-healed (truncated) HTTP call got a bare synthetic return. Both are invalid: an HTTP call can only be closed by an `http_*_response` with a 100–599 status. | Such calls are left out of the event stream (their children move up to their parent) and listed in `metadata.unanswered_http_requests` with the reason (`network error` or `no response before the recording closed`). The caller still records the thrown error. |
| Calls didn't nest. Each HTTP event and every call made after an `await` landed on its own `thread_id`, so standard tools (which rebuild the tree positionally per thread) saw a flat set of roots: a Deno request's official sequence diagram had three disconnected roots — server request, handler, outbound call. And a sync caller returning while the async work it started was still running broke nesting on its thread (validator: `expected parent id of return event #56 to be 55 but got 51`). | Every call records the call it was made from: the synchronous caller, or — where the runtime has async context (Node, Deno) — the call whose async continuation is running (`session.ts` `runInCall`). `toAppMap()` emits the events as that tree on one thread, ids renumbered in tree order: each call sits between its parent's call and return. A Deno request is one tree rooted at its `http_server_request`; `onSubmit → search → findOwners → GET` nests even though `onSubmit` returned first. The live `events` list keeps its original order and thread assignment. |
| classMap entries were keyed by name only, so two same-named functions in one file (e.g. two inline `onClick` handlers) lost one entry and the validator reported a call "missing in classmap". | Keyed by name and location. |

In the browser there is no async context, so a call made from an async
continuation there has no known parent and becomes a root (valid, just
flatter).

## The declared version

With these fixes every recording from both acceptance apps and this
repo's example passes the validator at every schema version from 1.6.0
to 1.13.1 (1.2–1.5 need parameter `object_id`/`receiver` fields the
recorder does not always write). The recorder declares **1.12**:

- 1.13.x differs from 1.12 only by an optional `timestamp` on events,
  which the recorder does not emit, so claiming 1.13 would add nothing;
- 1.12 is also what the official Node agent (`appmap-node`) declares;
- `examples/petclinic-react/test/interactionRecorder.test.tsx` pins the
  declared version at 1.12.

`APPMAP_VERSION` in `recorder/src/recording.ts` is the single place the
version lives. If it changes, the validity tests check the new claim.

## Credential redaction

AppMaps get committed, attached to PRs and shared, so credentials must
not reach them. The acceptance runs found a plaintext password
(`"password":"secret-pw-1"`) in a React parameter value and a 191-char
`Authorization: Bearer …` token in a Deno one. `recorder/src/redact.ts`
now applies to every captured value (parameters, return values,
exception messages, HTTP headers and query parameters):

- a parameter, object property, query parameter or header whose name
  matches `password|secret|token|api[_-]?key` (case-insensitive) is
  recorded as `"[REDACTED]"`;
- `Authorization`, `Proxy-Authorization`, `Cookie` and `Set-Cookie`
  headers are always `"[REDACTED]"`;
- `Bearer <token>` inside any captured string becomes
  `Bearer [REDACTED]`.

Tested in `recorder/test/redaction.test.ts`.
