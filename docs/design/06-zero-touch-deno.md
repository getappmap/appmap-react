# 6. Zero-touch recording for Deno

Status: **accepted for plain `deno run`; explicitly not solved for
Supabase Edge Runtime** — see "The gap" below. Validated by
[`deno/test/preload.test.ts`](../../deno/test/preload.test.ts) (the
monkey-patch, under plain Node/Vitest) and
[`examples/deno-edge`](../../examples/deno-edge)'s smoke test, which
now runs `src/petLookup.ts` completely unmodified — no import, no
`withAppMap(...)` call — through the real `deno` binary and asserts on
the recorded AppMap.

## Why doc 05 wasn't the end of it

Doc 05 landed a working driver, but it required exactly the pattern a
getappmap maintainer had already flagged, in writing, as wrong for the
.NET agent's PR ([getappmap/appmap-dotnet#34](https://github.com/getappmap/appmap-dotnet/pull/34)):
"Using AppMap shouldn't require modifying production code." Doc 05's
`withAppMap` required a manual import, refactoring the handler into a
named top-level function, and hand-rewriting `Deno.serve(handler)`
into `Deno.serve(withAppMap(handler, {...}))`. That PR's resolution
was a runner (`appmap-dotnet -- dotnet run`) that sets
`DOTNET_STARTUP_HOOKS` and auto-injects, with explicit wiring demoted
to a documented "advanced/more control" path. This doc is that
resolution for Deno.

## The mechanism: `--preload`

`deno run` has a real, first-class equivalent of `DOTNET_STARTUP_HOOKS`:

```
--preload <file>   A list of files that will be executed before the main module
```

[`deno/preload.ts`](../../deno/preload.ts) monkey-patches
`globalThis.Deno.serve` when loaded this way — by the time the entry
file's own, untouched `Deno.serve(handler)` call runs, `Deno.serve` is
already the patched version. `Deno.serve` has three real call shapes
(confirmed against `deno types`, not guessed):

```ts
Deno.serve(handler)
Deno.serve(options, handler)
Deno.serve({ ...options, handler })
```

All three are handled; anything else (notably the separate `export
default { fetch } satisfies Deno.ServeDefaultExport` convention used
by the `deno serve` *subcommand*, which never calls `Deno.serve()` at
all) passes through unrecorded rather than guessing.

## The runner: `appmap-deno`

Per-function instrumentation (the existing Babel transform) still
needs to run *before* Deno parses the file — there's no loader-hook
equivalent to intercept that. So [`deno/bin/appmap-deno.ts`](../../deno/bin/appmap-deno.ts)
does what the transform step used to require a human to do by hand:

```
node --experimental-strip-types deno/bin/appmap-deno.ts [--app <name>] <entry> [-- <extra deno run args>]
```

1. Reads the real entry file, **never modified on disk**.
2. Runs it through the existing `transformSource` — unchanged from
   doc 03/05, no new visitor needed.
3. Writes the transformed copy to `.appmap.<basename>` **next to the
   original** — not a temp directory — so the file's own relative
   imports (`../_shared/foo.ts`) resolve exactly as they would for the
   real file.
4. Execs `deno run --preload deno/preload.ts -A --unstable-sloppy-imports
   <passthrough args> <transformed copy>`, with `APPMAP_APP` set from
   `--app` (or the entry's basename).
5. Deletes the transformed copy when the child exits, including on
   `SIGINT`/`SIGTERM`.

The entry file itself is identical before and after — `git diff` on it
shows nothing.

## The gap: Supabase Edge Runtime

Checked, not assumed: **Supabase Edge Runtime is not the `deno` CLI**.
It's a custom Rust server embedding Deno core, with its own flag
surface (`--import-map`, `--debug`, `--use-api`, environment
variables) and no `--preload` or equivalent hook. Import maps remap
module *specifiers*; they cannot intercept a global like `Deno.serve`.

This is doc 05's `withAppMap` + manual wiring's actual reason to keep
existing: it's the only path into the real target this project's
downstream user runs on. The zero-touch runner in this doc covers
plain `deno run` / self-hosted Deno (Deno Deploy unverified — same
"is it really the CLI, or a custom embedding?" question applies and
hasn't been checked). Following the .NET PR's own precedent for
System.Web (a documented, named gap rather than a silent one): **there
is currently no zero-touch path onto Supabase Edge Functions.** Manual
`withAppMap` wiring is the supported, documented path there, same as
explicit `UseAppMap` stayed supported and documented for .NET's
advanced cases.

## Non-goals (this doc)

- Instrumenting a function's transitive local imports (e.g.
  `_shared/*.ts`) — `appmap-deno` transforms only the one entry file
  passed to it, matching doc 05's manual scope. A separate decision.
- A labels mechanism requiring no import (the `AppMap.Attributes` /
  `com.appland.appmap.annotation` equivalent) — related, not done
  here.
- Solving the Supabase gap — named above, not attempted.

## Known limitation carried over from doc 05

`withAppMap` (and therefore the preload-wrapped handler) only forwards
a request's first argument to the developer's handler. Real
`Deno.serve` handlers may take a second `info` argument (remote
address); it is silently dropped. Pre-existing, not introduced by this
doc — noted here because the preload path makes it easier to hit by
accident (a handler using `info` now "just works" until it doesn't).
