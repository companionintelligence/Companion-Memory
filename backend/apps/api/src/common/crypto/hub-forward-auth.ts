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
 * That signature names no destination. Under a key more than one app's headers are
 * signed with (an older Hub signs every app that has no key of its own with the
 * Hub-wide secret it also gives Memory), another app's copy verifies here just as
 * well. So a Hub that gives Memory a key of its own also sends a bound assertion,
 * `X-CI-Hub-User-Assertion: 2.<nonce>.<signature>`, signed with that key over a
 * message that names this app's URN (the audience) and a nonce no other request
 * carries. See {@link buildForwardAuthAssertionMessage} and {@link verifyHubForwardAuth}.
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
export const FORWARD_AUTH_ASSERTION_HEADER = 'x-ci-hub-user-assertion';
export const FORWARD_AUTH_USER_AID_HEADER = 'x-ci-hub-user-aid';
export const FORWARD_AUTH_HUB_AID_HEADER = 'x-ci-hub-aid';
export const FORWARD_AUTH_KEL_DIGEST_HEADER = 'x-ci-hub-kel-digest';

/** The bound assertion's format version, the first field of its header. */
export const FORWARD_AUTH_ASSERTION_VERSION = '2';

/**
 * Default replay window: reject signatures more than 30 seconds either side of now.
 *
 * The Hub signs on the forward-auth subrequest Traefik makes for this very request, on the
 * same machine and clock, so a legitimate header set is milliseconds old when it lands.
 */
export const DEFAULT_FORWARD_AUTH_MAX_SKEW_MS = 30 * 1000;

/** Prefix of every Hub user-directory issuer. Never a valid OIDC issuer, which is always an https URL. */
export const HUB_ISSUER_PREFIX = 'urn:ci-hub:';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const HUB_ISSUER_PATTERN = new RegExp(`^${HUB_ISSUER_PREFIX}${UUID}$`);
const HUB_USER_ID_PATTERN = new RegExp(`^${UUID}$`);
/** `2.<nonce>.<hex signature>`. The nonce is base64url, so it never holds the separator. */
const ASSERTION_PATTERN = new RegExp(
  `^${FORWARD_AUTH_ASSERTION_VERSION}\\.([A-Za-z0-9_-]{16,128})\\.([0-9a-f]{64})$`,
);

export interface ForwardAuthHeaders {
  user?: string | null;
  timestamp?: string | null;
  signature?: string | null;
  issuer?: string | null;
  userId?: string | null;
  userIdSignature?: string | null;
  /** `2.<nonce>.<signature>`, from a Hub that gave this app a key of its own. */
  assertion?: string | null;
  /** Unsigned: see {@link UnsignedKeriHints}. */
  userAid?: string | null;
  /** Unsigned: see {@link UnsignedKeriHints}. */
  hubAid?: string | null;
  /** Unsigned: see {@link UnsignedKeriHints}. */
  kelDigest?: string | null;
}

/**
 * The KERI identifiers a Hub sends beside a stable id: `X-CI-Hub-User-AID`, `X-CI-Hub-AID` and
 * `X-CI-Hub-KEL-Digest`.
 *
 * ═══ NOTHING HERE IS SIGNED ═══
 *
 * No signature covers these headers: not the stable-id HMAC, not the bound assertion (the Hub's
 * `buildForwardAuthAssertionMessage` signs audience, nonce, timestamp, username, issuer and id,
 * and nothing else). Nor does the Hub's Traefik list them in `authResponseHeaders`, so a
 * visitor's own copy reaches this app untouched. Each is whatever the browser chose to send.
 *
 * An AID is a public identifier, so treating one as an identity would let anyone signed in to
 * the Hub name somebody else's and be signed in as them. They are kept only as hints: format
 * checked, never looked up ahead of the signed (issuer, subject), never bound to an account.
 * Binding a person's AID needs the Hub to sign it first (a new assertion version).
 */
