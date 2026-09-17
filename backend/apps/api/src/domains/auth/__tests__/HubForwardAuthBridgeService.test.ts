import type { Response } from 'express';

import { signForwardAuthUser } from '@ci/common/crypto';
import config from '@ci/configuration';

import { HubForwardAuthBridgeService } from '../services/HubForwardAuthBridgeService';

const SECRET = 'bridge-secret';
const NOW = 1_700_000_000_000;

function signedHeaders(username: string, secret = SECRET, now = NOW) {
  return {
    'x-ci-hub-user': username,
    'x-ci-hub-user-timestamp': String(now),
    'x-ci-hub-user-signature': signForwardAuthUser(secret, username, now),
  };
}

function makeService() {
  const userService = {
    findById: jest.fn(),
    findByEmail: jest.fn(),
    create: jest.fn(),
  };
  const authService = {
    validateSessionToken: jest.fn(),
    invalidateSession: jest.fn().mockResolvedValue(undefined),
    issueSessionToken: jest.fn().mockResolvedValue({ sessionToken: 'new-sess', sessionId: 'sid-2' }),
    issueAccessToken: jest.fn().mockReturnValue('access-hello'),
    getSessionMetadata: jest.fn().mockReturnValue({ ip: '127.0.0.1', userAgent: 'jest' }),
  };
  const csrfService = { generateToken: jest.fn().mockReturnValue('csrf-2') };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new HubForwardAuthBridgeService(
    userService as never,
    authService as never,
    csrfService as never,
    logger as never,
  );

  return { service, userService, authService, csrfService };
}

describe('HubForwardAuthBridgeService', () => {
  const previous = {
    enabled: config.auth.hubForwardAuth.enabled,
    secret: config.auth.hubForwardAuth.secret,
    maxSkewMs: config.auth.hubForwardAuth.maxSkewMs,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    config.auth.hubForwardAuth.enabled = true;
    config.auth.hubForwardAuth.secret = SECRET;
    config.auth.hubForwardAuth.maxSkewMs = 300_000;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    config.auth.hubForwardAuth.enabled = previous.enabled;
    config.auth.hubForwardAuth.secret = previous.secret;
    config.auth.hubForwardAuth.maxSkewMs = previous.maxSkewMs;
  });

  it('ignores requests when forward-auth is disabled', () => {
    config.auth.hubForwardAuth.enabled = false;
    const { service } = makeService();
    const req = { headers: signedHeaders('hello@lifescope.io'), cookies: {} } as never;

    expect(service.verifyUsername(req)).toBeNull();
  });

  it('returns the verified Hub username', () => {
    const { service } = makeService();
    const req = { headers: signedHeaders('hello@lifescope.io'), cookies: {} } as never;

    expect(service.verifyUsername(req)).toBe('hello@lifescope.io');
  });

  it('leaves a matching Memory session alone', async () => {
    const { service, userService, authService } = makeService();
    authService.validateSessionToken.mockReturnValue({ sub: 'user-a' });
    userService.findById.mockResolvedValue({ id: 'user-a', email: 'hello@lifescope.io' });
    const req = {
      headers: signedHeaders('hello@lifescope.io'),
      cookies: { [config.auth.cookies.sessionTokenName]: 'old-token' },
    } as never;
    const res = { cookie: jest.fn() } as unknown as Response;

    await expect(service.alignSession(req, res)).resolves.toEqual({
      username: 'hello@lifescope.io',
      replaced: false,
    });
    expect(authService.invalidateSession).not.toHaveBeenCalled();
    expect(userService.create).not.toHaveBeenCalled();
  });

  it('replaces a stale Memory session and JIT-creates the Hub person', async () => {
    const { service, userService, authService, csrfService } = makeService();
    authService.validateSessionToken.mockReturnValue({ sub: 'user-a' });
    userService.findById.mockResolvedValue({ id: 'user-a', email: 'chamberlain.bennett@gmail.com' });
    userService.findByEmail.mockResolvedValue(null);
    userService.create.mockResolvedValue({ id: 'user-b', email: 'hello@lifescope.io' });
    const req = {
      headers: signedHeaders('hello@lifescope.io'),
      cookies: { [config.auth.cookies.sessionTokenName]: 'old-token' },
      secure: false,
    } as never;
    const cookie = jest.fn();
    const res = { cookie } as unknown as Response;

    await expect(service.alignSession(req, res)).resolves.toEqual({
      username: 'hello@lifescope.io',
      replaced: true,
      accessToken: 'access-hello',
    });
    expect(authService.invalidateSession).toHaveBeenCalledWith('user-a', 'old-token', expect.any(Object));
    expect(userService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: 'hello@lifescope.io' }),
    );
    expect(authService.issueSessionToken).toHaveBeenCalledWith('user-b', expect.any(Object));
    expect(csrfService.generateToken).toHaveBeenCalledWith('sid-2');
    expect(cookie).toHaveBeenCalled();
  });
});
