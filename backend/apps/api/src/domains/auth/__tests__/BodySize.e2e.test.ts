import { Controller, Post, type INestApplication, Body } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { json, urlencoded } from 'express';
import request from 'supertest';

/**
 * Simple controller for testing body size limits
 */
@Controller()
class TestAuthController {
  @Post('authenticate')
  login(@Body() body: Record<string, unknown>) {
    return { success: true, body };
  }

  @Post('signup')
  signup(@Body() body: Record<string, unknown>) {
    return { success: true, body };
  }

  @Post('authenticate/refresh')
  refresh(@Body() body: Record<string, unknown>) {
    return { success: true, body };
  }
}

/**
 * E2E tests to verify that JSON body size limits are properly enforced
 * to prevent memory exhaustion DoS attacks on auth endpoints.
 */
describe('Auth endpoint body size limits', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [TestAuthController],
    }).compile();

    app = module.createNestApplication();

    // Apply the same body size limits as in main.ts
    app.use(json({ limit: '100kb' }));
    app.use(urlencoded({ extended: true, limit: '100kb' }));

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /authenticate', () => {
    it('should reject requests with body exceeding 100kb with 413 status', async () => {
      // Create a payload that exceeds 100kb
      const largeString = 'x'.repeat(101 * 1024);
      const largePayload = {
        username: 'test',
        password: largeString,
      };

      const response = await request(app.getHttpServer())
        .post('/authenticate')
        .send(largePayload)
        .expect(413);
    });

    it('should accept requests with normal-sized body (< 100kb)', async () => {
      const normalPayload = {
        username: 'testuser',
        password: 'testpassword',
      };

      const response = await request(app.getHttpServer()).post('/authenticate').send(normalPayload);

      // We expect 200 or 201 (successful), not 413
      expect(response.status).not.toBe(413);
      expect([200, 201]).toContain(response.status);
    });
  });

  describe('POST /signup', () => {
    it('should reject requests with body exceeding 100kb with 413 status', async () => {
      // Create a payload that exceeds 100kb
      const largeString = 'x'.repeat(101 * 1024);
      const largePayload = {
        name: largeString,
        email: 'test@example.com',
        password: 'password123',
      };

      await request(app.getHttpServer()).post('/signup').send(largePayload).expect(413);
    });

    it('should accept requests with normal-sized body (< 100kb)', async () => {
      const normalPayload = {
        name: 'Test User',
        email: 'test@example.com',
        password: 'password123',
      };

      const response = await request(app.getHttpServer()).post('/signup').send(normalPayload);

      // We expect 200 or 201 (successful), not 413
      expect(response.status).not.toBe(413);
      expect([200, 201]).toContain(response.status);
    });
  });

  describe('POST /authenticate/refresh', () => {
    it('should reject requests with body exceeding 100kb with 413 status', async () => {
      // Create a payload that exceeds 100kb
      const largeString = 'x'.repeat(101 * 1024);
      const largePayload = {
        token: largeString,
      };

      await request(app.getHttpServer())
        .post('/authenticate/refresh')
        .send(largePayload)
        .expect(413);
    });

    it('should accept requests with normal-sized body (< 100kb)', async () => {
      const normalPayload = {};

      const response = await request(app.getHttpServer()).post('/authenticate/refresh').send(normalPayload);

      // We expect 200 or 201 (successful), not 413
      expect(response.status).not.toBe(413);
      expect([200, 201]).toContain(response.status);
    });
  });
});
