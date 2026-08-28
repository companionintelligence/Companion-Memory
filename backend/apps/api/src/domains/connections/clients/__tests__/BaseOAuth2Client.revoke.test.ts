import type { Connection } from '../../entities/ConnectionEntity';
import { GoogleClient } from '../GoogleClient';

/**
 * Exercises BaseOAuth2Client.revoke() through GoogleClient (which sets the
 * Google RFC 7009 revocation endpoint). GoogleClient's other collaborators
 * (ProviderKeyService, CloudOAuthProxyService) are `@Inject`ed field props and
 * are NOT touched by revoke(), so a bare `new GoogleClient(logger)` is enough.
 */
function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn-1',
    accessToken: 'access-tok',
    refreshToken: 'refresh-tok',
    providerId: 'google',
    userId: 'user-1',
    // Unused-by-revoke fields, filled to satisfy the type.
    name: 'Google',
    active: true,
    schedule: null,
    tokenExpiry: null,
    syncState: null,
    activeEndpoints: [],
    needsReauth: false,
    externalId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Connection;
}

describe('BaseOAuth2Client.revoke (via GoogleClient)', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('POSTs the token to Google’s revocation endpoint and reports revoked=true', async () => {
    const fetchMock = jest.fn(async () => new Response(null, { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new GoogleClient(makeLogger() as never);
    const result = await client.revoke(
      makeConnection({ refreshToken: 'refresh-tok', accessToken: 'access-tok' }),
    );

    expect(result.revoked).toBe(true);
    expect(fetchMock).toHaveBeenCalled();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/revoke');
    expect(init.method).toBe('POST');
    // The refresh token is preferred (revoking it kills the whole grant) and is
    // sent as the `token` form field.
    expect(String(init.body)).toContain('token=refresh-tok');
  });

  it('attempts BOTH tokens when present (refresh + access), deduped', async () => {
    const fetchMock = jest.fn(async () => new Response(null, { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new GoogleClient(makeLogger() as never);
    await client.revoke(makeConnection({ refreshToken: 'refresh-tok', accessToken: 'access-tok' }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).map((c) =>
      String(c[1].body),
    );
    expect(bodies.some((b) => b.includes('token=refresh-tok'))).toBe(true);
    expect(bodies.some((b) => b.includes('token=access-tok'))).toBe(true);
  });

  it('is a no-op (revoked=false, no fetch) when the connection has no tokens', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new GoogleClient(makeLogger() as never);
    const result = await client.revoke(makeConnection({ refreshToken: null, accessToken: null }));

    expect(result.revoked).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is best-effort: a provider error yields revoked=false and never throws', async () => {
    const fetchMock = jest.fn(async () => {
      throw new Error('network down');
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new GoogleClient(makeLogger() as never);
    const result = await client.revoke(makeConnection({ refreshToken: 'refresh-tok', accessToken: null }));

    expect(result.revoked).toBe(false);
  });

  it('treats a non-OK response (already-revoked token) as best-effort, not fatal', async () => {
    const fetchMock = jest.fn(async () => new Response('invalid_token', { status: 400 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new GoogleClient(makeLogger() as never);
    const result = await client.revoke(makeConnection({ refreshToken: 'refresh-tok', accessToken: null }));

    // 400 => not counted as revoked, but no throw; caller still proceeds to purge.
    expect(result.revoked).toBe(false);
  });
});
