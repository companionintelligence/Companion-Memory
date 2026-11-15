import { generateKeyPairSync } from 'node:crypto';

import { DTG_CONTEXT_V1, W3C_CREDENTIALS_V2 } from '../contexts';
import { secureDocument } from '../dataIntegrity';
import { toDateTimeStamp } from '../dateTime';
import { didKeyFromPublicKey, didKeyVerificationMethod } from '../didKey';
import { LocalSigner, rawPublicKey } from '../ed25519';

/** Creates a self-signed Ed25519 DTG verifiable credential for VTC unit/HTTP tests. */
export async function createSignedDtgCredential(opts: {
  validFrom?: Date;
  validUntil?: Date;
  subject?: string;
}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const rawPub = rawPublicKey(publicKey);
  const did = didKeyFromPublicKey(rawPub);
  const vm = didKeyVerificationMethod(did);
  const signer = new LocalSigner(vm, privateKey);
  const validFrom = opts.validFrom ?? new Date(Date.now() - 60_000);
  const validUntil = opts.validUntil ?? new Date(Date.now() + 86_400_000);

  const unsignedDoc = {
    '@context': [W3C_CREDENTIALS_V2, DTG_CONTEXT_V1],
    id: 'urn:uuid:7c2a4f9e-3b1d-4a56-9d0e-1f2a3b4c5d6e',
    type: ['VerifiableCredential', 'DTGCredential', 'MembershipCredential'],
    issuer: did,
    issuerScope: 'public',
    validFrom: toDateTimeStamp(validFrom),
    validUntil: toDateTimeStamp(validUntil),
    credentialSubject: {
      id: opts.subject ?? 'did:key:z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2',
    },
  };

  const signedDoc = await secureDocument(unsignedDoc, signer, {
    created: validFrom,
  });

  return { did, signedDoc };
}
