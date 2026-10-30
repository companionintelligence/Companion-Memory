import { getApiKey, outboxOwnerStamp, setApiBaseUrl, setApiKey, type OutboxItem } from '@ci/common';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { jwtDecode } from 'jwt-decode';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from '@/hooks/useAuth';

import { UnsentCapturesSignOutDialog } from './UnsentCapturesSignOutDialog';

vi.mock('jwt-decode', () => ({ jwtDecode: vi.fn() }));

const HUB = 'http://127.0.0.1:4100';
const MEMORY = 'https://core7.example.com';
const DEVICE_KEY = 'outgoing-key';

interface Call {
  url: string;
  method: string;
}

function json(body: unknown, status = 200): Response {
  return { ok: status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

function empty(status = 204): Response {
  return { ok: status < 300, status, text: async () => '' } as Response;
}

function row(id: string, seq: number, overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id,
    kind: 'note',
    capturedAt: '2026-10-01T00:00:00Z',
    seq,
    status: 'pending',
    attempts: 0,
    lastError: null,
    owner: null,
    payload: { records: [] },
    ...overrides,
  };
}

/**
 * A paired phone, signed in with {@link DEVICE_KEY}, whose Local Hub queue holds `queue`.
 * `online` decides whether the Memory answers at all.
 */
function phone({ online }: { online: boolean }) {
  localStorage.setItem('ci.apiBaseUrl', MEMORY);
  setApiBaseUrl(MEMORY);

  const keystore = new Map([
    ['ci.apiKey', DEVICE_KEY],
    ['ci.apiBaseUrl', MEMORY],
  ]);
  const queue = new Map<string, OutboxItem>();
  const calls: Call[] = [];

  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: {
      LocalHub: {
        start: vi.fn(async () => ({ baseUrl: HUB, token: 'hub-token' })),
        secureGet: vi.fn(async ({ key }: { key: string }) => ({ value: keystore.get(key) ?? null })),
        secureSet: vi.fn(async ({ key, value }: { key: string; value: string }) => {
          keystore.set(key, value);
        }),
        secureRemove: vi.fn(async ({ key }: { key: string }) => {
          keystore.delete(key);
        }),
      },
    },
  };

  const sidecar = (path: string, method: string): Response => {
    const [route, query] = path.split('?');
    const [, , , id, verb] = route.split('/');

    if (method === 'GET' && !id) {
      const status = new URLSearchParams(query ?? '').get('status');
      const items = [...queue.values()]
        .filter((item) => !status || item.status === status)
        .map(({ payload: _payload, ...summary }) => summary);
      const all = [...queue.values()];

      return json({
        items,
        counts: {
          pending: all.filter((item) => item.status === 'pending').length,
          needsAttention: all.filter((item) => item.status === 'needs_attention').length,
          total: all.length,
        },
        capacity: { max: 5000, used: all.length, warnAt: 4000 },
      });
    }

    if (method === 'DELETE' && !id) {
      const deleted = queue.size;

      queue.clear();

      return json({ deleted });
    }

    const item = queue.get(id);

    if (!item) {
      return json({ error: 'not_found' }, 404);
    }

    if (method === 'GET') {
      return json(item);
    }

    if (method === 'POST' && verb === 'attempt') {
      queue.delete(id);

      return empty();
    }

    return json({ error: 'not_found' }, 404);
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();

      calls.push({ url, method });

      if (url.startsWith(HUB)) {
        return sidecar(url.slice(HUB.length), method);
      }

      if (!online) {
        throw new TypeError('Load failed');
      }

      return url.endsWith('/api/keys/current') ? empty() : json({ id: 'accepted' }, 201);
    }),
  );

  return { keystore, queue, calls };
}

function AccountMenu() {
  const [{ authenticated }, { logout }] = useAuth();

  return (
    <>
      <p>{authenticated ? 'signed in' : 'signed out'}</p>
      <button type="button" onClick={() => void logout()}>
        Log out
      </button>
    </>
  );
}

function renderApp() {
  return render(
    <MemoryRouter>
      <AuthProvider args={[]}>
        <UnsentCapturesSignOutDialog />
        <AccountMenu />
      </AuthProvider>
    </MemoryRouter>,
  );
}

async function signedIn() {
  renderApp();
  await screen.findByText('signed in');
}

const cleared = (calls: Call[]) =>
  calls.some((call) => call.url === `${HUB}/api/outbox` && call.method === 'DELETE');
const revoked = (calls: Call[]) => calls.some((call) => call.url.endsWith('/api/keys/current'));