interface UnsignedKeriHints {
  /** The person's KERI AID, `did:keri:<44 base64url characters>`. Unsigned. */
  userAid?: string;
  /** The Hub appliance's KERI AID, same form. Unsigned. */
  hubAid?: string;
  /** Digest of the latest event in the person's KEL, 44 base64url characters. Unsigned. */
  kelDigest?: string;
}

/** A KERI AID as a DID: a 44-character qb64 prefix, nothing else. */
const KERI_AID_DID_PATTERN = /^did:keri:[A-Za-z0-9_-]{44}$/;
/** A 256-bit digest in qb64: 44 base64url characters. */
const KEL_DIGEST_PATTERN = /^[A-Za-z0-9_-]{44}$/;

/** A Hub person's stable identity: the (issuer, subject) pair `ci.federated_identities` binds. */
export interface HubStableId {
  /** `urn:ci-hub:<directory-uuid>` — the Hub user directory that minted the id. */
  issuer: string;
  /** The Hub user's `public_id`: minted once per person, unchanged by any rename, never reused. */
  subject: string;
  /**
   * KERI identifiers sent beside the stable id, only those well-formed. NOT covered by any
   * signature: see {@link UnsignedKeriHints} before reading one.
   */
  unsignedKeri?: UnsignedKeriHints;
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

  return { ok: true, username, stableId: withUnsignedKeriHints({ issuer, subject: userId }, headers) };
}

/**
 * The stable id with whichever KERI hints are well-formed, the rest dropped. They were not part
 * of anything verified above; see {@link UnsignedKeriHints}.
 */
function withUnsignedKeriHints(stableId: HubStableId, headers: ForwardAuthHeaders): HubStableId {
  const hints: UnsignedKeriHints = {};

  if (headers.userAid && KERI_AID_DID_PATTERN.test(headers.userAid)) {
    hints.userAid = headers.userAid;
  }

  if (headers.hubAid && KERI_AID_DID_PATTERN.test(headers.hubAid)) {
    hints.hubAid = headers.hubAid;
  }

  if (headers.kelDigest && KEL_DIGEST_PATTERN.test(headers.kelDigest)) {
    hints.kelDigest = headers.kelDigest;
  }

  return Object.keys(hints).length > 0 ? { ...stableId, unsignedKeri: hints } : stableId;
}

/**
 * Canonical message of the bound assertion. Keep in lock-step with the signer.
 *
 * The audience is the app URN the Hub resolved the request's host to (`ci-memory:ci-marketplace`
 * for Companion Memory), so an assertion signed for another app never verifies here even under a
 * shared key. The nonce is fresh per forward-auth call, so two requests never share an assertion,
 * not even two in the same millisecond. The stable id rides inside it (empty fields when the Hub
 * sent none), so the id's own signature is not needed on this path.
 */
export function buildForwardAuthAssertionMessage(
  audience: string,
  nonce: string,
  timestampMs: number,
  username: string,
  issuer: string | null,
  userId: string | null,
): string {
  return `ci-hub-forward-auth/${FORWARD_AUTH_ASSERTION_VERSION}\n${audience}\n${nonce}\n${timestampMs}\n${username}\n${issuer ?? ''}\n${userId ?? ''}`;
}

/** Compute the lowercase-hex HMAC-SHA256 signature of a bound assertion. */
export function signForwardAuthAssertion(
  secret: string,
  audience: string,
  nonce: string,
  timestampMs: number,
  username: string,
  issuer: string | null = null,
  userId: string | null = null,
): string {
  return createHmac('sha256', secret)
    .update(buildForwardAuthAssertionMessage(audience, nonce, timestampMs, username, issuer, userId))
    .digest('hex');
}

/** The `X-CI-Hub-User-Assertion` header value for a nonce and signature. */
export function formatForwardAuthAssertion(nonce: string, signature: string): string {
  return `${FORWARD_AUTH_ASSERTION_VERSION}.${nonce}.${signature}`;
}

