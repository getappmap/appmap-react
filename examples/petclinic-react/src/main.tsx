import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ClinicProvider } from './context/ClinicContext';
import { App } from './App';

// Interaction recording (one AppMap per user interaction, shipped to
// the Vite dev server's collector → tmp/appmap/interactions/) is
// zero-touch: the `app` option on appmapVitePlugin in vite.config.ts
// injects installInteractionRecorder() into every page. Nothing here
// calls it. See docs/design/07.

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClinicProvider config={{ apiBase: '/api' }}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ClinicProvider>
  </StrictMode>,
);
