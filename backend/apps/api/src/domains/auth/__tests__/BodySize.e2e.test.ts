import { type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { json, urlencoded } from 'express';
import request from 'supertest';

import { IdFormatGuard, JwtAuthGuard } from '@ci/common/guards';
import { LoggingModule } from '@ci/common/logging';

import { AuthModule } from '..';
import { SessionEntity } from '../entities/SessionEntity';
import { SignupCodeEntity } from '../entities/SignupCodeEntity';

/**
 * E2E tests to verify that JSON body size limits are properly enforced
 * to prevent memory exhaustion DoS attacks on auth endpoints.
 */
describe('Auth endpoint body size limits', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AuthModule, LoggingModule],
      providers: [
        {
          provide: APP_GUARD,
          useClass: IdFormatGuard,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(getRepositoryToken(SessionEntity))
      .useValue({})
      .overrideProvider(getRepositoryToken(SignupCodeEntity))
      .useValue({})
      .compile();

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

      expect(response.status).toBe(413);
    });

    it('should accept requests with normal-sized body (< 100kb)', async () => {
      const normalPayload = {
        username: 'testuser',
        password: 'testpassword',
      };

      const response = await request(app.getHttpServer()).post('/authenticate').send(normalPayload);

      // We expect either 401 (unauthorized - normal flow since user doesn't exist)
      // or 200 (if mock succeeds), but NOT 413
      expect(response.status).not.toBe(413);
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

      const response = await request(app.getHttpServer()).post('/signup').send(largePayload).expect(413);

      expect(response.status).toBe(413);
    });

    it('should accept requests with normal-sized body (< 100kb)', async () => {
      const normalPayload = {
        name: 'Test User',
        email: 'test@example.com',
        password: 'password123',
      };

      const response = await request(app.getHttpServer()).post('/signup').send(normalPayload);

      // We expect either 400 (bad request - normal flow for validation errors)
      // or 201 (if mock succeeds), but NOT 413
      expect(response.status).not.toBe(413);
    });
  });

  describe('POST /authenticate/refresh', () => {
    it('should reject requests with body exceeding 100kb with 413 status', async () => {
      // Create a payload that exceeds 100kb
      const largeString = 'x'.repeat(101 * 1024);
      const largePayload = {
        token: largeString,
      };

      const response = await request(app.getHttpServer())
        .post('/authenticate/refresh')
        .send(largePayload)
        .expect(413);

      expect(response.status).toBe(413);
    });

    it('should accept requests with normal-sized body (< 100kb)', async () => {
      const normalPayload = {};

      const response = await request(app.getHttpServer()).post('/authenticate/refresh').send(normalPayload);

      // We expect either 401 (unauthorized - normal flow since token is missing/invalid)
      // or 200 (if mock succeeds), but NOT 413
      expect(response.status).not.toBe(413);
    });
  });
});