beforeEach(() => {
  // The web test's session token; an hour left, so no refresh is due while it runs.
  vi.mocked(jwtDecode).mockReturnValue({ sub: 'u1', iat: 0, exp: Math.floor(Date.now() / 1000) + 3600 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem('ci.apiBaseUrl');
  setApiBaseUrl('');
  setApiKey(null);
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

describe('signing out of the phone app with captures that have not uploaded', () => {
  it("asks first, counting only this account's captures, and touches nothing before the answer", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { keystore, queue, calls } = phone({ online: false });
    await signedIn();
    const mine = outboxOwnerStamp();

    queue.set('note', row('note', 1, { owner: mine }));
    queue.set('older-build', row('older-build', 2, { owner: null }));
    queue.set('parked', row('parked', 3, { owner: mine, status: 'needs_attention', attempts: 5 }));
    queue.set('other-account', row('other-account', 4, { owner: `${MEMORY} 00000000000000` }));

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    const dialog = await screen.findByRole('alertdialog');

    expect(within(dialog).getByText("3 captures haven't uploaded yet")).toBeInTheDocument();
    expect(
      within(dialog).getByText('Sign out and delete them? To keep them, cancel and stay signed in.'),
    ).toBeInTheDocument();
    expect(screen.getByText('signed in')).toBeInTheDocument();
    expect(cleared(calls)).toBe(false);
    expect(revoked(calls)).toBe(false);
    expect(keystore.get('ci.apiKey')).toBe(DEVICE_KEY);
    expect(queue.size).toBe(4);
    // The last upload try did happen, while the key still worked.
    expect(calls.some((call) => call.url === `${MEMORY}/api/v1/notes`)).toBe(true);
  });

  it('Cancel keeps the session and the queue as they were, so they can upload later', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { keystore, queue, calls } = phone({ online: false });
    await signedIn();
    queue.set('note', row('note', 1, { owner: outboxOwnerStamp() }));
    queue.set('fix', row('fix', 2, { owner: outboxOwnerStamp(), kind: 'positions' }));

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByText('signed in')).toBeInTheDocument();
    expect(getApiKey()).toBe(DEVICE_KEY);
    expect(keystore.get('ci.apiKey')).toBe(DEVICE_KEY);
    expect(localStorage.getItem('ci.apiBaseUrl')).toBe(MEMORY);
    expect(cleared(calls)).toBe(false);
    expect(revoked(calls)).toBe(false);
    // Not one attempt spent on either: the failed offline sends were not reported.
    expect([...queue.values()].map(({ id, status, attempts }) => ({ id, status, attempts }))).toEqual([
      { id: 'note', status: 'pending', attempts: 0 },
      { id: 'fix', status: 'pending', attempts: 0 },
    ]);
    expect(calls.some((call) => call.url.endsWith('/attempt'))).toBe(false);
  });

  it('Sign out deletes them and signs out, as sign-out always did', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { keystore, queue, calls } = phone({ online: false });
    await signedIn();
    queue.set('note', row('note', 1, { owner: outboxOwnerStamp() }));

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    const dialog = await screen.findByRole('alertdialog');

    expect(within(dialog).getByText("1 capture hasn't uploaded yet")).toBeInTheDocument();
    expect(
      within(dialog).getByText('Sign out and delete it? To keep it, cancel and stay signed in.'),
    ).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out' }));

    await screen.findByText('signed out');
    expect(queue.size).toBe(0);
    expect(cleared(calls)).toBe(true);
    expect(revoked(calls)).toBe(true);
    expect(keystore.has('ci.apiKey')).toBe(false);
    expect(getApiKey()).toBeNull();
    expect(localStorage.getItem('ci.apiBaseUrl')).toBeNull();
  });

  it('signs out without asking when the last upload try empties the queue', async () => {
    const { queue, calls } = phone({ online: true });
    await signedIn();
    queue.set('note', row('note', 1, { owner: outboxOwnerStamp() }));

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));

    await screen.findByText('signed out');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(calls.some((call) => call.url === `${MEMORY}/api/v1/notes`)).toBe(true);
    expect(queue.size).toBe(0);
    expect(revoked(calls)).toBe(true);
  });

  it("signs out without asking when only another account's captures are left", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { queue, calls } = phone({ online: false });
    await signedIn();
    queue.set('other-account', row('other-account', 1, { owner: `${MEMORY} 00000000000000` }));

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));

    await screen.findByText('signed out');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    // Never sent anywhere, and gone with the session as before.
    expect(calls.some((call) => call.url.startsWith(MEMORY) && call.url.endsWith('/notes'))).toBe(false);
    expect(queue.size).toBe(0);
  });
});

describe('signing out in a browser', () => {
  it('never asks: there is no capture queue on the web', async () => {
    const calls: Call[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });

        return url.endsWith('/api/authenticate/refresh') ? json({ accessToken: 'web-session' }) : empty(200);
      }),
    );

    await signedIn();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    });

    await screen.findByText('signed out');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(calls.some((call) => call.url === '/api/authenticate/logout' && call.method === 'POST')).toBe(
      true,
    );
    expect(calls.some((call) => call.url.startsWith(HUB))).toBe(false);
  });
});
