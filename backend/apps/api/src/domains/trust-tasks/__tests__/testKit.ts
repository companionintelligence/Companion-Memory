import { generateKeyPairSync, type KeyObject } from 'node:crypto';

import { z } from 'zod/v3';

import { createEddsaJcs2022Proof } from '../crypto/dataIntegrity';
import type { JsonObject, TrustTaskDocument } from '../document';
import type { ClaimStore } from '../duplicateGuard';
import { isoSeconds, type DocumentSigner } from '../producer';
import type { TaskSpecification } from '../specs';
import { sovereignVerificationMethodId, sovereignVidFor } from '../vid';

/** Shared fixtures for the Trust Tasks specs. Nothing here is production code. */

export interface Party extends DocumentSigner {
  readonly publicKey: Uint8Array;
}

/** A fresh party with a self-certifying `did:keri:D<x>` VID. */
export function newParty(): Party {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = new Uint8Array(Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url'));
  const vid = sovereignVidFor(raw);

  return { vid, verificationMethod: sovereignVerificationMethodId(vid), privateKey, publicKey: raw };
}

export const T0 = Date.parse('2026-11-05T12:00:00Z');

export const ECHO_TYPE = 'https://example.com/trust-tasks/spec/test/echo/0.1';

/** A consequential, proof-required, recipient-required specification the pipeline can be exercised with. */
export function echoSpec(overrides: Partial<TaskSpecification> = {}): TaskSpecification {
  return {
    typeUri: ECHO_TYPE,
    slug: 'test/echo',
    version: '0.1',
    title: 'Echo',
    targetFrameworkVersion: '0.7.0',
    status: 'draft',
    parties: { issuer: 'REQUIRED', recipient: 'REQUIRED' },
    bearer: false,
    proof: { request: 'REQUIRED', response: 'REQUIRED' },
    issuedAt: 'REQUIRED',
    sideEffects: { level: 'mutating', rationale: 'test' },
    exposure: { discloses: 'none', ingests: 'none', actsAsSubject: false, rationale: 'test' },
    retention: { class: 'exchange', rationale: 'test' },
    repeatSafe: false,
    outcome: 'test',
    freeText: [],
    maxDocumentBytes: 4096,
    request: z.object({ message: z.string().max(100) }).strict(),
    response: z.object({ echoed: z.string() }).strict(),
    ...overrides,
  };
}

/** A map-backed `claimOnce` that honours expiry, for the duplicate guard. */
export function memoryClaimStore(): ClaimStore & { readonly claims: Map<string, number> } {
  const claims = new Map<string, number>();

  return {
    claims,
    async claimOnce({ key, now, expiresAtMs }) {
      const existing = claims.get(key);
      if (existing !== undefined && existing > now) {
        return false;
      }

      claims.set(key, expiresAtMs);

      return true;
    },
  };
}

export interface Draft {
  from: Party;
  to: string;
  type?: string;
  payload?: JsonObject;
  at?: number;
  /** Members merged over the document before it is signed. */
  extra?: JsonObject;
  id?: string;
}

/** An unsigned document from `from` to `to`. */
export function draft(input: Draft): TrustTaskDocument {
  return {
    id: input.id ?? `urn:uuid:${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`,
    type: input.type ?? ECHO_TYPE,
    issuer: input.from.vid,
    recipient: input.to,
    issuedAt: isoSeconds(input.at ?? T0),
    payload: input.payload ?? { message: 'hello' },
    ...input.extra,
  };
}

/** A document signed by `signer` (which need not be `from`, to build forgeries). */
export function sign(
  unsigned: TrustTaskDocument,
  signer: { verificationMethod: string; privateKey: KeyObject },
  options: { created?: string; proofPurpose?: string } = {},
): TrustTaskDocument {
  return {
    ...unsigned,
    proof: createEddsaJcs2022Proof(unsigned, {
      verificationMethod: signer.verificationMethod,
      privateKey: signer.privateKey,
      proofPurpose: options.proofPurpose ?? 'authentication',
      created: options.created ?? isoSeconds(T0),
    }),
  };
}

/** `draft` then `sign` with the sender's own key: the ordinary well-formed request. */
export function signedRequest(input: Draft): TrustTaskDocument {
  return sign(draft(input), input.from);
}
