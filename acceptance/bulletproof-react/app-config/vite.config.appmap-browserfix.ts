// WORKAROUND for recorder bug 2 (see RESULTS.md), used only for the second
// browser pass so the interaction recorder itself can be evaluated.
// The plugin's transformIndexHtml injects
//   <script type="module">import "virtual:appmap-interaction-recorder";</script>
// as a plain-function hook, which Vite runs AFTER its own dev-HTML import
// rewriting, so the browser receives the bare `virtual:` specifier and
// refuses it (CORS: unsupported scheme). This post-order hook rewrites the
// specifier to Vite's /@id/ URL. Config only; no app or recorder change.
import { mergeConfig, type Plugin } from 'vite';

import appmapConfig from './vite.config.appmap';

const virtualIdFix: Plugin = {
  name: 'acceptance-appmap-virtual-id-fix',
  transformIndexHtml: {
    order: 'post',
    handler: (html) =>
      html.replace(
        'import "virtual:appmap-interaction-recorder"',
        'import "/@id/virtual:appmap-interaction-recorder"',
      ),
  },
};

export default mergeConfig(appmapConfig, { plugins: [virtualIdFix] });
