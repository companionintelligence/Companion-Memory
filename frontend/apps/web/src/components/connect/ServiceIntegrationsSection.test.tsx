import { GlobalUID } from '@ci/common';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The providers the server lists, per test. Empty unless a test is about them. */
const h = vi.hoisted(() => ({ providers: [] as Array<Record<string, unknown>> }));

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
          edges: h.providers.map((node) => ({ node })),
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

beforeEach(() => {
  h.providers = [];
});

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

/**
 * `providers.localOnly` means two different things, and only one of them is a
 * reason to put an OAuth Setup dialog in front of someone.
 *
 * For an `oauth2` provider the server FORCES it true while this appliance has no
 * CI Portal credentials, which is what sends the person to register their own
 * OAuth app. Signal is seeded `local_only = true` for a different reason: it
 * talks to a signal-cli REST API on the appliance's own network, so there is no
 * cloud proxy to use — and it authenticates with an API key, which the provider
 * page asks for. Tapping it opened "Signal — OAuth Setup" with a callback URL and
 * a Settings → OAuth Credentials step for a service that has no OAuth at all.
 */
describe('ServiceIntegrationsSection provider cards', () => {
  const SIGNAL_ID = '019e3d77-c6e3-8f14-da06-2b5f7c0e1d19';
  const GOOGLE_ID = '0198779b-182c-716e-9275-b81d99a47fdb';

  function provider(rawId: string, name: string, authType: string) {
    return {
      id: GlobalUID.encode('provider', rawId),
      name,
      localOnly: true,
      authType,
      providerKeys: null,
      appSetupUrl: 'https://example.com/setup',
      scopes: null,
    };
  }

  function renderCards() {
    return render(
      <MemoryRouter initialEntries={['/sources/connect']}>
        <Routes>
          <Route path="/sources/connect" element={<ServiceIntegrationsSection />} />
          <Route path="/providers/:id" element={<div>provider page</div>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('sends an api_key provider to its own page, not to OAuth app setup', () => {
    h.providers = [provider(SIGNAL_ID, 'Signal', 'api_key')];
    renderCards();

    fireEvent.click(screen.getByRole('button', { name: /Signal/i }));

    expect(screen.getByText('provider page')).toBeInTheDocument();
    expect(screen.queryByText(/OAuth Setup/)).not.toBeInTheDocument();
  });

  it('still asks an oauth2 provider with no keys for its own OAuth app', () => {
    h.providers = [provider(GOOGLE_ID, 'Google', 'oauth2')];
    renderCards();

    fireEvent.click(screen.getByRole('button', { name: /Google/i }));

    expect(screen.getByText(/Google — OAuth Setup/)).toBeInTheDocument();
    expect(screen.queryByText('provider page')).not.toBeInTheDocument();
  });

  it('lets an oauth2 provider that has keys through to its page', () => {
    h.providers = [{ ...provider(GOOGLE_ID, 'Google', 'oauth2'), providerKeys: { id: 'key-1' } }];
    renderCards();

    fireEvent.click(screen.getByRole('button', { name: /Google/i }));

    expect(screen.getByText('provider page')).toBeInTheDocument();
  });
});
