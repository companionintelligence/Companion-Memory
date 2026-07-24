import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

import { ForbiddenException, Injectable } from '@nestjs/common';

import config from '@ci/configuration';

const CSRF_SECRET = config.auth.csrf.secret;

/**
 * Scope segment of a token minted before authentication (no session yet). A
 * literal rather than an empty string so the token format stays unambiguous:
 * every token carries exactly three segments, and `anon` can never collide
 * with a session id (it is not a uuid shape).
 */
export const ANON_CSRF_SCOPE = 'anon';

/**
 * Token shape: `{scope}.{randomHex64}.{hmacHex64}` where scope is either the
 * literal `anon` or a lowercase uuid session id. Anchored and character-exact
 * so a legacy 2-segment token, a tampered segment, or a multi-byte scope all
 * fail parsing (and therefore validation) instead of reaching the HMAC step in
 * a shape it does not expect.
 */
const TOKEN_PATTERN =
  /^(anon|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[0-9a-f]{64}\.[0-9a-f]{64}$/;

/**
 * Why a CSRF validation was rejected. Carried on {@link CsrfValidationError}
 * for logging/observability — never surfaced to the client, which only sees
 * the generic messages (an attacker probing the endpoint learns nothing about
 * which check failed beyond what the unchanged messages already reveal).
 */
export type CsrfRejectionReason =
  | 'missing'
  | 'invalid'
  | 'pair-mismatch'
  | 'bad-signature'
  | 'bound-token-on-anon-request'
  | 'anon-token-on-authed-session'
  | 'session-mismatch';

/**
 * Every CSRF rejection thrown by {@link CsrfService.validateToken}. MUST remain
 * an `instanceof ForbiddenException`: the consent and confirm-account self-heal
 * paths gate their 303 re-render on exactly that check, and anything else would
 * surface as a 500 that bypasses them.
 */
export class CsrfValidationError extends ForbiddenException {
  constructor(
    readonly reason: CsrfRejectionReason,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Implements the signed double-submit cookie pattern for CSRF protection, with
 * the token bound to the principal it was minted for.
 *
 * Token format: `{scope}.{randomHex}.{hmacHex}` — scope is the session id the
 * token was minted under, or `anon` for a pre-auth mint. The HMAC covers
 * `scope + "\n" + random`, so the scope segment cannot be swapped onto a
 * differently-scoped token.
 *
 * This service is responsible for generating and verifying CSRF tokens.
 * Cookie management and request validation are controller concerns.
 */
@Injectable()
export class CsrfService {
  /**
   * Generate a signed CSRF token bound to `sessionId` (or to the anonymous
   * scope when `null` — a pre-auth mint).
   */
  generateToken(sessionId: string | null): string {
    const scope = sessionId ?? ANON_CSRF_SCOPE;
    const random = randomBytes(32).toString('hex');
    const signature = this.sign(scope, random);

    return `${scope}.${random}.${signature}`;
  }

  /**
   * Validate a CSRF token pair (cookie + header/field) against the requesting
   * principal.
   *
   * Verifies that both values are present, match each other using a
   * constant-time comparison, carry a valid HMAC signature, and were minted for
   * `sessionId` (`null` = anonymous request): a pre-auth token is only valid on
   * a pre-auth request, and a session-bound token only on a request riding the
   * very session that minted it. A stolen-or-fixated token therefore stops
   * working the moment it crosses a principal boundary.
   *
   * The checks run cheapest-and-least-revealing first: presence → type →
   * double-submit pair equality → HMAC → scope. Pair equality before parsing is
   * deliberate (unchanged from v1) — a cookie/field mismatch is rejected before
   * the server reveals, via timing or message, anything about token structure.
   *
   * @throws CsrfValidationError (a ForbiddenException) if validation fails
   */
  validateToken(cookieValue: unknown, headerValue: unknown, sessionId: string | null): void {
    // Missing takes precedence over malformed so an absent cookie/header reports
    // "Missing" rather than "Invalid": a genuinely absent value arrives as
    // `undefined` (no cookie / no header) or `''` (empty), which the type check
    // below would otherwise mislabel as invalid. A falsy non-string (e.g. `0`,
    // `false`) is not "missing" — it falls through to the type check.
    if (cookieValue == null || cookieValue === '' || headerValue == null || headerValue === '') {
      throw new CsrfValidationError('missing', 'Missing CSRF token');
    }

    // Both arguments are `unknown` rather than `string | undefined` because
    // neither source is actually type-safe: cookie-parser runs JSONCookies over
    // every cookie, so a `csrfToken=j:{…}` value arrives as a parsed object (or
    // number, or boolean), and Express header values can be arrays. Passing
    // either into Buffer.from() throws a TypeError that escapes as a 500 and
    // bypasses the callers' self-heal handling, so reject non-strings here as a
    // plain CSRF failure — which lets the caller re-render and ensureToken
    // replace the poisoned cookie.
    if (typeof cookieValue !== 'string' || typeof headerValue !== 'string') {
      throw new CsrfValidationError('invalid', 'Invalid CSRF token');
    }

    // Compare BYTE lengths, not JS string lengths. `timingSafeEqual` rejects
    // buffers of differing byte length with a RangeError, and a multi-byte
    // character makes the two measures disagree ('é' is one JS char but two
    // bytes) — so a string-length guard lets such a pair through and the throw
    // escapes as a 500, bypassing the callers' CSRF self-heal handling.
    const cookieBytes = Buffer.from(cookieValue);
    const headerBytes = Buffer.from(headerValue);

    if (cookieBytes.length !== headerBytes.length) {
      throw new CsrfValidationError('pair-mismatch', 'CSRF token mismatch');
    }

    if (!timingSafeEqual(cookieBytes, headerBytes)) {
      throw new CsrfValidationError('pair-mismatch', 'CSRF token mismatch');
    }

    const parsed = this.parseToken(cookieValue);

    if (parsed == null || !this.verifySignature(parsed.scope, parsed.random, parsed.signature)) {
      throw new CsrfValidationError('bad-signature', 'Invalid CSRF token');
    }

    // Scope binding, checked LAST — only after the HMAC has proven the token is
    // one this server minted. Plain `===` is fine here: both values are
    // server-known (the scope was just authenticated by the HMAC, and the
    // context scope comes from the session JWT), so there is no secret left for
    // a timing oracle to leak.
    const contextScope = sessionId ?? ANON_CSRF_SCOPE;

    if (parsed.scope !== contextScope) {
      if (parsed.scope === ANON_CSRF_SCOPE) {
        // Pre-auth token presented on an authenticated session: the token
        // predates (or sidesteps) the login that minted this session.
        throw new CsrfValidationError(
          'anon-token-on-authed-session',
          'CSRF token is not bound to this session',
        );
      }

      if (contextScope === ANON_CSRF_SCOPE) {
        // Session-bound token presented without that session's cookie: either
        // the session expired out from under the token, or the token was
        // carried onto a request it does not belong to.
        throw new CsrfValidationError(
          'bound-token-on-anon-request',
          'CSRF token is not bound to this session',
        );
      }

      // Bound to a DIFFERENT session — the cross-principal case this binding
      // exists to stop.
      throw new CsrfValidationError('session-mismatch', 'CSRF token is not bound to this session');
    }
  }

  /**
   * Return the existing token when it carries a valid signature AND is bound to
   * the requesting principal, otherwise mint a fresh one for that principal.
   *
   * A CSRF token identifies a browser and its principal, not a request: reusing
   * a valid same-scope cookie keeps every open tab and server-rendered page
   * (consent / confirm-account) converged on one stable value, so a background
   * session refresh can never invalidate a form that was rendered earlier.
   * Rotation is reserved for identity boundaries (login, signup, OIDC sign-in)
   * and logout (clear) — and, since binding, for a token whose scope no longer
   * matches the principal presenting it (a legacy or cross-principal cookie
   * self-heals into a correctly-bound one on the next ensure).
   */
  ensureToken(cookieValue: unknown, sessionId: string | null): string {
    const contextScope = sessionId ?? ANON_CSRF_SCOPE;
    const parsed = this.parseToken(cookieValue);

    if (
      parsed != null &&
      parsed.scope === contextScope &&
      this.verifySignature(parsed.scope, parsed.random, parsed.signature)
    ) {
      return cookieValue as string;
    }

    return this.generateToken(sessionId);
  }

  /**
   * Verify the format and HMAC signature of a token, scope-agnostic: a `true`
   * here means "this server minted it", not "it belongs to this request" —
   * scope binding is validateToken/ensureToken's job.
   */
  verifyToken(token: unknown): boolean {
    const parsed = this.parseToken(token);

    if (parsed == null) {
      return false;
    }

    return this.verifySignature(parsed.scope, parsed.random, parsed.signature);
  }

  /**
   * Split a token into its `{scope}.{random}.{signature}` segments, or `null`
   * when the value is not a string in exactly that shape. The anchored pattern
   * is the format gate: legacy 2-segment tokens, extra segments, non-hex
   * characters and multi-byte scopes all return `null` here — which downstream
   * surfaces as a clean 403/re-mint, never a TypeError/RangeError 500.
   */
  private parseToken(token: unknown): { scope: string; random: string; signature: string } | null {
    // See validateToken: a cookie value is not guaranteed to be a string.
    if (typeof token !== 'string') {
      return null;
    }

    if (!TOKEN_PATTERN.test(token)) {
      return null;
    }

    const [scope, random, signature] = token.split('.');

    return { scope, random, signature };
  }

  /**
   * Constant-time comparison of a token's signature segment against the
   * expected HMAC for its scope + random. Byte lengths are compared first:
   * `timingSafeEqual` throws a RangeError on differing byte lengths, and while
   * the anchored parse pattern already pins the segment to 64 hex chars, this
   * guard keeps the no-500 property local rather than depending on a caller.
   */
  private verifySignature(scope: string, random: string, signature: string): boolean {
    const expectedSignature = this.sign(scope, random);

    const signatureBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expectedSignature);

    if (signatureBytes.length !== expectedBytes.length) {
      return false;
    }

    return timingSafeEqual(signatureBytes, expectedBytes);
  }

  /**
   * HMAC over `scope + "\n" + random`. The newline delimiter keeps the two
   * inputs unambiguous (neither can contain one), so a scope/random boundary
   * shift can never produce the same MAC. Covering the scope is what makes the
   * binding tamper-proof: re-labelling a token's scope segment invalidates its
   * signature.
   */
  private sign(scope: string, random: string): string {
    return createHmac('sha256', CSRF_SECRET).update(`${scope}\n${random}`).digest('hex');
  }
}
