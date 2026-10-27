import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';

import {
  formatForwardAuthAssertion,
  signForwardAuthAssertion,
  signForwardAuthUser,
  signForwardAuthUserId,
} from '@ci/common/crypto';
import config from '@ci/configuration';

import { HubForwardAuthBridgeService } from '../services/HubForwardAuthBridgeService';
import { SpentHubAssertions } from '../utils/spentHubAssertions';

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

const IDENTITY_SECRET = 'memory-own-secret';
const AUDIENCE = 'ci-memory:ci-marketplace';

/** What a Hub that gave Memory its own key sends: the stable-id headers plus the bound assertion. */
function boundHeaders(
  username: string,
  { nonce = 'nB7cS0fTq3kz1XyH9wA2eQ', audience = AUDIENCE }: { nonce?: string; audience?: string } = {},
) {
  const signature = signForwardAuthAssertion(
    IDENTITY_SECRET,
    audience,
    nonce,
    NOW,
    username,
    DIRECTORY,
    HUB_ID,
  );

  return {
    ...stableHeaders(username),
    'x-ci-hub-user-assertion': formatForwardAuthAssertion(nonce, signature),
  };
}

/** An account whose address is proven: created from a Portal or Hub identity, or there before the rule. */
function account(id: string, email: string) {
  return { id, email, emailProvenAt: new Date(NOW - 86_400_000) };
}

/** An account whose address someone typed into signup or an email change. */
function unprovenAccount(id: string, email: string) {
  return { id, email, emailProvenAt: null };
}

function uniqueViolation(): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
}

