import { ContextService } from '@ci/common/context';

import { ApiKeyStrategy } from '../services/ApiKeyStrategy';

/**
 * The strategy accepts a key from `x-api-key` or `Authorization: Bearer <key>`.
 *
 * The bearer form exists because most MCP clients expose only a bearer-token field and cannot send
 * a custom header, which made `/api/mcp` unreachable for them. These tests pin both forms, the
 * case-insensitive scheme match, the precedence between them, and that a malformed Authorization
 * header — or a session JWT — is not mistaken for a key.
 */
describe('ApiKeyStrategy', () => {
  const VALID_KEY = 'a'.repeat(64);
  const USER = { id: 'user-1' };

  let apiKeyService: { validateCredential: jest.Mock };
  let userService: { findById: jest.Mock };
  let strategy: ApiKeyStrategy;

  /** Minimal express-like request: `req.get()` is case-insensitive, as express is. */
  const requestWith = (headers: Record<string, string>) => {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

    return { get: (name: string) => lower[name.toLowerCase()], headers: lower } as never;
  };

  beforeEach(() => {
    jest.spyOn(ContextService, 'set').mockImplementation(() => undefined as never);
    apiKeyService = { validateCredential: jest.fn() };
    userService = { findById: jest.fn() };
    apiKeyService.validateCredential.mockResolvedValue({ userId: USER.id, scopes: ['mcp'], keyId: 'key-1' });
    userService.findById.mockResolvedValue(USER);
    strategy = new ApiKeyStrategy(apiKeyService as never, userService as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('authenticates a key sent as x-api-key', async () => {
    const user = await strategy.validate(requestWith({ 'x-api-key': VALID_KEY }));

    expect(apiKeyService.validateCredential).toHaveBeenCalledWith(VALID_KEY);
    expect(user).toEqual(USER);
  });

  it('authenticates a key sent as Authorization: Bearer', async () => {
    const user = await strategy.validate(requestWith({ authorization: `Bearer ${VALID_KEY}` }));

    expect(apiKeyService.validateCredential).toHaveBeenCalledWith(VALID_KEY);
    expect(user).toEqual(USER);
  });

  it('prefers x-api-key when both headers are present', async () => {
    await strategy.validate(requestWith({ 'x-api-key': VALID_KEY, authorization: 'Bearer other-key' }));

    expect(apiKeyService.validateCredential).toHaveBeenCalledWith(VALID_KEY);
  });

  it('exposes the key scopes and id so route scope enforcement can run', async () => {
    const req = requestWith({ authorization: `Bearer ${VALID_KEY}` });

    await strategy.validate(req);

    expect((req as unknown as { apiKeyScopes: string[] }).apiKeyScopes).toEqual(['mcp']);
    expect((req as unknown as { apiKeyId: string }).apiKeyId).toBe('key-1');
    expect(req).not.toHaveProperty('apiKeyAccessTokenExpiresAt');
  });

  it("marks a request that carried a key's access token, and when that token ends", async () => {
    apiKeyService.validateCredential.mockResolvedValue({
      userId: USER.id,
      scopes: [],
      keyId: 'key-1',
      accessTokenExpiresAt: 123_000,
    });
    const req = requestWith({ 'x-api-key': 'aaa.bbb.ccc' });

    await expect(strategy.validate(req)).resolves.toEqual(USER);
    expect((req as unknown as { apiKeyId: string }).apiKeyId).toBe('key-1');
    expect((req as unknown as { apiKeyAccessTokenExpiresAt: number }).apiKeyAccessTokenExpiresAt).toBe(
      123_000,
    );
  });

  it('accepts a lowercase bearer scheme, as RFC 7235 requires', async () => {
    // passport-jwt lowercases the scheme before comparing (extract_jwt.js:54,60), so `bearer <jwt>`
    // already authenticates. Matching the scheme case-sensitively here would 401 the same spelling
    // for a key — an inconsistency between two strategies reading one header.
    const user = await strategy.validate(requestWith({ authorization: `bearer ${VALID_KEY}` }));

    expect(apiKeyService.validateCredential).toHaveBeenCalledWith(VALID_KEY);
    expect(user).toEqual(USER);
  });

  it('falls through to the bearer form when x-api-key is blank', async () => {
    // A proxy that always sets the header must not mask a credential the request did carry.
    const user = await strategy.validate(
      requestWith({ 'x-api-key': '   ', authorization: `Bearer ${VALID_KEY}` }),
    );

    expect(apiKeyService.validateCredential).toHaveBeenCalledWith(VALID_KEY);
    expect(user).toEqual(USER);
  });

  it('cannot authenticate a session JWT presented as Bearer', async () => {
    // The safety of accepting the bearer form rests on ApiKeyService.validateCredential, not on the
    // hash lookup: a JWT-shaped value is only ever checked as a device access token, which a session
    // JWT cannot pass (`deviceAccessToken.test.ts`), and anything else must be 64 hex characters.
    // Mirror that so the claim is pinned here, where a reader of this strategy will look for it.
    apiKeyService.validateCredential.mockImplementation(async (key: string) =>
      /^[0-9a-f]{64}$/.test(key) ? { userId: USER.id, scopes: [], keyId: 'key-1' } : null,
    );

    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJl';
    const user = await strategy.validate(requestWith({ authorization: `Bearer ${jwt}` }));

    expect(apiKeyService.validateCredential).toHaveBeenCalledWith(jwt);
    expect(user).toBeNull();
  });

  it('ignores a non-Bearer Authorization scheme', async () => {
    const user = await strategy.validate(requestWith({ authorization: `Basic ${VALID_KEY}` }));

    expect(apiKeyService.validateCredential).not.toHaveBeenCalled();
    expect(user).toBeNull();
  });

  it('ignores a Bearer header with an empty token', async () => {
    const user = await strategy.validate(requestWith({ authorization: 'Bearer    ' }));

    expect(apiKeyService.validateCredential).not.toHaveBeenCalled();
    expect(user).toBeNull();
  });

  it('returns null when no credential header is present', async () => {
    const user = await strategy.validate(requestWith({}));

    expect(apiKeyService.validateCredential).not.toHaveBeenCalled();
    expect(user).toBeNull();
  });

  it('returns null when the key does not resolve', async () => {
    apiKeyService.validateCredential.mockResolvedValue(null);

    const user = await strategy.validate(requestWith({ authorization: `Bearer ${VALID_KEY}` }));

    expect(user).toBeNull();
  });
});
