/**
 * Authentication: turns the `Authorization` / `Capability-Invocation` / `Digest` headers of a
 * request into a verified *signature layer* result, and nothing more.
 *
 * What "verified" means here is only what can be decided from the request and the clock: the
 * HTTP signature is well formed, covers what the profile requires, is inside its time window,
 * verifies against a key that the signer's DID document lists for `capabilityInvocation` today,
 * and the body matches its signed `Digest`. Whether the invoked *capability* authorizes the
 * request depends on server state (the Space's controller) and is decided later, in `access.ts`.
 *
 * Every failure here describes the request, so it is a precise `invalid-authorization-header`
 * (400). None of them depends on whether any target exists. A request with neither header is
 * anonymous, which is not an error: a policy may still let it read.
 */
import { verifyDigestHeader } from './digest';
import { verifyEd25519 } from './ed25519';
import {
  HttpSignatureError,
  buildSigningString,
  checkSignatureWindow,
  parseAuthorizationSignature,
} from './httpSignature';
import { didOf } from './keys';
import type { DidRegistry } from './keys';
import { PwsError } from './problems';
import type { PwsUrls } from './routes';
import { ZcapError, parseCapabilityInvocation } from './zcap';
import type { ParsedCapabilityInvocation } from './zcap';

/** A request after the adapter has normalized it: lowercase header names, a concrete body. */
export interface NormalizedRequest {
  /** Upper-case. */
  method: string;
  /** Absolute URL, as the server believes it was addressed (origin from configuration). */
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export type Authn =
  | { kind: 'anonymous' }
  | {
      kind: 'signed';
      /** The DID behind the signing key, and the key's own DID URL. */
      invoker: { did: string; keyId: string };
      parsed: ParsedCapabilityInvocation;
      /** The signature's `created`, in seconds. */
      created: number;
    };

export interface AuthnEnv {
  urls: PwsUrls;
  keys: DidRegistry;
  now: Date;
  skewSeconds: number;
  /** Longest `expires - created` accepted: it bounds how long a captured request can be replayed. */
  maxSignatureLifetimeSeconds: number;
}

/** Headers the signature must cover (draft-cavage-12 plus the `(key-id)` pseudo-header). */
const REQUIRED_COVERED = [
  '(key-id)',
  '(created)',
  '(expires)',
  '(request-target)',
  'host',
  'capability-invocation',
];

/**
 * What a `401` offers (RFC 9110 §15.5.2 requires a challenge): the scheme, and the headers every
 * signature must cover. A request that carries a body must also cover `content-type` and `digest`.
 */
export const SIGNATURE_CHALLENGE = `Signature realm="Portable Web Spaces",headers="${REQUIRED_COVERED.join(' ')}"`;

function bad(detail: string): PwsError {
  return new PwsError('invalid-authorization-header', detail);
}

export async function authenticate(req: NormalizedRequest, env: AuthnEnv): Promise<Authn> {
  const authorization = req.headers.authorization;
  const invocation = req.headers['capability-invocation'];
  if (authorization === undefined && invocation === undefined) {
    return { kind: 'anonymous' };
  }

  if (authorization === undefined) {
    throw bad('A Capability-Invocation header requires an Authorization header.');
  }

  if (invocation === undefined) {
    throw bad('An Authorization header requires a Capability-Invocation header.');
  }

  let parsed;
  try {
    parsed = parseAuthorizationSignature(authorization);
  } catch (error) {
    throw bad(error instanceof HttpSignatureError ? error.message : 'The Authorization header is malformed.');
  }

  const hasContentType = req.headers['content-type'] !== undefined;
  const required = hasContentType ? [...REQUIRED_COVERED, 'content-type', 'digest'] : REQUIRED_COVERED;
  for (const header of required) {
    if (!parsed.headers.includes(header)) {
      throw bad(`The signature must cover the "${header}" header.`);
    }
  }

  if (parsed.created === undefined || parsed.expires === undefined) {
    throw bad('The signature must carry "created" and "expires".');
  }

  if (parsed.expires - parsed.created > env.maxSignatureLifetimeSeconds || parsed.expires < parsed.created) {
    throw bad('The signature lifetime is not acceptable.');
  }

  if (req.headers.host !== env.urls.host) {
    throw bad('The Host header does not name this server.');
  }

  try {
    checkSignatureWindow(parsed, Math.floor(env.now.getTime() / 1000), env.skewSeconds);
  } catch (error) {
    throw bad(error instanceof HttpSignatureError ? error.message : 'The signature is not currently valid.');
  }

  if (hasContentType) {
    const digest = req.headers.digest;
    if (digest === undefined || !verifyDigestHeader(digest, req.body)) {
      throw bad('The Digest header is missing, malformed or does not match the request body.');
    }
  }

  const key = await env.keys.resolveKey(parsed.keyId, 'capabilityInvocation');
  if (!key) {
    throw bad('The signing key does not resolve for capability invocation.');
  }

  let signingString: string;
  try {
    signingString = buildSigningString({
      headers: parsed.headers,
      keyId: parsed.keyId,
      created: parsed.created,
      expires: parsed.expires,
      method: req.method,
      url: req.url,
      requestHeaders: req.headers,
    });
  } catch (error) {
    throw bad(error instanceof HttpSignatureError ? error.message : 'The signing string cannot be built.');
  }

  if (!verifyEd25519(key.publicKey, new TextEncoder().encode(signingString), parsed.signature)) {
    throw bad('The HTTP signature does not verify.');
  }

  let capability: ParsedCapabilityInvocation;
  try {
    capability = parseCapabilityInvocation(invocation);
  } catch (error) {
    throw bad(error instanceof ZcapError ? error.message : 'The Capability-Invocation header is malformed.');
  }

  // The signature covers the header, so the action is as the invoker meant it. It must be the
  // method; a HEAD may also be invoked as the GET it is authorized as.
  const acceptable = req.method === 'HEAD' ? ['HEAD', 'GET'] : [req.method];
  if (!acceptable.includes(capability.action)) {
    throw bad('The invoked action does not match the request method.');
  }

  return {
    kind: 'signed',
    invoker: { did: didOf(parsed.keyId), keyId: parsed.keyId },
    parsed: capability,
    created: parsed.created,
  };
}
