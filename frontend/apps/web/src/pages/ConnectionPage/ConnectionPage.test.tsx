import { GlobalUID } from '@ci/common';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';


import { renderWithProviders } from '@/test/renderWithProviders';

import { ConnectionPage, GET_CONNECTION, UPDATE_CONNECTION } from './ConnectionPage';

vi.mock('@ci/common', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return { ...actual, usePageTitle: () => {} };
});

// `useAuth` reads AuthProvider context, which `renderWithProviders` does not
// supply (it fetches on mount) — the established pattern for pages that need
// it is to mock the hook directly.
vi.mock('@/hooks', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return { ...actual, useAuth: () => [{ authToken: 'test-token', authenticated: true }] };
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
