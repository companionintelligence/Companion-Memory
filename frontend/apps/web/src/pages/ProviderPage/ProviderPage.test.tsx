import { GlobalUID } from '@ci/common';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { GET_PROVIDER, ProviderPage } from './ProviderPage';

const toastError = vi.hoisted(() => vi.fn());

vi.mock('@ci/common', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return { ...actual, usePageTitle: () => {} };
});

// Sonner's toast only renders behind a mounted <Toaster>, which this page
// does not own — mocking the hook directly is the established pattern here
// (see PlanPage.test.tsx) for asserting a toast fired without fighting
// portal/animation timing.
vi.mock('@ci/shadcn', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return { ...actual, useToast: () => ({ toast: { error: toastError, success: vi.fn(), info: vi.fn() } }) };
});

// `useConnectService` reads `useAuth`, which `renderWithProviders` does not
// supply. Mocking it directly also gives the test a way to drive `error`
// straight from a click, instead of standing up a fetch stub for `/api/providers`.
const connectService = vi.hoisted(() => ({ error: null as unknown }));

vi.mock('./useConnectService', () => ({
  useConnectService: () => [
    { authorizationUrl: null, loading: false, error: connectService.error, apiKey: null, setApiKey: vi.fn() },
    { connect: vi.fn() },
  ],
}));

const PROVIDER_ID = GlobalUID.encode('provider', 'p1');

function providerMock(overrides: Record<string, unknown> = {}) {
  return {
    request: { query: GET_PROVIDER, variables: { id: PROVIDER_ID } },
    result: {
      data: {
        provider: {
          __typename: 'ProviderType',
          id: PROVIDER_ID,
          name: 'Google Photos',
          description: null,
          logoUrl: null,
          authType: 'oauth',
          localOnly: false,
          appSetupUrl: null,
          openidKeyLink: null,
          theme: null,
          endpoints: [],
          ...overrides,
        },
      },
    },
  };
}

function renderProvider(mocks = [providerMock()]) {
  return renderWithProviders(<ProviderPage />, {
    route: '/providers/p1',
    path: '/providers/:id',
    mocks,
  });
}

/**
 * B14: the connect form used to end in a three-dot carousel row — a leftover
 * from a multi-step wizard this form no longer is. The middle dot had no
 * onClick at all, and the dot labelled "Next slide" actually called
 * handleConnect, starting a real OAuth redirect under a label that promised
 * navigation. Only the Back control (already correctly labelled, already
 * present) should remain.
 */
describe('ProviderPage — no dead carousel controls', () => {
  it('renders Back, but not the dead middle dot or the mislabelled "next" control', async () => {
    renderProvider();

    expect(await screen.findByRole('button', { name: 'Back to connections' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /select provider endpoints/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /next slide/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /go back to connect page/i })).not.toBeInTheDocument();
  });
});

/**
 * The error toast used to be a static 'Error connecting to API' regardless of
 * cause. It now names the provider and the underlying message, so a user
 * whose API key was rejected sees why instead of a sentence generic enough to
 * describe any request on the page.
 */
describe('ProviderPage — error toast names the provider and the cause', () => {
  it('toasts the provider name and the error message when connect fails', async () => {
    connectService.error = new Error('Invalid API key');

    renderProvider();

    await screen.findByText('Connect your Companion to Google Photos');
    expect(toastError).toHaveBeenCalledWith('Could not connect to Google Photos. Invalid API key');

    connectService.error = null;
  });
});
