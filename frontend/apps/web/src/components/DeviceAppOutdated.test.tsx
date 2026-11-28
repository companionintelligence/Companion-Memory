import { startDeviceAccessTokens, stopDeviceAccessTokens, type DeviceAccessTokenResult } from '@ci/common';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEVICE_APP_OUTDATED_COPY } from './DeviceAppOutdated';
import { ProtectedRoute } from './ProtectedRoute';
import { RedirectKnownUser } from './RedirectKnownUser';

vi.mock('@/common/feature', () => ({
  useFeatures: () => ({ loading: false }),
}));

vi.mock('@/hooks', () => ({
  // Signed in on a phone, with no profile: it cannot load without a credential.
  useAuth: () => [
    { expired: false, loading: false, authToken: null, authenticated: true, unreachable: false },
    { refresh: vi.fn() },
  ],
  useCurrentUser: () => ({ user: null, loading: false, unreachable: false, refetch: vi.fn() }),
}));

const legacy = (outdated?: 'memory' | 'app'): DeviceAccessTokenResult => ({
  status: 'legacy',
  token: null,
  expiresAt: null,
  keyId: 'key-1',
  ownerStamp: null,
  ...(outdated ? { outdated } : {}),
});

function renderPage() {
  return render(
    <MemoryRouter>
      <ProtectedRoute>
        <p>the page</p>
      </ProtectedRoute>
    </MemoryRouter>,
  );
}

describe('a signed-in app that cannot be handed tokens', () => {
  afterEach(() => {
    stopDeviceAccessTokens();
  });

  it.each(['memory', 'app'] as const)(
    'says to update %s instead of the page or a sign-in',
    async (outdated) => {
      await act(async () => {
        await startDeviceAccessTokens(async () => legacy(outdated));
      });

      renderPage();

      expect(screen.getByTestId('device-app-outdated')).toHaveTextContent(
        DEVICE_APP_OUTDATED_COPY[outdated].title,
      );
      expect(screen.queryByText('the page')).not.toBeInTheDocument();
    },
  );

  it('says so on a cold launch too, instead of sending the signed-in person to sign in again', async () => {
    await act(async () => {
      await startDeviceAccessTokens(async () => legacy('memory'));
    });

    render(
      <MemoryRouter>
        <RedirectKnownUser>
          <p>the sign-in</p>
        </RedirectKnownUser>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('device-app-outdated')).toHaveTextContent(
      DEVICE_APP_OUTDATED_COPY.memory.title,
    );
    expect(screen.queryByText('the sign-in')).not.toBeInTheDocument();
  });

  it('offers to check again only when Memory is what needs updating', async () => {
    await act(async () => {
      await startDeviceAccessTokens(async () => legacy());
    });

    renderPage();

    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
  });
});
