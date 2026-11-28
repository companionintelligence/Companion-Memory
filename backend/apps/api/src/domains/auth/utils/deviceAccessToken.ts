import { createHmac } from 'crypto';

import { jwtVerify, SignJWT } from 'jose';

import config from '@ci/configuration';

/**
 * Short-lived access tokens for the apps' own device keys.
 *
 * The phone and desktop apps sign in once and keep a durable, full-capability API key in the OS
 * keystore. Before these tokens, the web page inside the app read that key back and sent it on
 * every request, so any script that ever ran in the page could carry off a credential that worked
 * from anywhere until someone revoked it. Now the app's native side keeps the key, trades it here
 * (`POST /keys/access-token`) for a token that works for {@link DEVICE_ACCESS_TOKEN_TTL_SECONDS},
 * and the page only ever holds that.
 *
 * A token stands for its key, nothing more:
 * - It is accepted wherever the key is (`x-api-key`, or `Authorization: Bearer`), and resolved to
 *   the key on every request (`ApiKeyService.validateCredential`), so it carries the key's scopes,
 *   capability and provenance, and stops working the moment the key is revoked or expires.
 * - It is never a session. It is signed with a key derived from the session secret, not the
 *   session secret itself, so `JwtStrategy` cannot verify it, and it carries a `purpose`, which
 *   `JwtStrategy` refuses on its own. Routes that take only a session or a Portal bearer
 *   (`JwtOrPortalAuthGuard`: minting and listing keys) refuse it like they refuse the key.
 * - It cannot mint another token (`ApiKeyController.accessToken`), so a stolen one ends when it
 *   expires.
 */

/** How long a token works. The apps ask for a new one a minute before this runs out. */
export const DEVICE_ACCESS_TOKEN_TTL_SECONDS = 300;

/** `purpose` claim, which `JwtStrategy` refuses (only a Python run token's purpose gets anywhere there). */
export const DEVICE_ACCESS_TOKEN_PURPOSE = 'device_access';

const ISSUER = 'ci-server';
const AUDIENCE = 'ci-server:device-access';
const ALGORITHM = 'HS256';
/** Changing this label retires every token in flight, which is harmless: the apps ask again. */
const SIGNING_KEY_LABEL = 'ci-server device access token v1';

/** A compact JWS (three base64url segments) of a plausible size. A device key is 64 hex characters, so never this. */
const JWS_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LENGTH = 2048;

/** A key id as `ApiKeyService` mints them (uuid v7), so a forged claim never becomes a strange query. */
const KEY_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DeviceAccessTokenClaims {
  keyId: string;
  userId: string;
  /** When the token stops working, in ms since the epoch. */
  expiresAtMs: number;
}

let derived: { source: string; key: Uint8Array } | null = null;

/** HMAC-SHA256 of the session secret under a fixed label: a key of its own, which the session strategy does not hold. */
function signingKey(): Uint8Array {
  const source = config.auth.jwt.authTokenSecret;

  if (!derived || derived.source !== source) {
    derived = {
      source,
      key: new Uint8Array(createHmac('sha256', source).update(SIGNING_KEY_LABEL).digest()),
    };
  }

  return derived.key;
}

/** Whether `raw` has the shape of a token at all. Says nothing about whether it is valid. */
export function looksLikeDeviceAccessToken(raw: string): boolean {
  return raw.length <= MAX_TOKEN_LENGTH && JWS_SHAPE.test(raw);
}

/** A token for the key `keyId` of `userId`, working for {@link DEVICE_ACCESS_TOKEN_TTL_SECONDS} from `nowMs`. */
export async function mintDeviceAccessToken(
  key: { keyId: string; userId: string },
  nowMs = Date.now(),
): Promise<{ token: string; expiresAtMs: number }> {
  const issuedAt = Math.floor(nowMs / 1000);
  const expiresAt = issuedAt + DEVICE_ACCESS_TOKEN_TTL_SECONDS;

  const token = await new SignJWT({ purpose: DEVICE_ACCESS_TOKEN_PURPOSE, akid: key.keyId })
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(key.userId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(signingKey());

  return { token, expiresAtMs: expiresAt * 1000 };
}

/**
 * The key and user a token stands for, or null when it is not one of ours, was altered, or has
 * expired. Never throws. Whether the key itself still works is for the caller to look up.
 */
export async function verifyDeviceAccessToken(raw: string): Promise<DeviceAccessTokenClaims | null> {
  if (!looksLikeDeviceAccessToken(raw)) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(raw, signingKey(), {
      algorithms: [ALGORITHM],
      issuer: ISSUER,
      audience: AUDIENCE,
      requiredClaims: ['exp', 'sub'],
    });

    const keyId = payload.akid;

    if (
      payload.purpose !== DEVICE_ACCESS_TOKEN_PURPOSE ||
      typeof keyId !== 'string' ||
      !KEY_ID_SHAPE.test(keyId) ||
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      typeof payload.exp !== 'number'
    ) {
      return null;
    }

    return { keyId, userId: payload.sub, expiresAtMs: payload.exp * 1000 };
  } catch {
    return null;
  }
}
