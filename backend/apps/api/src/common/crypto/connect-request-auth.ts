import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed-request authentication for the Hub -> CI-Server app-connect calls
 * (`/connect/exchange`, `/connect/revoke`, `/connect/rotate`).
 *
 * Unlike the Traefik forward-auth header (which attests only an identity), this
 * binds the signature to the specific request — method, path, and a hash of the
 * body — plus a per-request nonce and timestamp. That makes a captured header
 * set useless: it can't be replayed (the nonce is single-use, enforced by a
 * cache on the verifier), can't be redirected to another endpoint (path is
 * signed), and can't have its body swapped (e.g. revoke a different app — the
 * body hash is signed). Keyed on the dedicated CI_HUB_FORWARD_AUTH_SECRET shared
 * with CI-Hub. Kept in lock-step with the signer in CI-Hub at
 * `packages/backend/src/modules/auth/utils/connect-request-signing.ts`.
 */

export const CONNECT_TIMESTAMP_HEADER = 'x-ci-connect-timestamp';
export const CONNECT_NONCE_HEADER = 'x-ci-connect-nonce';
export const CONNECT_SIGNATURE_HEADER = 'x-ci-connect-signature';

/** Replay window: reject signatures whose timestamp is outside ±this skew. */
export const DEFAULT_CONNECT_MAX_SKEW_MS = 60 * 1000;

/**
 * Max nesting the body canonicalizer will walk. Canonicalization is unavoidably
 * pre-auth (the body hash is part of the signed message), so an unauthenticated
 * caller controls the input; a bound turns a pathologically-deep body into a
 * clean rejection instead of a stack-overflow 500. Real connect bodies are flat
 * (`{code}` / `{app}`), so this is never hit legitimately and stays in lock-step
 * with the CI-Hub signer.
 */
const MAX_CANONICALIZE_DEPTH = 64;

export interface ConnectRequestParts {
  method: string;
  path: string;
  timestamp?: string | null;
  nonce?: string | null;
  signature?: string | null;
  /** Parsed request body (canonicalized before hashing). */
  body: unknown;
}

export type ConnectVerifyResult =
  | { ok: true; nonce: string; timestampMs: number }
  | { ok: false; reason: 'missing_headers' | 'bad_timestamp' | 'expired' | 'bad_signature' | 'bad_body' };

/** SHA-256 hex of a value. */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Deterministic JSON for the body hash: object keys sorted (recursively) so the
 * signer and verifier hash identical bytes regardless of key insertion order.
 */
export function canonicalizeBody(body: unknown): string {
  const seen = new WeakSet<object>();

  const walk = (value: unknown, depth: number): unknown => {
    if (value === null || typeof value !== 'object') {
      return value;
    }

    // Bound recursion so an attacker-supplied deeply-nested body (canonicalized
    // pre-auth) cannot overflow the stack; a legit connect body is depth 1.
    if (depth > MAX_CANONICALIZE_DEPTH) {
      throw new RangeError('connect body nesting exceeds the allowed depth');
    }

    // Track only ANCESTORS (add before recursing, remove after) so a genuine
    // cycle collapses to null, while a DAG — the same object referenced twice on
    // sibling branches — still serializes fully. A plain add-only WeakSet would
    // null the second occurrence and diverge from the verifier, which re-parses
    // the JSON wire body (JSON.parse never produces shared references).
    if (seen.has(value as object)) {
      return null;
    }

    seen.add(value as object);

    let result: unknown;
    if (Array.isArray(value)) {
      result = value.map((item) => walk(item, depth + 1));
    } else {
      const out: Record<string, unknown> = {};

      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = walk((value as Record<string, unknown>)[key], depth + 1);
      }

      result = out;
    }

    seen.delete(value as object);

    return result;
  };

  return JSON.stringify(walk(body ?? {}, 0));
}

/** The canonical string that both sides sign. */
export function buildConnectMessage(
  method: string,
  path: string,
  timestampMs: number,
  nonce: string,
  body: unknown,
): string {
  return [method.toUpperCase(), path, String(timestampMs), nonce, sha256Hex(canonicalizeBody(body))].join(
    '\n',
  );
}

/** Compute the lowercase-hex HMAC-SHA256 signature for a request. */
export function signConnectRequest(
  secret: string,
  method: string,
  path: string,
  timestampMs: number,
  nonce: string,
  body: unknown,
): string {
  return createHmac('sha256', secret)
    .update(buildConnectMessage(method, path, timestampMs, nonce, body))
    .digest('hex');
}

function signaturesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

/**
 * Verify a signed connect request. Nonce single-use is enforced by the caller
 * (guard) via a replay cache; this only checks header presence, timestamp skew,
 * and the HMAC. Returns the nonce/timestamp so the caller can record them.
 */
export function verifyConnectRequest(
  secret: string,
  parts: ConnectRequestParts,
  opts: { now?: number; maxSkewMs?: number } = {},
): ConnectVerifyResult {
  const { method, path, timestamp, nonce, signature, body } = parts;

  if (!secret || !timestamp || !nonce || !signature) {
    return { ok: false, reason: 'missing_headers' };
  }

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || !Number.isInteger(timestampMs)) {
    return { ok: false, reason: 'bad_timestamp' };
  }

  const now = opts.now ?? Date.now();
  const maxSkewMs = opts.maxSkewMs ?? DEFAULT_CONNECT_MAX_SKEW_MS;
  if (Math.abs(now - timestampMs) > maxSkewMs) {
    return { ok: false, reason: 'expired' };
  }

  let expected: string;
  try {
    expected = signConnectRequest(secret, method, path, timestampMs, nonce, body);
  } catch {
    // Body canonicalization failed (e.g. exceeds MAX_CANONICALIZE_DEPTH) — reject
    // cleanly rather than letting the RangeError surface as a 500.
    return { ok: false, reason: 'bad_body' };
  }

  if (!signaturesEqual(signature, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  return { ok: true, nonce, timestampMs };
}
