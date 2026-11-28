import { getApiKey, setApiKey } from '@ci/common';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLiveChangesAuth, subscribeLiveChanges } from '@/api/liveChanges';

import { useLiveChanges } from './useLiveChanges';
import { useSessionAuth } from './useSessionAuth';

vi.mock('@ci/common', async (orig) => ({
  ...(await orig<typeof import('@ci/common')>()),
  getApiKey: vi.fn(),
}));

vi.mock('@/api/liveChanges', () => ({
  setLiveChangesAuth: vi.fn(),
  subscribeLiveChanges: vi.fn(() => () => undefined),
}));

vi.mock('./useSessionAuth', () => ({ useSessionAuth: vi.fn() }));

const mockedGetApiKey = vi.mocked(getApiKey);
const mockedSetAuth = vi.mocked(setLiveChangesAuth);
const mockedSession = vi.mocked(useSessionAuth);

function session(ready: boolean, authToken: string | null) {
  mockedSession.mockReturnValue({ ready, authToken, headers: {} });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetApiKey.mockReturnValue(null);
});

describe('useLiveChanges', () => {
  it('hands the web session token to the stream as a bearer', () => {
    session(true, 'jwt-1');

    renderHook(() => useLiveChanges(['tasks'], () => undefined));

    expect(mockedSetAuth).toHaveBeenLastCalledWith('jwt-1');
    expect(vi.mocked(subscribeLiveChanges)).toHaveBeenCalledWith(['tasks'], expect.any(Function));
  });

  it('gives the stream nothing while the web session is not ready', () => {
    session(false, null);

    renderHook(() => useLiveChanges(['calendar'], () => undefined));

    expect(mockedSetAuth).toHaveBeenLastCalledWith(null);
  });

  it('prefers the bearer when there is one, even with a key set', () => {
    session(true, 'jwt-1');
    mockedGetApiKey.mockReturnValue('device-key');

    renderHook(() => useLiveChanges(['tasks'], () => undefined));

    expect(mockedSetAuth).toHaveBeenLastCalledWith('jwt-1');
  });

  // The phone app has no web token: `authToken` is null and the device's API
  // key is what signs its requests.
  it('hands the phone API key to the stream when there is no web token', () => {
    session(true, null);
    mockedGetApiKey.mockReturnValue('device-key');

    renderHook(() => useLiveChanges(['tasks'], () => undefined));

    expect(mockedSetAuth).toHaveBeenLastCalledWith('device-key', 'apiKey');
  });

  it('passes a new key on when the phone signs in again', () => {
    session(true, null);
    mockedGetApiKey.mockReturnValue('old-key');
    const { rerender } = renderHook(() => useLiveChanges(['tasks'], () => undefined));
    expect(mockedSetAuth).toHaveBeenLastCalledWith('old-key', 'apiKey');

    mockedGetApiKey.mockReturnValue('new-key');
    rerender();

    expect(mockedSetAuth).toHaveBeenLastCalledWith('new-key', 'apiKey');
  });

  // The phone's token is renewed every few minutes by `apiAuth.ts`, with nothing in React changing.
  it('passes each new token on as it arrives, without waiting for a render', () => {
    session(true, null);
    mockedGetApiKey.mockReturnValue('token-1');
    renderHook(() => useLiveChanges(['tasks'], () => undefined));
    expect(mockedSetAuth).toHaveBeenLastCalledWith('token-1', 'apiKey');

    mockedGetApiKey.mockReturnValue('token-2');
    // What the token manager does when the native side hands over a new token: notify.
    act(() => {
      setApiKey('token-2');
    });

    expect(mockedSetAuth).toHaveBeenLastCalledWith('token-2', 'apiKey');
    setApiKey(null);
  });

  it('takes the key away when the phone signs out', () => {
    session(true, null);
    mockedGetApiKey.mockReturnValue('device-key');
    const { rerender } = renderHook(() => useLiveChanges(['tasks'], () => undefined));

    session(false, null);
    mockedGetApiKey.mockReturnValue(null);
    rerender();

    expect(mockedSetAuth).toHaveBeenLastCalledWith(null);
  });
});
