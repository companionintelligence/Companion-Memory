import { type INestApplication, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { FeatureService } from '@ci/common/feature';
import { BodyParserMiddleware } from '@ci/common/middleware';

import { DidcommAgent } from '../agent';
import { DidcommController } from '../DidcommController';
import { generateDidKeyIdentity, secretsOf } from '../identity';
import { createDidResolver } from '../resolver';
import { buildPing } from '../trustPing';

describe('DidcommController HTTP pipeline', () => {
  it('accepts application/didcomm-encrypted+json over Nest HTTP + BodyParserMiddleware', async () => {
    let enabled = false;

    @Module({
      controllers: [DidcommController],
      providers: [
        {
          provide: FeatureService,
          useValue: { isFeatureEnabled: jest.fn(async () => enabled) },
        },
      ],
    })
    class DidcommTestModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(BodyParserMiddleware).forRoutes('*');
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [DidcommTestModule],
    }).compile();

    const app: INestApplication = moduleRef.createNestApplication();
    await app.init();

    try {
      await request(app.getHttpServer()).get('/didcomm/did').expect(404);
      await request(app.getHttpServer()).post('/didcomm/message').send({}).expect(404);

      enabled = true;
      const didRes = await request(app.getHttpServer()).get('/didcomm/did').expect(200);
      const serverDid = (didRes.body as { did: string }).did;
      expect(serverDid).toMatch(/^did:peer:/);

      const alice = generateDidKeyIdentity();
      const aliceAgent = new DidcommAgent({
        did: alice.did,
        resolver: createDidResolver(),
        secrets: secretsOf(alice),
      });
      const ping = buildPing({ from: alice.did, to: [serverDid] });
      const { packed } = await aliceAgent.pack(ping, { to: serverDid });

      const msgRes = await request(app.getHttpServer())
        .post('/didcomm/message')
        .set('Content-Type', 'application/didcomm-encrypted+json')
        .send(packed)
        .expect(201);

      expect(msgRes.body.handled).toBe(true);
      expect(msgRes.body.repliesCount).toBe(1);
    } finally {
      await app.close();
    }
  });
});
