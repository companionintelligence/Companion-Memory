import {
  createHash,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

/**
 * RFC 9421 HTTP Message Signatures, profiled for the peer-ask surface — plus
 * the RFC 9530 `Content-Digest` that binds a signature to a body.
 *
 * ═══ WHY THE BEARER TOKEN IS NOT ENOUGH ═══
 *
 * `/agent/v1/ask` authenticates a peer with a CI-Portal OIDC bearer token whose
 * audience is this box, and `peer_links` is keyed on the `(issuer, subject)`
 * that token asserts. Three things follow, and all three are properties of
 * bearer tokens rather than of our implementation:
 *
 *   1. A LEAKED TOKEN IS A COMPLETE IMPERSONATION for its whole lifetime.
 *      Nothing binds the token to the request it arrived on, so anyone holding
 *      the bytes can ask anything the peer could ask.
 *   2. NOTHING BINDS THE TOKEN TO THE BODY. A proxy, a log shipper, or anything
 *      else on the path can rewrite the question between the peer and this box
 *      and the token still verifies.
 *   3. REPLAY IS UNDETECTABLE. The same request can be delivered a thousand
 *      times; only the `askId` idempotency key limits the damage, and it limits
 *      it per-key, not per-request.
 *
 * UMA-for-agents makes retiring bearer RPTs its recommendation #4 for exactly
 * this, and its answer is the one here: the request is SIGNED by the key that
 * is the peer's identity, over a base that covers the method, the target and a
 * digest of the body, with a nonce and a validity window.
 *
 * ═══ WHAT IS DELIBERATELY NOT HERE ═══
 *
 * A general structured-fields (RFC 8941) parser. This module accepts exactly
 * the profile below and rejects everything else, which is the safe direction at
 * a boundary that a peer controls: an unrecognized parameter is a refusal, not
 * something to skip past. A permissive parser at this position is how a
 * signature that covers less than it appears to gets accepted.
 *
 * Every function here is PURE — no clock, no config, no database, no cache. The
 * clock-dependent and replay-dependent half lives in `PeerSignatureService`,
 * which is what makes the arithmetic below unit-testable without one.
 *
 * CI-Server #1711 -> epic #1712.
 */

/** The only algorithm this profile accepts. */
export const PEER_SIGNATURE_ALG = 'ed25519';

/** The signature label this box emits. Any label is accepted on the way in. */
export const PEER_SIGNATURE_LABEL = 'ci';

/**
 * The components a peer-ask signature MUST cover.
 *
 * `@method` and `@target-uri` stop a signature captured on one route from being
 * replayed onto another — the collect route (`GET /ask/:correlation`) and the
 * ask route (`POST /ask`) are different authorizations and must not share one.
 * `content-digest` is what binds the signature to the QUESTION; without it a
 * signature is a token again, just a more expensive one.
 */
export const REQUIRED_COMPONENTS = ['@method', '@target-uri'] as const;

/** Additionally required whenever the request carries a body. */
export const BODY_COMPONENT = 'content-digest';

/** Parsed `Signature-Input` parameters for one label. */
export interface SignatureParams {
  /** Covered component identifiers, in the order they were signed. */
  components: string[];
  /** Unix seconds. */
  created: number;
  /** Unix seconds. */
  expires: number;
  /** RFC 7638 JWK thumbprint of the signing key. */
  keyid: string;
  alg: string;
  nonce: string;
}

/** A parsed signature: the params, the raw bytes, and the label they arrived under. */
export interface ParsedSignature {
  label: string;
  params: SignatureParams;
  signature: Buffer;
  /** The exact `Signature-Input` value for this label, needed to rebuild the base. */
  rawParams: string;
}

export class SignatureFormatError extends Error {
  constructor(readonly reason: string) {
    super(`malformed signature: ${reason}`);
    this.name = 'SignatureFormatError';
  }
}

/**
 * RFC 9530 `Content-Digest` for a body: `sha-256=:<base64>:`.
 *
 * SHA-256 only, and the algorithm is not negotiable by the sender — letting a
 * peer choose it means letting a peer choose a weak one.
 */
export function contentDigest(body: string): string {
  const hash = createHash('sha256').update(body, 'utf8').digest('base64');

  return `sha-256=:${hash}:`;
}

/**
 * Whether `header` is a Content-Digest matching `body`.
 *
 * Compares the whole formatted value rather than picking the base64 out, so a
 * header naming a DIFFERENT algorithm can never match: `sha-512=:...:` fails
 * against a `sha-256=:...:` expectation instead of being silently accepted on
 * the strength of some other digest the sender preferred.
 */
export function verifyContentDigest(header: string | undefined, body: string): boolean {
  if (!header) {
    return false;
  }

  return timingSafeStringEqual(header.trim(), contentDigest(body));
}

/**
 * The RFC 9421 signature base: one `"name": value` line per covered component,
 * then `"@signature-params"` carrying the inner list and its parameters, with
 * NO trailing newline.
 *
 * `rawParams` is passed through byte-for-byte rather than re-serialized from
 * the parsed struct. That is load-bearing: the verifier must sign over exactly
 * what the sender signed over, and any normalization here (reordering
 * parameters, re-quoting, dropping an unknown one) would produce a base that
 * differs from the sender's and fail every honest signature while a hostile
 * sender simply matches whatever we produce.
 */
export function buildSignatureBase(params: {
  components: readonly string[];
  method: string;
  targetUri: string;
  contentDigestHeader?: string;
  rawParams: string;
}): string {
  const lines = params.components.map((component) => {
    switch (component) {
      case '@method':
        return `"@method": ${params.method.toUpperCase()}`;
      case '@target-uri':
        return `"@target-uri": ${params.targetUri}`;
      case BODY_COMPONENT:
        if (!params.contentDigestHeader) {
          throw new SignatureFormatError('content-digest is covered but absent');
        }

        return `"content-digest": ${params.contentDigestHeader.trim()}`;
      default:
        // An unknown covered component cannot be reconstructed, so it cannot be
        // verified. Refusing is the only safe answer: skipping it would verify
        // a signature over a base the sender never produced.
        throw new SignatureFormatError(`unsupported covered component: ${component}`);
    }
  });

  lines.push(`"@signature-params": ${params.rawParams}`);

  return lines.join('\n');
}

/** Serialize the `Signature-Input` value this box emits. */
export function formatSignatureParams(params: SignatureParams): string {
  const inner = params.components.map((c) => `"${c}"`).join(' ');

  return (
    `(${inner});created=${params.created};expires=${params.expires};` +
    `keyid="${params.keyid}";alg="${params.alg}";nonce="${params.nonce}"`
  );
}

/** Exactly the parameters this profile understands. Anything else is a refusal. */
const KNOWN_PARAMS: ReadonlySet<string> = new Set(['created', 'expires', 'keyid', 'alg', 'nonce']);

const LABEL_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const KEYID_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;

/**
 * Parse the `Signature-Input` and `Signature` header pair.
 *
 * EXACTLY ONE LABEL is accepted. A request carrying two signatures forces a
 * choice about which one authorizes it, and every answer to that is a
 * vulnerability: taking the first lets a sender prepend a weak one, taking the
 * strongest means ranking them, and taking all of them means a request is
 * authorized by the union of two keys' permissions.
 */
export function parseSignatureHeaders(
  signatureInput: string | undefined,
  signature: string | undefined,
): ParsedSignature {
  if (!signatureInput || !signature) {
    throw new SignatureFormatError('missing Signature or Signature-Input');
  }

  const inputMatch = /^([A-Za-z0-9_-]+)=(\(.*)$/.exec(signatureInput.trim());
  if (!inputMatch) {
    throw new SignatureFormatError('unparseable Signature-Input');
  }

  const [, label, rawParams] = inputMatch;
  if (!LABEL_PATTERN.test(label)) {
    throw new SignatureFormatError('bad label');
  }

  const sigMatch = new RegExp(`^${escapeRegExp(label)}=:([A-Za-z0-9+/=]+):$`).exec(signature.trim());
  if (!sigMatch) {
    // Also the "two labels" case: the Signature header must name the SAME single
    // label, so a second one cannot be smuggled in on either header.
    throw new SignatureFormatError('unparseable Signature, or label mismatch');
  }

  return {
    label,
    params: parseParams(rawParams),
    signature: Buffer.from(sigMatch[1], 'base64'),
    rawParams,
  };
}

function parseParams(raw: string): SignatureParams {
  const listMatch = /^\(([^)]*)\)(.*)$/.exec(raw);
  if (!listMatch) {
    throw new SignatureFormatError('unparseable covered component list');
  }

  const [, innerList, tail] = listMatch;

  const components =
    innerList.length === 0
      ? []
      : innerList.split(' ').map((item) => {
          const quoted = /^"([^"]+)"$/.exec(item);
          if (!quoted) {
            throw new SignatureFormatError('covered components must be quoted');
          }

          return quoted[1];
        });

  if (new Set(components).size !== components.length) {
    // A repeated component means two lines in the base for one value, which a
    // sender can use to make the base ambiguous.
    throw new SignatureFormatError('duplicate covered component');
  }

  const params = new Map<string, string>();
  // Deliberately anchored and exhaustive: the tail must be entirely made of
  // recognized `;key=value` pairs, so an unknown parameter is a refusal rather
  // than something skipped over.
  const PARAM = /;([a-z]+)=("[^"]*"|\d+)/g;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = PARAM.exec(tail)) != null) {
    if (match.index !== consumed) {
      throw new SignatureFormatError('unparseable signature parameters');
    }

    consumed = PARAM.lastIndex;

    const [, key, value] = match;
    if (!KNOWN_PARAMS.has(key)) {
      // An unknown parameter is REFUSED, not stored and ignored. RFC 9421
      // parameters change what a signature means (`tag`, for one, scopes it to
      // an application), so silently dropping one accepts a signature the
      // sender scoped to something else entirely.
      throw new SignatureFormatError(`unsupported signature parameter: ${key}`);
    }

    if (params.has(key)) {
      throw new SignatureFormatError(`duplicate parameter: ${key}`);
    }

    params.set(key, value.startsWith('"') ? value.slice(1, -1) : value);
  }

  if (consumed !== tail.length) {
    throw new SignatureFormatError('trailing junk in signature parameters');
  }

  const created = integerParam(params, 'created');
  const expires = integerParam(params, 'expires');
  const keyid = params.get('keyid') ?? '';
  const alg = params.get('alg') ?? '';
  const nonce = params.get('nonce') ?? '';

  if (!KEYID_PATTERN.test(keyid)) {
    throw new SignatureFormatError('bad keyid');
  }

  if (alg !== PEER_SIGNATURE_ALG) {
    throw new SignatureFormatError(`unsupported alg: ${alg}`);
  }

  if (!NONCE_PATTERN.test(nonce)) {
    // A nonce is REQUIRED, not optional: it is the whole of the replay
    // defence that the validity window alone cannot provide.
    throw new SignatureFormatError('missing or bad nonce');
  }

  if (expires <= created) {
    throw new SignatureFormatError('expires must be after created');
  }

  return { components, created, expires, keyid, alg, nonce };
}

