import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from './utils';

describe('CreateOwner', () => {
  it('creates an owner and navigates to their detail page', async () => {
    const user = userEvent.setup();
    renderApp('/owners/new');

    await user.type(screen.getByLabelText(/first name/i), 'Maria');
    await user.type(screen.getByLabelText(/last name/i), 'Escobito');
    await user.type(screen.getByLabelText(/city/i), 'Madison');
    await user.type(screen.getByLabelText(/telephone/i), '6085557683');
    await user.click(screen.getByRole('button', { name: /add owner/i }));

    // POST /owners succeeded and we navigated to the new owner's page.
    expect(await screen.findByRole('heading', { name: 'Maria Escobito' })).toBeInTheDocument();
  });

  it('renders the backend validation error', async () => {
    const user = userEvent.setup();
    renderApp('/owners/new');

    await user.type(screen.getByLabelText(/first name/i), 'Maria');
    // lastName left empty → 400 {"error": "invalid owner: lastName is required"}
    await user.click(screen.getByRole('button', { name: /add owner/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'invalid owner: lastName is required',
    );
  });
});
