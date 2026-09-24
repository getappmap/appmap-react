// Zero-touch entry point (docs/design/06): run with
// `deno run --preload preload.ts <entry>` (bin/appmap-deno.ts does this
// for you) and the entry file's own, completely unmodified
// `Deno.serve(handler)` call gets recorded — no import, no manual
// withAppMap(...) wrap in application code.
//
// Mechanism: Deno's `--preload` flag runs this file before the main
// module, so by the time the entry file's top-level `Deno.serve(...)`
// call executes, `Deno.serve` is already this patched version.
//
// Deno.serve has three real call shapes (confirmed against `deno
// types`, not guessed): a bare handler, an options object plus a
// handler, and an options object with the handler embedded as
// `.handler`. All three are handled below; anything else (notably the
// separate `export default { fetch } satisfies Deno.ServeDefaultExport`
// convention used by the `deno serve` subcommand, which never calls
// `Deno.serve()` at all) passes through unrecorded rather than guessing.

import { withAppMap } from './appmap.ts';

type AnyHandler = (...args: unknown[]) => Response | Promise<Response>;

const appName = Deno.env.get('APPMAP_APP');
const original = Deno.serve as unknown as (...args: unknown[]) => unknown;

function wrap(handler: AnyHandler): AnyHandler {
  // withAppMap's Handler type is (req: Request) => Response|Promise —
  // real Deno.serve handlers may also take a second `info` (remote
  // address) argument, which withAppMap does not forward. This is an
  // existing limitation of withAppMap itself (see deno/appmap.ts),
  // not something the preload path introduces.
  return withAppMap(handler as (req: Request) => Response | Promise<Response>, {
    app: appName,
  }) as AnyHandler;
}

Deno.serve = ((...args: unknown[]) => {
  const [first, second] = args;

  if (typeof first === 'function') {
    return original(wrap(first as AnyHandler), ...args.slice(1));
  }

  if (first && typeof first === 'object') {
    const options = first as Record<string, unknown>;
    if (typeof second === 'function') {
      return original(options, wrap(second as AnyHandler), ...args.slice(2));
    }
    if (typeof options.handler === 'function') {
      return original({ ...options, handler: wrap(options.handler as AnyHandler) });
    }
  }

  return original(...args);
}) as unknown as typeof Deno.serve;
