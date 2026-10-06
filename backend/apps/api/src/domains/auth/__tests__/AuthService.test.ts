import { createHmac } from 'crypto';

import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { Repository } from 'typeorm';

import config from '@ci/configuration';

import type { SessionEntity } from '../entities/SessionEntity';
import { AuthService, signupIntentSecret } from '../services/AuthService';
import type { JwtPayload } from '../types';

const SESSION_COOKIE = config.auth.cookies.sessionTokenName;
const REFRESH_SECRET = config.auth.jwt.refreshTokenSecret;

const jwtService = new JwtService({});

function decodeSessionToken(token: string): JwtPayload {
  return jwtService.verify<JwtPayload>(token, { secret: REFRESH_SECRET });
}

function reqWithCookies(cookies: Record<string, unknown>): Request {
  return { cookies } as unknown as Request;
}

/**
 * Unit tests for the session-id ↔ JWT `sid` linkage that CSRF principal-binding
 * rests on: the id persisted in the session row and the `sid` claim in the
 * signed cookie must be the SAME value at issue time, survive rotation, and be
 * recoverable from a request via resolveCsrfScope — otherwise a freshly minted
 * session-bound CSRF token would never match its own session.
 */
describe('AuthService — session id binding', () => {
  const meta = { ip: '127.0.0.1', userAgent: 'jest' };

  let saved: SessionEntity[];
  let findOneResults: Array<SessionEntity | null>;

  const sessionRepository = {
    create: jest.fn((entity: Partial<SessionEntity>) => entity as SessionEntity),
    save: jest.fn(async (entity: SessionEntity) => {
      saved.push(entity);

      return entity;
    }),
    findOne: jest.fn(async () => findOneResults.shift() ?? null),
    delete: jest.fn(),
  };

  const service = new AuthService(jwtService, sessionRepository as unknown as Repository<SessionEntity>);

  beforeEach(() => {
    jest.clearAllMocks();
    saved = [];
    findOneResults = [];
  });

  describe('issueSessionToken', () => {
    it('signs the JWT with a sid matching the persisted session row id', async () => {
      const { sessionToken, sessionId } = await service.issueSessionToken('user-1', meta);

      const payload = decodeSessionToken(sessionToken);

      expect(payload.sub).toBe('user-1');
      expect(payload.sid).toBe(sessionId);

      // The row was persisted under that very id — sid is not a parallel
      // identifier but THE session row's primary key.
      expect(saved).toHaveLength(1);
      expect(saved[0].id).toBe(sessionId);
    });

    it('mints a distinct session id per issue', async () => {
      const first = await service.issueSessionToken('user-1', meta);
      const second = await service.issueSessionToken('user-1', meta);

      expect(first.sessionId).not.toBe(second.sessionId);
    });
  });

  describe('rotateSessionToken', () => {
    const sessionRow = (id: string): SessionEntity =>
      ({
        id,
        token: 'stored-hash',
        previous_token: null,
        rotated_at: null,
        expires_at: new Date(Date.now() + 60_000),
      }) as unknown as SessionEntity;

    it('returns the session id and signs the rotated JWT with the SAME sid', async () => {
      findOneResults = [sessionRow('sess-1')];

      const result = await service.rotateSessionToken('user-1', 'incoming-token', meta);

      expect(result.sessionId).toBe('sess-1');
      expect(result.sessionToken).not.toBeNull();

      // Rotation must not re-mint the identity: the new cookie still points at
      // the same session row, so the browser's bound CSRF token stays valid.
      // (This is also the upgrade path for legacy sid-less cookies — their
      // first rotation embeds the sid.)
      expect(decodeSessionToken(result.sessionToken!).sid).toBe('sess-1');
    });

    it('returns the session id on a grace-period match too (no new cookie)', async () => {
      // First findOne (current hash) misses, second (previous hash within the
      // grace window) hits. sessionToken stays null — the browser keeps the
      // cookie from the request that performed the real rotation — but the
      // caller still needs the id to keep the CSRF cookie bound.
      findOneResults = [null, sessionRow('sess-1')];

      const result = await service.rotateSessionToken('user-1', 'incoming-token', meta);

      expect(result).toEqual({ sessionToken: null, sessionId: 'sess-1' });
    });
  });

  describe('resolveCsrfScope', () => {
    it('returns the sid from a valid session cookie', () => {
      const token = jwtService.sign(
        { sub: 'user-1', sid: 'sess-1' },
        { secret: REFRESH_SECRET, expiresIn: '7d' },
      );

      expect(service.resolveCsrfScope(reqWithCookies({ [SESSION_COOKIE]: token }))).toBe('sess-1');
    });

    it('returns the sid even when the session JWT is expired (but validly signed)', () => {
      // Deliberate: the scope identifies the MINTING principal; enforcing
      // expiry here would 403 the refresh call that recovers an expired
      // session and burn the SPA's one-shot retry.
      const token = jwtService.sign(
        { sub: 'user-1', sid: 'sess-1' },
        { secret: REFRESH_SECRET, expiresIn: '-1h' },
      );

      expect(service.resolveCsrfScope(reqWithCookies({ [SESSION_COOKIE]: token }))).toBe('sess-1');
    });

    it('returns null for an absent, non-string, empty, forged, or sid-less cookie', () => {
      const forged = jwtService.sign({ sub: 'user-1', sid: 'sess-1' }, { secret: 'wrong-secret' });
      const legacy = jwtService.sign({ sub: 'user-1' }, { secret: REFRESH_SECRET, expiresIn: '7d' });

      for (const cookies of [
        {},
        { [SESSION_COOKIE]: undefined },
        { [SESSION_COOKIE]: '' },
        { [SESSION_COOKIE]: { j: 'son' } },
        { [SESSION_COOKIE]: 'not-a-jwt' },
        { [SESSION_COOKIE]: forged },
        { [SESSION_COOKIE]: legacy },
      ]) {
        expect(service.resolveCsrfScope(reqWithCookies(cookies))).toBeNull();
      }
    });
  });

  /**
   * findSession (private, reached only via rotateSessionToken/invalidateSession)
   * builds its `where` clause with `user: { id: userId }` alongside the
   * token/ip/user-agent hash match. Every test above uses a `findOne` mock
   * that ignores its `where` argument entirely (`findOneResults.shift()`),
   * so none of them can tell whether that user-scoping clause is actually
   * applied — a token-hash collision, or a bug that dropped the `user`
   * clause, could let one user's refresh/logout call match and
   * mutate/delete a DIFFERENT user's session row.
   *
   * This block uses a small in-memory repo that genuinely filters by the
   * `where` criteria it receives (replicating AuthService's own HMAC digest
   * so the token/ip/user-agent hashes line up), so a regression that dropped
   * or inverted the user-id scoping would make the "wrong owner" tests below
   * fail by matching/mutating the other user's row.
   */
  describe('findSession user-id scoping (via rotateSessionToken / invalidateSession)', () => {
    function digest(value: string): string {
      return createHmac('sha256', config.auth.session.fieldPepper).update(value).digest('hex');
    }

    function makeScopedSessionRepository(rows: SessionEntity[]) {
      const table = [...rows];

      const matchesWhere = (row: SessionEntity, where: Record<string, unknown>): boolean =>
        Object.entries(where).every(([key, value]) => {
          if (key === 'user') {
            return (row as unknown as { user: { id: string } }).user?.id === (value as { id: string }).id;
          }

          // MoreThan(now) FindOperator — compare against its wrapped value.
          if (value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
            return (row as unknown as Record<string, Date>)[key] > (value as { value: Date }).value;
          }

          return (row as unknown as Record<string, unknown>)[key] === value;
        });

      return {
        create: jest.fn((entity: Partial<SessionEntity>) => entity as SessionEntity),
        save: jest.fn(async (entity: SessionEntity) => entity),
        findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          return table.find((row) => matchesWhere(row, where)) ?? null;
        }),
        delete: jest.fn(async ({ id }: { id: string }) => {
          const before = table.length;

          for (let i = table.length - 1; i >= 0; i--) {
            if (table[i].id === id) {
              table.splice(i, 1);
            }
          }

          return { affected: before - table.length };
        }),
      };
    }

    const rawToken = 'incoming-token';

    function sessionRowForUser(id: string, userId: string): SessionEntity {
      return {
        id,
        token: digest(rawToken),
        previous_token: null,
        rotated_at: null,
        expires_at: new Date(Date.now() + 60_000),
        ip: digest(meta.ip),
        user_agent: digest(meta.userAgent!),
        user: { id: userId },
      } as unknown as SessionEntity;
    }

    it("rotateSessionToken: a token bound to another user does not match this user's session", async () => {
      const repo = makeScopedSessionRepository([sessionRowForUser('sess-1', 'user-1')]);
      const scopedService = new AuthService(jwtService, repo as unknown as Repository<SessionEntity>);

      // Right token, right ip/user-agent, WRONG user — must not match user-1's row.
      await expect(scopedService.rotateSessionToken('user-2', rawToken, meta)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it("rotateSessionToken: the owning user's matching token rotates successfully", async () => {
      const repo = makeScopedSessionRepository([sessionRowForUser('sess-1', 'user-1')]);
      const scopedService = new AuthService(jwtService, repo as unknown as Repository<SessionEntity>);

      const result = await scopedService.rotateSessionToken('user-1', rawToken, meta);

      expect(result.sessionId).toBe('sess-1');
      expect(result.sessionToken).not.toBeNull();
    });

    it("invalidateSession: a different user cannot delete another user's session by guessing/replaying the token", async () => {
      const repo = makeScopedSessionRepository([sessionRowForUser('sess-1', 'user-1')]);
      const scopedService = new AuthService(jwtService, repo as unknown as Repository<SessionEntity>);

      await expect(scopedService.invalidateSession('user-2', rawToken, meta)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      // The session survives — the delete branch was never reached.
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it('invalidateSession: the owning user can log themselves out (session row is removed)', async () => {
      const repo = makeScopedSessionRepository([sessionRowForUser('sess-1', 'user-1')]);
      const scopedService = new AuthService(jwtService, repo as unknown as Repository<SessionEntity>);

      await scopedService.invalidateSession('user-1', rawToken, meta);

      expect(repo.delete).toHaveBeenCalledWith({ id: 'sess-1' });
    });
  });
});

/**
 * The signup intent carries a first-time OIDC sign-in from the callback to the confirm step. When
 * the callback waived the signup code only because the appliance had no accounts, the confirm step
 * must re-decide that as it creates the account — so the fact has to survive the round trip, and
 * must not appear on an intent where nothing was waived.
 */
describe('AuthService — signup intent', () => {
  const service = new AuthService(jwtService, {} as unknown as Repository<SessionEntity>);
  const identity = { issuer: 'https://hub.test', subject: 'portal-sub-1' };

  it('carries firstAccountOnly through to the confirm step', () => {
    const token = service.issueSignupIntentToken('new@example.com', 'New', identity, {
      firstAccountOnly: true,
    });

    expect(service.verifySignupIntentToken(token)).toEqual({
      email: 'new@example.com',
      name: 'New',
      ...identity,
      firstAccountOnly: true,
    });
  });

  it.each([
    ['not asked for', undefined],
    ['false', { firstAccountOnly: false }],
  ])('leaves it off an intent where nothing was waived (%s)', (_label, admission) => {
    const token = service.issueSignupIntentToken('new@example.com', 'New', identity, admission);

    expect(jwtService.decode<Record<string, unknown>>(token)).not.toHaveProperty('firstAccountOnly');
    expect(service.verifySignupIntentToken(token)).toEqual({
      email: 'new@example.com',
      name: 'New',
      ...identity,
    });
  });

  it('reads an intent minted before the field existed as one that waived nothing', () => {
    const legacy = jwtService.sign(
      { email: 'new@example.com', purpose: 'signup_intent', ...identity },
      { secret: signupIntentSecret(), expiresIn: '10m' },
    );

    expect(service.verifySignupIntentToken(legacy).firstAccountOnly).toBeUndefined();
  });
});

/**
 * A signup intent and a session cookie are different credentials and must never stand in for each
 * other. An intent has no `sub`; accepted as a session, the connect consent page looked up an
 * account with no id and got whichever came first.
 */
describe('AuthService — intents and sessions do not cross', () => {
  const sessionRepository = { findOne: jest.fn() };
  const service = new AuthService(jwtService, sessionRepository as unknown as Repository<SessionEntity>);
  const intent = () =>
    service.issueSignupIntentToken('new@example.com', 'New', { issuer: 'https://hub.test', subject: 's-1' });
  const session = (claims: Record<string, unknown>) =>
    jwtService.sign(claims, { secret: REFRESH_SECRET, expiresIn: '1h' });

  beforeEach(() => jest.clearAllMocks());

  it('signs an intent with a key of its own, so it does not verify as a session', () => {
    expect(signupIntentSecret()).not.toBe(REFRESH_SECRET);
    expect(() => service.validateSessionToken(intent())).toThrow();
    expect(service.resolveCsrfScope(reqWithCookies({ [SESSION_COOKIE]: intent() }))).toBeNull();
  });

  it('does not take a session cookie as an intent', () => {
    expect(() => service.verifySignupIntentToken(session({ sub: 'user-1', sid: 'sess-1' }))).toThrow();
  });

  it.each([
    ['no sub', { sid: 'sess-1' }],
    ['a non-string sub', { sub: 42, sid: 'sess-1' }],
    ['an empty sub', { sub: '', sid: 'sess-1' }],
    ['a purpose claim', { sub: 'user-1', sid: 'sess-1', purpose: 'signup_intent' }],
  ])('refuses a token signed with the session secret that carries %s', (_label, claims) => {
    const token = session(claims);

    expect(() => service.validateSessionToken(token)).toThrow(UnauthorizedException);
    expect(service.resolveCsrfScope(reqWithCookies({ [SESSION_COOKIE]: token }))).toBeNull();
  });

  it('accepts a session cookie that names a user', () => {
    expect(service.validateSessionToken(session({ sub: 'user-1', sid: 'sess-1' })).sub).toBe('user-1');
  });

  describe('resolveLiveSession', () => {
    it('returns the session when its row is live and belongs to the user the cookie names', async () => {
      sessionRepository.findOne.mockResolvedValueOnce({ id: 'sess-1' });

      await expect(service.resolveLiveSession(session({ sub: 'user-1', sid: 'sess-1' }))).resolves.toEqual({
        userId: 'user-1',
        sessionId: 'sess-1',
      });
      expect(sessionRepository.findOne).toHaveBeenCalledWith({
        where: expect.objectContaining({ user: { id: 'user-1' } }),
      });
    });

    it('returns null for a signed-out session: the cookie verifies, the row is gone', async () => {
      sessionRepository.findOne.mockResolvedValue(null);

      await expect(service.resolveLiveSession(session({ sub: 'user-1', sid: 'sess-1' }))).resolves.toBeNull();
    });

    it('returns null without touching the table for an intent or a forged cookie', async () => {
      await expect(service.resolveLiveSession(intent())).resolves.toBeNull();
      await expect(service.resolveLiveSession('not-a-jwt')).resolves.toBeNull();
      expect(sessionRepository.findOne).not.toHaveBeenCalled();
    });
  });
});
