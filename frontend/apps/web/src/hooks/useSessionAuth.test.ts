import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSessionAuth } from './useSessionAuth';

const h = vi.hoisted(() => ({
  authToken: null as string | null,
  authenticated: false,
  expired: false,
}));

vi.mock('./useAuth', () => ({
  useAuth: () => [{ authToken: h.authToken, authenticated: h.authenticated, expired: h.expired }, {}],
}));

describe('useSessionAuth', () => {
  it('is ready on native when the API key session is up and sends no bearer', () => {
    h.authToken = null;
    h.authenticated = true;
    h.expired = false;

    const { result } = renderHook(() => useSessionAuth());

    expect(result.current.ready).toBe(true);
    expect(result.current.headers.Authorization).toBeUndefined();
  });

  it('sends a bearer only when there is a web JWT', () => {
    h.authToken = 'jwt-1';
    h.authenticated = true;
    h.expired = false;

    const { result } = renderHook(() => useSessionAuth());

    expect(result.current.ready).toBe(true);
    expect(result.current.headers.Authorization).toBe('Bearer jwt-1');
  });

  it('is not ready before the keystore restore or after expiry', () => {
    h.authToken = null;
    h.authenticated = false;
    h.expired = false;

    const idle = renderHook(() => useSessionAuth());
    expect(idle.result.current.ready).toBe(false);

    h.authToken = 'stale';
    h.authenticated = true;
    h.expired = true;

    const expired = renderHook(() => useSessionAuth());
    expect(expired.result.current.ready).toBe(false);
  });
});
