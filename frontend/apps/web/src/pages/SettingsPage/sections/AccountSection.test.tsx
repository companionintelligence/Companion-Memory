import { FetchJsonError } from '@ci/common';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountSection } from './AccountSection';

/**
 * Account deletion is irreversible and is the in-app path both stores require, so the
 * things worth pinning are: it cannot fire until the user has retyped their own
 * address, and it authenticates the way NATIVE does (API key, no JWT) as well as the
 * way web does — a `Bearer null` here would break the App Store build, i.e. the only
 * client the requirement is actually about.
 *
 * Change-email/change-password pin the current-password requirement, which follows
 * the server's `hasOwnPassword` exactly: an account provisioned with a random 32-byte
 * password it has never seen — by Portal/OIDC sign-in, or by the Hub bridge with no
 * federated identity at all — must not be asked for one it cannot supply. And while
 * the Hub signs the account in, its address is the Hub's link to it, so the page says
 * so instead of offering a change.
 */
const h = vi.hoisted(() => ({
  authToken: null as string | null,
  // Only set where a test is about the native shell: a device API key and no web JWT, which
  // `useAuth` reports as `authenticated` with a null `authToken`.
  authenticated: false,
  logout: vi.fn(),
  refetch: vi.fn(),
  email: 'jsmith@example.com',
  hasFederatedIdentity: false,
  hasOwnPassword: true,
  emailManagedByHub: false,
}));

vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: h.authToken, authenticated: h.authenticated }, { logout: h.logout }],
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
  h.authenticated = false;
  h.email = 'jsmith@example.com';
  h.hasFederatedIdentity = false;
  h.hasOwnPassword = true;
  h.emailManagedByHub = false;

  fetchJson.mockImplementation((url: string, init?: FetchCallInit) => {
    if (isAccountReadCall(url, init)) {
      return Promise.resolve({
        email: h.email,
        hasFederatedIdentity: h.hasFederatedIdentity,
        hasOwnPassword: h.hasOwnPassword,
        emailManagedByHub: h.emailManagedByHub,
      });
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

  it('keeps iOS from autocorrecting the retyped address, without making it a type=email field', () => {
    render(<AccountSection />);
    openDialog();

    const field = screen.getByLabelText(/to confirm/i);
    expect(field).toHaveAttribute('inputmode', 'email');
    expect(field).toHaveAttribute('autocapitalize', 'none');
    expect(field).toHaveAttribute('autocorrect', 'off');
    expect(field).toHaveAttribute('spellcheck', 'false');
    expect(field).toHaveAttribute('autocomplete', 'off');
    // A mismatch only disables the button; type=email would add a browser validation bubble.
    expect(field).not.toHaveAttribute('type', 'email');
  });

  it('clears the typed address when Cancel is clicked, so reopening starts disabled', async () => {
    render(<AccountSection />);
    openDialog();
    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'jsmith@example.com' } });
    await waitFor(() => expect(confirmButton()).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    openDialog();

    expect(screen.getByLabelText(/to confirm/i)).toHaveValue('');
    expect(confirmButton()).toBeDisabled();
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
    // The deleted account's key no longer works, so captures still queued on the phone
    // could never upload: sign-out does not stop to ask about them.
    expect(h.logout).toHaveBeenCalledWith({ discardUnsentCaptures: true });
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

  it('native: tells a device whose key the server refuses (403) to sign in again, and stays signed in', async () => {
    // A phone that signed in before keys were minted at `full` holds a `write` one, which
    // `DELETE /account` refuses. "Please try again" would never work; signing in again does.
    h.authToken = null;
    fetchJson.mockImplementation((url: string, init?: FetchCallInit) => {
      if (isAccountReadCall(url, init)) {
        return Promise.resolve({ email: h.email, hasFederatedIdentity: false, hasOwnPassword: true });
      }

      return Promise.reject(
        new FetchJsonError(
          403,
          'Forbidden',
          'This API key is "write" and cannot perform this action, which requires "full" access',
        ),
      );
    });
    render(<AccountSection />);
    openDialog();

    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'jsmith@example.com' } });
    fireEvent.click(confirmButton());

    expect(await screen.findByText(/Sign out, sign back in, then try again/)).toBeInTheDocument();
    expect(screen.queryByText(/Could not delete the account/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/requires "full" access/)).not.toBeInTheDocument();
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

  it('skips the current-password field for a Hub-provisioned account, which has no federated identity either', async () => {
    // The field this used to render asked for the bridge's random password.
    h.hasFederatedIdentity = false;
    h.hasOwnPassword = false;
    render(<AccountSection />);

    await screen.findByText(/no password yet/i);

    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('New email'), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update email' }));

    await waitFor(() => expect(h.refetch).toHaveBeenCalled());

    const [, init] = findCall('PATCH', '/api/account/email');
    expect(JSON.parse(init.body!)).toEqual({ newEmail: 'new@example.com' });
  });

  it('explains instead of offering the form while the Hub signs this account in by its address', async () => {
    h.hasOwnPassword = false;
    h.emailManagedByHub = true;
    render(<AccountSection />);

    expect(await screen.findByText(/Your Hub signs you in to Memory with this address/)).toBeInTheDocument();
    expect(screen.queryByLabelText('New email')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update email' })).not.toBeInTheDocument();
    // Only the email is the Hub's: setting a password is still offered.
    expect(screen.getByRole('button', { name: 'Set password' })).toBeInTheDocument();
  });

  it('asks for the current password when the account read fails, rather than guessing it away', async () => {
    fetchJson.mockImplementation((url: string, init?: FetchCallInit) =>
      isAccountReadCall(url, init)
        ? Promise.reject(new Error('Fetch failed: 500'))
        : Promise.resolve(undefined),
    );
    render(<AccountSection />);

    await waitFor(() => expect(fetchJson).toHaveBeenCalledWith('/api/account', expect.anything()));

    expect(
      await screen.findByLabelText('Current password', { selector: '#emailCurrentPassword' }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('Current password', { selector: '#passwordCurrentPassword' }),
    ).toBeInTheDocument();
  });

  it('asks a federated account that HAS set a password for it, like any other account', async () => {
    h.hasFederatedIdentity = true;
    h.hasOwnPassword = true;
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

  function refuseEmailAsTaken() {
    fetchJson.mockImplementation((url: string, init?: FetchCallInit) => {
      if (isAccountReadCall(url, init)) {
        return Promise.resolve({ email: h.email, hasFederatedIdentity: false, hasOwnPassword: true });
      }

      if (init?.method === 'PATCH' && url === '/api/account/email') {
        return Promise.reject(new FetchJsonError(400, 'Bad Request', 'That email address is already in use'));
      }

      return Promise.resolve(undefined);
    });
  }

  it('surfaces the server error and does not refetch the user', async () => {
    refuseEmailAsTaken();
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

  it('drops the server error as soon as a field is edited again', async () => {
    refuseEmailAsTaken();
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

    // The next address is one the browser refuses, so the form never submits and only the edit
    // can take the old message away.
    fireEvent.change(screen.getByLabelText('New email'), { target: { value: 'not-an-address' } });

    expect(screen.queryByText('That email address is already in use')).not.toBeInTheDocument();
  });
});

describe('AccountSection — the last administrator', () => {
  function refuseUntilSuccessorNamed() {
    fetchJson.mockImplementation((url: string, init?: FetchCallInit) => {
      if (isAccountReadCall(url, init)) {
        return Promise.resolve({ email: h.email, hasFederatedIdentity: false, hasOwnPassword: true });
      }

      if (init?.method === 'DELETE') {
        const body = JSON.parse(init.body!) as { successorEmail?: string };

        if (!body.successorEmail) {
          return Promise.reject(new FetchJsonError(409, 'Conflict', 'SUCCESSOR_REQUIRED'));
        }

        if (body.successorEmail !== 'member@example.com') {
          return Promise.reject(new FetchJsonError(409, 'Conflict', 'SUCCESSOR_NOT_FOUND'));
        }
      }

      return Promise.resolve(undefined);
    });
  }

  it('asks who takes over when the server says this is the last administrator, then deletes', async () => {
    refuseUntilSuccessorNamed();
    render(<AccountSection />);
    openDialog();

    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'jsmith@example.com' } });
    fireEvent.click(confirmButton());

    expect(await screen.findByText(/You are the only administrator/)).toBeInTheDocument();
    expect(h.logout).not.toHaveBeenCalled();
    // Nothing to send until someone is named.
    expect(confirmButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/person who takes over/i), {
      target: { value: ' member@example.com ' },
    });
    fireEvent.click(confirmButton());

    await waitFor(() => expect(h.logout).toHaveBeenCalled());
    const deletes = (fetchJson.mock.calls as Array<[string, FetchCallInit?]>).filter(
      ([, init]) => init?.method === 'DELETE',
    );
    expect(JSON.parse(deletes.at(-1)![1]!.body!)).toEqual({
      confirmEmail: 'jsmith@example.com',
      successorEmail: 'member@example.com',
    });
  });

  it('says so when the named successor has no account here, and stays signed in', async () => {
    refuseUntilSuccessorNamed();
    render(<AccountSection />);
    openDialog();

    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'jsmith@example.com' } });
    fireEvent.click(confirmButton());
    fireEvent.change(await screen.findByLabelText(/person who takes over/i), {
      target: { value: 'stranger@example.com' },
    });
    fireEvent.click(confirmButton());

    expect(await screen.findByText(/No other account on this Memory uses that email/)).toBeInTheDocument();
    expect(h.logout).not.toHaveBeenCalled();
  });
});

