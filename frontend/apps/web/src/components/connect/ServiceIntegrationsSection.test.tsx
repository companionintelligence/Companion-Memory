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

// `useBlueBubblesStatus` reads AuthProvider context, which this test does not
// supply — the established pattern (see ConnectionPage.test.tsx) is to mock
// the hook directly rather than render a real, network-fetching provider.
vi.mock('@/hooks', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return { ...actual, useAuth: () => [{ authToken: 'test-token', authenticated: true }] };
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

  it('offers BlueBubbles as its own clickable card, not one of the OAuth providers', () => {
    render(
      <MemoryRouter>
        <ServiceIntegrationsSection />
      </MemoryRouter>,
    );

    const blueBubbles = screen.getByRole('button', { name: /BlueBubbles/i });
    expect(blueBubbles).not.toBeDisabled();
    expect(blueBubbles).not.toHaveTextContent(/Coming soon/i);
  });

  // Connecting it needs a BlueBubbles server already reachable from this
  // appliance — not a one-click sign-in — so it has no place in the
  // first-run gallery the onboarding variant renders.
  it('does not offer BlueBubbles during onboarding', () => {
    render(
      <MemoryRouter>
        <ServiceIntegrationsSection variant="onboarding" onProviderSelect={() => {}} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('button', { name: /BlueBubbles/i })).not.toBeInTheDocument();
  });
});
