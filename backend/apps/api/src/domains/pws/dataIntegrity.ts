import { createHash } from 'node:crypto';

import { verifyEd25519, type Signer } from './ed25519';
import { canonicalize } from './jcs';
import { base58btcDecode, base58btcEncode } from './multibase';

/**
 * Data Integrity proofs with the `eddsa-jcs-2022` cryptosuite (W3C "Data Integrity EdDSA Cryptosuites v1.0",
 * §3.3), written generically enough to secure a zcap: the proof options may carry extra members such as
 * `capabilityChain`, and every one of them is part of what is signed.
 *
 *   proofConfig = the proof options without `proofValue`, plus `type` and `cryptosuite`, plus the document's
 *                 `@context` when it has one
 *   signed data = SHA-256(JCS(proofConfig)) || SHA-256(JCS(document without proof))      (64 bytes)
 *   proofValue  = "z" + base58btc(Ed25519 signature of the signed data)
 *
 * `dataIntegrity.spec.ts` pins it to W3C Appendix B.3 (the hashes AND the signature, reproduced from the
 * published secret key). The algorithm for zcap delegation proofs was read from the PWS reference stack's
 * `eddsa-jcs-2022` suite (`@interop/ed25519-signature` 7.2.5 over `@interop/data-integrity-proof`): the proof
 * carries `type`, `created`, `verificationMethod`, `cryptosuite`, `proofPurpose`, `capabilityChain` and `@context`,
 * all hashed, and the signed capability's own `@context` is `["https://w3id.org/zcap/v1",
 * "https://w3id.org/security/data-integrity/v2"]` because the signing library appends the latter. Byte-for-byte
 * agreement with that stack's output is checked in `referenceVectors.spec.ts`, against the vectors it generated.
 *
 * Verification follows the same reference behaviour on `@context`: a proof that carries one must find it as a
 * prefix of the document's `@context` (entry by entry), and the document is then hashed with the proof's
 * `@context`. A proof with no `@context` is hashed as it stands, so a document that has one and a proof that
 * does not will simply fail to verify unless that is how it was signed. Anything stricter (a zcap proof must
 * name the zcap context) is the caller's policy, not this file's.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [member: string]: JsonValue };
export type JsonObject = { [member: string]: JsonValue };

export interface DataIntegrityProof {
  type: 'DataIntegrityProof';
  cryptosuite: 'eddsa-jcs-2022';
  verificationMethod: string;
  created: string;
  proofPurpose: string;
  proofValue: string;
  [member: string]: JsonValue;
}

export interface ProofOptions {
  verificationMethod: string;
  created: string;
  proofPurpose: string;
  [member: string]: JsonValue;
}

export class DataIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataIntegrityError';
  }
}

const sha256 = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

function dataToSign(proofConfig: JsonObject, document: JsonObject): Uint8Array {
  return Uint8Array.from([...sha256(canonicalize(proofConfig)), ...sha256(canonicalize(document))]);
}

/** Secures `document` (which must not carry a `proof`) with an `eddsa-jcs-2022` proof made by `signer`. */
export async function createEddsaJcs2022Proof(args: {
  document: JsonObject;
  proofOptions: ProofOptions;
  signer: Signer;
}): Promise<DataIntegrityProof> {
  const { document, proofOptions, signer } = args;
  if ('proof' in document) {
    throw new DataIntegrityError('the document to secure must not already carry a proof');
  }
  if ('proofValue' in proofOptions) {
    throw new DataIntegrityError('proof options must not carry a proofValue');
  }
  if (proofOptions.verificationMethod !== signer.id) {
    throw new DataIntegrityError('the proof names a verification method other than the signer');
  }

  const proofConfig: JsonObject = {
    ...proofOptions,
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
  };
  const documentContext = document['@context'];
  if (documentContext !== undefined) {
    proofConfig['@context'] = documentContext;
  }

  const signature = await signer.sign(dataToSign(proofConfig, document));
  if (signature.length !== 64) {
    throw new DataIntegrityError('an Ed25519 signature is 64 bytes');
  }

  return { ...proofConfig, proofValue: `z${base58btcEncode(signature)}` } as DataIntegrityProof;
}

/** Whether `proof` is a valid `eddsa-jcs-2022` proof by `publicKey` over `document`. Never throws. */
export function verifyEddsaJcs2022Proof(args: {
  document: JsonObject;
  proof: DataIntegrityProof;
  publicKey: Uint8Array;
}): boolean {
  const { document, proof, publicKey } = args;
  try {
    if (proof.type !== 'DataIntegrityProof' || proof.cryptosuite !== 'eddsa-jcs-2022') {
      return false;
    }
    if ('proof' in document) {
      return false;
    }
    const { proofValue, ...proofConfig } = proof;
    if (typeof proofValue !== 'string' || !proofValue.startsWith('z')) {
      return false;
    }
    const signature = base58btcDecode(proofValue.slice(1));

    let securedDocument = document;
    const proofContext = proofConfig['@context'];
    if (proofContext !== undefined) {
      const documentContext = document['@context'];
      if (documentContext === undefined) {
        return false;
      }
      const proofEntries = Array.isArray(proofContext) ? proofContext : [proofContext];
      const documentEntries = Array.isArray(documentContext) ? documentContext : [documentContext];
      for (const [i, entry] of proofEntries.entries()) {
        const counterpart = documentEntries[i];
        if (counterpart === undefined || canonicalize(entry) !== canonicalize(counterpart)) {
          return false;
        }
      }
      securedDocument = { ...document, '@context': proofContext };
    }

    return verifyEd25519(publicKey, dataToSign(proofConfig, securedDocument), signature);
  } catch {
    return false;
  }
}
