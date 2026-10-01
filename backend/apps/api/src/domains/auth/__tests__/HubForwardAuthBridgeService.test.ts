import type { Response } from 'express';

import { signForwardAuthUser, signForwardAuthUserId } from '@ci/common/crypto';
import config from '@ci/configuration';

import { HubForwardAuthBridgeService } from '../services/HubForwardAuthBridgeService';

const SECRET = 'bridge-secret';
const NOW = 1_700_000_000_000;

const DIRECTORY = 'urn:ci-hub:6f1c2a4e-2f3b-4c5d-8e9f-0a1b2c3d4e5f';
const OTHER_DIRECTORY = 'urn:ci-hub:00000000-0000-4000-8000-000000000000';
const HUB_ID = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';
const OTHER_HUB_ID = '0192a3b4-c5d6-7e8f-9a0b-ffffffffffff';

function signedHeaders(username: string, secret = SECRET, now = NOW) {
  return {
    'x-ci-hub-user': username,
    'x-ci-hub-user-timestamp': String(now),
    'x-ci-hub-user-signature': signForwardAuthUser(secret, username, now),
  };
}

/** The headers a Hub that sends stable ids attaches: the triple plus the signed (issuer, id). */
function stableHeaders(username: string, { issuer = DIRECTORY, userId = HUB_ID } = {}) {
  return {
    ...signedHeaders(username),
    'x-ci-hub-user-issuer': issuer,
    'x-ci-hub-user-id': userId,
    'x-ci-hub-user-id-signature': signForwardAuthUserId(SECRET, issuer, userId, username, NOW),
  };
}

function account(id: string, email: string) {
  return { id, email };
}

function uniqueViolation(): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
}

