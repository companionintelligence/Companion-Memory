import { generateKeyPairSync } from 'node:crypto';

import { NotFoundException } from '@nestjs/common';

import { DTG_CONTEXT_V1, W3C_CREDENTIALS_V2 } from './contexts';
import { secureDocument } from './dataIntegrity';
import { didKeyFromPublicKey, didKeyVerificationMethod } from './didKey';
import { LocalSigner, rawPublicKey } from './ed25519';
import { VtcController } from './VtcController';

describe('VtcController', () => {
  it('throws NotFoundException when vtc.credentials is disabled', async () => {
    const mockFeatures = {
      isFeatureEnabled: jest.fn().mockResolvedValue(false),
    } as never;
    const controller = new VtcController(mockFeatures);

    await expect(controller.verifyCredential({ credential: {} })).rejects.toThrow(NotFoundException);
  });

  it('verifies a signed DTG credential when vtc.credentials is enabled', async () => {
    const mockFeatures = {
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
    } as never;
    const controller = new VtcController(mockFeatures);

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const rawPub = rawPublicKey(publicKey);
    const did = didKeyFromPublicKey(rawPub);
    const vm = didKeyVerificationMethod(did);
    const signer = new LocalSigner(vm, privateKey);

    const unsignedDoc = {
      '@context': [W3C_CREDENTIALS_V2, DTG_CONTEXT_V1],
      id: 'urn:uuid:7c2a4f9e-3b1d-4a56-9d0e-1f2a3b4c5d6e',
      type: ['VerifiableCredential', 'DTGCredential', 'MembershipCredential'],
      issuer: did,
      issuerScope: 'public',
      validFrom: '2026-05-14T10:00:00Z',
      validUntil: '2026-06-13T10:00:00Z',
      credentialSubject: { id: 'did:key:z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2' },
    };

    const signedDoc = await secureDocument(unsignedDoc, signer, {
      created: new Date('2026-05-14T10:00:00Z'),
    });

    const result = await controller.verifyCredential({
      credential: signedDoc,
      expectedSubject: 'did:key:z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2',
    });

    expect(result.valid).toBe(true);
    expect(result.issuer).toBe(did);
    expect(result.subject).toBe('did:key:z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2');
    expect(result.subtype).toBe('MembershipCredential');
  });
});
