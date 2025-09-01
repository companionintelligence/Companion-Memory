import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import request from 'supertest';

import { IdFormatGuard, JwtAuthGuard } from '@ci/common/guards';
import { ProxyService } from '@ci/common/services/ProxyService';
import { SpeechModule } from '../index';

const mockCanActivate = jest.fn().mockImplementation((context) => {
  const request = context.switchToHttp().getRequest();
  // Mock the user context
  if (request.context) {
    request.context.userId = 'test-user-id';
  }
  return true;
});

class MockJwtAuthGuard {
  canActivate = mockCanActivate;
}

// Mock ProxyService to test the controller behavior
const mockProxyService = {
  proxyRequest: jest.fn().mockImplementation((req, res, targetUrl) => {
    res.status(200).json({ audio: 'Test audio data', url: targetUrl });
  }),
};

describe('TTS Controller', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [SpeechModule],
      providers: [
        {
          provide: APP_GUARD,
          useClass: IdFormatGuard,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(MockJwtAuthGuard)
      .overrideProvider(ProxyService)
      .useValue(mockProxyService)
      .compile();

    app = module.createNestApplication();
    
    // Apply the request context middleware to set up context
    app.use((req: any, res: any, next: any) => {
      req.context = {
        requestId: 'test-request-id',
        query: req.query,
        userId: 'test-user-id',
      };
      next();
    });

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /tts', () => {
    it('should proxy request to TTS service', async () => {
      const testData = { text: 'Hello, world!' };
      
      const response = await request(app.getHttpServer())
        .post('/tts')
        .send(testData)
        .expect(200);

      expect(mockProxyService.proxyRequest).toHaveBeenCalled();
      expect(response.body.audio).toBe('Test audio data');
    });

    it('should forward request to correct TTS service URL', async () => {
      const testData = { text: 'Hello, world!' };
      
      await request(app.getHttpServer())
        .post('/tts')
        .send(testData)
        .expect(200);

      const callArgs = mockProxyService.proxyRequest.mock.calls[0];
      const targetUrl = callArgs[2];
      expect(targetUrl).toBe('http://localhost:9002/tts'); // Should use TTS host, not STT host
    });

    it('should reject requests without text', async () => {
      await request(app.getHttpServer())
        .post('/tts')
        .send({})
        .expect(400);
    });

    it('should reject requests with empty text', async () => {
      await request(app.getHttpServer())
        .post('/tts')
        .send({ text: '' })
        .expect(400);
    });

    it('should reject requests with whitespace-only text', async () => {
      await request(app.getHttpServer())
        .post('/tts')
        .send({ text: '   ' })
        .expect(400);
    });
  });
});