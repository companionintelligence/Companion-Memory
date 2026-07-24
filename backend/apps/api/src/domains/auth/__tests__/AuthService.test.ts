import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { Repository } from 'typeorm';

import config from '@ci/configuration';

import type { SessionEntity } from '../entities/SessionEntity';
import { AuthService } from '../services/AuthService';
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
});
