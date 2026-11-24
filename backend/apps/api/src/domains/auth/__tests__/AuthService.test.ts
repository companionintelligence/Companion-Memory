import { createHmac } from 'crypto';

import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { FindOperator, type Repository } from 'typeorm';

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
    update: jest.fn(async (_criteria: unknown, _partial: Partial<SessionEntity>) => ({ affected: 1 })),
    delete: jest.fn(async (_criteria: unknown) => ({ affected: 1 })),
  };

  const service = new AuthService(jwtService, sessionRepository as unknown as Repository<SessionEntity>);

  beforeEach(() => {
    jest.clearAllMocks();
    saved = [];
    findOneResults = [];
  });

  it('signs access tokens with millisecond issuance for recovery revocation', () => {
    const sign = jest.fn().mockReturnValue('signed-access-token');
    const auth = new AuthService({ sign } as never, sessionRepository as never);
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_001);
    try {
      expect(auth.issueAccessToken('user-1')).toBe('signed-access-token');
      expect(sign).toHaveBeenCalledWith({ sub: 'user-1', issuedAtMs: 1_000_001 });
    } finally {
      now.mockRestore();
    }
  });

  it('carries the session id and the caller-supplied issuance together', () => {
    const sign = jest.fn().mockReturnValue('signed-access-token');
    const auth = new AuthService({ sign } as never, sessionRepository as never);

    auth.issueAccessToken('user-1', 'sess-1', 42);

    expect(sign).toHaveBeenCalledWith({ sub: 'user-1', issuedAtMs: 42, sid: 'sess-1' });
  });

  describe('issueSessionToken', () => {
    /** A repository whose transaction reads `credentials_reset_at` as `stored`. */
    function lockingRepository(stored: Date | null | undefined) {
      const inner = { create: sessionRepository.create, save: sessionRepository.save };
      const query = jest.fn(async () => (stored === undefined ? [] : [{ credentials_reset_at: stored }]));
      const repository = {
        ...sessionRepository,
        manager: {
          transaction: jest.fn(async (work: (manager: unknown) => unknown) =>
            work({ query, getRepository: () => inner }),
          ),
        },
      };

      return { auth: new AuthService(jwtService, repository as never), query };
    }

    it('issues under the owner lock when the reset stamp is the one sign-in read', async () => {
      const resetAt = new Date(1_000);
      const { auth, query } = lockingRepository(new Date(1_000));

      const { sessionId } = await auth.issueSessionToken('user-1', meta, resetAt);

      expect(query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), ['user-1']);
      expect(saved.map((row) => row.id)).toEqual([sessionId]);
    });

    it.each([
      ['a recovery that landed after the password check', null, new Date(2_000)],
      ['a second recovery', new Date(1_000), new Date(2_000)],
      ['an account deleted meanwhile', null, undefined],
    ])('refuses a sign-in raced by %s', async (_label, expected, stored) => {
      const { auth } = lockingRepository(stored);

      await expect(auth.issueSessionToken('user-1', meta, expected)).rejects.toThrow(UnauthorizedException);
      expect(saved).toHaveLength(0);
    });

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
      // grace window) hits. This row was never rotated, so there is no current
      // token to sign again and sessionToken stays null, but the caller still
      // needs the id to keep the CSRF cookie bound.
      findOneResults = [null, sessionRow('sess-1')];

      const result = await service.rotateSessionToken('user-1', 'incoming-token', meta);

      expect(result).toEqual({ sessionToken: null, sessionId: 'sess-1' });
    });

    /** Rotate sess-1 once and return the token it issued and the row as the rotation left it. */
    async function rotatedOnce(): Promise<{ token: string; row: SessionEntity }> {
      findOneResults = [sessionRow('sess-1')];
      const { sessionToken } = await service.rotateSessionToken('user-1', 'incoming-token', meta);
      const [criteria, written] = sessionRepository.update.mock.calls.at(-1)!;

      return {
        token: sessionToken!,
        row: { ...sessionRow('sess-1'), ...(criteria as object), ...written } as SessionEntity,
      };
    }

    it('replaces the token only where the row still holds the one it read', async () => {
      const { token } = await rotatedOnce();

      expect(sessionRepository.save).not.toHaveBeenCalled();
      expect(sessionRepository.update).toHaveBeenCalledWith(
        { id: 'sess-1', token: 'stored-hash' },
        { previous_token: 'stored-hash', token: expect.any(String), rotated_at: expect.any(Date) },
      );
      // The token is signed in the second rotated_at records.
      const [, written] = sessionRepository.update.mock.calls[0];
      expect(jwtService.decode<{ iat: number }>(token).iat).toBe(
        Math.floor((written.rotated_at as Date).getTime() / 1000),
      );
    });

    it('answers a grace match with the current token, signed again byte for byte', async () => {
      const { token, row } = await rotatedOnce();
      findOneResults = [null, row];

      const result = await service.rotateSessionToken('user-1', 'incoming-token', meta);

      expect(result).toEqual({ sessionToken: token, sessionId: 'sess-1' });
      // A grace match replaces nothing.
      expect(sessionRepository.update).toHaveBeenCalledTimes(1);
    });

    it('sends nothing on a grace match whose current token does not sign again to the stored hash', async () => {
      const { row } = await rotatedOnce();
      // As for a session rotated before the token's iat came from rotated_at.
      findOneResults = [null, { ...row, rotated_at: new Date((row.rotated_at as Date).getTime() - 2000) }];

      const result = await service.rotateSessionToken('user-1', 'incoming-token', meta);

      expect(result).toEqual({ sessionToken: null, sessionId: 'sess-1' });
    });

    it('turns a rotation another refresh beat into a grace match with the winner token', async () => {
      const { token: winner, row } = await rotatedOnce();
      sessionRepository.update.mockClear();
      // Read before the winner wrote; the conditional write then finds the token changed.
      findOneResults = [sessionRow('sess-1'), null, row];
      sessionRepository.update.mockResolvedValueOnce({ affected: 0 });

      const result = await service.rotateSessionToken('user-1', 'incoming-token', meta);

      expect(result).toEqual({ sessionToken: winner, sessionId: 'sess-1' });
    });

    it('looks again rather than trusting a write whose row count the driver did not report', async () => {
      const { token: winner, row } = await rotatedOnce();
      sessionRepository.update.mockClear();
      findOneResults = [sessionRow('sess-1'), null, row];
      sessionRepository.update.mockResolvedValueOnce({ affected: undefined } as never);

      const result = await service.rotateSessionToken('user-1', 'incoming-token', meta);

      expect(result).toEqual({ sessionToken: winner, sessionId: 'sess-1' });
    });

    it('writes nothing when a rotation in the same second signs the token it was given', async () => {
      // Pinned inside one second: the second rotation signs the very token the first one issued.
      jest.useFakeTimers({
        now: new Date('2026-11-16T10:00:00.100Z'),
        doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval'],
      });

      try {
        const { token, row } = await rotatedOnce();
        sessionRepository.update.mockClear();
        jest.setSystemTime(new Date('2026-11-16T10:00:00.900Z'));
        findOneResults = [row];

        const result = await service.rotateSessionToken('user-1', token, meta);

        expect(result).toEqual({ sessionToken: token, sessionId: 'sess-1' });
        // previous_token still names the token before it, which another tab may still be sending.
        expect(sessionRepository.update).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('refuses a rotation whose session a sign-out ended before it wrote', async () => {
      findOneResults = [sessionRow('sess-1'), null, null];
      sessionRepository.update.mockResolvedValueOnce({ affected: 0 });

      await expect(service.rotateSessionToken('user-1', 'incoming-token', meta)).rejects.toThrow(
        new UnauthorizedException('Invalid session'),
      );
      expect(sessionRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('invalidateOtherSessions', () => {
    const digest = (value: string) =>
      createHmac('sha256', config.auth.session.fieldPepper).update(value).digest('hex');

    it("ends the other sessions and drops the kept session's previous token", async () => {
      await service.invalidateOtherSessions('user-1', 'current-token');

      expect(sessionRepository.delete).toHaveBeenCalledWith({
        user: { id: 'user-1' },
        token: expect.any(FindOperator),
      });
      expect(sessionRepository.update).toHaveBeenCalledWith(
        { user: { id: 'user-1' }, token: digest('current-token') },
        { previous_token: null },
      );
    });

    it('ends every session and updates none without a session cookie', async () => {
      await service.invalidateOtherSessions('user-1', null);

      expect(sessionRepository.delete).toHaveBeenCalledWith({ user: { id: 'user-1' } });
      expect(sessionRepository.update).not.toHaveBeenCalled();
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
   * findLiveSession (private; rotateSessionToken reaches it through findSession
   * with the ip/user-agent hashes, invalidateSession without them) builds its
   * `where` clause with `user: { id: userId }` alongside the token hash match. Every test above uses a `findOne` mock
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
  describe('findLiveSession user-id scoping (via rotateSessionToken / invalidateSession)', () => {
    function digest(value: string): string {
      return createHmac('sha256', config.auth.session.fieldPepper).update(value).digest('hex');
    }

    function makeScopedSessionRepository(rows: SessionEntity[]) {
      const table = [...rows];

      const matchesWhere = (row: SessionEntity, where: Record<string, unknown>): boolean =>
        Object.entries(where).every(([key, value]) => {
          // What TypeORM 1.x does with `undefined` or `null` in a where condition by
          // default: refuse the whole query. A NULL match has to ask for IsNull().
          if (value === undefined || value === null) {
            throw new Error(
              `${value === undefined ? 'Undefined' : 'Null'} value encountered in property 'SessionEntity.${key}' of a where condition.`,
            );
          }

          const cell = (row as unknown as Record<string, unknown>)[key];

          if (key === 'user') {
            return (cell as { id: string } | undefined)?.id === (value as { id: string }).id;
          }

          if (value instanceof FindOperator) {
            switch (value.type) {
              case 'isNull':
                return cell == null;
              case 'moreThan':
                return (cell as Date) > (value.value as Date);
              default:
                throw new Error(`This test repository does not handle the '${value.type}' operator.`);
            }
          }

          return cell === value;
        });

      return {
        create: jest.fn((entity: Partial<SessionEntity>) => entity as SessionEntity),
        save: jest.fn(async (entity: SessionEntity) => entity),
        findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          return table.find((row) => matchesWhere(row, where)) ?? null;
        }),
        update: jest.fn(async (where: Record<string, unknown>, partial: Partial<SessionEntity>) => {
          const rows = table.filter((row) => matchesWhere(row, where));
          rows.forEach((row) => Object.assign(row, partial));

          return { affected: rows.length };
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

      await expect(scopedService.invalidateSession('user-2', rawToken)).resolves.toBe(false);
      // The session survives — the delete branch was never reached.
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it('invalidateSession: the owning user can log themselves out (session row is removed)', async () => {
      const repo = makeScopedSessionRepository([sessionRowForUser('sess-1', 'user-1')]);
      const scopedService = new AuthService(jwtService, repo as unknown as Repository<SessionEntity>);

      await expect(scopedService.invalidateSession('user-1', rawToken)).resolves.toBe(true);

      expect(repo.delete).toHaveBeenCalledWith({ id: 'sess-1' });
    });

    it('invalidateSession: does not compare the address or user agent the session was signed in from', async () => {
      // Signed in from another address with another browser; sign-out takes no request metadata.
      const repo = makeScopedSessionRepository([
        {
          ...sessionRowForUser('sess-1', 'user-1'),
          ip: digest('10.0.0.7'),
          user_agent: digest('Chrome/146'),
        },
      ]);
      const scopedService = new AuthService(jwtService, repo as unknown as Repository<SessionEntity>);

      await expect(scopedService.invalidateSession('user-1', rawToken)).resolves.toBe(true);

      expect(repo.delete).toHaveBeenCalledWith({ id: 'sess-1' });
      for (const call of repo.findOne.mock.calls as unknown as Array<[{ where: Record<string, unknown> }]>) {
        expect(call[0].where).not.toHaveProperty('ip');
        expect(call[0].where).not.toHaveProperty('user_agent');
      }
    });

    it('invalidateSession: matches the previous token inside the grace window but not after it', async () => {
      const rotated = (rotatedAt: Date) =>
        makeScopedSessionRepository([
          {
            ...sessionRowForUser('sess-1', 'user-1'),
            token: digest('already-rotated-token'),
            previous_token: digest(rawToken),
            rotated_at: rotatedAt,
          },
        ]);

      const inside = rotated(new Date());
      await expect(
        new AuthService(jwtService, inside as unknown as Repository<SessionEntity>).invalidateSession(
          'user-1',
          rawToken,
        ),
      ).resolves.toBe(true);
      expect(inside.delete).toHaveBeenCalledWith({ id: 'sess-1' });

      const after = rotated(new Date(Date.now() - 24 * 60 * 60 * 1000));
      await expect(
        new AuthService(jwtService, after as unknown as Repository<SessionEntity>).invalidateSession(
          'user-1',
          rawToken,
        ),
      ).resolves.toBe(false);
      expect(after.delete).not.toHaveBeenCalled();
    });

    it('invalidateSession: finds nothing to end for an expired session', async () => {
      const repo = makeScopedSessionRepository([
        { ...sessionRowForUser('sess-1', 'user-1'), expires_at: new Date(Date.now() - 1000) },
      ]);
      const scopedService = new AuthService(jwtService, repo as unknown as Repository<SessionEntity>);

      await expect(scopedService.invalidateSession('user-1', rawToken)).resolves.toBe(false);
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it('invalidateSession: answers false when another sign-out deleted the row between lookup and delete', async () => {
      const repo = makeScopedSessionRepository([sessionRowForUser('sess-1', 'user-1')]);
      repo.delete.mockResolvedValueOnce({ affected: 0 });
      const scopedService = new AuthService(jwtService, repo as unknown as Repository<SessionEntity>);

      await expect(scopedService.invalidateSession('user-1', rawToken)).resolves.toBe(false);
    });

    it('rotateSessionToken: a request with no User-Agent is refused as an invalid session, not a query error', async () => {
      const repo = makeScopedSessionRepository([sessionRowForUser('sess-1', 'user-1')]);
      const scopedService = new AuthService(jwtService, repo as unknown as Repository<SessionEntity>);

      await expect(scopedService.rotateSessionToken('user-1', rawToken, { ip: meta.ip })).rejects.toThrow(
        new UnauthorizedException('Invalid session'),
      );
    });

    it('rotateSessionToken: a session signed in with no User-Agent rotates for a request with none', async () => {
      // issueSessionToken stores NULL when the sign-in had no User-Agent header.
      const signedInWithout = () =>
        makeScopedSessionRepository([{ ...sessionRowForUser('sess-1', 'user-1'), user_agent: null }]);

      const scopedService = new AuthService(
        jwtService,
        signedInWithout() as unknown as Repository<SessionEntity>,
      );
      const result = await scopedService.rotateSessionToken('user-1', rawToken, { ip: meta.ip });

      expect(result.sessionId).toBe('sess-1');

      // The binding still holds the other way: a User-Agent the session was not signed in with.
      const other = new AuthService(jwtService, signedInWithout() as unknown as Repository<SessionEntity>);

      await expect(other.rotateSessionToken('user-1', rawToken, meta)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rotateSessionToken: inside the grace window, a session signed in with no address or User-Agent matches its previous token', async () => {
      const repo = makeScopedSessionRepository([
        {
          ...sessionRowForUser('sess-1', 'user-1'),
          token: digest('already-rotated-token'),
          previous_token: digest(rawToken),
          rotated_at: new Date(),
          ip: null,
          user_agent: null,
        },
      ]);
      const scopedService = new AuthService(jwtService, repo as unknown as Repository<SessionEntity>);

      await expect(scopedService.rotateSessionToken('user-1', rawToken, {})).resolves.toEqual({
        sessionToken: null,
        sessionId: 'sess-1',
      });
    });

    it('invalidateSession: a session signed in with no User-Agent signs out too', async () => {
      const repo = makeScopedSessionRepository([
        { ...sessionRowForUser('sess-1', 'user-1'), user_agent: null },
      ]);
      const scopedService = new AuthService(jwtService, repo as unknown as Repository<SessionEntity>);

      await expect(scopedService.invalidateSession('user-1', rawToken)).resolves.toBe(true);

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

describe('AuthService: telling open live-update streams', () => {
  const ACCESS_SECRET = config.auth.jwt.authTokenSecret;

  function makeService(rows: Array<Partial<SessionEntity>> = []) {
    const repo = {
      findOne: jest.fn(async () => rows[0] ?? null),
      delete: jest.fn(async () => ({ affected: rows.length })),
      update: jest.fn(async () => ({ affected: 1 })),
    };
    const liveChanges = { publishRevoked: jest.fn().mockResolvedValue(undefined) };
    const service = new AuthService(
      new JwtService({ secret: ACCESS_SECRET }),
      repo as unknown as Repository<SessionEntity>,
      liveChanges as never,
    );

    return { service, repo, liveChanges };
  }

  it('ties an access token to the session it was minted for', () => {
    const { service } = makeService();

    const tied = new JwtService({}).verify<JwtPayload>(service.issueAccessToken('user-1', 'sess-1'), {
      secret: ACCESS_SECRET,
    });
    const untied = new JwtService({}).verify<JwtPayload>(service.issueAccessToken('user-1'), {
      secret: ACCESS_SECRET,
    });

    expect(tied).toMatchObject({ sub: 'user-1', sid: 'sess-1' });
    expect(untied.sub).toBe('user-1');
    expect(untied).not.toHaveProperty('sid');
  });

  it('tells open streams once a session is signed out', async () => {
    const { service, repo, liveChanges } = makeService([{ id: 'sess-1' }]);

    await service.invalidateSession('user-1', 'cookie-token');

    expect(repo.delete).toHaveBeenCalledWith({ id: 'sess-1' });
    expect(liveChanges.publishRevoked).toHaveBeenCalledWith('user-1');
    expect(repo.delete.mock.invocationCallOrder[0]).toBeLessThan(
      liveChanges.publishRevoked.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('tells nobody when the session was already signed out', async () => {
    const { service, repo, liveChanges } = makeService();

    await expect(service.invalidateSession('user-1', 'cookie-token')).resolves.toBe(false);

    expect(repo.delete).not.toHaveBeenCalled();
    expect(liveChanges.publishRevoked).not.toHaveBeenCalled();
  });

  it('tells nobody when a concurrent sign-out deleted the session first', async () => {
    const { service, repo, liveChanges } = makeService([{ id: 'sess-1' }]);
    repo.delete.mockResolvedValueOnce({ affected: 0 });

    await expect(service.invalidateSession('user-1', 'cookie-token')).resolves.toBe(false);

    expect(liveChanges.publishRevoked).not.toHaveBeenCalled();
  });

  it('tells open streams once the other sessions are signed out', async () => {
    const { service, liveChanges } = makeService([{ id: 'sess-2' }]);

    await service.invalidateOtherSessions('user-1', 'cookie-token');

    expect(liveChanges.publishRevoked).toHaveBeenCalledWith('user-1');
  });

  it('tells nobody when there were no other sessions to sign out', async () => {
    const { service, liveChanges } = makeService();

    await service.invalidateOtherSessions('user-1', 'cookie-token');

    expect(liveChanges.publishRevoked).not.toHaveBeenCalled();
  });

  it('tells open streams only after the kept session has dropped its previous token', async () => {
    const { service, repo, liveChanges } = makeService([{ id: 'sess-2' }]);

    await service.invalidateOtherSessions('user-1', 'cookie-token');

    expect(repo.update.mock.invocationCallOrder[0]).toBeLessThan(
      liveChanges.publishRevoked.mock.invocationCallOrder[0] ?? 0,
    );
  });
});
