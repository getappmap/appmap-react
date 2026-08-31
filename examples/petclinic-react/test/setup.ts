import '@testing-library/jest-dom/vitest';
import { setupServer } from 'msw/node';
import { registerAppMapHooks } from '@funwithappmap/react-recorder/vitest';
import { handlers } from './mocks/handlers';

// MSW first (patches fetch once, in beforeAll), then the recorder's
// per-test hooks (wrap whatever fetch is current when the test starts).
export const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

registerAppMapHooks({ app: 'petclinic-react' });
