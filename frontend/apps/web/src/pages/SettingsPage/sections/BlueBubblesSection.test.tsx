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
  canEdit: true,
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

/**
 * The settings answer depends on who asks. The webhook URL's secret lets anyone post messages
 * into the connector owner's memory, and the host and error text locate their Mac, so the server
 * sends those to an administrator only. Everyone else gets on/off and activity times, and the page
 * shows that and nothing it could not use.
 */
describe('BlueBubblesSection for an account that is not an administrator', () => {
  const STATUS = {
    canEdit: false,
    enabled: true,
    connectionStatus: 'connected',
    lastSyncCursor: null,
    lastWebhookReceivedAt: null,
  };

  it('shows the status and a note, with no form and no webhook URL', async () => {
    h.fetchJson.mockResolvedValue(STATUS);

    render(<BlueBubblesSection />);

    expect(
      await screen.findByText(/An administrator of this Companion sets up BlueBubbles/),
    ).toBeInTheDocument();
    expect(screen.getByText('connected')).toBeInTheDocument();
    expect(screen.queryByLabelText('Host')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy webhook URL' })).not.toBeInTheDocument();
    expect(screen.queryByText('Live updates')).not.toBeInTheDocument();
  });
});

describe('BlueBubblesSection webhook URL rotation', () => {
  it('asks first, then swaps in the new URL without touching unsaved edits', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    h.fetchJson.mockImplementation((url: string, init?: { method?: string }) =>
      Promise.resolve(
        url === '/api/bluebubbles/rotate-webhook-secret' && init?.method === 'POST'
          ? { ...CONFIG, webhookPath: '/api/bluebubbles/webhook/new-secret' }
          : CONFIG,
      ),
    );

    render(<BlueBubblesSection />);

    expect(await screen.findByText(/\/api\/bluebubbles\/webhook\/secret$/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'studio.local' } });

    fireEvent.click(screen.getByRole('button', { name: 'Make a new URL' }));

    expect(await screen.findByText(/\/api\/bluebubbles\/webhook\/new-secret$/)).toBeInTheDocument();
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByLabelText('Host')).toHaveValue('studio.local');
    confirm.mockRestore();
  });

  it('does nothing when the confirmation is declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    h.fetchJson.mockResolvedValue(CONFIG);

    render(<BlueBubblesSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'Make a new URL' }));

    expect(h.fetchJson).not.toHaveBeenCalledWith('/api/bluebubbles/rotate-webhook-secret', expect.anything());
    confirm.mockRestore();
  });
});
