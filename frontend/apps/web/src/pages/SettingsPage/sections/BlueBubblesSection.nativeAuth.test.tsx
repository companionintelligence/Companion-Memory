import { setApiBaseUrl, setApiKey } from '@ci/common';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BlueBubblesSection } from './BlueBubblesSection';

// The real `useSessionAuth` runs on top of this, so the section is exercised for a web JWT
// session and for the native shell, whose only credential is an API key.
const h = vi.hoisted(() => ({
  auth: { authToken: 'jwt-abc' as string | null, authenticated: true, expired: false },
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => [h.auth, {}] }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { id: 'u1', isAdmin: true }, loading: false, error: undefined }),
}));

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
}

const calls: Call[] = [];

const config = {
  canEdit: true,
  host: 'mac.local',
  port: 1234,
  useHttps: false,
  hasPassword: true,
  hasPrivateApi: false,
  enabled: true,
  webhookPath: '/api/bluebubbles/webhook/s3cret',
  connectionStatus: 'connected',
  lastError: null,
  lastSyncCursor: null,
  lastWebhookReceivedAt: null,
};

function stubApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? 'GET',
        url: String(input),
        headers: { ...(init?.headers as Record<string, string> | undefined) },
      });

      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(config),
      } as Response);
    }),
  );
}

beforeEach(() => {
  calls.length = 0;
  h.auth.authToken = 'jwt-abc';
  h.auth.authenticated = true;
  h.auth.expired = false;
});

afterEach(() => {
  setApiKey(null);
  setApiBaseUrl('');
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  vi.unstubAllGlobals();
});

describe('BlueBubblesSection', () => {
  it('loads the saved connection with the bearer on the web', async () => {
    stubApi();

    render(<BlueBubblesSection />);

    await waitFor(() => expect(screen.getByLabelText('Host')).toHaveValue('mac.local'));
    expect(calls[0].url).toContain('/api/bluebubbles/config');
    expect(calls[0].headers.Authorization).toBe('Bearer jwt-abc');
  });

  /**
   * ═══ A BLANK, UNSAVABLE FORM ON THE PHONE ═══
   *
   * `authToken` is the web JWT, null in the Capacitor app — whose durable credential is a
   * keystore API key. `load` returned before it asked, so the saved connection never filled the
   * form, and `dirty` needs a loaded config — Save could never become enabled. The controller is
   * `JwtOrApiKeyAuthGuard` (writes add the appliance-admin guard).
   */
  describe('native shell (API key, no web JWT)', () => {
    beforeEach(() => {
      h.auth.authToken = null;
      setApiKey('device-key');
      setApiBaseUrl('https://memory.example.com');
      // `getWebOrigin()` (the webhook address) is the Memory server only inside the native shell.
      (window as unknown as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    });

    it('loads the saved connection with the device key and no bearer', async () => {
      stubApi();

      render(<BlueBubblesSection />);

      await waitFor(() => expect(screen.getByLabelText('Host')).toHaveValue('mac.local'));
      expect(screen.getByLabelText('Port')).toHaveValue('1234');
      expect(calls[0].headers['x-api-key']).toBe('device-key');
      expect(calls[0].headers).not.toHaveProperty('Authorization');
    });

    it('lets a change be saved, with the device key and no bearer', async () => {
      stubApi();

      render(<BlueBubblesSection />);
      await waitFor(() => expect(screen.getByLabelText('Host')).toHaveValue('mac.local'));

      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'studio.local' } });
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));

      const put = calls.find((call) => call.method === 'PUT')!;
      expect(put.headers['x-api-key']).toBe('device-key');
      expect(put.headers).not.toHaveProperty('Authorization');
    });

    // The URL is pasted into BlueBubbles Server on another machine, so it has to name the Memory
    // server — in the app `window.location.origin` is the shell's own `capacitor://localhost`.
    it('shows the webhook address of the Memory server, not of the app shell', async () => {
      stubApi();

      render(<BlueBubblesSection />);

      expect(
        await screen.findByText('https://memory.example.com/api/bluebubbles/webhook/s3cret'),
      ).toBeInTheDocument();
    });
  });
});