/** What {@link verifyHubForwardAuth} checks a request against; build it with {@link forwardAuthPolicy}. */
export interface ForwardAuthPolicy {
  /** `CI_HUB_FORWARD_AUTH_SECRET`, the Hub-wide secret. Verifies the unbound format. */
  sharedSecret: string;
  /** This app's own key and URN, both provisioned by the Hub; null from a Hub that gave neither. */
  bound: { secret: string; audience: string } | null;
  /** Whether a header set without a bound assertion is accepted, checked against `sharedSecret`. */
  acceptUnbound: boolean;
  maxSkewMs: number;
}

/** `auto` follows the Hub: an assertion is required once the Hub has given this app its own key. */
export type RequireAudienceSetting = 'auto' | 'true' | 'false';

/**
 * The verification policy for an `auth.hubForwardAuth` config block.
 *
 * - A Hub that predates bound assertions gives Memory only its Hub-wide secret, and signs every
 *   app that has no key of its own with that secret too. Its headers are the only ones such a Hub
 *   sends, so refusing them would end Hub sign-in to Memory: `auto` accepts them.
 * - A Hub that gives Memory `identitySecret` and `audience` (its app URN) signs Memory's requests
 *   with a bound assertion under that key, and signs no other app with the Hub-wide secret. From
 *   then on the unbound format proves nothing a bound assertion doesn't, and is the one shape a
 *   copy from elsewhere could take: `auto` refuses it.
 * - `true` refuses the unbound format even from an older Hub (no Hub sign-in to Memory until the
 *   Hub is updated). `false` accepts it beside the bound one, for a Hub whose Traefik does not
 *   pass the assertion header through.
 */
export function forwardAuthPolicy(cfg: {
  secret: string;
  identitySecret?: string | null;
  audience?: string | null;
  requireAudience?: RequireAudienceSetting | null;
  maxSkewMs: number;
}): ForwardAuthPolicy {
  const identitySecret = (cfg.identitySecret ?? '').trim();
  const audience = (cfg.audience ?? '').trim();
  const bound = identitySecret && audience ? { secret: identitySecret, audience } : null;
  const setting = cfg.requireAudience ?? 'auto';
  const acceptUnbound = setting === 'auto' ? bound == null : setting === 'false';

  return { sharedSecret: cfg.secret, bound, acceptUnbound, maxSkewMs: cfg.maxSkewMs };
}

/** A verified Hub person, and what names this one header set for the paths that may use it once. */
export interface VerifiedHubForwardAuth {
  username: string;
  stableId: HubStableId | null;
  /** True when it came with an assertion bound to this app; false for the unbound format. */
  bound: boolean;
  /**
   * Names this one signing, for the paths that may use it once: the bound assertion's nonce.
   *
   * Null for the unbound format, which has nothing that tells one signing from another: two
   * requests for the same person in the same millisecond carry the same signature, so treating it
   * as single-use would refuse the second of two tabs opened together. It would buy nothing either,
   * since a Hub that sends only this format hands fresh copies of it to other apps.
   */
  replayKey: string | null;
  /** When this header set stops verifying anyway (its timestamp plus the skew), in ms. */
  expiresAt: number;
}

export type HubForwardAuthFailure =
  Extract<ForwardAuthVerifyResult, { ok: false }>['reason'] | 'bad_assertion' | 'unbound';

export type HubForwardAuthResult =
  ({ ok: true } & VerifiedHubForwardAuth) | { ok: false; reason: HubForwardAuthFailure };

