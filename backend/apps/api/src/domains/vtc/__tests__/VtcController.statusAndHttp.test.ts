import { generateKeyPairSync } from 'node:crypto';

import { Test } from '@nestjs/testing';
import request from 'supertest';

import { FeatureService } from '@ci/common/feature';

import { DTG_CONTEXT_V1, W3C_CREDENTIALS_V2 } from '../contexts';
import { secureDocument } from '../dataIntegrity';
import { didKeyFromPublicKey, didKeyVerificationMethod } from '../didKey';
import { LocalSigner, rawPublicKey } from '../ed25519';
import { buildStatusListCredential, createBitstring, writeStatus } from '../statusList';
import { VtcController } from '../VtcController';

const LIST_URL = 'https://community.example/v1/status-lists/revocation';

async function buildSignedFixture(options?: {
  statusPurpose?: 'revocation' | 'suspension';
  bitSet?: boolean;
}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const issuerDid = didKeyFromPublicKey(rawPublicKey(publicKey));
  const signer = new LocalSigner(didKeyVerificationMethod(issuerDid), privateKey);
  const purpose = options?.statusPurpose ?? 'revocation';

  const bits = createBitstring();
  if (options?.bitSet) {
    writeStatus(bits, 42, 1);
  }

  const unsignedList = buildStatusListCredential({
    id: LIST_URL,
    issuer: issuerDid,
    purpose,
    bits,
    validFrom: new Date(Date.now() - 60_000),
    validUntil: new Date(Date.now() + 3_600_000),
    ttlMs: 300_000,
  });
  const signedList = await secureDocument(unsignedList, signer, {
    created: new Date(),
  });

  const unsignedCred = {
    '@context': [W3C_CREDENTIALS_V2, DTG_CONTEXT_V1],
    id: 'urn:uuid:cred-status-1',
    type: ['VerifiableCredential', 'DTGCredential', 'MembershipCredential', 'PersonhoodCredential'],
    issuer: issuerDid,
    issuerScope: 'public',
    validFrom: new Date(Date.now() - 60_000).toISOString(),
    validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    credentialSubject: {
      id: 'did:key:z6MkSubject00000000000000000000000000000000000000',
    },
    credentialStatus: {
      id: `${LIST_URL}#42`,
      type: 'BitstringStatusListEntry',
      statusPurpose: purpose,
      statusListIndex: '42',
      statusListCredential: LIST_URL,
    },
  };
  const signedCred = await secureDocument(unsignedCred, signer, {
    created: new Date(),
  });

  return { issuerDid, signedCred, signedList, entry: unsignedCred.credentialStatus };
}

describe('VtcController HTTP status list & community verification', () => {
  it('fails closed with 404 on both VTC endpoints when vtc.credentials flag is disabled', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [VtcController],
      providers: [
        { provide: FeatureService, useValue: { isFeatureEnabled: jest.fn().mockResolvedValue(false) } },
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer()).post('/vtc/verify').send({ credential: {} }).expect(404);
    await request(app.getHttpServer()).post('/vtc/status-list/evaluate').send({ entry: {} }).expect(404);

    await app.close();
  });

  it('verifies DTG credentials against inline signed BitstringStatusListCredentials with zero network I/O', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [VtcController],
      providers: [
        { provide: FeatureService, useValue: { isFeatureEnabled: jest.fn().mockResolvedValue(true) } },
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();
    const server = app.getHttpServer();

    const active = await buildSignedFixture({ statusPurpose: 'revocation', bitSet: false });
    const activeRes = await request(server)
      .post('/vtc/verify')
      .send({
        credential: active.signedCred,
        expectedCommunity: active.issuerDid,
        requireStatus: true,
        statusListCredential: active.signedList,
      })
      .expect(201);

    expect(activeRes.body).toMatchObject({
      valid: true,
      issuer: active.issuerDid,
      issuerScope: 'public',
      subtype: 'MembershipCredential',
      credentialId: 'urn:uuid:cred-status-1',
      statusChecked: true,
      personhoodHint: true,
    });

    const evalOk = await request(server)
      .post('/vtc/status-list/evaluate')
      .send({
        entry: active.entry,
        statusListCredential: active.signedList,
        expectedIssuer: active.issuerDid,
      })
      .expect(201);
    expect(evalOk.body).toEqual({
      valid: true,
      purpose: 'revocation',
      status: 0,
      bounded: true,
    });

    const revoked = await buildSignedFixture({ statusPurpose: 'revocation', bitSet: true });
    const revokedRes = await request(server)
      .post('/vtc/verify')
      .send({
        credential: revoked.signedCred,
        statusListCredentials: { [LIST_URL]: revoked.signedList },
      })
      .expect(201);
    expect(revokedRes.body).toEqual({ valid: false, reason: 'REVOKED' });

    const suspended = await buildSignedFixture({ statusPurpose: 'suspension', bitSet: true });
    const suspendedRes = await request(server)
      .post('/vtc/verify')
      .send({
        credential: suspended.signedCred,
        statusListCredential: suspended.signedList,
      })
      .expect(201);
    expect(suspendedRes.body).toEqual({ valid: false, reason: 'SUSPENDED' });

    const issuerMismatch = await request(server)
      .post('/vtc/status-list/evaluate')
      .send({
        entry: revoked.entry,
        statusListCredential: revoked.signedList,
        expectedIssuer: 'did:key:z6MkDifferentIssuer',
      })
      .expect(201);
    expect(issuerMismatch.body).toEqual({ valid: false, reason: 'STATUS_LIST_ISSUER_MISMATCH' });

    const missingList = await request(server)
      .post('/vtc/verify')
      .send({
        credential: active.signedCred,
        requireStatus: true,
      })
      .expect(201);
    expect(missingList.body).toEqual({ valid: false, reason: 'STATUS_UNAVAILABLE' });

    await app.close();
  });
});
