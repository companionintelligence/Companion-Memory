import { FetchJsonError } from '@ci/common';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountSection } from './AccountSection';

/**
 * Account deletion is irreversible and is the in-app path both stores require, so the
 * things worth pinning are: it cannot fire until the user has retyped their own
 * address, and it authenticates the way NATIVE does (API key, no JWT) as well as the
 * way web does — a `Bearer null` here would break the App Store build, i.e. the only
 * client the requirement is actually about.
 *
 * Change-email/change-password pin the OIDC-aware current-password requirement: a
 * federated account (a random 32-byte password it has never seen) must not be asked
 * for one it cannot supply.
 */
const h = vi.hoisted(() => ({
  authToken: null as string | null,
  logout: vi.fn(),
  refetch: vi.fn(),
  email: 'jsmith@example.com',
  hasFederatedIdentity: false,
  hasOwnPassword: true,
}));

vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: h.authToken }, { logout: h.logout }],
  useCurrentUser: () => ({
    user: { id: 'u1', email: h.email },
    loading: false,
    error: undefined,
    refetch: h.refetch,
  }),
}));

// `fetchJson` is the shared request layer; on native it attaches `x-api-key` itself.
// Spread the real module rather than replacing it: anything else rendered here that
// reaches for an `@ci/common` export should still get the real one (including
// `FetchJsonError`, which the component checks with `instanceof`).
const fetchJson = vi.hoisted(() => vi.fn());
vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson,
}));

interface FetchCallInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** The mount-time `GET /api/account` fetch every render kicks off; distinguished from
 * the action-specific PATCH/DELETE calls tests actually assert on by having no method. */
function isAccountReadCall(url: string, init?: FetchCallInit) {
  return url === '/api/account' && !init?.method;
}

/** Finds the one call matching `method` (and `url` when given), ignoring the mount read. */
function findCall(method: string, url?: string): [string, FetchCallInit] {
  const call = (fetchJson.mock.calls as Array<[string, FetchCallInit?]>).find(
    ([callUrl, callInit]) => callInit?.method === method && (url === undefined || callUrl === url),
  );

  if (!call) {
    throw new Error(`No fetchJson call found for ${method} ${url ?? ''}`);
  }

  return call as [string, FetchCallInit];
}

function openDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Delete account' }));
}

/** The confirm button inside the dialog (the card has a same-named opener). */
function confirmButton() {
  return screen.getAllByRole('button', { name: 'Delete account' }).at(-1)!;
}

