import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { FeatureService } from '@ci/common/feature';

import { IdentikeyController } from '../IdentikeyController';

describe('IdentikeyController HTTP pipeline', () => {
  it('enforces HTTP 404 when disabled and issues JSON-safe challenges when enabled', async () => {
    let enabled = false;
    const moduleRef = await Test.createTestingModule({
      controllers: [IdentikeyController],
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
      await request(app.getHttpServer()).post('/auth/identikey/challenge').expect(404);
      await request(app.getHttpServer())
        .post('/auth/identikey/verify')
        .send({ responseBase64: 'AAAA' })
        .expect(404);

      enabled = true;
      const chalRes = await request(app.getHttpServer())
        .post('/auth/identikey/challenge')
        .set('Host', 'identikey.example')
        .expect(201);
      expect(chalRes.body.challengeBase64).toBeDefined();
      expect(chalRes.body.challenge.audience).toBe('identikey.example');
      expect(typeof chalRes.body.challenge.nonceBase64).toBe('string');
    } finally {
      await app.close();
    }
  });
});
