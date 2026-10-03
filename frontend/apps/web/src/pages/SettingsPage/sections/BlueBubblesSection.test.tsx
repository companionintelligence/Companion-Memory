import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BlueBubblesSection } from './BlueBubblesSection';

const h = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  scrollIntoView: vi.fn(),
  // One object, not a literal per call: the real `useSessionAuth` hands back the same `headers` for
  // as long as the token is the same, and the section reloads whenever that identity changes.
  session: { ready: true, authToken: 'token', headers: { Authorization: 'Bearer token' } },
}));

vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: 'token' }, {}],
  // The section gates on the session (a web JWT or a native device key), not on the token alone.
  useSessionAuth: () => h.session,
  useCurrentUser: () => ({ user: { isAdmin: true } }),
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson: h.fetchJson,
}));

const CONFIG = {
  host: '192.168.1.50',
  port: 1234,
  useHttps: false,
  hasPassword: true,
  hasPrivateApi: false,
  enabled: true,
  webhookPath: '/api/bluebubbles/webhook/secret',
  connectionStatus: 'unknown',
  lastError: null,
  lastSyncCursor: null,
  lastWebhookReceivedAt: null,
};

beforeEach(() => {
  h.fetchJson.mockReset();
  h.scrollIntoView.mockReset();
  // jsdom implements no layout, so it has no `scrollIntoView` either.
  Element.prototype.scrollIntoView = h.scrollIntoView;
});

/**
 * On a phone this form is taller than the screen and its button row sits near
 * the bottom edge, so whatever a button reports is drawn BELOW the fold. Tapping
 * "Test connection" appeared to do nothing until the person scrolled down and
 * found the answer under "Sync now".
 */
describe('BlueBubblesSection feedback', () => {
  it('brings the Test connection result into view when it arrives', async () => {
    h.fetchJson.mockImplementation((url: string) =>
      Promise.resolve(
        url === '/api/bluebubbles/test-connection' ? { ok: false, error: 'fetch failed' } : CONFIG,
      ),
    );

    render(<BlueBubblesSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }));

    const result = await screen.findByText('fetch failed');

    await waitFor(() => expect(h.scrollIntoView).toHaveBeenCalled());
    // The result itself, not some other part of the page.
    expect(h.scrollIntoView.mock.contexts[0]).toBe(result);
  });

  it('does it again for a second test, which replaces the first answer', async () => {
    h.fetchJson.mockImplementation((url: string) =>
      Promise.resolve(
        url === '/api/bluebubbles/test-connection' ? { ok: false, error: 'fetch failed' } : CONFIG,
      ),
    );

    render(<BlueBubblesSection />);

    const test = await screen.findByRole('button', { name: 'Test connection' });

    fireEvent.click(test);
    await screen.findByText('fetch failed');
    await waitFor(() => expect(h.scrollIntoView).toHaveBeenCalledTimes(1));

    fireEvent.click(test);
    await waitFor(() => expect(h.scrollIntoView).toHaveBeenCalledTimes(2));
  });

  it('does not scroll anywhere just because the form loaded', async () => {
    h.fetchJson.mockResolvedValue(CONFIG);

    render(<BlueBubblesSection />);

    await screen.findByRole('button', { name: 'Test connection' });

    expect(h.scrollIntoView).not.toHaveBeenCalled();
  });
});
