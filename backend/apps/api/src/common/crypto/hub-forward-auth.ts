import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifier for the Traefik forward-auth identity header issued by CI-Hub.
 *
 * CI-Hub authenticates a user session at Traefik and forwards the username in
 * `X-CI-Hub-User`. That header used to be unsigned, so any container that could
 * reach a backing app on `ci_os_hub_network` could forge it and impersonate a
 * user to whatever consumed it (CI-Engineering/architecture/subsystems/
 * security-trust-and-ops.md, gap #5).
 *
 * CI-Hub now signs the header with HMAC-SHA256 over `${username}\n${timestampMs}`
 * keyed on a secret shared with this server. This module verifies that signature
 * before the identity is trusted. The signing side lives in CI-Hub at
 * `packages/backend/src/modules/auth/utils/forward-auth-signing.ts` — the two
 * must stay in lock-step.
 *
 * A username is not a stable key: the person can rename themselves on the Hub,
 * and a Memory account found by it strands its data the moment the two diverge.
 * So a Hub that knows which person it is signing for also sends that person's
 * stable id — `X-CI-Hub-User-Id`, minted once per Hub user and never reused, and
 * `X-CI-Hub-User-Issuer`, the Hub user directory that minted it — under a second
 * signature that binds both to the username and timestamp above. See
 * CI-Engineering/architecture/identity/hub-memory-account-link.md.
 */

export const FORWARD_AUTH_USER_HEADER = 'x-ci-hub-user';
export const FORWARD_AUTH_TIMESTAMP_HEADER = 'x-ci-hub-user-timestamp';
export const FORWARD_AUTH_SIGNATURE_HEADER = 'x-ci-hub-user-signature';
export const FORWARD_AUTH_USER_ISSUER_HEADER = 'x-ci-hub-user-issuer';
export const FORWARD_AUTH_USER_ID_HEADER = 'x-ci-hub-user-id';
export const FORWARD_AUTH_USER_ID_SIGNATURE_HEADER = 'x-ci-hub-user-id-signature';

/** Default replay window: reject signatures older/newer than 5 minutes of skew. */
export const DEFAULT_FORWARD_AUTH_MAX_SKEW_MS = 5 * 60 * 1000;

/** Prefix of every Hub user-directory issuer. Never a valid OIDC issuer, which is always an https URL. */
export const HUB_ISSUER_PREFIX = 'urn:ci-hub:';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const HUB_ISSUER_PATTERN = new RegExp(`^${HUB_ISSUER_PREFIX}${UUID}$`);
const HUB_USER_ID_PATTERN = new RegExp(`^${UUID}$`);

export interface ForwardAuthHeaders {
  user?: string | null;
  timestamp?: string | null;
  signature?: string | null;
  issuer?: string | null;
  userId?: string | null;
  userIdSignature?: string | null;
}

/** A Hub person's stable identity: the (issuer, subject) pair `ci.federated_identities` binds. */
export interface HubStableId {
  /** `urn:ci-hub:<directory-uuid>` — the Hub user directory that minted the id. */
  issuer: string;
  /** The Hub user's `public_id`: minted once per person, unchanged by any rename, never reused. */
  subject: string;
}

export type ForwardAuthVerifyResult =
  | { ok: true; username: string; stableId: HubStableId | null }
  | {
      ok: false;
      reason: 'missing_headers' | 'bad_timestamp' | 'expired' | 'bad_signature' | 'bad_stable_id';
    };

/** Whether `issuer` names a Hub user directory rather than an OIDC issuer. */
export function isHubIssuer(issuer: string): boolean {
  return issuer.startsWith(HUB_ISSUER_PREFIX);
}

/** Canonical message that CI-Hub signs. Keep in lock-step with the signer. */
export function buildForwardAuthMessage(username: string, timestampMs: number): string {
  return `${username}\n${timestampMs}`;
}

/** Compute the lowercase-hex HMAC-SHA256 signature for a username at a given time. */
export function signForwardAuthUser(secret: string, username: string, timestampMs: number): string {
  return createHmac('sha256', secret).update(buildForwardAuthMessage(username, timestampMs)).digest('hex');
}

/**
 * Canonical message for the stable id. Keep in lock-step with the signer.
 *
 * Binds the id to the same username and timestamp as the triple, so it cannot be
 * spliced onto another response; the versioned prefix keeps it from ever being
 * mistaken for the triple's own message.
 */
export function buildForwardAuthUserIdMessage(
  issuer: string,
  userId: string,
  username: string,
  timestampMs: number,
): string {
  return `ci-hub-user-id/1\n${issuer}\n${userId}\n${username}\n${timestampMs}`;
}

/** Compute the lowercase-hex HMAC-SHA256 signature over the stable id. */
export function signForwardAuthUserId(
  secret: string,
  issuer: string,
  userId: string,
  username: string,
  timestampMs: number,
): string {
  return createHmac('sha256', secret)
    .update(buildForwardAuthUserIdMessage(issuer, userId, username, timestampMs))
    .digest('hex');
}

/** Constant-time comparison of two hex signature strings. */
function signaturesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch; guard first (length is not secret).
  if (bufA.length !== bufB.length) {
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

/**
 * Verify a signed forward-auth header set.
 *
 * The stable id is optional — an older Hub sends only the triple — but never
 * half-present: any of its three headers without the others, a malformed value,
 * or a signature that does not match rejects the whole identity. Traefik strips
 * a visitor's copy of every header its forward-auth middleware lists, so an
 * unsigned id can only be the visitor's own, sent through a config that predates
 * these names; failing closed costs that visitor their own request and nothing
 * else.
 *
 * @param secret shared HMAC secret (same value provisioned on CI-Hub)
 * @param headers the forward-auth headers as received
 * @param opts.now injectable clock (ms) for deterministic tests
 * @param opts.maxSkewMs allowed clock skew / replay window
 */
export function verifyForwardAuthHeaders(
  secret: string,
  headers: ForwardAuthHeaders,
  opts: { now?: number; maxSkewMs?: number } = {},
): ForwardAuthVerifyResult {
  const username = headers.user;
  const timestampRaw = headers.timestamp;
  const signature = headers.signature;

  if (!secret || !username || !timestampRaw || !signature) {
    return { ok: false, reason: 'missing_headers' };
  }

  const timestampMs = Number(timestampRaw);
  if (!Number.isFinite(timestampMs) || !Number.isInteger(timestampMs)) {
    return { ok: false, reason: 'bad_timestamp' };
  }

  const now = opts.now ?? Date.now();
  const maxSkewMs = opts.maxSkewMs ?? DEFAULT_FORWARD_AUTH_MAX_SKEW_MS;
  if (Math.abs(now - timestampMs) > maxSkewMs) {
    return { ok: false, reason: 'expired' };
  }

  const expected = signForwardAuthUser(secret, username, timestampMs);
  if (!signaturesEqual(signature, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const { issuer, userId, userIdSignature } = headers;
  if (!issuer && !userId && !userIdSignature) {
    return { ok: true, username, stableId: null };
  }

  if (
    !issuer ||
    !userId ||
    !userIdSignature ||
    !HUB_ISSUER_PATTERN.test(issuer) ||
    !HUB_USER_ID_PATTERN.test(userId)
  ) {
    return { ok: false, reason: 'bad_stable_id' };
  }

  const expectedId = signForwardAuthUserId(secret, issuer, userId, username, timestampMs);
  if (!signaturesEqual(userIdSignature, expectedId)) {
    return { ok: false, reason: 'bad_signature' };
  }

  return { ok: true, username, stableId: { issuer, subject: userId } };
}
