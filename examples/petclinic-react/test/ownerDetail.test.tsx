import { screen } from '@testing-library/react';
import { renderApp } from './utils';

describe('OwnerDetail', () => {
  // One interaction, two concurrent fetches (GET /owners/1 + GET /vets):
  // the recorded AppMap should contain two http_client_request events.
  it('shows the owner, their pets, and the vet roster size', async () => {
    renderApp('/owners/1');

    expect(await screen.findByRole('heading', { name: 'George Franklin' })).toBeInTheDocument();
    expect(screen.getByText('Leo (cat)')).toBeInTheDocument();
    expect(screen.getByText(/3 veterinarians on staff/)).toBeInTheDocument();
  });

  it('renders an error for an unknown owner', async () => {
    renderApp('/owners/404');

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load owner/i);
  });
});
