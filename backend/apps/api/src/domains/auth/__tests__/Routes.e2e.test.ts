import {
  Controller,
  Post,
  type INestApplication,
  Body,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { BodyParserMiddleware } from '@ci/common/middleware';

@Controller()
class TestAuthController {
  @Post('authenticate')
  login(@Body() body: Record<string, unknown>) {
    return {
      success: true,
      body,
    };
  }

  @Post('signup')
  signup(@Body() body: Record<string, unknown>) {
    return {
      success: true,
      body,
    };
  }

  @Post('authenticate/refresh')
  refresh(@Body() body: Record<string, unknown>) {
    return {
      success: true,
      body,
    };
  }
}

@Module({
  controllers: [TestAuthController],
})
class TestModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(BodyParserMiddleware).forRoutes('*');
  }
}

describe('Auth routes', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();

    app = module.createNestApplication({
      bodyParser: false,
      logger: false,
    });

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

      await request(app.getHttpServer()).post('/authenticate').send(largePayload).expect(413);
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

      await request(app.getHttpServer()).post('/authenticate/refresh').send(largePayload).expect(413);
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
