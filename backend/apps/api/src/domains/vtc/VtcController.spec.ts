import { NotFoundException } from '@nestjs/common';

import { createSignedDtgCredential } from './__tests__/vtcTestHelper';
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
    const subject = 'did:key:z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2';
    const { did, signedDoc } = await createSignedDtgCredential({ subject });

    const result = await controller.verifyCredential({
      credential: signedDoc,
      expectedSubject: subject,
    });

    expect(result.valid).toBe(true);
    expect(result.issuer).toBe(did);
    expect(result.subject).toBe(subject);
    expect(result.subtype).toBe('MembershipCredential');
  });

  it('enforces temporal validity and rejects expired or not-yet-valid credentials', async () => {
    const mockFeatures = {
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
    } as never;
    const controller = new VtcController(mockFeatures);

    const expired = await createSignedDtgCredential({
      validFrom: new Date(Date.now() - 2 * 86_400_000),
      validUntil: new Date(Date.now() - 10 * 60_000),
    });
    expect(await controller.verifyCredential({ credential: expired.signedDoc })).toEqual({
      valid: false,
      reason: 'EXPIRED',
    });

    const future = await createSignedDtgCredential({
      validFrom: new Date(Date.now() + 10 * 60_000),
      validUntil: new Date(Date.now() + 2 * 86_400_000),
    });
    expect(await controller.verifyCredential({ credential: future.signedDoc })).toEqual({
      valid: false,
      reason: 'NOT_YET_VALID',
    });
  });

  it('rejects tampered payloads, subject mismatch, unresolvable did:keri, and malformed inputs', async () => {
    const mockFeatures = {
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
    } as never;
    const controller = new VtcController(mockFeatures);
    const { signedDoc } = await createSignedDtgCredential({});

    // Tampered subject fails proof verification
    const tampered = {
      ...signedDoc,
      credentialSubject: { id: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH' },
    };
    expect((await controller.verifyCredential({ credential: tampered })).valid).toBe(false);

    // Subject mismatch when expectedSubject differs
    expect(
      await controller.verifyCredential({
        credential: signedDoc,
        expectedSubject: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
      }),
    ).toEqual({ valid: false, reason: 'SUBJECT_MISMATCH' });

    // Non-object / array inputs return MALFORMED_CREDENTIAL
    expect(await controller.verifyCredential({ credential: null })).toEqual({
      valid: false,
      reason: 'MALFORMED_CREDENTIAL',
    });
    expect(await controller.verifyCredential({ credential: [] })).toEqual({
      valid: false,
      reason: 'MALFORMED_CREDENTIAL',
    });

    // Unpinned domain/challenge proof properties refused by default verifier
    expect(
      await controller.verifyCredential({
        credential: {
          ...signedDoc,
          proof: { ...(signedDoc.proof as Record<string, unknown>), domain: 'evil.example' },
        },
      }),
    ).toEqual({ valid: false, reason: 'PROOF_UNSUPPORTED' });

    // did:keri: issuer fails closed because live KERI resolver is intentionally not registered
    const keriRes = await controller.verifyCredential({
      credential: {
        ...signedDoc,
        issuer: 'did:keri:EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
    });
    expect(keriRes.valid).toBe(false);

    // expectedCommunity mismatch fails closed with UNRECOGNIZED_COMMUNITY
    const wrongCommunity = await controller.verifyCredential({
      credential: signedDoc,
      expectedCommunity: 'did:key:z6MkwWrongCommunity',
    });
    expect(wrongCommunity).toEqual({ valid: false, reason: 'UNRECOGNIZED_COMMUNITY' });

    // requireStatus without any status entry fails closed with STATUS_REQUIRED
    const missingStatus = await controller.verifyCredential({
      credential: signedDoc,
      requireStatus: true,
    });
    expect(missingStatus).toEqual({ valid: false, reason: 'STATUS_REQUIRED' });
  });

  it('rejects malformed inputs on evaluateStatusList without network calls', async () => {
    const controller = new VtcController({
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
    } as never);

    expect(await controller.evaluateStatusList({ entry: { id: 'x' } })).toEqual({
      valid: false,
      reason: 'STATUS_VERIFICATION_ERROR: credentialStatus is not a BitstringStatusListEntry',
    });

    expect(
      await controller.evaluateStatusList({
        entry: {
          id: 'https://community.example/list#1',
          type: 'BitstringStatusListEntry',
          statusPurpose: 'revocation',
          statusListIndex: '1',
          statusListCredential: 'https://community.example/list',
        },
      }),
    ).toEqual({ valid: false, reason: 'STATUS_LIST_MISSING' });
  });
});