beforeEach(() => {
  h.authToken = 'jwt-abc';
  h.email = 'jsmith@example.com';
  h.hasFederatedIdentity = false;
  h.hasOwnPassword = true;

  fetchJson.mockImplementation((url: string, init?: FetchCallInit) => {
    if (isAccountReadCall(url, init)) {
      return Promise.resolve({ email: h.email, hasFederatedIdentity: h.hasFederatedIdentity, hasOwnPassword: h.hasOwnPassword });
    }

    return Promise.resolve(undefined); // 204 No Content
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AccountSection — delete', () => {
  it('shows the signed-in address and offers deletion', () => {
    render(<AccountSection />);

    expect(screen.getByText(/Signed in as jsmith@example.com/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete account' })).toBeEnabled();
  });

  it('states what is deleted and when, in both the card and the dialog', () => {
    // This copy is a promise, and the store disclosures repeat it. It stayed
    // deliberately vague while nothing consumed `purge_after`; now that
    // AccountPurgeService does, it names the window and the files. Pinned here
    // so it cannot drift away from what the server actually does — the grace
    // period is `accountDeletion.graceDays`.
    render(<AccountSection />);

    expect(screen.getByText(/permanently deleted from this server after 30 days/i)).toBeInTheDocument();
    expect(screen.getByText(/files you uploaded/i)).toBeInTheDocument();

    openDialog();

    expect(screen.getByText(/After 30 days this account, its memories/i)).toBeInTheDocument();
  });

  it('keeps deletion disabled until the account address is retyped', async () => {
    render(<AccountSection />);
    openDialog();

    expect(confirmButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'someone@else.com' } });
    expect(confirmButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'jsmith@example.com' } });
    await waitFor(() => expect(confirmButton()).toBeEnabled());
  });

  it('deletes the account and signs out when the confirmation matches', async () => {
    render(<AccountSection />);
    openDialog();

    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'jsmith@example.com' } });
    fireEvent.click(confirmButton());

    await waitFor(() => expect(h.logout).toHaveBeenCalled());

    const [url, init] = findCall('DELETE');
    expect(url).toBe('/api/account');
    expect(JSON.parse(init.body!)).toEqual({ confirmEmail: 'jsmith@example.com' });
    // Web session: the JWT rides as a Bearer token.
    expect(init.headers).toMatchObject({ Authorization: 'Bearer jwt-abc' });
  });

  it('accepts a differently-cased confirmation', async () => {
    render(<AccountSection />);
    openDialog();

    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: '  JSmith@Example.COM  ' } });
    await waitFor(() => expect(confirmButton()).toBeEnabled());
  });

  it('native (no JWT): sends NO Authorization header, leaving fetchJson to attach the API key', async () => {
    h.authToken = null;
    render(<AccountSection />);
    openDialog();

    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'jsmith@example.com' } });
    fireEvent.click(confirmButton());

    await waitFor(() => expect(h.logout).toHaveBeenCalled());

    const [, init] = findCall('DELETE');
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('surfaces an error and stays signed in when the request fails', async () => {
    fetchJson.mockImplementation((url: string, init?: FetchCallInit) => {
      if (isAccountReadCall(url, init)) {
        return Promise.resolve({ email: h.email, hasFederatedIdentity: false, hasOwnPassword: true });
      }

      return Promise.reject(new Error('Fetch failed: 500'));
    });
    render(<AccountSection />);
    openDialog();

    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'jsmith@example.com' } });
    fireEvent.click(confirmButton());

    expect(await screen.findByText(/Could not delete the account/i)).toBeInTheDocument();
    expect(h.logout).not.toHaveBeenCalled();
  });
});

