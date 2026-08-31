import { screen } from '@testing-library/react';
import { renderApp } from './utils';

describe('VetsList', () => {
  it('lists veterinarians with their specialties', async () => {
    renderApp('/vets');

    expect(await screen.findByText('James Carter')).toBeInTheDocument();
    expect(screen.getByText(/surgery, dentistry/)).toBeInTheDocument();
  });
});