describe('AccountSection — sign out everywhere', () => {
  it('asks first, then signs out everywhere else and says how many keys went', async () => {
    fetchJson.mockImplementation((url: string, init?: FetchCallInit) => {
      if (isAccountReadCall(url, init)) {
        return Promise.resolve({ email: h.email, hasFederatedIdentity: false, hasOwnPassword: true });
      }

      return Promise.resolve(url === '/api/account/sign-out-everywhere' ? { revokedKeys: 3 } : undefined);
    });
    render(<AccountSection />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    expect(() => findCall('POST', '/api/account/sign-out-everywhere')).toThrow();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out and delete keys' }));

    expect(
      await screen.findByText('Signed out everywhere else. 3 API keys were deleted.'),
    ).toBeInTheDocument();
    const [, init] = findCall('POST', '/api/account/sign-out-everywhere');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer jwt-abc' });
  });

  it('is not offered to the native shell, whose device key the route refuses', () => {
    h.authToken = null;
    h.authenticated = true;
    render(<AccountSection />);

    expect(screen.queryByRole('button', { name: 'Sign out everywhere' })).not.toBeInTheDocument();
  });
});

describe('AccountSection — change password', () => {
  it('asks the browser for at least eight characters, as the server does', async () => {
    render(<AccountSection />);

    expect(await screen.findByLabelText('New password')).toHaveAttribute('minLength', '8');
  });

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

    await screen.findByText(/phone and desktop apps you signed in on are signed out/i);

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

  it('drops the mismatch message as soon as a password is edited again', async () => {
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

    // The next try is too short, which the browser refuses before the form submits, so
    // nothing but the edit itself can take the old message away.
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'short' } });

    expect(screen.queryByText('New passwords do not match.')).not.toBeInTheDocument();
  });

  it('drops the last "Password updated." note when the next try does not match', async () => {
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
    await screen.findByText(/phone and desktop apps you signed in on are signed out/i);

    fireEvent.change(screen.getByLabelText('Current password', { selector: '#passwordCurrentPassword' }), {
      target: { value: 'new-password-1' },
    });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-password-2' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'different' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));

    expect(await screen.findByText('New passwords do not match.')).toBeInTheDocument();
    expect(screen.queryByText(/Password updated/)).not.toBeInTheDocument();
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

  it('lets a Hub-provisioned account set a password without one it never saw', async () => {
    h.hasFederatedIdentity = false;
    h.hasOwnPassword = false;
    h.emailManagedByHub = true;
    render(<AccountSection />);

    expect(await screen.findByText('Set a password')).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Current password', { selector: '#passwordCurrentPassword' }),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-password-1' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'new-password-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }));

    await screen.findByText(/phone and desktop apps you signed in on are signed out/i);

    const [, init] = findCall('PATCH', '/api/account/password');
    expect(JSON.parse(init.body!)).toEqual({ newPassword: 'new-password-1' });
  });

  it('tells someone the Hub signs in how to sign in again, since a reload keeps the old session', async () => {
    h.hasOwnPassword = false;
    h.emailManagedByHub = true;
    fetchJson.mockImplementation((url: string, init?: FetchCallInit) => {
      if (isAccountReadCall(url, init)) {
        return Promise.resolve({
          email: h.email,
          hasFederatedIdentity: false,
          hasOwnPassword: false,
          emailManagedByHub: true,
        });
      }

      if (init?.method === 'PATCH' && url === '/api/account/password') {
        return Promise.reject(new FetchJsonError(401, 'Unauthorized', 'REAUTH_REQUIRED'));
      }

      return Promise.resolve(undefined);
    });
    render(<AccountSection />);
    await screen.findByText('Set a password');

    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-password-1' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'new-password-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }));

    expect(
      await screen.findByText('Sign out, then open Memory from your Hub again to make this change.'),
    ).toBeInTheDocument();
  });

  it('labels a federated account that has its own password "Update password", not "Set password"', async () => {
    // The label reads the same before the account read lands, so hold the read and
    // assert only once it has.
    let answerRead!: (body: unknown) => void;
    fetchJson.mockImplementation((url: string, init?: FetchCallInit) =>
      isAccountReadCall(url, init)
        ? new Promise((resolve) => {
            answerRead = resolve;
          })
        : Promise.resolve(undefined),
    );
    render(<AccountSection />);

    await act(async () => {
      answerRead({
        email: h.email,
        hasFederatedIdentity: true,
        hasOwnPassword: true,
        emailManagedByHub: false,
      });
    });

    expect(screen.getByText('Change password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update password' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set password' })).not.toBeInTheDocument();
  });
});

