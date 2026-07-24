import { createHmac } from 'crypto';

import { ForbiddenException } from '@nestjs/common';

import config from '@ci/configuration';

import {
  ANON_CSRF_SCOPE,
  type CsrfRejectionReason,
  CsrfService,
  CsrfValidationError,
} from '../services/CsrfService';

const ANON_TOKEN_PATTERN = /^anon\.[0-9a-f]{64}\.[0-9a-f]{64}$/;
const BOUND_TOKEN_PATTERN =
  /^(anon|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[0-9a-f]{64}\.[0-9a-f]{64}$/;

const SID_A = '0198a5c2-0000-7abc-8def-0123456789ab';
const SID_B = '0198a5c2-ffff-7abc-8def-0123456789ab';

/**
 * A legacy (pre-binding) 2-segment token, correctly HMAC'd under the v1 scheme
 * (signature over the random alone). These live in real browsers' 7-day
 * cookies, so the v2 service must fail them cleanly (403 / re-mint), never
 * accept them and never 500.
 */
function legacyV1Token(): string {
  const random = 'ab'.repeat(32);
  const signature = createHmac('sha256', config.auth.csrf.secret).update(random).digest('hex');

  return `${random}.${signature}`;
}

/** Capture a validateToken rejection, asserting its type contract on the way. */
function rejectionOf(fn: () => void): CsrfValidationError {
  try {
    fn();
  } catch (err) {
    // MUST remain a ForbiddenException: the consent/confirm self-heal paths
    // gate their 303 re-render on exactly that instanceof check.
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err).toBeInstanceOf(CsrfValidationError);

    return err as CsrfValidationError;
  }

  throw new Error('expected validateToken to reject');
}

/**
 * Unit tests for the signed double-submit CSRF token service, with real crypto
 * (the HMAC secret comes from the test config). Two contracts are load-bearing:
 *
 * - The `ensureToken` matrix is what the stable-token design rests on: every
 *   render/refresh site reuses a valid same-scope cookie and only mints when
 *   the cookie is absent, invalid, or bound to a different principal, so a
 *   background session refresh can never invalidate a token already embedded
 *   in an open page (CI-Server#1740 / #1742).
 * - Principal binding: a token minted for one session (or pre-auth) must fail
 *   validation under any other principal, so a harvested or fixated token dies
 *   at the first principal boundary it crosses.
 */
