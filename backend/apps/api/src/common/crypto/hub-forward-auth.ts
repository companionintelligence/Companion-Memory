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
 */

export const FORWARD_AUTH_USER_HEADER = 'x-ci-hub-user';
export const FORWARD_AUTH_TIMESTAMP_HEADER = 'x-ci-hub-user-timestamp';
export const FORWARD_AUTH_SIGNATURE_HEADER = 'x-ci-hub-user-signature';

/** Default replay window: reject signatures older/newer than 5 minutes of skew. */
export const DEFAULT_FORWARD_AUTH_MAX_SKEW_MS = 5 * 60 * 1000;

export interface ForwardAuthHeaders {
  user?: string | null;
  timestamp?: string | null;
  signature?: string | null;
}

export type ForwardAuthVerifyResult =
  | { ok: true; username: string }
  | { ok: false; reason: 'missing_headers' | 'bad_timestamp' | 'expired' | 'bad_signature' };

/** Canonical message that CI-Hub signs. Keep in lock-step with the signer. */
export function buildForwardAuthMessage(username: string, timestampMs: number): string {
  return `${username}\n${timestampMs}`;
}

/** Compute the lowercase-hex HMAC-SHA256 signature for a username at a given time. */
export function signForwardAuthUser(secret: string, username: string, timestampMs: number): string {
  return createHmac('sha256', secret).update(buildForwardAuthMessage(username, timestampMs)).digest('hex');
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
 * @param secret shared HMAC secret (same value provisioned on CI-Hub)
 * @param headers the three forward-auth headers as received
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

  return { ok: true, username };
}
