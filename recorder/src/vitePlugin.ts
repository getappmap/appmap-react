import { mkdirSync, writeFileSync } from 'node:fs';
import { relative, join } from 'node:path';
import type { IndexHtmlTransformContext, Plugin } from 'vite';
import { transformSource } from './transform.js';
import {
  PROPAGATE_ENV,
  parseOriginPatterns,
  serializeOriginPatterns,
  type OriginPattern,
} from './propagation.js';

const COLLECTOR_PATH = '/__appmap/interactions';
const COLLECTOR_BODY_LIMIT = 50 * 1024 * 1024;
const INTERACTION_RECORDER_VIRTUAL_ID = 'virtual:appmap-interaction-recorder';
const RESOLVED_INTERACTION_RECORDER_VIRTUAL_ID = `\0${INTERACTION_RECORDER_VIRTUAL_ID}`;

// Build-time instrumentation (docs/design/03). This plugin is the React
// agent's analogue of the Go agent's toolexec wrapper — except Vite
// transforms are a first-class, documented extension point, so we don't
// have to own the toolchain. The transform itself is host-agnostic and
// lives in ./transform (also usable as a standalone pre-build pass for
// runtimes without a loader hook, e.g. Deno); this plugin selects files,
// gates on mode, and hosts the interaction collector.
//
// Labels (component / hook) are derived at runtime from naming
// conventions. Nested functions and handlers are handled by the transform.
//
// Gating: the transform applies in dev and test, never in production
// builds, unless `force` overrides.

export interface AppMapPluginOptions {
  /** Project-root-relative directory prefixes to instrument (the
   * appmap.yml `packages:` equivalent), e.g. ['src']. */
  include: string[];
  /** Directory prefixes to skip within include. */
  exclude?: string[];
  /** Instrument even in production builds. Default: never. */
  force?: boolean;
  /** App name for zero-touch interaction recording injection. */
  app?: string;
  /** Cross-origin backends whose requests get a `traceparent` header, so
   * their AppMaps can be linked to the frontend's: origins
   * ('https://api.example.com'), RegExps tested against the request URL,
   * or '*'. Same-origin requests are always stamped; other cross-origin
   * requests never are, because a header the backend's CORS does not
   * allow makes the browser block the request. A listed backend must
   * list `traceparent` in its Access-Control-Allow-Headers. Also read
   * from APPMAP_PROPAGATE_TRACE_HEADER_ORIGINS (comma-separated). Applies
   * to browser interaction recording and to Vitest test recording. */
  propagateTraceHeaderOrigins?: OriginPattern[];
}