function integerParam(params: Map<string, string>, key: string): number {
  const raw = params.get(key);
  if (raw == null || !/^\d+$/.test(raw)) {
    throw new SignatureFormatError(`missing or non-integer ${key}`);
  }

  return Number(raw);
}

/**
 * Whether the covered set is sufficient for this request.
 *
 * `hasBody` decides whether `content-digest` is required, and it is derived
 * from the REQUEST rather than from the signature: a sender must not be able to
 * drop the body binding by declining to cover it.
 */
export function coversRequiredComponents(components: readonly string[], hasBody: boolean): boolean {
  const covered = new Set(components);

  return (
    REQUIRED_COMPONENTS.every((component) => covered.has(component)) &&
    (!hasBody || covered.has(BODY_COMPONENT))
  );
}

/** Verify an Ed25519 signature over `base`. Returns false rather than throwing. */
export function verifySignatureBase(base: string, signature: Buffer, publicKey: KeyObject): boolean {
  try {
    return cryptoVerify(null, Buffer.from(base, 'utf8'), publicKey, signature);
  } catch {
    return false;
  }
}

/** Sign a base with an Ed25519 private key. */
export function signSignatureBase(base: string, privateKey: KeyObject): Buffer {
  return cryptoSign(null, Buffer.from(base, 'utf8'), privateKey);
}

