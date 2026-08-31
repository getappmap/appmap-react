import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from './utils';

describe('OwnersSearch', () => {
  it('finds owners by last name', async () => {
    const user = userEvent.setup();
    renderApp('/owners');

    await user.type(screen.getByLabelText(/last name/i), 'Davis');
    await user.click(screen.getByRole('button', { name: /find owner/i }));

    expect(await screen.findByRole('link', { name: 'Betty Davis' })).toBeInTheDocument();
    expect(screen.getByText('Sun Prairie')).toBeInTheDocument();
  });

  it('reports when no owner matches', async () => {
    const user = userEvent.setup();
    renderApp('/owners');

    await user.type(screen.getByLabelText(/last name/i), 'Nonexistent');
    await user.click(screen.getByRole('button', { name: /find owner/i }));

    expect(await screen.findByText(/no owners found/i)).toBeInTheDocument();
  });
});