export function appmapVitePlugin(options: AppMapPluginOptions): Plugin {
  let root = process.cwd();
  let base = '/';
  let enabled = true;
  let building = false;

  const selected = (id: string): string | undefined => {
    const file = id.split('?')[0];
    if (!/\.[jt]sx?$/.test(file) || file.includes('/node_modules/')) return undefined;
    const rel = relative(root, file);
    if (rel.startsWith('..')) return undefined;
    if (!options.include.some((dir) => rel === dir || rel.startsWith(dir + '/'))) return undefined;
    if (options.exclude?.some((dir) => rel === dir || rel.startsWith(dir + '/'))) return undefined;
    return rel;
  };
  const propagateOrigins = [
    ...(options.propagateTraceHeaderOrigins ?? []),
    ...parseOriginPatterns(process.env[PROPAGATE_ENV]),
  ];

  return {
    name: 'appmap-instrument',
    enforce: 'pre',
    config() {
      // Vitest runs tests in worker processes spawned after the config is
      // resolved; they inherit this, and the recorder reads it at load
      // (propagation.ts). The browser gets it through the injected
      // interaction recorder instead (load() below).
      if (propagateOrigins.length) process.env[PROPAGATE_ENV] = serializeOriginPatterns(propagateOrigins);
      // APPMAP_EVENT_VALUESIZE, like the .NET agent: propagate the
      // value-size cap into the client bundle, since the in-page
      // recorder has no process.env of its own. Read by recorder/src/
      // index.ts at import time.
      const raw = process.env.APPMAP_EVENT_VALUESIZE;
      const n = raw ? Number(raw) : undefined;
      if (n !== undefined && Number.isFinite(n) && n > 0) {
        return { define: { __APPMAP_EVENT_VALUESIZE__: JSON.stringify(n) } };
      }
      return undefined;
    },
    configResolved(config) {
      root = config.root;
      base = config.base || '/';
      building = config.command === 'build' && !config.build?.ssr;
      enabled = options.force || config.mode !== 'production';
    },
    buildStart() {
      // Production build with `force`: bundle the interaction recorder as
      // its own entry chunk; transformIndexHtml links it below.
      if (building && enabled && options.app) {
        this.emitFile({ type: 'chunk', id: INTERACTION_RECORDER_VIRTUAL_ID, name: 'appmap-interaction-recorder' });
      }
    },
    // The collector (docs/design/04): browsers can't write tmp/appmap/,
    // so the in-page recorder POSTs finished interaction AppMaps here —
    // the remote recording protocol with roles reversed.
    configureServer(server) {
      const outDir = join(root, 'tmp', 'appmap', 'interactions');
      let seq = 0;
      server.middlewares.use(COLLECTOR_PATH, (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
          if (body.length > COLLECTOR_BODY_LIMIT) req.destroy();
        });
        req.on('end', () => {
          try {
            const appmap = JSON.parse(body);
            const name = String(appmap?.metadata?.name ?? 'interaction')
              .replace(/[^a-zA-Z0-9._-]+/g, '_')
              .replace(/^_+|_+$/g, '')
              .slice(0, 150);
            mkdirSync(outDir, { recursive: true });
            const file = join(outDir, `${name}_${String(++seq).padStart(3, '0')}.appmap.json`);
            writeFileSync(file, JSON.stringify(appmap, null, 2));
            server.config.logger.info(`appmap: wrote ${relative(root, file)}`);
            res.statusCode = 204;
            res.end();
          } catch {
            res.statusCode = 400;
            res.end('invalid appmap json');
          }
        });
      });
    },
    async transform(code, id) {
      if (!enabled) return null;
      const rel = selected(id);
      if (!rel) return null;

      return transformSource(code, {
        relPath: rel,
        filename: id,
        jsx: /\.[jt]sx$/.test(id.split('?')[0]),
      });
    },
    resolveId(id) {
      if (!enabled || !options.app) return;
      if (id === INTERACTION_RECORDER_VIRTUAL_ID) return RESOLVED_INTERACTION_RECORDER_VIRTUAL_ID;
    },
    load(id) {
      if (id !== RESOLVED_INTERACTION_RECORDER_VIRTUAL_ID) return;
      const strings = propagateOrigins.filter((p): p is string => typeof p === 'string');
      const regexps = propagateOrigins
        .filter((p): p is RegExp => typeof p !== 'string')
        .map((p) => `new RegExp(${JSON.stringify(p.source)}, ${JSON.stringify(p.flags)})`);
      const json = JSON.stringify({ app: options.app, propagateTraceHeaderOrigins: strings });
      const recorderOptions = regexps.length
        ? `Object.assign(${json}, { propagateTraceHeaderOrigins: ${JSON.stringify(strings)}.concat([${regexps.join(', ')}]) })`
        : json;
      return [
        `import { installInteractionRecorder } from '@funwithappmap/react-recorder';`,
        `installInteractionRecorder(${recorderOptions});`,
      ].join('\n');
    },
    // Zero-touch interaction recording (docs/design/07). A plain-function
    // transformIndexHtml runs *after* Vite's own dev-HTML import
    // rewriting, so a bare `import "virtual:…"` injected here would reach
    // the browser un-rewritten — and the browser refuses the `virtual:`
    // scheme, so recording never started. Inject the URL Vite itself
    // serves the virtual module at instead (`<base>@id/__x00__<id>`, the
    // same thing @vitejs/plugin-react does for its preamble); in a
    // production build (`force`), link the chunk emitted in buildStart.
    transformIndexHtml(_html?: string, ctx?: IndexHtmlTransformContext) {
      if (!enabled || !options.app) return;
      if (ctx?.bundle) {
        const chunk = Object.values(ctx.bundle).find(
          (c) => c.type === 'chunk' && c.facadeModuleId === RESOLVED_INTERACTION_RECORDER_VIRTUAL_ID,
        );
        if (!chunk) return;
        return [
          {
            tag: 'script',
            attrs: { type: 'module', src: `${base}${chunk.fileName}` },
            injectTo: 'head' as const,
          },
        ];
      }
      return [
        {
          tag: 'script',
          attrs: { type: 'module' },
          children: `import ${JSON.stringify(`${base}@id/__x00__${INTERACTION_RECORDER_VIRTUAL_ID}`)};`,
          injectTo: 'head' as const,
        },
      ];
    },
  };
}