function makeService() {
  const userService = {
    findById: jest.fn().mockResolvedValue(null),
    findByEmail: jest.fn().mockResolvedValue(null),
    findByEmailIgnoringCase: jest.fn().mockResolvedValue([]),
    checkEmailAvailability: jest.fn().mockResolvedValue(false),
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
  const federatedIdentityService = {
    findUserId: jest.fn().mockResolvedValue(null),
    findForUserFromIssuer: jest.fn().mockResolvedValue(null),
    bind: jest.fn(async (data: { userId: string; issuer: string; subject: string }) => ({ ...data })),
  };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new HubForwardAuthBridgeService(
    userService as never,
    authService as never,
    csrfService as never,
    federatedIdentityService as never,
    logger as never,
  );

  return { service, userService, authService, csrfService, federatedIdentityService };
}

/** A request from a browser whose Memory cookie belongs to `sessionUser` (or none). */
function requestWith(headers: Record<string, string>, sessionCookie: string | null = 'old-token') {
  return {
    headers,
    cookies: sessionCookie ? { [config.auth.cookies.sessionTokenName]: sessionCookie } : {},
    secure: false,
  } as never;
}

function response() {
  const res = { cookie: jest.fn(), clearCookie: jest.fn() };

  return res as typeof res & Response;
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

  it("returns the Hub person's stable id when the Hub signed one", () => {
    const { service } = makeService();

    expect(service.verifyIdentity(requestWith(stableHeaders('hello@lifescope.io'), null))).toEqual({
      username: 'hello@lifescope.io',
      stableId: { issuer: DIRECTORY, subject: HUB_ID },
    });
  });

  it('trusts no identity at all when the stable id is tampered with', () => {
    const { service } = makeService();
    const headers = { ...stableHeaders('hello@lifescope.io'), 'x-ci-hub-user-id': OTHER_HUB_ID };

    expect(service.verifyIdentity(requestWith(headers, null))).toBeNull();
  });

  describe('namesAccount', () => {
    it('is true when the verified Hub username is this address, whatever its case', async () => {
      const { service } = makeService();
      const req = { headers: signedHeaders('hello@lifescope.io'), cookies: {} } as never;

      await expect(service.namesAccount(req, ' Hello@LifeScope.io ')).resolves.toBe(true);
    });

    it('is false for someone else', async () => {
      const { service } = makeService();
      const req = { headers: signedHeaders('hello@lifescope.io'), cookies: {} } as never;

      await expect(service.namesAccount(req, 'other@lifescope.io')).resolves.toBe(false);
    });

    it('is false for a header the Hub did not sign', async () => {
      const { service } = makeService();
      const req = { headers: signedHeaders('hello@lifescope.io', 'not-the-secret'), cookies: {} } as never;

      await expect(service.namesAccount(req, 'hello@lifescope.io')).resolves.toBe(false);
    });

    it('is false when forward-auth is disabled', async () => {
      config.auth.hubForwardAuth.enabled = false;
      const { service } = makeService();
      const req = { headers: signedHeaders('hello@lifescope.io'), cookies: {} } as never;

      await expect(service.namesAccount(req, 'hello@lifescope.io')).resolves.toBe(false);
    });

    it('is false once the stable id is linked: the link finds them, not the address', async () => {
      const { service, federatedIdentityService } = makeService();
      federatedIdentityService.findUserId.mockResolvedValue('user-a');

      await expect(
        service.namesAccount(requestWith(stableHeaders('hello@lifescope.io'), null), 'hello@lifescope.io'),
      ).resolves.toBe(false);
      expect(federatedIdentityService.findUserId).toHaveBeenCalledWith(DIRECTORY, HUB_ID);
    });

    it('is true for a stable id not linked yet, which the next page load links by this address', async () => {
      const { service } = makeService();

      await expect(
        service.namesAccount(requestWith(stableHeaders('hello@lifescope.io'), null), 'hello@lifescope.io'),
      ).resolves.toBe(true);
    });
  });

  describe('a Hub that sends no stable id (email alone, as before)', () => {
    it('leaves a matching Memory session alone', async () => {
      const { service, userService, authService } = makeService();
      authService.validateSessionToken.mockReturnValue({ sub: 'user-a' });
      userService.findById.mockResolvedValue(account('user-a', 'hello@lifescope.io'));

      await expect(
        service.alignSession(requestWith(signedHeaders('hello@lifescope.io')), response()),
      ).resolves.toEqual({
        username: 'hello@lifescope.io',
        replaced: false,
      });
      expect(authService.invalidateSession).not.toHaveBeenCalled();
      expect(userService.create).not.toHaveBeenCalled();
    });

    it('replaces a stale Memory session and JIT-creates the Hub person', async () => {
      const { service, userService, authService, csrfService, federatedIdentityService } = makeService();
      authService.validateSessionToken.mockReturnValue({ sub: 'user-a' });
      userService.findById.mockResolvedValue(account('user-a', 'chamberlain.bennett@gmail.com'));
      userService.create.mockResolvedValue(account('user-b', 'hello@lifescope.io'));
      const res = response();

      await expect(
        service.alignSession(requestWith(signedHeaders('hello@lifescope.io')), res),
      ).resolves.toEqual({
        username: 'hello@lifescope.io',
        replaced: true,
        accessToken: 'access-hello',
      });
      expect(authService.invalidateSession).toHaveBeenCalledWith('user-a', 'old-token', expect.any(Object));
      expect(userService.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ email: 'hello@lifescope.io', passwordChosenByUser: false }),
      );
      expect(authService.issueSessionToken).toHaveBeenCalledWith('user-b', expect.any(Object));
      expect(csrfService.generateToken).toHaveBeenCalledWith('sid-2');
      expect(res.cookie).toHaveBeenCalled();
      // Nothing to link: a legacy identity carries no stable id.
      expect(federatedIdentityService.bind).not.toHaveBeenCalled();
    });

    it('signs the previous person out before finding the account, as it always has', async () => {
      const { service, userService, authService } = makeService();
      authService.validateSessionToken.mockReturnValue({ sub: 'user-a' });
      userService.findById.mockResolvedValue(account('user-a', 'chamberlain.bennett@gmail.com'));
      userService.create.mockRejectedValue(new Error('db down'));

      await expect(
        service.alignSession(requestWith(signedHeaders('hello@lifescope.io')), response()),
      ).rejects.toThrow('db down');
      expect(authService.invalidateSession).toHaveBeenCalledWith('user-a', 'old-token', expect.any(Object));
    });
  });

  describe('a Hub that sends a stable id', () => {
    it('keeps a renamed Hub person in their linked account, whatever either address says now', async () => {
      // The person was linked as old@ and has since renamed themselves new@ on the Hub. By email they
      // would be a stranger here, and the old bridge JIT-created an empty account for new@.
      const { service, userService, authService, federatedIdentityService } = makeService();
      federatedIdentityService.findUserId.mockResolvedValue('user-a');
      authService.validateSessionToken.mockReturnValue({ sub: 'user-a' });
      userService.findById.mockResolvedValue(account('user-a', 'old@lifescope.io'));
      userService.findByEmail.mockResolvedValue(account('user-dup', 'new@lifescope.io'));

      await expect(
        service.alignSession(requestWith(stableHeaders('new@lifescope.io')), response()),
      ).resolves.toEqual({
        username: 'new@lifescope.io',
        replaced: false,
      });
      expect(federatedIdentityService.findUserId).toHaveBeenCalledWith(DIRECTORY, HUB_ID);
      expect(userService.create).not.toHaveBeenCalled();
      expect(authService.invalidateSession).not.toHaveBeenCalled();
    });

    it("moves a browser holding someone else's session to the linked account", async () => {
      const { service, userService, authService, federatedIdentityService } = makeService();
      federatedIdentityService.findUserId.mockResolvedValue('user-a');
      authService.validateSessionToken.mockReturnValue({ sub: 'user-z' });
      userService.findById.mockImplementation(async (_ctx: unknown, id: string) =>
        id === 'user-a' ? account('user-a', 'old@lifescope.io') : account('user-z', 'z@lifescope.io'),
      );

      await expect(
        service.alignSession(requestWith(stableHeaders('new@lifescope.io')), response()),
      ).resolves.toEqual({
        username: 'new@lifescope.io',
        replaced: true,
        accessToken: 'access-hello',
      });
      expect(authService.invalidateSession).toHaveBeenCalledWith('user-z', 'old-token', expect.any(Object));
      expect(authService.issueSessionToken).toHaveBeenCalledWith('user-a', expect.any(Object));
      expect(authService.issueAccessToken).toHaveBeenCalledWith('user-a');
    });

    it('links an unlinked person, once, to the account their Hub username names', async () => {
      const { service, userService, federatedIdentityService, authService } = makeService();
      userService.findByEmail.mockResolvedValue(account('user-a', 'hello@lifescope.io'));

      await expect(
        service.alignSession(requestWith(stableHeaders('hello@lifescope.io'), null), response()),
      ).resolves.toEqual({ username: 'hello@lifescope.io', replaced: true, accessToken: 'access-hello' });
      expect(federatedIdentityService.findForUserFromIssuer).toHaveBeenCalledWith('user-a', DIRECTORY);
      expect(federatedIdentityService.bind).toHaveBeenCalledWith({
        userId: 'user-a',
        issuer: DIRECTORY,
        subject: HUB_ID,
        email: 'hello@lifescope.io',
        bindMethod: 'email_link',
      });
      expect(authService.issueSessionToken).toHaveBeenCalledWith('user-a', expect.any(Object));
      expect(userService.create).not.toHaveBeenCalled();
    });

    it('adopts the only case-insensitive match when no account has the exact address', async () => {
      const { service, userService, federatedIdentityService } = makeService();
      userService.findByEmailIgnoringCase.mockResolvedValue([account('user-a', 'Hello@LifeScope.io')]);

      await service.alignSession(requestWith(stableHeaders('hello@lifescope.io'), null), response());

      expect(userService.findByEmailIgnoringCase).toHaveBeenCalledWith('hello@lifescope.io');
      expect(federatedIdentityService.bind).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-a' }),
      );
      expect(userService.create).not.toHaveBeenCalled();
    });

    it('refuses to choose between several case-insensitive matches', async () => {
      const { service, userService, federatedIdentityService } = makeService();
      userService.findByEmailIgnoringCase.mockResolvedValue([
        account('user-a', 'Hello@LifeScope.io'),
        account('user-b', 'HELLO@lifescope.io'),
      ]);

      await expect(
        service.alignSession(requestWith(stableHeaders('hello@lifescope.io'), null), response()),
      ).resolves.toEqual({ username: 'hello@lifescope.io', replaced: false, refused: 'account_ambiguous' });
      expect(federatedIdentityService.bind).not.toHaveBeenCalled();
      expect(userService.create).not.toHaveBeenCalled();
    });

    it("SECURITY: refuses an account another person of this Hub holds, and signs this browser's session out", async () => {
      // A renamed away from x@; the Hub later gave x@ to B. B's username names A's account.
      const { service, userService, authService, federatedIdentityService } = makeService();
      userService.findByEmail.mockResolvedValue(account('user-a', 'x@lifescope.io'));
      federatedIdentityService.findForUserFromIssuer.mockResolvedValue({
        userId: 'user-a',
        issuer: DIRECTORY,
        subject: OTHER_HUB_ID,
      });
      authService.validateSessionToken.mockReturnValue({ sub: 'user-a' });
      userService.findById.mockResolvedValue(account('user-a', 'x@lifescope.io'));
      const res = response();

      await expect(service.alignSession(requestWith(stableHeaders('x@lifescope.io')), res)).resolves.toEqual({
        username: 'x@lifescope.io',
        replaced: false,
        refused: 'account_linked_elsewhere',
      });
      expect(federatedIdentityService.bind).not.toHaveBeenCalled();
      expect(userService.create).not.toHaveBeenCalled();
      expect(authService.issueSessionToken).not.toHaveBeenCalled();
      expect(authService.invalidateSession).toHaveBeenCalledWith('user-a', 'old-token', expect.any(Object));
      expect(res.clearCookie).toHaveBeenCalledWith(config.auth.cookies.sessionTokenName, expect.any(Object));
    });

    it("adopts an account linked only into another Hub's directory (Memory restored onto a fresh Hub)", async () => {
      const { service, userService, federatedIdentityService } = makeService();
      userService.findByEmail.mockResolvedValue(account('user-a', 'hello@lifescope.io'));
      federatedIdentityService.findForUserFromIssuer.mockImplementation(
        async (_userId: string, issuer: string) =>
          issuer === OTHER_DIRECTORY
            ? { userId: 'user-a', issuer: OTHER_DIRECTORY, subject: OTHER_HUB_ID }
            : null,
      );

      await service.alignSession(requestWith(stableHeaders('hello@lifescope.io'), null), response());

      expect(federatedIdentityService.bind).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-a', issuer: DIRECTORY, subject: HUB_ID }),
      );
    });

    it('creates the account and its link in one transaction for someone this Memory has never seen', async () => {
      const { service, userService, federatedIdentityService } = makeService();
      const created = account('user-new', 'hello@lifescope.io');
      const manager = { marker: 'txn' };
      userService.create.mockImplementation(
        async (_ctx: unknown, _dto: unknown, alongside: (m: unknown, u: unknown) => Promise<unknown>) => {
          await alongside(manager, created);

          return created;
        },
      );

      await expect(
        service.alignSession(requestWith(stableHeaders('hello@lifescope.io'), null), response()),
      ).resolves.toEqual({ username: 'hello@lifescope.io', replaced: true, accessToken: 'access-hello' });
      expect(userService.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ email: 'hello@lifescope.io', passwordChosenByUser: false }),
        expect.any(Function),
      );
      expect(federatedIdentityService.bind).toHaveBeenCalledWith(
        {
          userId: 'user-new',
          issuer: DIRECTORY,
          subject: HUB_ID,
          email: 'hello@lifescope.io',
          bindMethod: 'sub',
        },
        manager,
      );
    });

    it('creates nothing while an account awaiting its purge still holds the address', async () => {
      const { service, userService } = makeService();
      userService.checkEmailAvailability.mockResolvedValue(true);

      await expect(
        service.alignSession(requestWith(stableHeaders('hello@lifescope.io'), null), response()),
      ).resolves.toEqual({ username: 'hello@lifescope.io', replaced: false, refused: 'account_unavailable' });
      expect(userService.create).not.toHaveBeenCalled();
    });

    it('refuses a person whose linked account was deleted, and creates nothing in its place', async () => {
      const { service, userService, federatedIdentityService } = makeService();
      federatedIdentityService.findUserId.mockResolvedValue('user-gone');

      await expect(
        service.alignSession(requestWith(stableHeaders('hello@lifescope.io'), null), response()),
      ).resolves.toEqual({ username: 'hello@lifescope.io', replaced: false, refused: 'account_unavailable' });
      expect(userService.findByEmail).not.toHaveBeenCalled();
      expect(userService.create).not.toHaveBeenCalled();
    });

    it('finds the winner when a second tab created the account first', async () => {
      const { service, userService, federatedIdentityService, authService } = makeService();
      userService.create.mockRejectedValue(uniqueViolation());
      // First look: nobody. After the lost race: the other tab's link.
      federatedIdentityService.findUserId.mockResolvedValueOnce(null).mockResolvedValue('user-won');
      userService.findById.mockResolvedValue(account('user-won', 'hello@lifescope.io'));

      await expect(
        service.alignSession(requestWith(stableHeaders('hello@lifescope.io'), null), response()),
      ).resolves.toEqual({ username: 'hello@lifescope.io', replaced: true, accessToken: 'access-hello' });
      expect(authService.issueSessionToken).toHaveBeenCalledWith('user-won', expect.any(Object));
    });

    it('follows a racer that linked the person to another account first', async () => {
      const { service, userService, federatedIdentityService, authService } = makeService();
      userService.findByEmail.mockResolvedValue(account('user-a', 'hello@lifescope.io'));
      federatedIdentityService.bind.mockResolvedValueOnce({
        userId: 'user-raced',
        issuer: DIRECTORY,
        subject: HUB_ID,
      });
      federatedIdentityService.findUserId.mockResolvedValueOnce(null).mockResolvedValue('user-raced');
      userService.findById.mockResolvedValue(account('user-raced', 'hello@lifescope.io'));

      await service.alignSession(requestWith(stableHeaders('hello@lifescope.io'), null), response());

      expect(authService.issueSessionToken).toHaveBeenCalledWith('user-raced', expect.any(Object));
    });

    it('signs the session out and rethrows when the account cannot be settled', async () => {
      const { service, userService, authService } = makeService();
      authService.validateSessionToken.mockReturnValue({ sub: 'user-z' });
      userService.findById.mockResolvedValue(account('user-z', 'z@lifescope.io'));
      userService.findByEmail.mockRejectedValue(new Error('db down'));
      const res = response();

      await expect(
        service.alignSession(requestWith(stableHeaders('hello@lifescope.io')), res),
      ).rejects.toThrow('db down');
      expect(authService.invalidateSession).toHaveBeenCalledWith('user-z', 'old-token', expect.any(Object));
      expect(res.clearCookie).toHaveBeenCalled();
      expect(authService.issueSessionToken).not.toHaveBeenCalled();
    });
  });

  describe('describeIdentity', () => {
    it('reports no account for a Hub that sends no stable id', async () => {
      const { service } = makeService();

      await expect(
        service.describeIdentity(requestWith(signedHeaders('hello@lifescope.io'), null)),
      ).resolves.toEqual({
        username: 'hello@lifescope.io',
        accountId: null,
      });
    });

    it('reports the linked account, without writing anything', async () => {
      const { service, userService, federatedIdentityService } = makeService();
      federatedIdentityService.findUserId.mockResolvedValue('user-a');
      userService.findById.mockResolvedValue(account('user-a', 'old@lifescope.io'));

      await expect(
        service.describeIdentity(requestWith(stableHeaders('new@lifescope.io'), null)),
      ).resolves.toEqual({
        username: 'new@lifescope.io',
        accountId: 'user-a',
      });
      expect(federatedIdentityService.bind).not.toHaveBeenCalled();
    });

    it('reports the account first sight would adopt, without linking it', async () => {
      const { service, userService, federatedIdentityService } = makeService();
      userService.findByEmail.mockResolvedValue(account('user-a', 'hello@lifescope.io'));

      await expect(
        service.describeIdentity(requestWith(stableHeaders('hello@lifescope.io'), null)),
      ).resolves.toEqual({
        username: 'hello@lifescope.io',
        accountId: 'user-a',
      });
      expect(federatedIdentityService.bind).not.toHaveBeenCalled();
    });

    it('reports no account for someone not created yet, or refused', async () => {
      const { service } = makeService();

      await expect(
        service.describeIdentity(requestWith(stableHeaders('hello@lifescope.io'), null)),
      ).resolves.toEqual({
        username: 'hello@lifescope.io',
        accountId: null,
      });
    });

    it('reports nothing without a verified identity', async () => {
      const { service } = makeService();

      await expect(service.describeIdentity(requestWith({}, null))).resolves.toEqual({
        username: null,
        accountId: null,
      });
    });
  });
});