/**
 * RFC 7638 JWK thumbprint of an OKP/Ed25519 public key, base64url SHA-256.
 *
 * Hand-rolled rather than pulled from `jose` because the required-members set
 * for OKP is exactly `crv`, `kty`, `x`, in lexicographic order, with no
 * whitespace — three keys, and the correctness of the ordering is the whole
 * algorithm. Rejecting any other key type here is deliberate: this profile is
 * Ed25519-only, and a thumbprint computed over a key we would never verify with
 * is an identifier for a key that cannot be used.
 */
export function jwkThumbprint(jwk: {
  kty?: unknown;
  crv?: unknown;
  x?: unknown;
  [key: string]: unknown;
}): string {
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || jwk.x.length === 0) {
    throw new SignatureFormatError('not an Ed25519 public JWK');
  }

  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });

  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

/** Build a verifying KeyObject from a public JWK, or null when it is unusable. */
export function publicKeyFromJwk(jwk: unknown): KeyObject | null {
  try {
    const candidate = jwk as { kty?: unknown; crv?: unknown; x?: unknown; d?: unknown };

    // A JWK carrying `d` is a PRIVATE key. Accepting one here would mean a peer
    // link could store a private key and this box would happily "verify" with
    // it — never a thing we want to have persisted, so it is refused at the
    // door rather than stripped.
    if (candidate.d != null) {
      return null;
    }

    jwkThumbprint(candidate);

    return createPublicKey({ key: candidate as never, format: 'jwk' });
  } catch {
    return null;
  }
}

/** Constant-time-ish string compare, so a digest check cannot be walked byte by byte. */
function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return diff === 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
