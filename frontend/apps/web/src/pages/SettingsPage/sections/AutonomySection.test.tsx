import { setApiKey } from '@ci/common';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutonomySection } from './AutonomySection';

// The real `useSessionAuth` runs on top of this, so the section is exercised for a web JWT
// session and for the native shell, whose only credential is an API key.
const h = vi.hoisted(() => ({
  auth: { authToken: 'jwt-abc' as string | null, authenticated: true, expired: false },
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => [h.auth, {}] }));

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

const calls: Call[] = [];

function stubApi(profile: { trustMode: string } = { trustMode: 'hands_off' }) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? 'GET',
        url: String(input),
        headers: { ...(init?.headers as Record<string, string> | undefined) },
        body: init?.body as string | undefined,
      });

      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(profile),
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
  vi.unstubAllGlobals();
});

describe('AutonomySection', () => {
  it('loads the saved trust mode with the bearer on the web', async () => {
    stubApi();

    render(<AutonomySection />);

    await waitFor(() => expect(screen.getByRole('button', { name: /Hands-off/ })).toBeEnabled());
    expect(screen.getByRole('button', { name: /Hands-off/ })).toHaveAttribute('aria-pressed', 'true');
    expect(calls[0].url).toContain('/api/personalization/profile');
    expect(calls[0].headers.Authorization).toBe('Bearer jwt-abc');
  });

  /**
   * ═══ AUTONOMY WAS DISABLED FOREVER ON THE PHONE ═══
   *
   * `authToken` is the web JWT, null in the Capacitor app — whose durable credential is a
   * keystore API key. `load` returned before it asked and never cleared `loading`, so all
   * three options and Save stayed disabled with no message, while
   * `GET /personalization/profile` answers 200 for the device key (the whole controller is
   * `JwtOrApiKeyAuthGuard`).
   */
  describe('native shell (API key, no web JWT)', () => {
    beforeEach(() => {
      h.auth.authToken = null;
      setApiKey('device-key');
    });

    it('loads the saved trust mode with the device key and enables the options', async () => {
      stubApi({ trustMode: 'hands_off' });

      render(<AutonomySection />);

      await waitFor(() => expect(screen.getByRole('button', { name: /Cautious/ })).toBeEnabled());
      expect(screen.getByRole('button', { name: /Balanced/ })).toBeEnabled();
      expect(screen.getByRole('button', { name: /Hands-off/ })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
      expect(screen.getByRole('button', { name: /Hands-off/ })).toHaveAttribute('aria-pressed', 'true');

      expect(calls[0].url).toContain('/api/personalization/profile');
      expect(calls[0].headers['x-api-key']).toBe('device-key');
      expect(calls[0].headers).not.toHaveProperty('Authorization');
    });

    it('saves the chosen trust mode with the device key and no bearer', async () => {
      stubApi({ trustMode: 'balanced' });

      render(<AutonomySection />);
      await waitFor(() => expect(screen.getByRole('button', { name: /Cautious/ })).toBeEnabled());

      fireEvent.click(screen.getByRole('button', { name: /Cautious/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));

      const post = calls.find((call) => call.method === 'POST')!;
      expect(post.url).toContain('/api/personalization/trust-mode');
      expect(JSON.parse(post.body!)).toEqual({ trustMode: 'cautious' });
      expect(post.headers['x-api-key']).toBe('device-key');
      expect(post.headers).not.toHaveProperty('Authorization');
      expect(await screen.findByText('Saved')).toBeInTheDocument();
    });
  });
});
