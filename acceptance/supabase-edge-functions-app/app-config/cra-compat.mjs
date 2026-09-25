// Run the app's UNMODIFIED Create React App source under Vite, because the
// recorder only integrates with Vite (a Vite plugin) and has no webpack/CRA
// hook. This file is harness config; it edits nothing in the app. It emulates
// what react-scripts does for this app:
//   - serve public/index.html as the page, with %PUBLIC_URL% -> '' and the
//     src/index.js entry appended (react-scripts injects its bundle there);
//   - compile JSX inside .js files (CRA's convention; Vite only does .jsx);
//   - provide process.env with NODE_ENV, PUBLIC_URL and REACT_APP_* vars.
// The whole substitution is listed in RESULTS.md under "App changes needed".
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export function craEnv() {
  const env = { NODE_ENV: 'development', PUBLIC_URL: '' };
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('REACT_APP_')) env[k] = v;
  return { 'process.env': JSON.stringify(env) };
}

/** JSX-in-.js for the app's own src/, compiled the way react-scripts does
 * (Babel, automatic runtime), using the app's own installed Babel, with
 * retainLines so line numbers in recordings still match the source.
 * `enforce: 'pre'` only in the workaround pass, so it runs before the
 * recorder's own 'pre' transform. */
export function craJsx({ pre = false } = {}) {
  let babel;
  let root = process.cwd();
  return {
    name: 'acceptance-cra-jsx-in-js',
    ...(pre ? { enforce: 'pre' } : {}),
    configResolved(config) {
      root = config.root;
    },
    transform(code, id) {
      const file = id.split('?')[0];
      if (!file.endsWith('.js') || file.includes('/node_modules/') || !file.startsWith(path.join(root, 'src'))) return null;
      const req = createRequire(path.join(root, 'package.json'));
      babel ??= req('@babel/core');
      const r = babel.transformSync(code, {
        filename: file,
        babelrc: false,
        configFile: false,
        retainLines: true,
        sourceMaps: true,
        plugins: [[req.resolve('@babel/plugin-transform-react-jsx'), { runtime: 'automatic' }]],
      });
      return { code: r.code, map: r.map };
    },
  };
}

export function craIndexHtml() {
  return {
    name: 'acceptance-cra-index-html',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '/').split('?')[0];
        if (url !== '/' && url !== '/index.html') return next();
        const raw = fs.readFileSync(path.join(server.config.root, 'public', 'index.html'), 'utf8');
        const html = raw
          .replaceAll('%PUBLIC_URL%', '')
          .replace('</body>', '<script type="module" src="/src/index.js"></script></body>');
        res.setHeader('content-type', 'text/html');
        res.end(await server.transformIndexHtml(url, html));
      });
    },
  };
}

export const craBase = {
  define: craEnv(),
  server: { port: Number(process.env.APP_PORT ?? 3300), strictPort: true, host: '127.0.0.1' },
  optimizeDeps: { entries: ['src/index.js'], esbuildOptions: { loader: { '.js': 'jsx' } } },
};
