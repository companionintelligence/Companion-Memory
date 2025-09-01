import { Test } from '@nestjs/testing';
import { INestApplication, MiddlewareConsumer } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import request from 'supertest';

import { IdFormatGuard, JwtAuthGuard } from '@ci/common/guards';
import { RequestContextMiddleware } from '@ci/common/middleware';
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
    res.status(200).json({ text: 'Test transcription', url: targetUrl });
  }),
};

describe('STT Controller', () => {
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

  describe('POST /stt', () => {
    it('should proxy request to STT service', async () => {
      const testAudioBuffer = Buffer.from('fake audio data');
      
      const response = await request(app.getHttpServer())
        .post('/stt')
        .attach('file', testAudioBuffer, 'test-audio.wav')
        .expect(200);

      expect(mockProxyService.proxyRequest).toHaveBeenCalled();
      expect(response.body.text).toBe('Test transcription');
    });

    it('should forward request to correct STT service URL', async () => {
      const testAudioBuffer = Buffer.from('fake audio data');
      
      await request(app.getHttpServer())
        .post('/stt')
        .attach('file', testAudioBuffer, 'test-audio.wav')
        .expect(200);

      const callArgs = mockProxyService.proxyRequest.mock.calls[0];
      const targetUrl = callArgs[2];
      expect(targetUrl).toBe('http://localhost:9001/stt');
    });

    it('should reject requests without audio file', async () => {
      await request(app.getHttpServer())
        .post('/stt')
        .field('text', 'some text instead of file')
        .expect(400);
    });

    it('should reject invalid audio file types', async () => {
      const testBuffer = Buffer.from('fake data');
      
      await request(app.getHttpServer())
        .post('/stt')
        .attach('file', testBuffer, 'test-file.txt')
        .expect(400);
    });

    it('should accept valid audio file types', async () => {
      const testAudioBuffer = Buffer.from('fake audio data');
      
      const audioFormats = ['test.wav', 'test.mp3', 'test.flac', 'test.m4a'];
      
      for (const format of audioFormats) {
        mockProxyService.proxyRequest.mockClear();
        
        await request(app.getHttpServer())
          .post('/stt')
          .attach('file', testAudioBuffer, format)
          .expect(200);

        expect(mockProxyService.proxyRequest).toHaveBeenCalled();
      }
    });
  });
});