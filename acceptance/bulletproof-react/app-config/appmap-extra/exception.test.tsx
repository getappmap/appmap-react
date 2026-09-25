// Check E: a real app code path that throws. <Authorization allowedRoles>
// with no logged-in user makes useAuthorization() throw
// Error('User does not exist!') (src/lib/authorization.tsx:31-33); the app's
// ErrorBoundary (AppProvider -> MainErrorFallback) catches it.
import { AppProvider } from '../src/app/provider';
import { Authorization, ROLES } from '../src/lib/authorization';
import { rtlRender, screen } from '../src/testing/test-utils';

test('E: Authorization without a user throws in useAuthorization', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  rtlRender(
    <AppProvider>
      <Authorization allowedRoles={[ROLES.ADMIN]}>secret</Authorization>
    </AppProvider>,
  );
  expect(
    await screen.findByText(/something went wrong/i, {}, { timeout: 4000 }),
  ).toBeInTheDocument();
  expect(screen.queryByText('secret')).not.toBeInTheDocument();
  spy.mockRestore();
});
