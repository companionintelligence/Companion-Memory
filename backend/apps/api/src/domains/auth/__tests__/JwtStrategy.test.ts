import { ContextService, SYSTEM_USER } from '@ci/common/context';

import { JwtStrategy } from '../services/JwtStrategy';

/**
 * JwtStrategy.validate is the primary Bearer-JWT authentication path for
 * every JWT-guarded route in the API (JwtOrPortalAuthGuard and friends sit on
 * top of it). Three things matter here and nowhere else:
 *
 *  - a payload that fails the `{ sub: string }` shape check must not
 *    authenticate, even if it otherwise looks plausible;
 *  - a `sub` for a user that no longer exists (e.g. a deleted account whose
 *    access token has not yet expired) must not authenticate — passport-jwt
 *    treats a `null` return as "unauthenticated", not an error;
 *  - a successful validation must publish the resolved user id onto
 *    ContextService, since downstream services (tenancy scoping, audit
 *    logging) read it from there rather than from the request.
 */
describe('JwtStrategy', () => {
  const USER = { id: 'user-1', name: 'Test User' };

  let userService: { findById: jest.Mock };
  let strategy: JwtStrategy;
  let setSpy: jest.SpyInstance;

  const req = {} as never;

  beforeEach(() => {
    setSpy = jest.spyOn(ContextService, 'set').mockImplementation(() => undefined as never);
    userService = { findById: jest.fn() };
    userService.findById.mockResolvedValue(USER);
    strategy = new JwtStrategy(userService as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('authenticates a payload with a valid sub for an existing user', async () => {
    const user = await strategy.validate(req, { sub: USER.id });

    // Looked up as the trusted system caller (this IS the authentication
    // boundary — there is no authenticated user yet to scope the lookup by).
    expect(userService.findById).toHaveBeenCalledWith({ userId: SYSTEM_USER }, USER.id);
    expect(user).toEqual(USER);
  });

  it('publishes the resolved user id onto ContextService on success', async () => {
    await strategy.validate(req, { sub: USER.id });

    expect(setSpy).toHaveBeenCalledWith({ userId: USER.id });
  });

  it('rejects a payload missing `sub` without ever looking up a user', async () => {
    const user = await strategy.validate(req, {} as never);

    expect(user).toBeNull();
    expect(userService.findById).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('rejects a payload whose `sub` is not a string', async () => {
    const user = await strategy.validate(req, { sub: 12345 } as never);

    expect(user).toBeNull();
    expect(userService.findById).not.toHaveBeenCalled();
  });

  it('returns null (not a throw) when the user in the token no longer exists', async () => {
    // A deleted account with a still-unexpired access token must not
    // authenticate as some other/no user — it must cleanly fail closed.
    userService.findById.mockResolvedValue(null);

    const user = await strategy.validate(req, { sub: 'deleted-user' });

    expect(user).toBeNull();
    expect(setSpy).not.toHaveBeenCalled();
  });
});

/**
 * A Python run token (`purpose: 'python_run'`) is signed with the same secret as a session, so this
 * strategy is the only thing between it and every JWT-guarded route. It must authenticate only the
 * sidecars' own read queries, and nothing else that carries a `purpose` may authenticate at all.
 */
describe('JwtStrategy and tokens minted for a purpose', () => {
  const USER = { id: 'owner-1', role: 'admin' };
  const RUN = { sub: USER.id, purpose: 'python_run', jobId: 'job-1', queue: 'hbpe' } as never;

  let userService: { findById: jest.Mock };
  let strategy: JwtStrategy;

  const graphql = (query: string) => ({ method: 'POST', originalUrl: '/graphql', body: { query } }) as never;

  beforeEach(() => {
    jest.spyOn(ContextService, 'set').mockImplementation(() => undefined as never);
    userService = { findById: jest.fn().mockResolvedValue(USER) };
    strategy = new JwtStrategy(userService as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['HBPE Me', 'query Me { me { id } }'],
    [
      'HBPE Summaries',
      'query Summaries($after: String) { summaries(first: 100, after: $after) { edges { node { id } } } }',
    ],
    ['HBPE ContentsExists', 'query ContentsExists { contents(first: 1) { edges { node { id } } } }'],
  ])('lets a run token read %s', async (_label, query) => {
    await expect(strategy.validate(graphql(query), RUN)).resolves.toEqual(USER);
  });

  it.each([
    ['POST /keys (a permanent key)', { method: 'POST', originalUrl: '/keys', body: { name: 'x' } }],
    [
      'POST /mcp/test-connection (spawns a command)',
      { method: 'POST', originalUrl: '/mcp/test-connection', body: { transport: 'stdio', command: 'sh' } },
    ],
    ['DELETE /account', { method: 'DELETE', originalUrl: '/account', body: {} }],
    [
      'a REST route sent an allowlisted query',
      { method: 'POST', originalUrl: '/keys', body: { query: 'query { me { id } }' } },
    ],
    [
      'a mutation',
      { method: 'POST', originalUrl: '/graphql', body: { query: 'mutation { deleteAccount }' } },
    ],
    [
      'a query and a mutation in one document',
      { method: 'POST', originalUrl: '/graphql', body: { query: 'query A { me { id } } mutation B { x }' } },
    ],
    [
      'a root field off the list',
      { method: 'POST', originalUrl: '/graphql', body: { query: 'query { apiKeys { id } }' } },
    ],
    [
      'an allowlisted field next to one off the list',
      { method: 'POST', originalUrl: '/graphql', body: { query: 'query { me { id } apiKeys { id } }' } },
    ],
    [
      'a root fragment spread',
      {
        method: 'POST',
        originalUrl: '/graphql',
        body: { query: 'query { ...F } fragment F on Query { me { id } }' },
      },
    ],
    [
      'a subscription',
      { method: 'POST', originalUrl: '/graphql', body: { query: 'subscription { me { id } }' } },
    ],
    ['a batched body', { method: 'POST', originalUrl: '/graphql', body: [{ query: 'query { me { id } }' }] }],
    ['an unparseable document', { method: 'POST', originalUrl: '/graphql', body: { query: 'query {' } }],
  ])('refuses a run token for %s', async (_label, req) => {
    await expect(strategy.validate(req as never, RUN)).resolves.toBeNull();
    expect(userService.findById).not.toHaveBeenCalled();
  });

  it('refuses any other purpose, even on a request a run token may make', async () => {
    const req = graphql('query { me { id } }');
    await expect(
      strategy.validate(req, { sub: USER.id, purpose: 'signup_intent' } as never),
    ).resolves.toBeNull();
  });

  it('still accepts a session token anywhere', async () => {
    await expect(
      strategy.validate({ method: 'POST', originalUrl: '/keys', body: {} } as never, { sub: USER.id }),
    ).resolves.toEqual(USER);
  });
});