describe('AccountSection — change email', () => {
  it('submits the new email with the current password, then refreshes the user', async () => {
    render(<AccountSection />);

    fireEvent.change(
      await screen.findByLabelText('Current password', { selector: '#emailCurrentPassword' }),
      {
        target: { value: 'my-password' },
      },
    );
    fireEvent.change(screen.getByLabelText('New email'), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update email' }));

    await waitFor(() => expect(h.refetch).toHaveBeenCalled());

    const [url, init] = findCall('PATCH', '/api/account/email');
    expect(url).toBe('/api/account/email');
    expect(JSON.parse(init.body!)).toEqual({
      newEmail: 'new@example.com',
      currentPassword: 'my-password',
    });
    expect(screen.getByText('Email updated.')).toBeInTheDocument();
  });

  it('skips the current-password field for a federated account with no password of its own', async () => {
    h.hasFederatedIdentity = true;
    h.hasOwnPassword = false;
    render(<AccountSection />);

    // The heading for the OIDC copy is enough proof the fetched flag landed.
    await screen.findByText(/no password yet/i);

    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('New email'), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update email' }));

    await waitFor(() => expect(h.refetch).toHaveBeenCalled());

    const [, init] = findCall('PATCH', '/api/account/email');
    expect(JSON.parse(init.body!)).toEqual({ newEmail: 'new@example.com' });
  });

  it('asks a federated account that HAS set a password for it, like any other account', async () => {
    h.hasFederatedIdentity = true;
    h.hasOwnPassword = true;
    render(<AccountSection />);

    fireEvent.change(await screen.findByLabelText('Current password', { selector: '#emailCurrentPassword' }), {
      target: { value: 'my-password' },
    });
    fireEvent.change(screen.getByLabelText('New email'), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update email' }));

    await waitFor(() => expect(h.refetch).toHaveBeenCalled());
    const [, init] = findCall('PATCH', '/api/account/email');
    expect(JSON.parse(init.body!)).toEqual({ newEmail: 'new@example.com', currentPassword: 'my-password' });
  });

  it('tells a federated account whose sign-in is too old to sign in again', async () => {
    h.hasFederatedIdentity = true;
    h.hasOwnPassword = false;
    fetchJson.mockImplementation((url: string, init?: FetchCallInit) => {
      if (isAccountReadCall(url, init)) {
        return Promise.resolve({ email: h.email, hasFederatedIdentity: true, hasOwnPassword: false });
      }

      if (init?.method === 'PATCH' && url === '/api/account/email') {
        return Promise.reject(new FetchJsonError(401, 'Unauthorized', 'REAUTH_REQUIRED'));
      }

      return Promise.resolve(undefined);
    });
    render(<AccountSection />);
    await screen.findByText(/no password yet/i);

    fireEvent.change(screen.getByLabelText('New email'), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update email' }));

    expect(await screen.findByText('Sign in again to make this change.')).toBeInTheDocument();
    expect(h.refetch).not.toHaveBeenCalled();
  });

  it('surfaces the server error and does not refetch the user', async () => {
    fetchJson.mockImplementation((url: string, init?: FetchCallInit) => {
      if (isAccountReadCall(url, init)) {
        return Promise.resolve({ email: h.email, hasFederatedIdentity: false, hasOwnPassword: true });
      }

      if (init?.method === 'PATCH' && url === '/api/account/email') {
        return Promise.reject(new FetchJsonError(400, 'Bad Request', 'That email address is already in use'));
      }

      return Promise.resolve(undefined);
    });
    render(<AccountSection />);

    fireEvent.change(
      await screen.findByLabelText('Current password', { selector: '#emailCurrentPassword' }),
      {
        target: { value: 'my-password' },
      },
    );
    fireEvent.change(screen.getByLabelText('New email'), { target: { value: 'taken@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update email' }));

    expect(await screen.findByText('That email address is already in use')).toBeInTheDocument();
    expect(h.refetch).not.toHaveBeenCalled();
  });
});

describe('AccountSection — change password', () => {
  it('submits the new password with the current password, then reports other devices signed out', async () => {
    render(<AccountSection />);

    fireEvent.change(
      await screen.findByLabelText('Current password', { selector: '#passwordCurrentPassword' }),
      {
        target: { value: 'my-password' },
      },
    );
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-password-1' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'new-password-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));

    await screen.findByText(/other signed-in devices/i);

    const [url, init] = findCall('PATCH', '/api/account/password');
    expect(url).toBe('/api/account/password');
    expect(JSON.parse(init.body!)).toEqual({
      newPassword: 'new-password-1',
      currentPassword: 'my-password',
    });
  });

  it('blocks submission client-side when the confirmation does not match, without calling the server', async () => {
    render(<AccountSection />);

    fireEvent.change(
      await screen.findByLabelText('Current password', { selector: '#passwordCurrentPassword' }),
      {
        target: { value: 'my-password' },
      },
    );
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-password-1' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'different' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));

    expect(await screen.findByText('New passwords do not match.')).toBeInTheDocument();
    expect(() => findCall('PATCH', '/api/account/password')).toThrow();
  });

  it('labels the action "Set a password" and skips current-password for a federated account without one', async () => {
    h.hasFederatedIdentity = true;
    h.hasOwnPassword = false;
    render(<AccountSection />);

    expect(await screen.findByText('Set a password')).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Current password', { selector: '#passwordCurrentPassword' }),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-password-1' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'new-password-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }));

    await waitFor(() => expect(() => findCall('PATCH', '/api/account/password')).not.toThrow());

    const [, init] = findCall('PATCH', '/api/account/password');
    expect(JSON.parse(init.body!)).toEqual({ newPassword: 'new-password-1' });
  });
});
