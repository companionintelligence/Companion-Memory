import type { Connection } from '@ci/domains/connections';
import {
  getRedditScopesFromActiveEndpoints,
  REDDIT_USER_AGENT,
  RedditClient,
} from '@ci/domains/connections/clients/RedditClient';

describe('getRedditScopesFromActiveEndpoints', () => {
  const endpointScopeMap = {
    Posts: ['history', 'read', 'identity'],
    Comments: ['history', 'read', 'identity'],
    Saved: ['history', 'read', 'save', 'identity'],
    default: ['identity', 'read'],
  };

  it('returns default scopes when no endpoints are active', () => {
    expect(getRedditScopesFromActiveEndpoints([], endpointScopeMap)).toBe('identity read');
  });

  it('merges scopes for posts and comments', () => {
    const scopes = getRedditScopesFromActiveEndpoints(['Posts', 'Comments'], endpointScopeMap).split(' ');

    expect(scopes).toEqual(expect.arrayContaining(['identity', 'read', 'history']));
    expect(scopes).not.toContain('save');
  });

  it('includes save scope when saved endpoint is active', () => {
    const scopes = getRedditScopesFromActiveEndpoints(['Saved'], endpointScopeMap).split(' ');

    expect(scopes).toEqual(expect.arrayContaining(['save', 'history', 'read', 'identity']));
  });
});

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/**
 * RedditClient's collaborators are `@Inject`ed field props; set the one
 * revoke() reads by hand.
 */
function makeClient(keys: { clientId: string; clientSecret: string } | null) {
  const client = new RedditClient(makeLogger() as never);
  const findByProviderId = jest.fn(async () => keys);

  Object.assign(client, { providerKeyService: { findByProviderId } });

  return { client, findByProviderId };
}

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn-1',
    userId: 'user-1',
    providerId: 'reddit-provider-id',
    accessToken: 'access-tok',
    refreshToken: 'refresh-tok',
    ...overrides,
  } as Connection;
}

describe('RedditClient scopes', () => {
  // Reddit's API reference: /api/v1/me is `identity`; /user/{name}/submitted,
  // /comments and /saved are `history`. `save` (write) and `read` are unused.
  it.each([[['Posts']], [['Comments']], [['Saved']], [['Posts', 'Comments', 'Saved']]])(
    'asks only for identity and history for %j',
    (endpoints) => {
      const { client } = makeClient(null);

      expect(client.getScopesFromActiveEndpoints(endpoints).split(' ').sort()).toEqual([
        'history',
        'identity',
      ]);
    },
  );

  it('asks only for identity with no endpoints active', () => {
    const { client } = makeClient(null);

    expect(client.getScopesFromActiveEndpoints([])).toBe('identity');
  });
});

describe('RedditClient.revoke', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('revokes both tokens with Basic client auth, refresh token first', async () => {
    const fetchMock = jest.fn(async () => new Response(null, { status: 204 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { client, findByProviderId } = makeClient({ clientId: 'cid', clientSecret: 'csecret' });
    const result = await client.revoke(makeConnection());

    expect(result).toEqual({ revoked: true });
    expect(findByProviderId).toHaveBeenCalledWith({ userId: 'user-1' }, 'reddit-provider-id');

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;

    expect(calls).toHaveLength(2);

    for (const [url, init] of calls) {
      const headers = init.headers as Record<string, string>;

      expect(url).toBe('https://www.reddit.com/api/v1/revoke_token');
      expect(init.method).toBe('POST');
      expect(headers.Authorization).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
      expect(headers['User-Agent']).toBe(REDDIT_USER_AGENT);
    }

    expect(new URLSearchParams(String(calls[0][1].body)).get('token')).toBe('refresh-tok');
    expect(new URLSearchParams(String(calls[0][1].body)).get('token_type_hint')).toBe('refresh_token');
    expect(new URLSearchParams(String(calls[1][1].body)).get('token')).toBe('access-tok');
    expect(new URLSearchParams(String(calls[1][1].body)).get('token_type_hint')).toBe('access_token');
  });

  it('skips the call (revoked=false) without the user’s own Reddit app credentials', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const { client } = makeClient(null);

    await expect(client.revoke(makeConnection())).resolves.toEqual({ revoked: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is a no-op when the connection holds no tokens', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const { client, findByProviderId } = makeClient({ clientId: 'cid', clientSecret: 'csecret' });

    await expect(client.revoke(makeConnection({ accessToken: null, refreshToken: null }))).resolves.toEqual({
      revoked: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(findByProviderId).not.toHaveBeenCalled();
  });

  it('never throws: a network error or a refusal reports revoked=false', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(new Response('', { status: 401 })) as unknown as typeof fetch;

    const { client } = makeClient({ clientId: 'cid', clientSecret: 'csecret' });

    await expect(client.revoke(makeConnection())).resolves.toEqual({ revoked: false });
  });
});
