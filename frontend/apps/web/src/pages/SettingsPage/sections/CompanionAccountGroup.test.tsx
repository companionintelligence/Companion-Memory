import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CompanionAccountGroup } from './CompanionAccountGroup';

/**
 * "Companion account" in Account settings. An owner who set up Memory with a password connects a
 * Portal sign-in here: their typed address no longer counts as proven, so a Portal sign-in does
 * not reach the account by address any more.
 */

const fetchJson = vi.hoisted(() => vi.fn());
vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson,
}));

const assign = vi.fn();
const originalLocation = window.location;

beforeEach(() => {
  fetchJson.mockReset();
  assign.mockReset();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, href: 'http://memory.test/self', assign },
  });
  window.history.replaceState(null, '', '/self');
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});

function renderGroup(props: Partial<Parameters<typeof CompanionAccountGroup>[0]> = {}) {
  const onChanged = vi.fn();

  render(
    <CompanionAccountGroup
      authToken="jwt-abc"
      asksCurrentPassword
      signInAgain="Sign in again to make this change."
      companionAccount={null}
      onChanged={onChanged}
      {...props}
    />,
  );

  return { onChanged };
}

describe('Companion account', () => {
  it('connects after the current password, then goes to the Portal sign-in it is given', async () => {
    fetchJson.mockResolvedValue({ redirect: '/api/authenticate/oidc' });
    renderGroup();

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'my-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Companion account' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/api/authenticate/oidc'));
    const [url, init] = fetchJson.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe('/api/account/companion-link');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ currentPassword: 'my-password' });
  });

  it('asks no password of an account without one of its own', async () => {
    fetchJson.mockResolvedValue({ redirect: '/api/authenticate/oidc' });
    renderGroup({ asksCurrentPassword: false });

    expect(screen.queryByLabelText('Current password')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Companion account' }));

    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(JSON.parse((fetchJson.mock.calls[0] as [string, { body: string }])[1].body)).toEqual({});
  });

  it.each([
    ['connected', 'Companion account connected.'],
    ['linked_elsewhere', 'already signs in to another account on this Memory'],
    ['expired', 'Nothing was connected; try again.'],
  ])('says what the Portal round trip came back with (%s), once', (outcome, text) => {
    window.history.replaceState(null, '', `/self?companion=${outcome}`);
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, href: `http://memory.test/self?companion=${outcome}`, assign },
    });

    renderGroup();

    expect(screen.getByText(text, { exact: false })).toBeInTheDocument();
    expect(window.history.state === null || typeof window.history.state === 'object').toBe(true);
    expect(new URL(document.location.href).searchParams.has('companion')).toBe(false);
  });

  it('disconnects after the current password, keeping the password sign-in', async () => {
    fetchJson.mockResolvedValue(undefined);
    const { onChanged } = renderGroup({ companionAccount: { email: 'owner@example.com' } });

    expect(screen.getByText(/Connected as owner@example.com/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'my-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Companion account' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect((fetchJson.mock.calls[0] as [string, { method: string }])[1].method).toBe('DELETE');
  });

  it('offers no disconnect to an account whose only way in is the Companion sign-in', () => {
    renderGroup({ companionAccount: { email: 'owner@example.com' }, asksCurrentPassword: false });

    expect(screen.queryByRole('button', { name: 'Disconnect Companion account' })).toBeNull();
    expect(screen.getByText(/can't be disconnected until you set a password/)).toBeInTheDocument();
  });
});
