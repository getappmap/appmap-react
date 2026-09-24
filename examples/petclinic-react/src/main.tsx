import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ClinicProvider } from './context/ClinicContext';
import { App } from './App';

// Interaction recording is zero-touch: appmapVitePlugin injects the
// recorder from vite.config.ts in development and test builds.

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClinicProvider config={{ apiBase: '/api' }}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ClinicProvider>
  </StrictMode>,
);
