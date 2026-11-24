import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useConnectService } from './useConnectService';

const h = vi.hoisted(() => ({ fetchJson: vi.fn() }));

vi.mock('@/hooks', () => ({ useAuth: () => [{ authToken: 'token' }, {}] }));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson: h.fetchJson,
}));

beforeEach(() => {
  h.fetchJson.mockReset();
  h.fetchJson.mockResolvedValue({ authorizationUrl: '' });
});

/**
 * Signal: one signal-cli service can hold several numbers, each somebody's own. The server used to
 * bind a new connection to whichever number the service listed first; now the caller names it.
 */
describe('useConnectService', () => {
  it('sends the number the person typed with the key', async () => {
    const { result } = renderHook(() => useConnectService());

    act(() => {
      result.current[0].setApiKey('signal-key');
      result.current[0].setAccount(' +15550001111 ');
    });
    await act(() => result.current[1].connect('signal-provider-id', ['Messages']));

    const [url, init] = h.fetchJson.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('/api/providers/signal-provider-id');
    expect(JSON.parse(init.body)).toEqual({
      endpoints: ['Messages'],
      apiKey: 'signal-key',
      account: '+15550001111',
    });
  });

  it('sends no account for a provider that does not ask for one', async () => {
    const { result } = renderHook(() => useConnectService());

    await act(() => result.current[1].connect('google-provider-id', []));

    const [, init] = h.fetchJson.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({ endpoints: [] });
  });
});
