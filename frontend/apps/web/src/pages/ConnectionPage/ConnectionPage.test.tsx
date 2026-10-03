import { GlobalUID, setApiKey } from '@ci/common';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { ConnectionPage, GET_CONNECTION, UPDATE_CONNECTION } from './ConnectionPage';

vi.mock('@ci/common', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return { ...actual, usePageTitle: () => {} };
});

// The web session holds a JWT. The native shell holds only a device API key, so there is no JWT
// there (`authToken` null) while the session is still `authenticated`.
const authState = vi.hoisted(() => ({ authToken: 'test-token' as string | null, authenticated: true }));

// `useAuth` reads AuthProvider context, which `renderWithProviders` does not
// supply (it fetches on mount) — the established pattern for pages that need
// it is to mock the hook directly.
vi.mock('@/hooks', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return { ...actual, useAuth: () => [authState] };
});

afterEach(() => {
  authState.authToken = 'test-token';
  authState.authenticated = true;
  setApiKey(null);
});

const CONNECTION_ID = GlobalUID.encode('connection', 'c1');

function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'ConnectionType',
    id: CONNECTION_ID,
    name: 'Google Photos',
    active: true,
    // No schedule stored — the case where the old bug turned a null schedule
    // into '1 hour' the moment the connection was renamed.
    schedule: null,
    tokenExpiry: null,
    syncState: null,
    activeEndpoints: [],
    providerId: 'p1',
    needsReauth: false,
    externalId: 'ext-1',
    accountLabel: 'me@example.com',
    provider: {
      __typename: 'ProviderType',
      id: 'p1',
      name: 'Google Photos',
      authType: 'oauth',
      endpoints: [],
    },
    ...overrides,
  };
}

function connectionMock(row: ReturnType<typeof connectionRow>) {
  return {
    request: { query: GET_CONNECTION, variables: { id: CONNECTION_ID } },
    result: { data: { connection: row } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}

/**
 * `handleEdit` used to send `schedule: editFormData.schedule || '1 hour'` on
 * every save — always a truthy value, because the dialog has no field that
 * lets the user actually change the schedule. The resolver already treats an
 * omitted `schedule` as "leave it alone" (`input.schedule ? input.schedule :
 * undefined`); this call site never gave it the chance to. Renaming a
 * connection whose schedule was null silently turned on hourly polling.
 */
describe('ConnectionPage — Edit does not touch the sync schedule', () => {
  it('does not send schedule when saving a name change', async () => {
    const saved: Record<string, unknown>[] = [];

    renderWithProviders(<ConnectionPage />, {
      route: '/connections/c1',
      path: '/connections/:id',
      mocks: [
        connectionMock(connectionRow()),
        {
          request: { query: UPDATE_CONNECTION },
          variableMatcher: () => true,
          result: (variables: Record<string, unknown>) => {
            saved.push(variables);

            return {
              data: {
                updateConnection: {
                  __typename: 'UpdateConnectionPayload',
                  success: true,
                  connection: connectionRow({ name: 'Google Photos (renamed)' }),
                },
              },
            };
          },
        },
      ],
    });

    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));

    const nameField = await screen.findByDisplayValue('Google Photos');
    fireEvent.change(nameField, { target: { value: 'Google Photos (renamed)' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saved).toHaveLength(1));
    const input = saved[0].input as Record<string, unknown>;
    expect(input).not.toHaveProperty('schedule');
    expect(input.name).toBe('Google Photos (renamed)');
  });
});

function updateConnectionMock(saved: Record<string, unknown>[]) {
  return {
    request: { query: UPDATE_CONNECTION },
    variableMatcher: () => true,
    result: (variables: Record<string, unknown>) => {
      saved.push(variables);

      return {
        data: {
          updateConnection: {
            __typename: 'UpdateConnectionPayload',
            success: true,
            connection: connectionRow({ name: 'Google Photos (renamed)' }),
          },
        },
      };
    },
  };
}

/**
 * ═══ "AUTHENTICATION TOKEN OR CONNECTION NOT FOUND" ON THE PHONE ═══
 *
 * `authToken` is the web JWT, null in the Capacitor app — whose durable credential is a keystore
 * API key. Saving an edit threw on `!authToken` before it sent anything, though the save is a
 * GraphQL mutation that authenticates through the Apollo link (which attaches the key) and never
 * reads the token. The phone could open Edit but never save it.
 */
describe('ConnectionPage — native shell (API key, no web JWT)', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('saves an edit without a web JWT', async () => {
    authState.authToken = null;
    const saved: Record<string, unknown>[] = [];

    renderWithProviders(<ConnectionPage />, {
      route: '/connections/c1',
      path: '/connections/:id',
      mocks: [connectionMock(connectionRow()), updateConnectionMock(saved)],
    });

    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));

    const nameField = await screen.findByDisplayValue('Google Photos');
    fireEvent.change(nameField, { target: { value: 'Google Photos (renamed)' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect((saved[0].input as Record<string, unknown>).name).toBe('Google Photos (renamed)');
    expect(screen.queryByText(/not found/i)).not.toBeInTheDocument();
  });

  function stubReauthUrl() {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ url: '#reauthorize' }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    return fetchMock;
  }

  /** The headers the first reauthorization request went out with, as a plain object. */
  function reauthHeaders(fetchMock: ReturnType<typeof stubReauthUrl>): Record<string, string> {
    const init = fetchMock.mock.calls[0]?.[1];

    return { ...(init?.headers as Record<string, string> | undefined) };
  }

  async function clickReauthorize() {
    renderWithProviders(<ConnectionPage />, {
      route: '/connections/c1',
      path: '/connections/:id',
      mocks: [connectionMock(connectionRow({ needsReauth: true }))],
    });

    fireEvent.click(await screen.findByRole('button', { name: /reauthorize connection/i }));
  }

  it('asks for the reauthorization address with the device key and no bearer', async () => {
    authState.authToken = null;
    setApiKey('device-key');
    const fetchMock = stubReauthUrl();

    await clickReauthorize();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const headers = reauthHeaders(fetchMock);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/connections/c1/connect');
    expect(headers['x-api-key']).toBe('device-key');
    expect(headers).not.toHaveProperty('Authorization');
  });

  it('still sends the bearer on the web', async () => {
    const fetchMock = stubReauthUrl();

    await clickReauthorize();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(reauthHeaders(fetchMock).Authorization).toBe('Bearer test-token');
  });
});