function makeService() {
  const userService = {
    findById: jest.fn().mockResolvedValue(null),
    findAccountByEmail: jest.fn().mockResolvedValue(null),
    checkEmailAvailability: jest.fn().mockResolvedValue(false),
    create: jest.fn(),
    isEmailProven: jest.fn((user: { emailProvenAt?: Date | null }) => user.emailProvenAt != null),
    markEmailProven: jest.fn().mockResolvedValue(undefined),
  };
  const authService = {
    validateSessionToken: jest.fn(),
    // The browser's session row is live unless a case says otherwise.
    resolveLiveSession: jest.fn().mockResolvedValue({ userId: 'user-a', sessionId: 'sid-old' }),
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

  return { service, userService, authService, csrfService, federatedIdentityService, logger };
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
  const previous = { ...config.auth.hubForwardAuth };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    config.auth.hubForwardAuth.enabled = true;
    config.auth.hubForwardAuth.secret = SECRET;
    config.auth.hubForwardAuth.identitySecret = '';
    config.auth.hubForwardAuth.audience = '';
    config.auth.hubForwardAuth.requireAudience = 'auto';
    config.auth.hubForwardAuth.maxSkewMs = 300_000;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Object.assign(config.auth.hubForwardAuth, previous);
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

    it('replaces a matching cookie when its Memory session is no longer live', async () => {
      const { service, userService, authService } = makeService();
      authService.validateSessionToken.mockReturnValue({ sub: 'user-a' });
      authService.resolveLiveSession.mockResolvedValue(null);
      userService.findById.mockResolvedValue(account('user-a', 'hello@lifescope.io'));
      userService.findAccountByEmail.mockResolvedValue(account('user-a', 'hello@lifescope.io'));

      await expect(
        service.alignSession(requestWith(signedHeaders('hello@lifescope.io')), response()),
      ).resolves.toEqual({
        username: 'hello@lifescope.io',
        replaced: true,
        accessToken: 'access-hello',
      });
      expect(authService.invalidateSession).toHaveBeenCalledWith('user-a', 'old-token', expect.any(Object));
      expect(authService.issueSessionToken).toHaveBeenCalledWith('user-a', expect.any(Object));
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

    it('signs a fresh browser in to the proven account the address names', async () => {
      const { service, userService, authService } = makeService();
      userService.findAccountByEmail.mockResolvedValue(account('user-a', 'hello@lifescope.io'));

      await expect(
        service.alignSession(requestWith(signedHeaders('hello@lifescope.io'), null), response()),
      ).resolves.toEqual({ username: 'hello@lifescope.io', replaced: true, accessToken: 'access-hello' });
      expect(authService.issueSessionToken).toHaveBeenCalledWith('user-a', expect.any(Object));
      expect(userService.create).not.toHaveBeenCalled();
    });

    it("SECURITY: refuses an account whose address nobody proved, and signs this browser's session out", async () => {
      // A member typed this person's address into their own account before the person arrived.
      // Without a stable id the address is the whole link, so adopting it would hand the member
      // every one of this person's sign-ins.
      const { service, userService, authService } = makeService();
      userService.findAccountByEmail.mockResolvedValue(unprovenAccount('user-planted', 'hello@lifescope.io'));
      authService.validateSessionToken.mockReturnValue({ sub: 'user-z' });
      userService.findById.mockResolvedValue(account('user-z', 'z@lifescope.io'));
      const res = response();

      await expect(
        service.alignSession(requestWith(signedHeaders('hello@lifescope.io')), res),
      ).resolves.toEqual({
        username: 'hello@lifescope.io',
        replaced: false,
        refused: 'account_unproven',
      });
      expect(authService.issueSessionToken).not.toHaveBeenCalled();
      expect(userService.create).not.toHaveBeenCalled();
      expect(authService.invalidateSession).toHaveBeenCalledWith('user-z', 'old-token', expect.any(Object));
      expect(res.clearCookie).toHaveBeenCalledWith(config.auth.cookies.sessionTokenName, expect.any(Object));
    });

    it('refuses to choose between several accounts that match the address once case is ignored', async () => {
      const { service, userService, authService } = makeService();
      userService.findAccountByEmail.mockResolvedValue('ambiguous');

      await expect(
        service.alignSession(requestWith(signedHeaders('hello@lifescope.io'), null), response()),
      ).resolves.toEqual({ username: 'hello@lifescope.io', replaced: false, refused: 'account_ambiguous' });
      expect(userService.create).not.toHaveBeenCalled();
      expect(authService.issueSessionToken).not.toHaveBeenCalled();
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
      userService.findAccountByEmail.mockResolvedValue(account('user-dup', 'new@lifescope.io'));

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

    it('replaces a same-user cookie when its backing session row is gone', async () => {
      const { service, userService, authService, federatedIdentityService } = makeService();
      federatedIdentityService.findUserId.mockResolvedValue('user-a');
      authService.validateSessionToken.mockReturnValue({ sub: 'user-a' });
      authService.resolveLiveSession.mockResolvedValue(null);
      userService.findById.mockResolvedValue(account('user-a', 'hello@lifescope.io'));

      await expect(
        service.alignSession(requestWith(stableHeaders('hello@lifescope.io')), response()),
      ).resolves.toEqual({
        username: 'hello@lifescope.io',
        replaced: true,
        accessToken: 'access-hello',
      });
      expect(authService.invalidateSession).toHaveBeenCalledWith('user-a', 'old-token', expect.any(Object));
      expect(authService.issueSessionToken).toHaveBeenCalledWith('user-a', expect.any(Object));
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
      userService.findAccountByEmail.mockResolvedValue(account('user-a', 'hello@lifescope.io'));

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
      userService.findAccountByEmail.mockResolvedValue(account('user-a', 'Hello@LifeScope.io'));

      await service.alignSession(requestWith(stableHeaders('hello@lifescope.io'), null), response());

      expect(userService.findAccountByEmail).toHaveBeenCalledWith('hello@lifescope.io');
      expect(federatedIdentityService.bind).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-a' }),
      );
      expect(userService.create).not.toHaveBeenCalled();
    });

    it('refuses to choose between several case-insensitive matches', async () => {
      const { service, userService, federatedIdentityService } = makeService();
      userService.findAccountByEmail.mockResolvedValue('ambiguous');

      await expect(
        service.alignSession(requestWith(stableHeaders('hello@lifescope.io'), null), response()),
      ).resolves.toEqual({ username: 'hello@lifescope.io', replaced: false, refused: 'account_ambiguous' });
      expect(federatedIdentityService.bind).not.toHaveBeenCalled();
      expect(userService.create).not.toHaveBeenCalled();
    });

    it("SECURITY: refuses an account another person of this Hub holds, and signs this browser's session out", async () => {
      // A renamed away from x@; the Hub later gave x@ to B. B's username names A's account.
      const { service, userService, authService, federatedIdentityService } = makeService();
      userService.findAccountByEmail.mockResolvedValue(account('user-a', 'x@lifescope.io'));
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

    it('SECURITY: refuses to adopt an account whose address nobody proved, unless this browser is signed in to it', async () => {
      // Someone with an account here typed this person's address into it before they arrived.
      const { service, userService, authService, federatedIdentityService } = makeService();
      userService.findAccountByEmail.mockResolvedValue(unprovenAccount('user-planted', 'hello@lifescope.io'));
      const res = response();

      await expect(
        service.alignSession(requestWith(stableHeaders('hello@lifescope.io'), null), res),
      ).resolves.toEqual({ username: 'hello@lifescope.io', replaced: false, refused: 'account_unproven' });
      expect(federatedIdentityService.bind).not.toHaveBeenCalled();
      expect(userService.create).not.toHaveBeenCalled();
      expect(authService.issueSessionToken).not.toHaveBeenCalled();
      expect(userService.markEmailProven).not.toHaveBeenCalled();
    });

    it('adopts an unproven account when this browser is signed in to it, and counts the address as proven', async () => {
      // The person signed in with the account's own password here, and the Hub calls them by its
      // address: together that is the explicit link.
      const { service, userService, authService, federatedIdentityService } = makeService();
      const own = unprovenAccount('user-a', 'hello@lifescope.io');
      userService.findAccountByEmail.mockResolvedValue(own);
      authService.validateSessionToken.mockReturnValue({ sub: 'user-a' });
      userService.findById.mockResolvedValue(own);

      await expect(
        service.alignSession(requestWith(stableHeaders('hello@lifescope.io')), response()),
      ).resolves.toEqual({ username: 'hello@lifescope.io', replaced: false });
      expect(authService.resolveLiveSession).toHaveBeenCalledWith('old-token');
      expect(federatedIdentityService.bind).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-a', issuer: DIRECTORY, subject: HUB_ID }),
      );
      expect(userService.markEmailProven).toHaveBeenCalledWith('user-a');
    });

    it("SECURITY: does not count a signed-out session's cookie as being signed in to the account", async () => {
      // Logging out deletes the session row and leaves the cookie's signature valid.
      const { service, userService, authService, federatedIdentityService } = makeService();
      const own = unprovenAccount('user-a', 'hello@lifescope.io');
      userService.findAccountByEmail.mockResolvedValue(own);
      authService.validateSessionToken.mockReturnValue({ sub: 'user-a' });
      authService.resolveLiveSession.mockResolvedValue(null);
      userService.findById.mockResolvedValue(own);

      await expect(
        service.alignSession(requestWith(stableHeaders('hello@lifescope.io')), response()),
      ).resolves.toEqual({ username: 'hello@lifescope.io', replaced: false, refused: 'account_unproven' });
      expect(federatedIdentityService.bind).not.toHaveBeenCalled();
    });

    it("SECURITY: a session in someone else's account does not unlock an unproven one", async () => {
      const { service, userService, authService, federatedIdentityService } = makeService();
      userService.findAccountByEmail.mockResolvedValue(unprovenAccount('user-planted', 'hello@lifescope.io'));
      authService.validateSessionToken.mockReturnValue({ sub: 'user-z' });
      userService.findById.mockResolvedValue(account('user-z', 'z@lifescope.io'));

      await expect(
        service.alignSession(requestWith(stableHeaders('hello@lifescope.io')), response()),
      ).resolves.toEqual({ username: 'hello@lifescope.io', replaced: false, refused: 'account_unproven' });
      expect(federatedIdentityService.bind).not.toHaveBeenCalled();
    });

    it("adopts an account linked only into another Hub's directory (Memory restored onto a fresh Hub)", async () => {
      const { service, userService, federatedIdentityService } = makeService();
      userService.findAccountByEmail.mockResolvedValue(account('user-a', 'hello@lifescope.io'));
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
        // The address is the Hub-signed username, so the new account's address counts as proven.
        expect.objectContaining({
          email: 'hello@lifescope.io',
          passwordChosenByUser: false,
          emailProven: true,
        }),
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
      expect(userService.findAccountByEmail).not.toHaveBeenCalled();
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
      userService.findAccountByEmail.mockResolvedValue(account('user-a', 'hello@lifescope.io'));
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
      userService.findAccountByEmail.mockRejectedValue(new Error('db down'));
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
      userService.findAccountByEmail.mockResolvedValue(account('user-a', 'hello@lifescope.io'));

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

  describe('one session per Hub sign-in', () => {
    it('spends no unbound header set: two tabs an older Hub signed in the same millisecond both sign in', async () => {
      const { service, userService, authService } = makeService();
      userService.findAccountByEmail.mockResolvedValue(account('user-a', 'hello@lifescope.io'));
      const headers = signedHeaders('hello@lifescope.io');

      await service.alignSession(requestWith(headers, null), response());
      await expect(service.alignSession(requestWith(headers, null), response())).resolves.toMatchObject({
        replaced: true,
      });
      expect(authService.issueSessionToken).toHaveBeenCalledTimes(2);
    });

    it('mints once from a bound assertion and refuses the same assertion again', async () => {
      config.auth.hubForwardAuth.identitySecret = IDENTITY_SECRET;
      config.auth.hubForwardAuth.audience = AUDIENCE;
      const { service, federatedIdentityService, userService, authService } = makeService();
      federatedIdentityService.findUserId.mockResolvedValue('user-a');
      userService.findById.mockResolvedValue(account('user-a', 'hello@lifescope.io'));
      const headers = boundHeaders('hello@lifescope.io');

      await expect(service.alignSession(requestWith(headers, null), response())).resolves.toMatchObject({
        replaced: true,
      });
      await expect(service.alignSession(requestWith(headers, null), response())).rejects.toThrow(
        UnauthorizedException,
      );
      expect(authService.issueSessionToken).toHaveBeenCalledTimes(1);
    });

    it('refuses a replay that verified in its last millisecond, though the lookups ran past its expiry', async () => {
      config.auth.hubForwardAuth.identitySecret = IDENTITY_SECRET;
      config.auth.hubForwardAuth.audience = AUDIENCE;
      const { service, federatedIdentityService, userService, authService } = makeService();
      federatedIdentityService.findUserId.mockResolvedValue('user-a');
      userService.findById.mockResolvedValue(account('user-a', 'hello@lifescope.io'));
      const headers = boundHeaders('hello@lifescope.io');
      await service.alignSession(requestWith(headers, null), response());

      // The skew check passes at expiresAt itself; the account lookups then take the clock past it.
      const expiresAt = NOW + config.auth.hubForwardAuth.maxSkewMs;
      jest
        .spyOn(Date, 'now')
        .mockReturnValueOnce(expiresAt)
        .mockReturnValue(expiresAt + 50);

      await expect(service.alignSession(requestWith(headers, null), response())).rejects.toThrow(
        UnauthorizedException,
      );
      expect(authService.issueSessionToken).toHaveBeenCalledTimes(1);
    });

    it('mints for two requests in the same millisecond: each assertion has its own nonce', async () => {
      config.auth.hubForwardAuth.identitySecret = IDENTITY_SECRET;
      config.auth.hubForwardAuth.audience = AUDIENCE;
      const { service, federatedIdentityService, userService, authService } = makeService();
      federatedIdentityService.findUserId.mockResolvedValue('user-a');
      userService.findById.mockResolvedValue(account('user-a', 'hello@lifescope.io'));

      await service.alignSession(requestWith(boundHeaders('hello@lifescope.io'), null), response());
      await service.alignSession(
        requestWith(boundHeaders('hello@lifescope.io', { nonce: 'Zr4mK8pL2vJ6sD0gU1tY5w' }), null),
        response(),
      );

      expect(authService.issueSessionToken).toHaveBeenCalledTimes(2);
    });

    it('spends nothing while the browser already holds the right session', async () => {
      config.auth.hubForwardAuth.identitySecret = IDENTITY_SECRET;
      config.auth.hubForwardAuth.audience = AUDIENCE;
      const { service, federatedIdentityService, userService, authService } = makeService();
      federatedIdentityService.findUserId.mockResolvedValue('user-a');
      authService.validateSessionToken.mockReturnValue({ sub: 'user-a' });
      userService.findById.mockResolvedValue(account('user-a', 'hello@lifescope.io'));
      const headers = boundHeaders('hello@lifescope.io');

      // The same header set on an ordinary page load, then on a browser with no session.
      await expect(service.alignSession(requestWith(headers), response())).resolves.toMatchObject({
        replaced: false,
      });
      await expect(service.alignSession(requestWith(headers, null), response())).resolves.toMatchObject({
        replaced: true,
      });
    });

    it('signs nobody out when it refuses a spent assertion', async () => {
      config.auth.hubForwardAuth.identitySecret = IDENTITY_SECRET;
      config.auth.hubForwardAuth.audience = AUDIENCE;
      const { service, federatedIdentityService, userService, authService } = makeService();
      federatedIdentityService.findUserId.mockResolvedValue('user-b');
      userService.findById.mockImplementation(async (_ctx: unknown, id: string) =>
        id === 'user-b' ? account('user-b', 'hello@lifescope.io') : account('user-a', 'other@lifescope.io'),
      );
      const headers = boundHeaders('hello@lifescope.io');
      await service.alignSession(requestWith(headers, null), response());
      authService.invalidateSession.mockClear();
      authService.issueSessionToken.mockClear();
      // The same assertion again, from a browser signed in as someone else.
      authService.validateSessionToken.mockReturnValue({ sub: 'user-a' });
      const res = response();

      await expect(service.alignSession(requestWith(headers), res)).rejects.toThrow(UnauthorizedException);
      expect(authService.invalidateSession).not.toHaveBeenCalled();
      expect(authService.issueSessionToken).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
      expect(res.clearCookie).not.toHaveBeenCalled();
    });

    it("signs out the other person's session when the ledger has no room left to spend the assertion", async () => {
      config.auth.hubForwardAuth.identitySecret = IDENTITY_SECRET;
      config.auth.hubForwardAuth.audience = AUDIENCE;
      jest.spyOn(SpentHubAssertions.prototype, 'spend').mockReturnValue('full');
      const { service, federatedIdentityService, userService, authService } = makeService();
      federatedIdentityService.findUserId.mockResolvedValue('user-b');
      authService.validateSessionToken.mockReturnValue({ sub: 'user-a' });
      userService.findById.mockImplementation(async (_ctx: unknown, id: string) =>
        id === 'user-b' ? account('user-b', 'hello@lifescope.io') : account('user-a', 'other@lifescope.io'),
      );
      const res = response();

      await expect(
        service.alignSession(requestWith(boundHeaders('hello@lifescope.io')), res),
      ).rejects.toThrow(ServiceUnavailableException);
      // Left standing, the SPA would refresh user-a's session under user-b's Hub sign-in.
      expect(authService.invalidateSession).toHaveBeenCalledWith('user-a', 'old-token', expect.anything());
      expect(res.clearCookie).toHaveBeenCalled();
      expect(authService.issueSessionToken).not.toHaveBeenCalled();
    });
  });

  describe('startup warnings', () => {
    it('says Hub sign-in is off when the bound assertion is required but this app has no key', () => {
      config.auth.hubForwardAuth.requireAudience = 'true';
      const { logger } = makeService();

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Hub sign-in is off'));
    });

    it('says Hub sign-in is off, not unbound, when there is no secret of either kind', () => {
      config.auth.hubForwardAuth.secret = '';
      const { logger } = makeService();

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no identity header can verify'));
      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('accepts identity headers'));
    });

    it('says when the unbound format is still accepted beside the bound one', () => {
      config.auth.hubForwardAuth.identitySecret = IDENTITY_SECRET;
      config.auth.hubForwardAuth.audience = AUDIENCE;
      config.auth.hubForwardAuth.requireAudience = 'false';
      const { logger } = makeService();

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('REQUIRE_AUDIENCE=false'));
    });

    it("says when this app's own key is the Hub-wide secret", () => {
      config.auth.hubForwardAuth.identitySecret = SECRET;
      config.auth.hubForwardAuth.audience = AUDIENCE;
      const { logger } = makeService();

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('is the Hub-wide'));
    });

    it('says nothing for a Hub that gave this app its own key', () => {
      config.auth.hubForwardAuth.identitySecret = IDENTITY_SECRET;
      config.auth.hubForwardAuth.audience = AUDIENCE;
      const { logger } = makeService();

      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('a Hub that gave Memory its own key', () => {
    beforeEach(() => {
      config.auth.hubForwardAuth.identitySecret = IDENTITY_SECRET;
      config.auth.hubForwardAuth.audience = AUDIENCE;
    });

    it('signs in by the bound assertion', () => {
      const { service } = makeService();

      expect(service.verifyIdentity(requestWith(boundHeaders('hello@lifescope.io'), null))).toEqual({
        username: 'hello@lifescope.io',
        stableId: { issuer: DIRECTORY, subject: HUB_ID },
      });
    });

    it('trusts no identity from headers without the assertion, though they verify under the shared secret', async () => {
      const { service, authService } = makeService();

      expect(service.verifyIdentity(requestWith(stableHeaders('hello@lifescope.io'), null))).toBeNull();
      await expect(
        service.alignSession(requestWith(stableHeaders('hello@lifescope.io'), null), response()),
      ).resolves.toEqual({ username: null, replaced: false });
      expect(authService.issueSessionToken).not.toHaveBeenCalled();
    });

    it('trusts no identity from an assertion signed for another app', () => {
      const { service } = makeService();
      const headers = boundHeaders('hello@lifescope.io', { audience: 'importer:ci-marketplace' });

      expect(service.verifyIdentity(requestWith(headers, null))).toBeNull();
    });

    describe('the KERI headers, which no signature covers', () => {
      // 44 base64url characters after `did:keri:`, the only form kept.
      const VICTIM_AID = 'did:keri:EVictimAid_000000000000000000000000000000000';
      const HUB_AID = 'did:keri:EHubAid_000000000000000000000000000000000000';
      const KEL_DIGEST = 'EKelDigest_000000000000000000000000000000000';

      /** Signed in as the Hub person DIRECTORY#HUB_ID, plus whatever KERI headers the browser added. */
      function withKeri(username: string, keri: Record<string, string>) {
        return { ...boundHeaders(username), ...keri };
      }

      it('keeps the well-formed ones beside the signed stable id, marked unsigned', () => {
        const { service } = makeService();
        const headers = withKeri('hello@lifescope.io', {
          'x-ci-hub-user-aid': VICTIM_AID,
          'x-ci-hub-aid': HUB_AID,
          'x-ci-hub-kel-digest': KEL_DIGEST,
        });

        expect(service.verifyIdentity(requestWith(headers, null))).toEqual({
          username: 'hello@lifescope.io',
          stableId: {
            issuer: DIRECTORY,
            subject: HUB_ID,
            unsignedKeri: { userAid: VICTIM_AID, hubAid: HUB_AID, kelDigest: KEL_DIGEST },
          },
        });
      });

      it('drops malformed ones', () => {
        const { service } = makeService();
        const headers = withKeri('hello@lifescope.io', {
          'x-ci-hub-user-aid': 'did:keri:Duser-aid-12345',
          'x-ci-hub-aid': `${HUB_AID}\nx`,
          'x-ci-hub-kel-digest': 'not a digest',
        });

        expect(service.verifyIdentity(requestWith(headers, null))).toEqual({
          username: 'hello@lifescope.io',
          stableId: { issuer: DIRECTORY, subject: HUB_ID },
        });
      });

      it('SECURITY: signs in as the signed identity, never as the account an AID header names', async () => {
        // An AID is public. Were the header an identity, anyone signed in to the Hub could name
        // someone else's and be signed in as them.
        const { service, userService, authService, federatedIdentityService } = makeService();
        federatedIdentityService.findUserId.mockImplementation(async (issuer: string, subject: string) => {
          if (issuer === 'did:keri' && subject === VICTIM_AID) {
            return 'user-victim';
          }

          return issuer === DIRECTORY && subject === HUB_ID ? 'user-a' : null;
        });
        userService.findById.mockImplementation(async (_ctx: unknown, id: string) =>
          account(id, id === 'user-a' ? 'hello@lifescope.io' : 'victim@lifescope.io'),
        );
        const headers = withKeri('hello@lifescope.io', { 'x-ci-hub-user-aid': VICTIM_AID });

        await expect(service.alignSession(requestWith(headers, null), response())).resolves.toEqual({
          username: 'hello@lifescope.io',
          replaced: true,
          accessToken: 'access-hello',
        });
        expect(authService.issueSessionToken).toHaveBeenCalledWith('user-a', expect.any(Object));
        expect(authService.issueSessionToken).not.toHaveBeenCalledWith('user-victim', expect.anything());
        expect(federatedIdentityService.findUserId).not.toHaveBeenCalledWith('did:keri', expect.anything());
        expect(federatedIdentityService.bind).not.toHaveBeenCalled();
        await expect(service.describeIdentity(requestWith(headers, null))).resolves.toEqual({
          username: 'hello@lifescope.io',
          accountId: 'user-a',
        });
      });

      it("SECURITY: never binds an AID header to the account, so nobody can squat someone else's", async () => {
        const { service, userService, federatedIdentityService } = makeService();
        // First sight, adopted by address.
        userService.findAccountByEmail.mockResolvedValue(account('user-a', 'hello@lifescope.io'));
        const headers = withKeri('hello@lifescope.io', { 'x-ci-hub-user-aid': VICTIM_AID });

        await service.alignSession(requestWith(headers, null), response());

        expect(federatedIdentityService.bind).toHaveBeenCalledTimes(1);
        expect(federatedIdentityService.bind).toHaveBeenCalledWith(
          expect.objectContaining({ userId: 'user-a', issuer: DIRECTORY, subject: HUB_ID }),
        );
      });

      it('never binds an AID header to an account it creates either', async () => {
        const { service, userService, federatedIdentityService } = makeService();
        const created = account('user-new', 'hello@lifescope.io');
        userService.create.mockImplementation(
          async (_ctx: unknown, _dto: unknown, alongside: (m: unknown, u: unknown) => Promise<unknown>) => {
            await alongside({ marker: 'txn' }, created);

            return created;
          },
        );
        const headers = withKeri('hello@lifescope.io', { 'x-ci-hub-user-aid': VICTIM_AID });

        await service.alignSession(requestWith(headers, null), response());

        expect(federatedIdentityService.bind).toHaveBeenCalledTimes(1);
        expect(federatedIdentityService.bind).toHaveBeenCalledWith(
          expect.objectContaining({ userId: 'user-new', issuer: DIRECTORY, subject: HUB_ID }),
          expect.anything(),
        );
      });
    });
  });
});
