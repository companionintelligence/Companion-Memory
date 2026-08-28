import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@apollo/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@apollo/client')>();

  return {
    ...actual,
    useQuery: () => ({
      data: {
        connections: {
          edges: [
            {
              node: {
                id: 'conn-google-1',
                name: 'Google',
                active: true,
                needsReauth: false,
                providerId: '0198779b-182c-716e-9275-b81d99a47fdb',
                syncState: null,
              },
            },
          ],
        },
        providers: {
          edges: [],
        },
        oAuthCallbackUrl: 'http://localhost/oauth/callback',
      },
    }),
  };
});

import { ServiceIntegrationsSection } from './ServiceIntegrationsSection';

describe('ServiceIntegrationsSection', () => {
  it('keeps a connected Google card clickable so another account can be added', () => {
    render(
      <MemoryRouter>
        <ServiceIntegrationsSection />
      </MemoryRouter>,
    );

    const google = screen.getByRole('button', { name: /Google/i });
    expect(google).toHaveTextContent(/Connected/i);
    expect(google).not.toBeDisabled();
  });
});
