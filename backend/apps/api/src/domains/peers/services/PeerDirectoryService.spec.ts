/**
 * Discovery egresses too, and it used to do it with a bare `fetch`.
 *
 * `directoryUrl` is operator config rather than peer data, so the URL itself is
 * a smaller worry — but the RESPONSE is not operator config. A directory that
 * answered `302 Location: http://127.0.0.1:5432/` had this box follow it, for
 * exactly the same reason `PeerAskClient` did: the check ran on the URL and the
 * transport was left free to choose the next one.
 *
 * This suite exists so the guard cannot quietly come off ONE of the two callers
 * — which is the shape this domain has to be most careful about, since the
 * whole point of `urlPolicy` is that there is one policy and no exceptions.
 */
jest.mock('undici', () => {
  const actual = jest.requireActual('undici');

  return { __esModule: true, ...actual, fetch: jest.fn() };
});

jest.mock('@ci/configuration', () => ({
  __esModule: true,
  default: {
    logging: { level: 'error' },
    peers: { directoryUrl: 'https://portal.example.com/api', timeoutMs: 5_000 },
  },
}));

import { fetch as undiciFetch } from 'undici';

import config from '@ci/configuration';

import { PeerDirectoryService } from './PeerDirectoryService';

const mockFetch = undiciFetch as unknown as jest.Mock;
const peers = (config as unknown as { peers: { directoryUrl?: string } }).peers;

function service(): PeerDirectoryService {
  const logger = { setContext: jest.fn(), warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() };

  return new PeerDirectoryService(logger as never);
}

function respond(status: number, json: unknown = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map<string, string>(),
    body: { cancel: jest.fn().mockResolvedValue(undefined) },
    json: async () => json,
  };
}

const DESCRIPTOR = {
  handle: 'devon',
  displayName: 'Devon',
  memoryEndpoint: 'https://devon.example.com/agent/v1',
  issuer: 'https://portal.example.com',
  subject: 'sub-1',
};

beforeEach(() => {
  mockFetch.mockReset();
  peers.directoryUrl = 'https://portal.example.com/api';
});

describe('PeerDirectoryService — a mis-set directory URL cannot become a port scanner', () => {
  it.each([
    ['loopback', 'http://127.0.0.1:5432'],
    ['cloud metadata', 'https://169.254.169.254/latest'],
    ['a LAN box', 'https://192.168.1.10/api'],
    ['plain http', 'http://portal.example.com/api'],
  ])('resolve() against %s returns null without dialling', async (_label, directoryUrl) => {
    peers.directoryUrl = directoryUrl;

    await expect(service().resolve('devon', 'token')).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('search() is guarded on the same terms', async () => {
    peers.directoryUrl = 'https://127.0.0.1:5432';

    await expect(service().search('dev', 'token')).resolves.toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('PeerDirectoryService — a directory that answers with a redirect', () => {
  it.each([301, 302, 307])('resolve(): %i is refused, not chased', async (status) => {
    mockFetch.mockResolvedValue(respond(status));

    await expect(service().resolve('devon', 'token')).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('search(): the same', async () => {
    mockFetch.mockResolvedValue(respond(302));

    await expect(service().search('dev', 'token')).resolves.toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('PeerDirectoryService — the ordinary path still works', () => {
  it('resolves a handle through the guarded dialer', async () => {
    mockFetch.mockResolvedValue(respond(200, DESCRIPTOR));

    await expect(service().resolve('devon', 'token')).resolves.toEqual(DESCRIPTOR);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://portal.example.com/api/peers/resolve/devon');
    expect(options.redirect).toBe('manual');
    expect(options.dispatcher).toBeDefined();
    expect(options.headers.authorization).toBe('Bearer token');
  });

  it('searches through the guarded dialer', async () => {
    mockFetch.mockResolvedValue(respond(200, { peers: [DESCRIPTOR] }));

    await expect(service().search('dev', 'token')).resolves.toEqual([DESCRIPTOR]);
    expect(mockFetch.mock.calls[0][1].redirect).toBe('manual');
  });

  it('stays silent when discovery is not configured at all', async () => {
    peers.directoryUrl = undefined;

    await expect(service().resolve('devon', 'token')).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
