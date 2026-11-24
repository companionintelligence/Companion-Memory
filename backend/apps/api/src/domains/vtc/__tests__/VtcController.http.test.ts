import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { FeatureService } from '@ci/common/feature';

import { VtcController } from '../VtcController';

import { createSignedDtgCredential } from './vtcTestHelper';

describe('VtcController HTTP pipeline', () => {
  it('gates POST /vtc/verify with 404 when disabled and verifies over Nest HTTP when enabled', async () => {
    let enabled = false;
    const moduleRef = await Test.createTestingModule({
      controllers: [VtcController],
      providers: [
        {
          provide: FeatureService,
          useValue: { isFeatureEnabled: jest.fn(async () => enabled) },
        },
      ],
    }).compile();

    const app: INestApplication = moduleRef.createNestApplication();
    await app.init();

    try {
      const { signedDoc } = await createSignedDtgCredential({});
      await request(app.getHttpServer()).post('/vtc/verify').send({ credential: signedDoc }).expect(404);

      enabled = true;
      const res = await request(app.getHttpServer())
        .post('/vtc/verify')
        .send({ credential: signedDoc })
        .expect(201);
      expect(res.body.valid).toBe(true);
      expect(res.body.subtype).toBe('MembershipCredential');
    } finally {
      await app.close();
    }
  });
});