describe('CsrfService', () => {
  const service = new CsrfService();

  describe('generateToken / verifyToken', () => {
    it('round-trips: anon tokens verify and carry the anon scope', () => {
      const token = service.generateToken(null);

      expect(token).toMatch(ANON_TOKEN_PATTERN);
      expect(token.startsWith(`${ANON_CSRF_SCOPE}.`)).toBe(true);
      expect(service.verifyToken(token)).toBe(true);
    });

    it('round-trips: session-bound tokens verify and carry the session id', () => {
      const token = service.generateToken(SID_A);

      expect(token).toMatch(BOUND_TOKEN_PATTERN);
      expect(token.startsWith(`${SID_A}.`)).toBe(true);
      expect(service.verifyToken(token)).toBe(true);
    });

    it('generates unique tokens', () => {
      expect(service.generateToken(null)).not.toBe(service.generateToken(null));
      expect(service.generateToken(SID_A)).not.toBe(service.generateToken(SID_A));
    });

    it('rejects a tampered scope segment (the binding is signed)', () => {
      // Re-labelling a token's scope must invalidate its signature — otherwise
      // an attacker could turn their own anon token into a "bound" one.
      const token = service.generateToken(SID_A);
      const [, random, signature] = token.split('.');

      expect(service.verifyToken(`${SID_B}.${random}.${signature}`)).toBe(false);
      expect(service.verifyToken(`${ANON_CSRF_SCOPE}.${random}.${signature}`)).toBe(false);
    });

    it('rejects a tampered random segment', () => {
      const token = service.generateToken(null);
      const [scope, random, signature] = token.split('.');
      const flipped = (random[0] === 'a' ? 'b' : 'a') + random.slice(1);

      expect(service.verifyToken(`${scope}.${flipped}.${signature}`)).toBe(false);
    });

    it('rejects a tampered signature segment', () => {
      const token = service.generateToken(null);
      const [scope, random, signature] = token.split('.');
      const flipped = (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1);

      expect(service.verifyToken(`${scope}.${random}.${flipped}`)).toBe(false);
    });

    it('rejects a legacy v1 (2-segment) token', () => {
      expect(service.verifyToken(legacyV1Token())).toBe(false);
    });

    it('rejects malformed tokens', () => {
      expect(service.verifyToken('')).toBe(false);
      expect(service.verifyToken('no-dot')).toBe(false);
      expect(service.verifyToken('short.sig')).toBe(false);
      expect(service.verifyToken('a.b.c')).toBe(false);
      // A fourth segment must not be silently ignored.
      expect(service.verifyToken(`${service.generateToken(null)}.extra`)).toBe(false);
    });

    it('rejects a token whose signature half is multi-byte without throwing', () => {
      // The signature comes from an attacker-settable cookie, so it can be
      // multi-byte while matching the expected hex signature's JS length. Must
      // return false, not throw a RangeError out of timingSafeEqual.
      const random = 'a'.repeat(64);
      const multiByteSignature = 'é'.repeat(64);

      expect(service.verifyToken(`${ANON_CSRF_SCOPE}.${random}.${multiByteSignature}`)).toBe(false);
    });
  });

  describe('ensureToken', () => {
    it('reuses a valid anon token IDENTICALLY on an anon request (CI-Server#1742)', () => {
      const existing = service.generateToken(null);

      // toBe, not just "verifies": every issue site must converge on the exact
      // same string or open pages diverge from the cookie.
      expect(service.ensureToken(existing, null)).toBe(existing);
    });

    it('reuses a valid bound token IDENTICALLY on its own session (CI-Server#1742)', () => {
      const existing = service.generateToken(SID_A);

      expect(service.ensureToken(existing, SID_A)).toBe(existing);
    });

    it('re-mints bound when an anon token arrives on an authenticated request', () => {
      const anonToken = service.generateToken(null);
      const token = service.ensureToken(anonToken, SID_A);

      expect(token).not.toBe(anonToken);
      expect(token.startsWith(`${SID_A}.`)).toBe(true);
      expect(service.verifyToken(token)).toBe(true);
    });

    it('re-mints anon when a bound token arrives on an anonymous request', () => {
      const boundToken = service.generateToken(SID_A);
      const token = service.ensureToken(boundToken, null);

      expect(token).not.toBe(boundToken);
      expect(token).toMatch(ANON_TOKEN_PATTERN);
    });

    it('re-mints when the token is bound to a DIFFERENT session', () => {
      const otherSessionsToken = service.generateToken(SID_B);
      const token = service.ensureToken(otherSessionsToken, SID_A);

      expect(token).not.toBe(otherSessionsToken);
      expect(token.startsWith(`${SID_A}.`)).toBe(true);
      expect(service.verifyToken(token)).toBe(true);
    });

    it('re-mints when the cookie is a legacy v1 token (rollout self-heal)', () => {
      const v1 = legacyV1Token();
      const token = service.ensureToken(v1, null);

      expect(token).not.toBe(v1);
      expect(token).toMatch(ANON_TOKEN_PATTERN);
    });

    it('mints when the cookie is absent or empty', () => {
      for (const absent of [undefined, ''] as unknown[]) {
        const token = service.ensureToken(absent, null);

        expect(token).toMatch(ANON_TOKEN_PATTERN);
      }
    });

    it('mints when cookie-parser produced a non-string (a `j:` JSON cookie)', () => {
      // cookie-parser runs JSONCookies over every cookie, so `csrfToken=j:{}`
      // arrives as a parsed object. Calling string methods on it used to
      // TypeError into a 500 on GET /authenticate/csrf, GET /api/connect and
      // confirm-account — and with the cookie's 7-day maxAge the browser stayed
      // wedged, with the SPA's own recovery endpoint among the casualties.
      for (const poisoned of [{}, 5, true, [], null] as unknown[]) {
        const token = service.ensureToken(poisoned, SID_A);

        expect(typeof token).toBe('string');
        expect(service.verifyToken(token)).toBe(true);
        expect(token.startsWith(`${SID_A}.`)).toBe(true);
      }
    });

    it('mints a fresh token when the cookie is invalid (e.g. signed with a rotated secret)', () => {
      const invalid = `${ANON_CSRF_SCOPE}.${'de'.repeat(32)}.${'ad'.repeat(32)}`;
      const token = service.ensureToken(invalid, null);

      expect(token).not.toBe(invalid);
      expect(service.verifyToken(token)).toBe(true);
    });
  });

  describe('validateToken — the principal-binding matrix', () => {
    const expectReason = (fn: () => void, reason: CsrfRejectionReason, message: string) => {
      const err = rejectionOf(fn);

      expect(err.reason).toBe(reason);
      expect(err.message).toContain(message);
    };

    it('accepts an anon token on an anonymous request', () => {
      const token = service.generateToken(null);

      expect(() => service.validateToken(token, token, null)).not.toThrow();
    });

    it('accepts a bound token on its own session', () => {
      const token = service.generateToken(SID_A);

      expect(() => service.validateToken(token, token, SID_A)).not.toThrow();
    });

    it('rejects a bound token on an anonymous request', () => {
      // The session that minted this token is gone (or its cookie was
      // stripped): the token no longer identifies the requesting principal.
      const token = service.generateToken(SID_A);

      expectReason(
        () => service.validateToken(token, token, null),
        'bound-token-on-anon-request',
        'CSRF token is not bound to this session',
      );
    });

    it('rejects an anon token on an authenticated session', () => {
      // A pre-auth token surviving into a session is exactly the fixation the
      // login-boundary rotation exists to prevent; validating enforces it too.
      const token = service.generateToken(null);

      expectReason(
        () => service.validateToken(token, token, SID_A),
        'anon-token-on-authed-session',
        'CSRF token is not bound to this session',
      );
    });

    it('rejects a token bound to a DIFFERENT session (the cross-principal case)', () => {
      const token = service.generateToken(SID_B);

      expectReason(
        () => service.validateToken(token, token, SID_A),
        'session-mismatch',
        'CSRF token is not bound to this session',
      );
    });

    it('rejects a legacy v1 token as bad-signature (not a 500, not a scope error)', () => {
      const v1 = legacyV1Token();

      expectReason(() => service.validateToken(v1, v1, null), 'bad-signature', 'Invalid CSRF token');
      expectReason(() => service.validateToken(v1, v1, SID_A), 'bad-signature', 'Invalid CSRF token');
    });

    it('rejects when either side is missing', () => {
      const token = service.generateToken(null);

      expect(() => service.validateToken(undefined, token, null)).toThrow(ForbiddenException);
      expect(() => service.validateToken(token, undefined, null)).toThrow(ForbiddenException);
    });

    it('labels a genuinely absent value "Missing" and a malformed one "Invalid"', () => {
      // Both are 403s, but the message must be accurate: an absent cookie/header
      // (undefined/null/empty) is "Missing", while a present-but-non-string value
      // (a `j:` JSON cookie parsed to an object) is "Invalid". The presence check
      // must run before the type check or "Missing" becomes unreachable.
      const token = service.generateToken(null);

      for (const absent of [undefined, null, ''] as unknown[]) {
        expectReason(() => service.validateToken(absent, token, null), 'missing', 'Missing CSRF token');
        expectReason(() => service.validateToken(token, absent, null), 'missing', 'Missing CSRF token');
      }

      for (const malformed of [{}, 5, true, []] as unknown[]) {
        expectReason(() => service.validateToken(malformed, token, null), 'invalid', 'Invalid CSRF token');
        expectReason(() => service.validateToken(token, malformed, null), 'invalid', 'Invalid CSRF token');
      }
    });

    it('rejects two DIFFERENT validly-signed same-scope tokens (pair equality is load-bearing)', () => {
      // Scope binding does not replace the double-submit: an attacker with a
      // session of their own could mint a validly-bound token, so only the
      // cookie↔field equality ties the request to this browser's cookie jar.
      const cookie = service.generateToken(SID_A);
      const field = service.generateToken(SID_A);

      expectReason(() => service.validateToken(cookie, field, SID_A), 'pair-mismatch', 'CSRF token mismatch');

      const anonCookie = service.generateToken(null);
      const anonField = service.generateToken(null);

      expectReason(
        () => service.validateToken(anonCookie, anonField, null),
        'pair-mismatch',
        'CSRF token mismatch',
      );
    });

    it('reports pair-mismatch BEFORE any scope verdict when cookie and header differ', () => {
      // The double-submit equality check must stay first (after presence/type):
      // a mismatched pair reveals nothing about token structure or binding.
      const anonToken = service.generateToken(null);
      const boundToken = service.generateToken(SID_A);

      expectReason(
        () => service.validateToken(anonToken, boundToken, SID_A),
        'pair-mismatch',
        'CSRF token mismatch',
      );
    });

    it('rejects an unsigned but equal pair', () => {
      expect(() => service.validateToken('forged.forged', 'forged.forged', null)).toThrow(ForbiddenException);
    });

    it('rejects a non-string value as Forbidden rather than throwing TypeError', () => {
      // Same JSON-cookie hazard on the validating side: Buffer.from({}) throws a
      // TypeError, which the callers classify as non-CSRF and re-throw as a 500,
      // skipping the self-heal that would have replaced the poisoned cookie.
      const token = service.generateToken(null);

      for (const poisoned of [{}, 5, true, [], null] as unknown[]) {
        expect(() => service.validateToken(poisoned, token, null)).toThrow(ForbiddenException);
        expect(() => service.validateToken(token, poisoned, null)).toThrow(ForbiddenException);
        expect(() => service.validateToken(poisoned, token, SID_A)).toThrow(ForbiddenException);
      }
    });

    it('rejects a multi-byte pair as Forbidden rather than throwing RangeError', () => {
      // 'é' is one JS character but two UTF-8 bytes, so a string-length guard
      // treats these as equal-length while timingSafeEqual sees 2 bytes vs 1 and
      // raises RangeError — which escapes the callers' CSRF handling as a 500
      // and skips the self-heal redirect. Byte-length comparison keeps it a 403.
      expect(() => service.validateToken('é', 'a', null)).toThrow(ForbiddenException);
      expect(() => service.validateToken('a', 'é', null)).toThrow(ForbiddenException);
    });

    it('rejects a multi-byte SCOPE segment as a 403, never a 500', () => {
      // The scope segment is attacker-settable via the cookie. A multi-byte
      // scope must fall out of the format gate as bad-signature — any
      // TypeError/RangeError here would 500 and bypass every self-heal path.
      const multiByteScope = `é.${'a'.repeat(64)}.${'b'.repeat(64)}`;

      expectReason(
        () => service.validateToken(multiByteScope, multiByteScope, null),
        'bad-signature',
        'Invalid CSRF token',
      );
      expectReason(
        () => service.validateToken(multiByteScope, multiByteScope, SID_A),
        'bad-signature',
        'Invalid CSRF token',
      );
    });

    it('rejects a token whose signature half is multi-byte', () => {
      const random = 'a'.repeat(64);
      const multiByteSignature = 'é'.repeat(64);
      const token = `${ANON_CSRF_SCOPE}.${random}.${multiByteSignature}`;

      expect(service.verifyToken(token)).toBe(false);
      expectReason(() => service.validateToken(token, token, null), 'bad-signature', 'Invalid CSRF token');
    });
  });
});
