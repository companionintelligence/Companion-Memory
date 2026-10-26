const ciPortal = { url: 'https://portal.example.com/', deviceId: 'device-1', apiKey: 'device-key-1' };

jest.mock('@ci/configuration', () => {
  const actual = jest.requireActual('@ci/configuration').default;

  return {
    __esModule: true,
    default: {
      ...actual,
      get ciPortal() {
        return { ...actual.ciPortal, ...ciPortal };
      },
    },
  };
});

import type { LoggerService } from '@ci/common/logging';

import { CloudOAuthProxyService } from '../CloudOAuthProxyService';

describe('CloudOAuthProxyService.getDeviceApplications', () => {
  const logger = { setContext: jest.fn(), warn: jest.fn(), debug: jest.fn(), log: jest.fn() } as unknown as LoggerService;
  const fetchMock = jest.fn();
  const realFetch = global.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  // Companion Portal reads a device on this route from `x-device-key` and nothing else. Sent as
  // Basic auth, the key was ignored and the call answered 401, so every installed agent that was
  // not connected yet counted as not installed.
  it('sends the device key the way Companion Portal reads it on this route', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ applications: [{ name: 'ci-hermes' }] }), { status: 200 }));

    const apps = await new CloudOAuthProxyService(logger).getDeviceApplications();

    expect(apps).toEqual([{ name: 'ci-hermes' }]);
    expect(fetchMock).toHaveBeenCalledWith('https://portal.example.com/api/devices/applications', {
      headers: { 'x-device-key': 'device-key-1' },
    });
  });

  it('answers an empty list when Companion Portal refuses', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'Invalid Device Key' }), { status: 401 }));

    await expect(new CloudOAuthProxyService(logger).getDeviceApplications()).resolves.toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith('CI Portal device applications request failed', expect.objectContaining({ status: 401 }));
  });
});
