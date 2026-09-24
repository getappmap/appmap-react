# 3. Build-time instrumentation

Status: **accepted**, validated by converting the example app from
hand-instrumentation to the transform: the same RTL suite passes and
the AppMaps come out richer (see "What the spike proved"). The plugin
is [`recorder/src/vitePlugin.ts`](../../recorder/src/vitePlugin.ts).

## The role

This is the React agent's analogue of the Go agent's toolexec wrapper
(its doc 02) — with one decisive difference: Vite transforms are a
first-class, documented extension point, so we don't have to own the
toolchain. The plugin runs `enforce: 'pre'` (before Vite's own
TS/JSX compile), parses each selected module with Babel
(`typescript` + `jsx` parser plugins), rewrites it, and returns code +
sourcemap. Vitest shares the Vite pipeline, so tests get the transform
with zero extra configuration.

## What it injects

Exactly the wrapper that doc 01's hand-instrumentation spike applied
manually — the spike was the specification:

```ts
// before
export function OwnerDetail() { … }
const useOwnerSearch = () => { … }

// after
import { autoInstrument as __appmap_instrument__ } from '@funwithappmap/react-recorder';
export function OwnerDetail() { … }
OwnerDetail = __appmap_instrument__(OwnerDetail, { definedClass, methodId, path, lineno }, argNames);
const useOwnerSearch = __appmap_instrument__(() => { … }, info, argNames);
```

Mechanical notes:

- **Function declarations** are mutable bindings and ESM exports are
  live, so reassigning after the declaration rebinds the export too.
  `export const` initializers are wrapped in place.
- **Function identity** (`definedClass` = module basename, `methodId`,
  `path`, `lineno`) comes from the Babel AST — real line numbers,
  unlike the hand-maintained ones the spike used.
- **Labels by convention** at runtime (`autoInstrument`): PascalCase →
  `component`, `use[A-Z]…` → `hook`. The .NET agent reads attributes
  and Go reads nothing; in React-land naming conventions are load-
  bearing (the rules of hooks depend on them), so they're reliable.

## Selection: top-level functions in configured paths

The appmap.yml equivalent is the plugin's options:

```ts
appmapVitePlugin({ include: ['src'], exclude: ['src/generated'] })
```

Granularity: **top-level functions only** (declarations and
function-valued `const`s, including exported ones). Nested closures —
the `search` callback inside `useOwnerSearch`, a submit handler inside
a component — are below the transform's line. Two reasons:

1. Instrumenting every closure floods maps with anonymous frames
   (every `useEffect` body, every `map()` callback).
2. The hand wrappers (`instrumentHandler` etc.) still exist and
   compose with the transform — the example keeps two of them on
   nested handlers, and both auto and manual events appear in the same
   map. Manual wrapping is the precision tool; the transform is the
   coverage tool.

Skipped for now (revisit when real apps need them): `export default
function`, class methods, generator functions.

## Dev/test-only gating

The transform applies when Vite's resolved `mode !== 'production'`
(override: `force: true`). Verified by building the example for
production and grepping the bundle: **no `__appmap_instrument__`, no
`autoInstrument` — and no `traceparent` either**, because with no
recording ever started, tree-shaking drops the entire fetch-patch
module. The only recorder code a production bundle can retain is a
hand-applied wrapper's null-check (`activeRecording()` returning
`undefined`).

The gating check also caught a real bug: `recorder` originally
re-exported the test-recording module (which imports `node:fs`) from
its main entry point, breaking browser builds outright. Test recording
now lives behind the `./vitest` entry point only — the main entry must
stay browser-loadable, and the production build is the regression test
for that.

## What the spike proved

