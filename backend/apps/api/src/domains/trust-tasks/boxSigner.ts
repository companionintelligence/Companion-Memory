import { createPrivateKey, createPublicKey, type webcrypto } from 'node:crypto';

import { base64urlDecode } from './crypto/multibase';
import { isJsonObject } from './document';
import type { DocumentSigner } from './producer';
import { sovereignVerificationMethodId, sovereignVidFor } from './vid';

/**
 * This box's signer: the Ed25519 key it already holds for RFC 9421 peer signatures
 * (`peers.signingKeyJwk`), read once and used for Trust Task proofs.
 *
 * One key, two doors. The box's Trust Task VID is the self-certifying `did:keri:D<x>` of that key, so
 * the identity a peer links this box by (the AID) is the same identity that signs its Trust Task
 * responses. It is derived from the key itself rather than from the key's `kid`: `PeerSignatureService`
 * only advertises an AID when `kid` happens to spell it out, but a self-certifying identifier does not
 * depend on a label.
 *
 * Returns null — never throws — for an absent or unusable key, so a misconfigured box has a closed
 * Trust Tasks surface rather than a crashed boot. A JWK whose public half does not match its private
 * half is refused: it would sign under an identifier its own key does not control.
 */
export function signerFromJwk(raw: unknown): DocumentSigner | null {
  try {
    const parsed: unknown = typeof raw === 'string' ? (raw.trim() === '' ? undefined : JSON.parse(raw)) : raw;
    if (!isJsonObject(parsed) || parsed.kty !== 'OKP' || parsed.crv !== 'Ed25519') {
      return null;
    }

    if (typeof parsed.d !== 'string' || typeof parsed.x !== 'string') {
      return null;
    }

    const privateKey = createPrivateKey({ key: parsed as webcrypto.JsonWebKey, format: 'jwk' });
    const derived = createPublicKey(privateKey).export({ format: 'jwk' });
    const publicKey = base64urlDecode(parsed.x);
    if (derived.x !== parsed.x || publicKey == null || publicKey.length !== 32) {
      return null;
    }

    const vid = sovereignVidFor(publicKey);

    return { vid, verificationMethod: sovereignVerificationMethodId(vid), privateKey };
  } catch {
    return null;
  }
}
