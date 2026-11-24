import { setApiBaseUrl } from '@ci/common';
import { render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useNeedsWebSignIn, WebSignInRequired } from './WebSignInRequired';

const h = vi.hoisted(() => ({
  auth: { authToken: null as string | null, authenticated: false },
}));

vi.mock('@/hooks', () => ({
  useAuth: () => [h.auth, {}],
}));

beforeEach(() => {
  h.auth.authToken = null;
  h.auth.authenticated = false;
});

afterEach(() => {
  setApiBaseUrl('');
});

describe('useNeedsWebSignIn', () => {
  it('is true for the native shell: signed in by a device key, with no web JWT', () => {
    h.auth.authenticated = true;
    h.auth.authToken = null;

    expect(renderHook(() => useNeedsWebSignIn()).result.current).toBe(true);
  });

  it('is false for a web session, which holds a JWT', () => {
    h.auth.authenticated = true;
    h.auth.authToken = 'jwt-abc';

    expect(renderHook(() => useNeedsWebSignIn()).result.current).toBe(false);
  });

  it('is false while nobody is signed in — that is a different problem, not this notice', () => {
    h.auth.authenticated = false;
    h.auth.authToken = null;

    expect(renderHook(() => useNeedsWebSignIn()).result.current).toBe(false);
  });
});

describe('WebSignInRequired', () => {
  it('names the need and carries the reason it is given', () => {
    render(<WebSignInRequired>Keys are managed from a browser.</WebSignInRequired>);

    expect(screen.getByRole('note')).toBeInTheDocument();
    expect(screen.getByText('Needs a web sign-in')).toBeInTheDocument();
    expect(screen.getByText('Keys are managed from a browser.')).toBeInTheDocument();
  });

  // On the phone the person may not remember where their Memory server lives, and "open it in a
  // browser" is no use without that.
  it('names the Memory server to open when the app is pointed at one', () => {
    setApiBaseUrl('https://memory.example.com');
    render(<WebSignInRequired>Because.</WebSignInRequired>);

    expect(screen.getByText('https://memory.example.com')).toBeInTheDocument();
  });

  it('names no server on the web, where the page is already on it', () => {
    render(<WebSignInRequired>Because.</WebSignInRequired>);

    expect(screen.queryByText(/Your Memory server/)).not.toBeInTheDocument();
  });

  it('accepts a different title', () => {
    render(<WebSignInRequired title="Use the web app">Because.</WebSignInRequired>);

    expect(screen.getByText('Use the web app')).toBeInTheDocument();
    expect(screen.queryByText('Needs a web sign-in')).not.toBeInTheDocument();
  });
});