function verifyBoundAssertion(
  bound: { secret: string; audience: string },
  headers: ForwardAuthHeaders,
  now: number,
  maxSkewMs: number,
): HubForwardAuthResult {
  const { user: username, timestamp: timestampRaw, assertion } = headers;
  if (!username || !timestampRaw || !assertion) {
    return { ok: false, reason: 'missing_headers' };
  }

  const timestampMs = Number(timestampRaw);
  if (!Number.isFinite(timestampMs) || !Number.isInteger(timestampMs)) {
    return { ok: false, reason: 'bad_timestamp' };
  }

  if (Math.abs(now - timestampMs) > maxSkewMs) {
    return { ok: false, reason: 'expired' };
  }

  const parsed = ASSERTION_PATTERN.exec(assertion);
  if (!parsed) {
    return { ok: false, reason: 'bad_assertion' };
  }

  const [, nonce, signature] = parsed;

  // Optional, never half-present, and well-formed: the same rule as the unbound format's id.
  const issuer = headers.issuer || null;
  const userId = headers.userId || null;
  if (
    (issuer == null) !== (userId == null) ||
    (issuer != null && !HUB_ISSUER_PATTERN.test(issuer)) ||
    (userId != null && !HUB_USER_ID_PATTERN.test(userId))
  ) {
    return { ok: false, reason: 'bad_stable_id' };
  }

  const expected = signForwardAuthAssertion(
    bound.secret,
    bound.audience,
    nonce,
    timestampMs,
    username,
    issuer,
    userId,
  );
  if (!signaturesEqual(signature, expected)) {
    // An assertion for another app (another audience) lands here too: it is a different message.
    return { ok: false, reason: 'bad_signature' };
  }

  return {
    ok: true,
    username,
    stableId: issuer && userId ? withUnsignedKeriHints({ issuer, subject: userId }, headers) : null,
    bound: true,
    replayKey: nonce,
    expiresAt: timestampMs + maxSkewMs,
  };
}

/**
 * Verify a request's Hub identity under {@link forwardAuthPolicy}.
 *
 * With a key of its own, a request carrying an assertion is judged by it alone: a wrong one is
 * refused rather than retried as the unbound format, because nothing the Hub sends this app fails
 * it. Without an assertion (or without a key to check one), the unbound format decides, when the
 * policy accepts it.
 */
export function verifyHubForwardAuth(
  policy: ForwardAuthPolicy,
  headers: ForwardAuthHeaders,
  opts: { now?: number } = {},
): HubForwardAuthResult {
  const now = opts.now ?? Date.now();

  if (policy.bound && headers.assertion) {
    return verifyBoundAssertion(policy.bound, headers, now, policy.maxSkewMs);
  }

  if (!policy.acceptUnbound) {
    return { ok: false, reason: 'unbound' };
  }

  const result = verifyForwardAuthHeaders(policy.sharedSecret, headers, { now, maxSkewMs: policy.maxSkewMs });
  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    username: result.username,
    stableId: result.stableId,
    bound: false,
    replayKey: null,
    expiresAt: Number(headers.timestamp) + policy.maxSkewMs,
  };
}

/** The forward-auth headers of an incoming request, first value of each. */
export function readForwardAuthHeaders(
  headers: Record<string, string | string[] | undefined>,
): ForwardAuthHeaders {
  const value = (name: string): string | null => {
    const raw = headers[name];

    return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
  };

  return {
    user: value(FORWARD_AUTH_USER_HEADER),
    timestamp: value(FORWARD_AUTH_TIMESTAMP_HEADER),
    signature: value(FORWARD_AUTH_SIGNATURE_HEADER),
    issuer: value(FORWARD_AUTH_USER_ISSUER_HEADER),
    userId: value(FORWARD_AUTH_USER_ID_HEADER),
    userIdSignature: value(FORWARD_AUTH_USER_ID_SIGNATURE_HEADER),
    assertion: value(FORWARD_AUTH_ASSERTION_HEADER),
    userAid: value(FORWARD_AUTH_USER_AID_HEADER),
    hubAid: value(FORWARD_AUTH_HUB_AID_HEADER),
    kelDigest: value(FORWARD_AUTH_KEL_DIGEST_HEADER),
  };
}