The example app's top-level hand-instrumentation was deleted
(`api/client.ts`, all pages, the hook — compare this commit's diff)
and the plugin added to `vite.config.ts`. Outcome:

- the same 8 RTL tests pass unchanged, still one AppMap per test, and
  `npm run link:demo` still links 13/13 requests;
- the maps got **richer**: previously-unwrapped functions now appear
  (`client.request` between `getOwner` and the fetch; `ClinicProvider`
  and `useClinic`, which were never hand-wrapped), with labels applied
  by convention:

```
src/context/ClinicContext/ClinicProvider  @src/context/ClinicContext.tsx:11  [component]
src/context/ClinicContext/useClinic       @src/context/ClinicContext.tsx:21  [hook]
src/pages/OwnerDetail/OwnerDetail         @src/pages/OwnerDetail.tsx:7      [component]
src/api/client/getOwner                   @src/api/client.ts:33
src/api/client/request                    @src/api/client.ts:16
…
5 call OwnerDetail.OwnerDetail
6 call ClinicContext.useClinic
9 call client.getOwner
10 call client.request
11 call GET http://localhost:8080/owners/1
```

## Consequences

- Doc 01's hand-instrumentation API stops being the user-facing
  surface and becomes (a) the transform's runtime and (b) the
  precision tool for nested functions.
- The transform emits TSX→TSX with sourcemaps and leaves type
  checking untouched (`tsc` never sees transformed code).
- Anything Vite doesn't compile (a dependency, inline `new Function`)
  is invisible to the transform — same blind spot as Go's toolexec
  with pre-built dependencies, and the same answer: instrument at the
  boundary you own.

## Amendment 2026-08-28: transform extracted, host-agnostic

Prompted by a request to instrument Supabase edge functions (Deno):
the Babel transform now lives in
[`recorder/src/transform.ts`](../../recorder/src/transform.ts)
(`transformSource`), with the Vite plugin reduced to a driver that
selects files, gates on mode, and hosts the collector. Two things made
the transform Deno-ready:

- **No loader hook needed by design** — the transform runs before any
  runtime sees the code, so a runtime only ever executes
  already-instrumented source. For Deno that means a pre-build pass
  over the function source before `deno run` / `supabase functions
  serve`; Deno never has to cooperate.
- **`runtimeModule` option** — module resolution is the one thing
  hosts disagree on. Vite/Node import the runtime by bare npm
  specifier; Deno needs a URL or import-map name. The injected import
  specifier is now configurable.

Verified by `examples/petclinic-react/test/transform.test.ts`, which
transforms a `Deno.serve`-shaped edge function with a URL runtime
specifier and asserts the wrapping and import. The recorder core is
already Deno-compatible (`performance.now`, `crypto.getRandomValues`,
`fetch`/`Request`/`Headers`; `node:fs` is quarantined behind
`./vitest`) — what a Deno port still needs is an output writer
(`Deno.writeTextFile` or POST to a collector) and a per-request
session driver that copies the incoming traceparent into metadata,
i.e. the Deno twin of the PetClinicGo middleware.

## Amendment (2026-09-24): JSX in `.js` files; a file that does not parse is left alone

The Vite plugin enabled Babel's JSX parser only for `.jsx`/`.tsx`, and
parsed everything with the TypeScript plugin. A Create React App keeps
its JSX in `.js` files (`acceptance/supabase-edge-functions-app`, bug 1):
every component failed with `Unexpected token`, Vite served a 500 and the
app did not render. The syntax now follows the extension
(`syntaxFor` in `recorder/src/transform.ts`): `.js`/`.mjs`/`.cjs`/`.jsx`
parse as JavaScript with JSX (Babel reads JSX-free JavaScript exactly as
before), `.ts`/`.mts`/`.cts` as TypeScript without JSX (so `<T>x` type
assertions keep working), `.tsx` as both. Emitting the JSX is still the
app's toolchain's job; the transform only instruments and keeps it.

And a recorder must never break the app: if the transform still cannot
parse a file, the plugin now serves it uninstrumented and prints
`appmap: not instrumenting <file>: <reason>` instead of failing the
request. Tests: `recorder/test/vitePluginSelection.test.ts`.

## Amendment (2026-09-24): globs in `include`/`exclude`; test files excluded by default

`exclude` took only directory prefixes. bulletproof-react co-locates its
tests (`src/**/__tests__/*.test.tsx`), so with `include: ['src']` the
functions its test files define (`renderDiscussion`, `TestDialog`,
`TestDrawer`) were recorded as app code, and the only way to keep them
out was to list every test directory by hand
(`acceptance/bulletproof-react`, bug 8).

`include` and `exclude` entries are now either a directory prefix / file
(as before) or a glob matched against the project-relative path: `*`
within a segment, `**` across segments, `?`, `{a,b}`
(`recorder/src/pathMatch.ts`). And test code is excluded by default —
`DEFAULT_TEST_EXCLUDE`:

```
**/__tests__/**
**/__mocks__/**
**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}
```

`defaultExclude: [...]` replaces that list; `defaultExclude: false`
instruments test files too. Tests: `recorder/test/vitePluginSelection.test.ts`.
