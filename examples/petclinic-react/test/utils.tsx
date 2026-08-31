import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ClinicProvider } from '../src/context/ClinicContext';
import { App } from '../src/App';
import { API_BASE } from './mocks/handlers';

/** Render the whole app at a route, configured against the MSW backend. */
export function renderApp(route: string) {
  return render(
    <ClinicProvider config={{ apiBase: API_BASE }}>
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </ClinicProvider>,
  );
}
