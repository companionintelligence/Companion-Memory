import { type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { HealthController } from '../HealthController';

@Module({
  controllers: [HealthController],
})
class HealthTestModule {}

describe('HealthController', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [HealthTestModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /health', () => {
    it('returns 200 with { status: "ok" }', async () => {
      const res = await request(app.getHttpServer()).get('/health');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('responds to repeated calls (liveness probe semantics)', async () => {
      // Sequential, not Promise.all: parallel supertest requests each spin up a
      // fresh ephemeral listener on the same un-listened server and race to bind,
      // which flakes in CI. A liveness probe only needs to stay 200 across calls.
      for (let i = 0; i < 5; i++) {
        const res = await request(app.getHttpServer()).get('/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
      }
    });

    it('does not require authentication', async () => {
      // Health check is intentionally unauthenticated so CI-Gateway and external
      // probes (Companion Hub, container orchestrators) can reach it without
      // managing credentials. If this test starts failing, the gateway and
      // operational monitoring will silently stop reporting Server health.
      const res = await request(app.getHttpServer())
        .get('/health')
        // explicitly no auth header / cookie
        .set('Authorization', '');

      expect(res.status).toBe(200);
    });
  });
});
