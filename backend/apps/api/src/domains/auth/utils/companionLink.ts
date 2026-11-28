import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The signed "connect a Companion (Portal) sign-in to account X" a signed-in person starts from
 * Settings, carried across the Portal round trip in an httpOnly cookie.
 *
 * Bound to the account and to the session that asked: the callback links the Portal identity only
 * when the same browser, still signed in as the same account, comes back with it inside the
 * lifetime. Stateless (an HMAC over the payload), so there is nothing to store and nothing to
 * clean up. The key is derived from AUTH_TOKEN_SECRET for this one purpose, so no other token
 * the API signs reads as one of these.
 */

export const COMPANION_LINK_COOKIE = 'ci_companion_link';

/** How long the Portal round trip may take: the same as the OIDC state and PKCE cookies. */
export const COMPANION_LINK_TTL_MS = 10 * 60 * 1000;

interface LinkPayload {
  /** The account to connect. */
  u: string;
  /** The first 32 hex characters of sha256(session token): the session that asked. */
  s: string;
  /** Expiry, ms since the epoch. */
  e: number;
}

function linkKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('companion-link-v1').digest();
}

function sessionDigest(sessionToken: string): string {
  return createHash('sha256').update(sessionToken).digest('hex').slice(0, 32);
}

function mac(secret: string, body: string): string {
  return createHmac('sha256', linkKey(secret)).update(body).digest('base64url');
}

/** The cookie value for `userId`, signed in with `sessionToken`. */
export function signCompanionLink(
  secret: string,
  userId: string,
  sessionToken: string,
  now: number = Date.now(),
): string {
  const payload: LinkPayload = { u: userId, s: sessionDigest(sessionToken), e: now + COMPANION_LINK_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');

  return `${body}.${mac(secret, body)}`;
}

/**
 * The account a link cookie names, when it is genuine, unexpired and was made by the session
 * presenting it now; otherwise null.
 */
export function verifyCompanionLink(
  secret: string,
  value: unknown,
  sessionToken: string | undefined,
  now: number = Date.now(),
): string | null {
  if (typeof value !== 'string' || !sessionToken) {
    return null;
  }

  const [body, signature, extra] = value.split('.');

  if (!body || !signature || extra !== undefined) {
    return null;
  }

  const expected = Buffer.from(mac(secret, body));
  const given = Buffer.from(signature);

  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }

  let payload: Partial<LinkPayload>;

  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<LinkPayload>;
  } catch {
    return null;
  }

  if (
    typeof payload.u !== 'string' ||
    typeof payload.s !== 'string' ||
    typeof payload.e !== 'number' ||
    payload.e <= now ||
    payload.s !== sessionDigest(sessionToken)
  ) {
    return null;
  }

  return payload.u;
}