/**
 * ═══ CREDENTIAL FORMS A PHONE CAN NEVER USE ═══
 *
 * `GET /account` and `PATCH /account/email|password` are `JwtAuthGuard`, deliberately never an
 * API key. The native shell holds only a device key (no web JWT), so Change email and Change
 * password could only answer "Unauthorized" — after the person had typed their current password.
 * Say so up front instead. `DELETE /account` is the exception that has to keep working: it takes a
 * key at `full`, and both stores require in-app deletion.
 */
describe('AccountSection on the native shell (device key, no web JWT)', () => {
  beforeEach(() => {
    h.authToken = null;
    h.authenticated = true;
  });

  it('says plainly that changing email or password needs a web sign-in', () => {
    render(<AccountSection />);

    expect(screen.getByText('Needs a web sign-in')).toBeInTheDocument();
    expect(
      screen.getByText(/email and password can only be changed from a web sign-in/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('New email')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update email' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /update password|set password/i })).not.toBeInTheDocument();
  });

  it('does not send the account read that can only 401', async () => {
    render(<AccountSection />);

    await waitFor(() => expect(screen.getByText('Needs a web sign-in')).toBeInTheDocument());

    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('keeps account deletion, which takes the device key', async () => {
    render(<AccountSection />);
    openDialog();

    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'jsmith@example.com' } });
    fireEvent.click(confirmButton());

    await waitFor(() => expect(h.logout).toHaveBeenCalled());

    const [url, init] = findCall('DELETE');
    expect(url).toBe('/api/account');
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('keeps the change forms for a web session', async () => {
    h.authToken = 'jwt-abc';

    render(<AccountSection />);

    expect(await screen.findByRole('button', { name: 'Update email' })).toBeInTheDocument();
    expect(screen.queryByText('Needs a web sign-in')).not.toBeInTheDocument();
  });
});
