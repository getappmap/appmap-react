# 7. Zero-touch interaction recording for React

Status: **accepted**, validated against a real `vite` dev server and a
real production build (not just a unit test) — see "What the spike
proved."

## Why this needed its own doc

Doc 06 closed the zero-touch gap for Deno, prompted by a getappmap
maintainer's review on a sibling agent's PR
([getappmap/appmap-dotnet#34](https://github.com/getappmap/appmap-dotnet/pull/34)):
"Using AppMap shouldn't require modifying production code." Checking
this repo's own React side against that same standard found the exact
same violation, just on the frontend: `examples/petclinic-react/src/main.tsx`
explicitly imported and called `installInteractionRecorder({ app: ... })`.
That's application code, not build config — the same category of
problem as Deno's manual `Deno.serve(withAppMap(handler))`, and it had
been sitting there since doc 04 without anyone naming it as a gap.

## The mechanism: `transformIndexHtml` + a virtual module

Vite plugins get a documented hook for injecting into the served page
without touching application source:
[`transformIndexHtml`](https://vite.dev/guide/api-plugin.html#transformindexhtml).
This is exactly how `@vitejs/plugin-react` itself injects its own Fast
Refresh preamble — confirmed by inspecting a real dev server's served
HTML, not assumed:

```html
<script type="module">import { injectIntoGlobalHook } from "/@react-refresh"; ...</script>
<script type="module">import "virtual:appmap-interaction-recorder";</script>
```

`appmapVitePlugin`'s new `app` option, when set:

1. `transformIndexHtml` injects a `<script type="module">` tag
   importing a virtual module id.
2. `resolveId`/`load` serve that id as `import {
   installInteractionRecorder } from '@funwithappmap/react-recorder';
   installInteractionRecorder({ app: <app> });` — real content Vite's
   dev server resolves and serves like any other module (confirmed via
   `/@id/virtual:appmap-interaction-recorder` on a running dev server).
3. Both hooks are gated by the same `enabled` flag the existing
   transform already computes in `configResolved` (dev/test only,
   unless `force`), so this can't leak into a production bundle any
   more than the transform itself can.

`main.tsx` now imports and calls nothing. The one change outside
`recorder/` is `vite.config.ts` gaining `app: 'petclinic-react'` on
the plugin options it already had — build config, not application
code, the same category doc 03's Vite plugin registration already was.

## What the spike proved

Checked against the real thing, not just `examples/petclinic-react/test/vitePlugin.test.ts`'s
direct hook calls (which cover the logic but never touch Vite's actual
HTML/module pipeline):

- **A real `vite` dev server** serves the injected script tag in its
  actual HTML response, and `/@id/virtual:appmap-interaction-recorder`
  resolves to the expected `installInteractionRecorder({"app":"petclinic-react"})`
  content, pulling the real recorder from
  `/@fs/.../recorder/src/index.ts`.
- **A real production build** (`vite build`) contains zero trace of
  `appmap`, `installInteractionRecorder`, or `__appmap_instrument__`
  anywhere in the output HTML or JS — grepped directly, the same way
  doc 03 verified the build-time transform's own production gating.

## Consequences

- `installInteractionRecorder` itself is unchanged and still exported
  — it's the documented path for a caller who wants non-default
  options (a different `idleMs`, a custom collector URL) or doesn't
  use the Vite plugin at all. De-emphasized, not removed, matching
  how explicit `UseAppMap` stayed supported and documented for .NET's
  advanced cases.
- This closes the React side of the same audit that produced doc 06.
  Between the two, neither this project's frontend nor its Deno-run
  backend example requires an application-code change to record.
  Supabase Edge Functions remain the one named, unsolved exception
  (doc 06's Tier 2).

## Amendment (2026-09-24): the injected import never loaded in a browser

The checks above looked at the served HTML text and at the `/@id/` URL
separately — never at a browser loading the one from the other. In
real Chromium the page carried
`<script type="module">import "virtual:appmap-interaction-recorder";</script>`
and the browser refused it (*"Cross origin requests are only supported
for protocol schemes: http, …"*), so zero-touch interaction recording
**never started** — on this repo's own example (Vite 6) and on
bulletproof-react (Vite 5).

Why: a plain-function `transformIndexHtml` is a *normal-order* hook,
and Vite runs normal hooks after its own dev-HTML pass that rewrites
module imports to servable URLs. Our injected bare `virtual:` specifier
was added after that rewrite and reached the browser as-is.
(`@vitejs/plugin-react` gets away with the same hook because it injects
an already-servable URL, `<base>@react-refresh`.)

Fix: the plugin now does what plugin-react does and injects the URL
Vite itself serves the virtual module at —
`import "<base>@id/__x00__virtual:appmap-interaction-recorder"` — which
goes through Vite's normal module pipeline (the module's own import of
the recorder is rewritten by Vite as usual). In a production build with
`force`, the recorder is emitted as its own chunk in `buildStart` and
the page links that chunk.

Proof, this time in the pipeline a browser uses:

- `recorder/test/vitePlugin.test.ts` starts a real Vite dev server
  (bases `/` and `/sub/`), fetches the page, resolves the injected
  specifier against the page URL exactly as a browser would, and
  fetches it and the recorder it imports (fails before the fix:
  the specifier resolves to a `virtual:` URL). It also runs a forced
  production build and checks the linked chunk.
- Headless Chromium (Playwright) on the example app's dev server and on
  bulletproof-react's: the page loads the recorder with no console
  error, and a click writes an interaction map to the collector.
