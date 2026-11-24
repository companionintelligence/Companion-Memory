import { didOf, fragmentOf, isDid } from './did';
import { type DidResolver, keyForKid } from './didDocument';
import { DidcommError } from './errors';
import { createCompactJws, parseCompactJws, verifyCompactJws } from './jws';
import { nowSeconds } from './message';
import { type SecretsResolver } from './secrets';

/**
 * DID rotation (DIDComm Messaging v2.1, "DID Rotation"): how a party moves a relationship from one
 * DID to another, which is how a relationship that began on a public or temporary DID (a
 * `did:key` in a QR code, say) ends up on a private pairwise `did:peer`.
 *
 * The first message from the new DID carries `from_prior`, a JWT signed by a key the *prior* DID
 * authorizes, saying `iss` (prior DID) hands the relationship to `sub` (new DID). It is evidence of
 * rotation, not a credential: it carries no audience binding, and the temporal claims (`exp`,
 * `nbf`, `aud`, `jti`) are returned to the caller and not enforced, because the specification
 * defines none for it and the reference implementation's own vectors carry long-expired ones. What
 * the caller must do with a verified rotation is its own decision: only a recipient that already
 * trusts `iss` has any reason to start trusting `sub`.
 *
 * Ending a relationship is a rotation to nothing: a JWT without `sub`, on a message without `from`.
 */

export interface VerifiedFromPrior {
  /** The prior DID. */
  issuer: string;
  /** The new DID, or `undefined` when the relationship is being ended. */
  subject?: string;
  issuedAt: number;
  /** The prior DID's key that signed. */
  kid: string;
  /** All claims, as received. */
  claims: Record<string, unknown>;
}

/** Builds the `from_prior` JWT. `issuerKid` must be one of the prior DID's `authentication` keys, held in `secrets`. */
export async function createFromPrior(input: {
  /** The new DID. Omit to end the relationship. */
  subject?: string;
  issuerKid: string;
  secrets: SecretsResolver;
  now?: number;
}): Promise<string> {
  const issuer = didOf(input.issuerKid);

  if (fragmentOf(input.issuerKid) === undefined) {
    throw new DidcommError('invalid-argument', 'issuerKid must be a DID URL naming a key');
  }

  if (input.subject !== undefined && (!isDid(input.subject) || input.subject === issuer)) {
    throw new DidcommError('invalid-argument', 'the new DID must be a DID different from the prior one');
  }

  const secret = await input.secrets.getSecret(input.issuerKid);

  if (!secret) {
    throw new DidcommError('secret-not-found', `no secret for ${input.issuerKid}`);
  }

  return createCompactJws(
    { typ: 'JWT', kid: input.issuerKid },
    {
      iss: issuer,
      ...(input.subject !== undefined ? { sub: input.subject } : {}),
      iat: input.now ?? nowSeconds(),
    },
    secret,
  );
}

export async function verifyFromPrior(
  token: string,
  options: { resolver: DidResolver },
): Promise<VerifiedFromPrior> {
  const parsed = parseCompactJws(token);
  const { iss, sub, iat } = parsed.payload;
  const kid = parsed.header.kid;

  if (!isDid(iss)) {
    throw new DidcommError('malformed-message', 'from_prior "iss" must be a DID without a fragment');
  }

  if (sub !== undefined && (!isDid(sub) || sub === iss)) {
    throw new DidcommError('malformed-message', 'from_prior "sub" must be a DID different from "iss"');
  }

  if (typeof iat !== 'number' || !Number.isSafeInteger(iat) || iat < 0) {
    throw new DidcommError('malformed-message', 'from_prior "iat" must be the rotation time in seconds');
  }

  if (typeof kid !== 'string' || fragmentOf(kid) === undefined || didOf(kid) !== iss) {
    throw new DidcommError('malformed-message', 'from_prior "kid" must name a key of the prior DID');
  }

  const document = await options.resolver.resolve(iss);
  const key = keyForKid(document, kid, 'authentication');

  if (!verifyCompactJws(parsed, key.jwk)) {
    throw new DidcommError('signature-invalid', 'from_prior signature does not verify');
  }

  return { issuer: iss, subject: sub as string | undefined, issuedAt: iat, kid, claims: parsed.payload };
}
